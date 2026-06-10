#!/usr/bin/env node
/**
 * TripAdvisor Deep Scrape — rating, review count, and review excerpts
 *
 * discover_links.js has been capturing TripAdvisor URLs for months but
 * nothing ever read them. This scraper resolves a shop's TripAdvisor page
 * (DB column → discovery JSONs → DuckDuckGo search), loads it with the
 * stealth browser (TripAdvisor aggressively blocks plain HTTP), and pulls:
 *   - aggregate rating + review count (from JSON-LD, stable across redesigns)
 *   - review excerpts (best-effort across several known selectors)
 *
 * Output: content/{shopId}/reviews/tripadvisor_reviews.json in the same
 * shape as yelp/google review files, so summarize_reviews.js folds it
 * into the review synthesis. Also persists shops.tripadvisor_url.
 *
 * Usage:
 *   node deep_scrape_tripadvisor.js --shop-id "uuid"
 *   node deep_scrape_tripadvisor.js --shop-id "uuid" --url "https://www.tripadvisor.com/..."
 *   node deep_scrape_tripadvisor.js --all --limit 10
 *   node deep_scrape_tripadvisor.js --all --force    # re-scrape existing
 */

const fs = require('fs');
const path = require('path');
const { supabase, delay, saveJSON, loadJSON, contentDir, getAllShops, updateShop,
  parseArgs, log, ddgSearch, createStealthBrowser } = require('./lib/common');

const TA_URL_RE = /tripadvisor\.com\/(?:Attraction_Review|ShowUserReviews|Shopping)[^"'&\s]*/i;
const APIFY_API_TOKEN = process.env.APIFY_API_TOKEN || null;
// Established TripAdvisor reviews actor (per-result billing, ~$0.005/review)
const APIFY_TA_ACTOR = 'maxcopell~tripadvisor-reviews';

// ── URL resolution ─────────────────────────────────────────

function urlFromDiscoveryFiles(shopId) {
  const discoveryDir = contentDir(shopId, 'discovery');
  if (!fs.existsSync(discoveryDir)) return null;

  const files = fs.readdirSync(discoveryDir).filter(f => f.endsWith('.json')).sort().reverse();
  for (const f of files) {
    const data = loadJSON(path.join(discoveryDir, f));
    const entries = (data?.byCategory?.tripadvisor) || [];
    for (const entry of entries) {
      if (entry.url && TA_URL_RE.test(entry.url)) return entry.url.split('?')[0];
    }
  }
  return null;
}

async function urlFromSearch(shop) {
  log(`  🔎 Searching DuckDuckGo: site:tripadvisor.com "${shop.name}" ${shop.city}`);
  const { html, blocked } = await ddgSearch(`site:tripadvisor.com "${shop.name}" ${shop.city}`);
  if (blocked) {
    log('  ⚠️  DuckDuckGo rate limited');
    return null;
  }
  const pattern = /(?:uddg=|href=")(https?(?::|%3A)(?:\/|%2F){2}(?:www\.)?tripadvisor\.com(?:\/|%2F)[^&"]+)/g;
  let m;
  while ((m = pattern.exec(html)) !== null) {
    let url;
    try { url = decodeURIComponent(m[1]); } catch { url = m[1]; }
    if (TA_URL_RE.test(url)) return url.split('?')[0];
  }
  return null;
}

// ── Page extraction ────────────────────────────────────────

async function scrapeTripAdvisorPage(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(6000);

  return page.evaluate(() => {
    const out = { name: null, rating: null, reviewCount: null, reviews: [] };

    // JSON-LD survives TripAdvisor's frequent class-name churn
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const data = JSON.parse(script.textContent);
        const nodes = Array.isArray(data) ? data : [data];
        for (const node of nodes) {
          const agg = node.aggregateRating;
          if (agg) {
            out.name = node.name || out.name;
            out.rating = parseFloat(agg.ratingValue) || out.rating;
            out.reviewCount = parseInt(agg.reviewCount || agg.ratingCount) || out.reviewCount;
          }
        }
      } catch (e) { /* malformed block — keep going */ }
    }

    // Review text: try current and legacy selectors
    const selectors = [
      '[data-automation="reviewText"]',
      'div[data-test-target="review-body"] q',
      '.QewHA span',          // 2023-era attraction reviews
      'q.XllAv',              // legacy
      '.partial_entry',       // very old
    ];
    const seen = new Set();
    for (const sel of selectors) {
      for (const el of document.querySelectorAll(sel)) {
        const text = (el.textContent || '').trim();
        if (text.length > 40 && !seen.has(text)) {
          seen.add(text);
          out.reviews.push({ text });
        }
      }
      if (out.reviews.length) break;
    }

    // Review titles pair with texts on attraction pages — attach best-effort
    const titles = Array.from(document.querySelectorAll('[data-automation="reviewTitle"], .review-title'))
      .map(el => (el.textContent || '').trim());
    out.reviews.forEach((r, i) => { if (titles[i]) r.title = titles[i]; });

    return out;
  });
}

// ── Apify fallback ─────────────────────────────────────────
// TripAdvisor's bot detection usually defeats even the stealth browser;
// the Apify actor runs on residential proxies and gets through.

async function scrapeViaApify(url) {
  log('  🐝 Falling back to Apify actor...');

  const runRes = await fetch(`https://api.apify.com/v2/acts/${APIFY_TA_ACTOR}/runs?token=${APIFY_API_TOKEN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ startUrls: [{ url }], maxItemsPerQuery: 20, scrapeReviewerInfo: false }),
  });
  const run = await runRes.json();
  if (!run.data?.id) throw new Error(`Apify run failed to start: ${JSON.stringify(run).slice(0, 200)}`);

  // Poll up to ~4 minutes
  let datasetId = null;
  for (let i = 0; i < 48; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const statusRes = await fetch(`https://api.apify.com/v2/actor-runs/${run.data.id}?token=${APIFY_API_TOKEN}`);
    const status = await statusRes.json();
    if (status.data?.status === 'SUCCEEDED') { datasetId = status.data.defaultDatasetId; break; }
    if (['FAILED', 'ABORTED', 'TIMED-OUT'].includes(status.data?.status)) {
      throw new Error(`Apify run ${status.data.status}`);
    }
  }
  if (!datasetId) throw new Error('Apify run timed out');

  const itemsRes = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_API_TOKEN}&format=json`);
  const items = await itemsRes.json();
  if (!Array.isArray(items) || items.length === 0) return { name: null, rating: null, reviewCount: null, reviews: [] };

  const place = items.find(it => it.placeInfo)?.placeInfo || {};
  return {
    name: place.name || null,
    rating: place.rating ?? null,
    reviewCount: place.numberOfReviews ?? items.length,
    reviews: items
      .filter(it => it.text || it.title)
      .map(it => ({
        text: it.text || it.title,
        title: it.title || null,
        rating: it.rating ?? null,
        author: (it.user && (it.user.username || it.user.name)) || null,
        date: it.publishedDate || null,
      })),
  };
}

// ── Per-shop flow ──────────────────────────────────────────

async function scrapeShop(shop, browserPage, urlOverride) {
  log(`\n🦉 TripAdvisor for: ${shop.name} (${shop.city}, ${shop.state})`);

  let url = urlOverride || shop.tripadvisor_url || urlFromDiscoveryFiles(shop.id);
  if (!url) url = await urlFromSearch(shop);
  if (!url) {
    log('  ✗ No TripAdvisor URL found');
    return false;
  }
  if (!/^https?:\/\//.test(url)) url = `https://www.${url.replace(/^www\./, '')}`;
  log(`  Fetching: ${url}`);

  let extracted = null;
  try {
    extracted = await scrapeTripAdvisorPage(browserPage, url);
  } catch (e) {
    log(`  ⚠️  Page load failed: ${e.message}`);
  }

  if (!extracted || (!extracted.rating && extracted.reviews.length === 0)) {
    log('  ✗ Direct scrape blocked or empty');
    if (!APIFY_API_TOKEN) {
      log('  ✗ No APIFY_API_TOKEN set — cannot fall back');
      return false;
    }
    try {
      extracted = await scrapeViaApify(url);
    } catch (e) {
      log(`  ⚠️  Apify fallback failed: ${e.message}`);
      return false;
    }
    if (!extracted.rating && extracted.reviews.length === 0) {
      log('  ✗ Apify returned no data for this page');
      return false;
    }
  }

  const record = {
    source: 'tripadvisor',
    url,
    scrapedAt: new Date().toISOString(),
    rating: extracted.rating,
    reviewCount: extracted.reviewCount,
    reviews: extracted.reviews.slice(0, 20).map(r => ({
      source: 'TripAdvisor',
      text: r.text.slice(0, 1500),
      title: r.title || null,
      author: 'TripAdvisor reviewer',
      rating: null,
    })),
  };

  saveJSON(contentDir(shop.id, 'reviews', 'tripadvisor_reviews.json'), record);
  log(`  💾 Saved ${record.reviews.length} excerpts (rating: ${record.rating ?? '—'}★, ${record.reviewCount ?? '?'} reviews)`);

  if (!shop.tripadvisor_url || urlOverride) {
    try {
      await updateShop(shop.id, { tripadvisor_url: url });
      log('  ✓ Updated shops.tripadvisor_url');
    } catch (e) {
      log(`  ⚠️  Could not persist tripadvisor_url: ${e.message} (run add-enrichment-source-columns.sql?)`);
    }
  }
  return true;
}

// ── CLI ────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();

  let shops;
  if (args['shop-id']) {
    const { data, error } = await supabase.from('shops').select('*').eq('id', args['shop-id']).single();
    if (error || !data) {
      log(`❌ Shop not found: ${args['shop-id']}`);
      process.exit(1);
    }
    shops = [data];
  } else if (args.all) {
    const limit = parseInt(args.limit) || 10;
    shops = await getAllShops(limit);
  } else {
    console.log('\nUsage:');
    console.log('  node deep_scrape_tripadvisor.js --shop-id "uuid"');
    console.log('  node deep_scrape_tripadvisor.js --shop-id "uuid" --url "https://www.tripadvisor.com/..."');
    console.log('  node deep_scrape_tripadvisor.js --all --limit 10');
    process.exit(0);
  }

  const { browser, context } = await createStealthBrowser();
  const page = await context.newPage();

  let scraped = 0;
  try {
    for (let i = 0; i < shops.length; i++) {
      const shop = shops[i];

      const existing = contentDir(shop.id, 'reviews', 'tripadvisor_reviews.json');
      if (fs.existsSync(existing) && !args.force && !args.url) {
        log(`⏭ ${shop.name}: already scraped (use --force to refresh)`);
        continue;
      }

      try {
        if (await scrapeShop(shop, page, args.url || null)) scraped++;
      } catch (e) {
        log(`  ❌ Error: ${e.message}`);
      }

      if (i < shops.length - 1) await delay(4000, 8000);
    }
  } finally {
    await browser.close().catch(() => {});
  }

  log(`\n✅ Done: ${scraped}/${shops.length} shops scraped`);
}

main().catch(e => {
  console.error('❌ Fatal:', e.message);
  process.exit(1);
});
