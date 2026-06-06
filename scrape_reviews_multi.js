#!/usr/bin/env node
/**
 * Multi-Source Review Scraper — Puppeteer + ScrapeGraphAI pipeline
 * 
 * Scrapes reviews from: Yelp, Google (via ChamberOfCommerce), Facebook,
 * Discogs, Wheree, Loc8NearMe, MapQuest, and shop website.
 * 
 * Usage:
 *   node scrape_reviews_multi.js --shop-id "uuid"
 *   node scrape_reviews_multi.js --shop-id "uuid" --sources yelp,facebook,discogs
 */

const puppeteer = require('puppeteer');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { saveJSON, loadJSON, contentDir, supabase, parseArgs, log } = require('./lib/common');

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// ═══════════════════════════════════════════════════════════════════════════════
// Browser Helpers
// ═══════════════════════════════════════════════════════════════════════════════

let _browser = null;
async function getBrowser() {
  if (!_browser) {
    _browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
  }
  return _browser;
}

async function closeBrowser() {
  if (_browser) { await _browser.close(); _browser = null; }
}

async function fetchPage(url, waitMs = 6000) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setUserAgent(UA);
    await page.setViewport({ width: 1920, height: 1080 });
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, waitMs));
    
    const title = await page.title();
    if (title.includes('Just a moment')) {
      await new Promise(r => setTimeout(r, 10000));
    }
    
    const content = await page.evaluate(() => document.body.innerText);
    const meta = await page.evaluate(() => {
      const m = {};
      document.querySelectorAll('meta[property], meta[name]').forEach(el => {
        const k = el.getAttribute('property') || el.getAttribute('name');
        if (k) m[k] = el.getAttribute('content');
      });
      return m;
    });
    
    return { content, meta, title, url: page.url() };
  } catch (e) {
    log(`  ✗ Failed to fetch ${url}: ${e.message}`);
    return null;
  } finally {
    await page.close();
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Simple text extraction (regex-based, no LLM needed for structured sites)
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// Source Scrapers
// ═══════════════════════════════════════════════════════════════════════════════

async function scrapeYelp(shopName, city, state) {
  const slug = shopName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-');
  const citySlug = city.toLowerCase().replace(/\s+/g, '-');
  const url = `https://www.yelp.com/biz/${slug}-${citySlug}`;
  
  log(`  Yelp: ${url}`);
  const page = await fetchPage(url, 8000);
  if (!page || page.content.includes('The page you requested is not available')) return null;
  
  const content = page.content;
  // Extract rating — Yelp uses tab-separated format: "4.0\t(2 reviews)" or inline
  const ratingMatch = content.match(/([\d.]+)\s*[\t\n]*\s*\((\d+)\s*reviews?\)/i);
  const rating = ratingMatch ? parseFloat(ratingMatch[1]) : null;
  const reviewCount = ratingMatch ? parseInt(ratingMatch[2]) : null;
  
  log(`  ✓ Yelp: ${rating || '?'}★, ${reviewCount || '?'} reviews`);
  return { rating, review_count: reviewCount, raw_content: content.slice(0, 10000), source_url: url };
}

async function scrapeFacebook(fbUrl) {
  if (!fbUrl) return null;
  log(`  Facebook: ${fbUrl}`);
  const page = await fetchPage(fbUrl, 8000);
  if (!page) return null;
  
  // Facebook meta tags are actually very rich
  const meta = page.meta;
  const result = {
    name: meta['og:title'],
    description: meta['og:description'] || meta['description'],
    image: meta['og:image'],
    source_url: fbUrl,
  };
  
  // Parse description for likes/checkins
  const desc = result.description || '';
  const likesMatch = desc.match(/([\d,]+)\s*likes?/i);
  const checkinsMatch = desc.match(/([\d,]+)\s*were here/i);
  const talkingMatch = desc.match(/([\d,]+)\s*talking/i);
  
  if (likesMatch) result.likes = parseInt(likesMatch[1].replace(/,/g, ''));
  if (checkinsMatch) result.checkins = parseInt(checkinsMatch[1].replace(/,/g, ''));
  if (talkingMatch) result.talking_about = parseInt(talkingMatch[1].replace(/,/g, ''));
  
  log(`  ✓ Facebook: ${result.likes || 0} likes, ${result.checkins || 0} checkins`);
  return result;
}

async function scrapeDiscogsSeller(sellerName) {
  const url = `https://www.discogs.com/sell/seller_feedback/${sellerName}`;
  log(`  Discogs seller: ${url}`);
  const page = await fetchPage(url, 8000);
  if (!page || page.content.includes('404')) return null;
  
  const content = page.content;
  const posMatch = content.match(/Positive\s*\n?\s*(\d+)/);
  const neuMatch = content.match(/Neutral\s*\n?\s*(\d+)/);
  const negMatch = content.match(/Negative\s*\n?\s*(\d+)/);
  const joinMatch = content.match(/Joined on\s+(.+)/);
  
  const result = {
    seller_name: sellerName,
    positive: posMatch ? parseInt(posMatch[1]) : 0,
    neutral: neuMatch ? parseInt(neuMatch[1]) : 0,
    negative: negMatch ? parseInt(negMatch[1]) : 0,
    joined: joinMatch ? joinMatch[1].trim() : null,
    source_url: url,
  };
  
  log(`  ✓ Discogs seller: ${result.positive} positive, ${result.negative} negative (joined ${result.joined})`);
  return result;
}

async function scrapeDiscogsLabel(labelId) {
  const url = `https://www.discogs.com/label/${labelId}`;
  log(`  Discogs label: ${url}`);
  const page = await fetchPage(url, 8000);
  if (!page) return null;
  
  const content = page.content;
  const releasesMatch = content.match(/Showing \d+-\d+ of (\d+)/);
  
  const result = {
    raw_content: content.slice(0, 5000),
    total_releases: releasesMatch ? parseInt(releasesMatch[1]) : null,
    source_url: url,
  };
  
  log(`  ✓ Discogs label: ${result.total_releases || '?'} releases`);
  return result;
}

async function scrapeWheree(slug) {
  const url = `https://${slug}.wheree.com/`;
  log(`  Wheree: ${url}`);
  const page = await fetchPage(url, 6000);
  if (!page || page.content.includes('not found') || page.content.length < 200) return null;
  
  log(`  ✓ Wheree: ${page.content.length} chars`);
  return { raw_content: page.content.slice(0, 5000), source_url: url };
}

async function scrapeChamberOfCommerce(shopName, city, state) {
  // This aggregates Google reviews
  const query = encodeURIComponent(`${shopName} ${city} ${state}`);
  const url = `https://www.chamberofcommerce.com/search?q=${query}&page=1`;
  log(`  ChamberOfCommerce (Google proxy): searching...`);
  
  // Search results page — just get the rating from meta
  // We already have this data from web_search, so skip browser fetch
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════════════

async function scrapeAllSources(shop) {
  const { id: shopId, name, city, state, slug, website, social_facebook, social_discogs } = shop;
  const results = {};
  
  log(`\n═══ Scraping reviews for: ${name} (${city}, ${state}) ═══`);
  
  // 1. Yelp
  try {
    results.yelp = await scrapeYelp(name, city, state);
  } catch (e) { log(`  ✗ Yelp error: ${e.message}`); }
  
  // 2. Facebook (record store page)
  if (social_facebook) {
    try {
      results.facebook = await scrapeFacebook(social_facebook);
    } catch (e) { log(`  ✗ Facebook error: ${e.message}`); }
  }
  
  // 3. Discogs
  if (social_discogs) {
    const labelMatch = social_discogs.match(/discogs\.com\/label\/(\d+)/);
    if (labelMatch) {
      try {
        results.discogs_label = await scrapeDiscogsLabel(labelMatch[1]);
      } catch (e) { log(`  ✗ Discogs label error: ${e.message}`); }
    }
    
    const sellerMatch = social_discogs.match(/discogs\.com\/(?:seller|user)\/([^\/\?]+)/);
    if (sellerMatch) {
      try {
        results.discogs_seller = await scrapeDiscogsSeller(sellerMatch[1]);
      } catch (e) { log(`  ✗ Discogs seller error: ${e.message}`); }
    }
  }
  
  // Also try common seller name patterns (slug-based)
  if (!results.discogs_seller) {
    const sellerSlug = slug?.replace(/-/g, '') || name.toLowerCase().replace(/[^a-z0-9]/g, '');
    try {
      results.discogs_seller = await scrapeDiscogsSeller(sellerSlug);
    } catch (e) { /* silently skip */ }
    if (!results.discogs_seller) {
      // Try "gethip" style
      const shortSlug = name.toLowerCase().replace(/\s+records?$/i, '').replace(/[^a-z0-9]/g, '');
      if (shortSlug !== sellerSlug) {
        try {
          results.discogs_seller = await scrapeDiscogsSeller(shortSlug);
        } catch (e) { /* silently skip */ }
      }
    }
  }
  
  // 4. Wheree
  try {
    const whereeSlug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/g, '');
    results.wheree = await scrapeWheree(whereeSlug);
  } catch (e) { log(`  ✗ Wheree error: ${e.message}`); }
  
  // Save results
  const outPath = contentDir(shopId, 'reviews', 'scraped_sources.json');
  results.scraped_at = new Date().toISOString();
  saveJSON(outPath, results);
  log(`\n✓ Saved scraped sources to ${outPath}`);
  
  return results;
}

async function run() {
  const args = parseArgs();
  const shopId = args['shop-id'];
  const sourcesFilter = args.sources ? args.sources.split(',') : null;
  
  if (!shopId) {
    log('Usage: node scrape_reviews_multi.js --shop-id "uuid"');
    process.exit(1);
  }
  
  const { data: shop } = await supabase.from('shops')
    .select('id, name, city, state, slug, website, social_facebook, social_discogs')
    .eq('id', shopId).single();
  
  if (!shop) { log('Shop not found'); process.exit(1); }
  
  try {
    await scrapeAllSources(shop);
  } finally {
    await closeBrowser();
  }
}

run().catch(e => { console.error(e); process.exit(1); });
