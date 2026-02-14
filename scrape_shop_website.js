#!/usr/bin/env node
/**
 * Deep Website Crawler — Crawls shop websites and summarizes with Ollama
 * 
 * Usage:
 *   node scrape_shop_website.js --url "https://example.com" --shop-id "uuid"
 *   node scrape_shop_website.js --all --limit 10
 */

const { delay, saveJSON, contentDir, getAllShops, updateShop,
  createStealthBrowser, ollamaSummarize, parseArgs, log } = require('./lib/common');
const cheerio = require('cheerio');
const { URL } = require('url');

const MAX_PAGES = 20;
const INTERESTING_PATHS = [
  '/', '/about', '/about-us', '/about-us/', '/our-story',
  '/events', '/events/', '/calendar', '/shows', '/in-store',
  '/contact', '/contact-us', '/hours', '/location', '/visit',
  '/blog', '/news', '/press',
  '/shop', '/store', '/catalog', '/new-arrivals',
  '/services', '/sell', '/buy', '/trade',
  '/staff', '/team', '/people',
  '/faq', '/info',
];

async function crawlWebsite(page, baseUrl, shopName) {
  const base = new URL(baseUrl);
  const visited = new Set();
  const pages = [];

  // Build priority URL list
  const urlsToCrawl = [];
  
  // Add interesting paths
  for (const p of INTERESTING_PATHS) {
    urlsToCrawl.push(new URL(p, base).href);
  }
  // Add the homepage at the front
  urlsToCrawl.unshift(baseUrl);

  for (const url of urlsToCrawl) {
    if (visited.size >= MAX_PAGES) break;
    const normalized = url.split('#')[0].split('?')[0].replace(/\/$/, '');
    if (visited.has(normalized)) continue;
    
    // Must be same domain
    try {
      const u = new URL(url);
      if (u.hostname !== base.hostname) continue;
    } catch { continue; }

    visited.add(normalized);

    try {
      log(`  Crawling: ${normalized}`);
      const response = await page.goto(normalized, { waitUntil: 'domcontentloaded', timeout: 15000 });
      if (!response || response.status() >= 400) continue;
      
      await delay(500, 1500);

      const content = await page.content();
      const $ = cheerio.load(content);

      // Remove scripts, styles, nav, footer
      $('script, style, nav, footer, header, iframe, noscript').remove();

      const title = $('title').text().trim();
      const h1 = $('h1').first().text().trim();
      const bodyText = $('main, article, .content, #content, .main, [role="main"]').text().trim() 
        || $('body').text().trim();
      
      // Clean up whitespace
      const cleanText = bodyText.replace(/\s+/g, ' ').trim().slice(0, 10000);

      // Extract structured data
      const structuredData = [];
      $('script[type="application/ld+json"]').each((_, el) => {
        try { structuredData.push(JSON.parse($(el).html())); } catch {}
      });

      // Extract emails and phones
      const emailMatches = content.match(/[\w.-]+@[\w.-]+\.\w{2,}/g) || [];
      const phoneMatches = content.match(/\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g) || [];

      // Discover more links on this page
      $('a[href]').each((_, el) => {
        const href = $(el).attr('href');
        if (!href) return;
        try {
          const full = new URL(href, normalized).href;
          if (new URL(full).hostname === base.hostname && !visited.has(full.split('#')[0].split('?')[0].replace(/\/$/, ''))) {
            urlsToCrawl.push(full);
          }
        } catch {}
      });

      // Classify page type
      const pathLower = new URL(normalized).pathname.toLowerCase();
      let pageType = 'general';
      if (pathLower === '/' || pathLower === '') pageType = 'homepage';
      else if (/about|story|history/.test(pathLower)) pageType = 'about';
      else if (/event|calendar|show|perform/.test(pathLower)) pageType = 'events';
      else if (/contact|location|visit|hour/.test(pathLower)) pageType = 'contact';
      else if (/blog|news|press/.test(pathLower)) pageType = 'blog';
      else if (/shop|store|catalog|product|new-arrival/.test(pathLower)) pageType = 'shop';
      else if (/staff|team|people/.test(pathLower)) pageType = 'staff';
      else if (/service|sell|buy|trade/.test(pathLower)) pageType = 'services';
      else if (/faq|info/.test(pathLower)) pageType = 'faq';

      pages.push({
        url: normalized,
        title,
        h1,
        pageType,
        textLength: cleanText.length,
        text: cleanText,
        emails: [...new Set(emailMatches)],
        phones: [...new Set(phoneMatches)],
        structuredData: structuredData.length > 0 ? structuredData : undefined,
      });

    } catch (e) {
      log(`    Error: ${e.message}`);
    }
  }

  return pages;
}

async function summarizeWithOllama(pages, shopName) {
  log(`  Summarizing ${pages.length} pages with Ollama...`);
  
  // Build context from all pages
  const context = pages.map(p => {
    return `=== ${p.pageType.toUpperCase()}: ${p.title || p.url} ===\n${p.text.slice(0, 3000)}`;
  }).join('\n\n');

  const prompt = `You are analyzing the website of "${shopName}", a record shop. Based on the following website content, extract and summarize:

1. **Overview**: What kind of shop is this? What's their vibe/brand?
2. **History**: When were they founded? Any notable history?
3. **Inventory Focus**: What formats (vinyl, CD, cassette)? Genres? New vs used?
4. **Services**: Do they buy/sell/trade? Online store? Shipping?
5. **Events**: Do they host events? What kind? How often?
6. **Staff**: Any notable staff/owner info?
7. **Hours & Location**: Store hours, address details
8. **Unique Features**: What makes them special? Listening rooms, cafe, etc.
9. **Community Role**: How do they engage with local music scene?

Be concise but thorough. Output as JSON with these keys: overview, history, inventory_focus, services, events, staff, hours_location, unique_features, community_role

WEBSITE CONTENT:
${context.slice(0, 12000)}`;

  try {
    const result = await ollamaSummarize(prompt);
    // Try to parse as JSON
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return { raw_summary: result };
  } catch (e) {
    log(`    Ollama summarization failed: ${e.message}`);
    return { error: e.message };
  }
}

async function run() {
  const args = parseArgs();
  const { browser, context } = await createStealthBrowser();

  try {
    const page = await context.newPage();

    if (args.url && args['shop-id']) {
      const pages = await crawlWebsite(page, args.url, args['shop-name'] || 'Record Shop');
      const summary = await summarizeWithOllama(pages, args['shop-name'] || 'Record Shop');
      
      const date = new Date().toISOString().split('T')[0];
      const crawlDir = contentDir(args['shop-id'], 'web', `crawl_${date}`);
      saveJSON(`${crawlDir}/pages.json`, pages);
      saveJSON(`${crawlDir}/summary.json`, summary);
      log(`Saved ${pages.length} pages + summary to ${crawlDir}`);
      return;
    }

    if (args.all) {
      const limit = parseInt(args.limit) || 10;
      const shops = await getAllShops(limit);
      let processed = 0;

      for (const shop of shops) {
        if (!shop.website || shop.website.includes('yelp.com') || shop.website.includes('facebook.com')) {
          log(`Skipping ${shop.name} — no real website`);
          continue;
        }

        try {
          log(`\n═══ ${shop.name} — ${shop.website} ═══`);
          const pages = await crawlWebsite(page, shop.website, shop.name);
          
          if (pages.length === 0) {
            log(`  No pages crawled, skipping`);
            continue;
          }

          const summary = await summarizeWithOllama(pages, shop.name);
          
          const date = new Date().toISOString().split('T')[0];
          const crawlDir = contentDir(shop.id, 'web', `crawl_${date}`);
          saveJSON(`${crawlDir}/pages.json`, pages);
          saveJSON(`${crawlDir}/summary.json`, summary);

          // Update Supabase with long description
          if (summary.overview) {
            await updateShop(shop.id, {
              long_description: summary.overview,
              enrichment_status: 'deep_enriched',
              date_of_enrichment: new Date().toISOString(),
            });
          }

          processed++;
          log(`✓ [${processed}] ${shop.name} — ${pages.length} pages crawled`);
          await delay(2000, 4000);
        } catch (e) {
          log(`✗ ${shop.name}: ${e.message}`);
        }
      }

      log(`\nDone. Processed ${processed} shops.`);
    }

  } finally {
    await browser.close();
  }
}

run().catch(e => { console.error(e); process.exit(1); });
