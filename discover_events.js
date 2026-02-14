#!/usr/bin/env node
/**
 * Event Discovery — Finds events for record shops via web search & website scraping
 * 
 * Usage:
 *   node discover_events.js --shop "Shady Dog" --city "Berwyn" --state "PA"
 *   node discover_events.js --shop-id "uuid"
 *   node discover_events.js --all --limit 10
 */

const { delay, saveJSON, contentDir, getAllShops, getShopByName,
  createStealthBrowser, ollamaSummarize, parseArgs, log } = require('./lib/common');
const cheerio = require('cheerio');

async function searchForEvents(page, shopName, city, state) {
  const events = [];
  const queries = [
    `${shopName} ${city} ${state} events`,
    `${shopName} ${city} in-store performance`,
    `${shopName} record store day`,
  ];

  for (const query of queries) {
    try {
      const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
      log(`  Searching: ${query}`);
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await delay(2000, 4000);

      const results = await page.evaluate(() => {
        const items = [];
        // Extract search result snippets that mention events
        const resultEls = document.querySelectorAll('.g, [data-sokoban-container]');
        resultEls.forEach(el => {
          const titleEl = el.querySelector('h3');
          const snippetEl = el.querySelector('.VwiC3b, [data-content-feature="1"]');
          const linkEl = el.querySelector('a');
          
          const title = titleEl?.textContent?.trim();
          const snippet = snippetEl?.textContent?.trim();
          const url = linkEl?.href;

          if (title && snippet) {
            const isEventRelated = /event|concert|perform|live|show|rsd|record store day|signing|meet|greet|dj set|listening party/i.test(title + ' ' + snippet);
            if (isEventRelated) {
              items.push({ title, snippet, url, source: 'google_search' });
            }
          }
        });
        return items;
      });

      events.push(...results);
    } catch (e) {
      log(`    Search error: ${e.message}`);
    }
    await delay(2000, 4000);
  }

  return events;
}

async function scrapeEventsPage(page, url) {
  try {
    log(`  Checking events page: ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await delay(1500, 2500);

    const content = await page.content();
    const $ = cheerio.load(content);
    $('script, style, nav, footer, header').remove();
    
    const text = $('main, article, .content, #content, body').text()
      .replace(/\s+/g, ' ').trim().slice(0, 8000);

    if (text.length < 50) return [];

    // Use Ollama to extract events
    const prompt = `Extract any upcoming events from this record shop's events page. Return as JSON array:
[{"event_type": "type", "title": "name", "date": "date if found", "description": "brief description", "artists": ["artist names"]}]

If no events found, return [].

PAGE CONTENT:
${text.slice(0, 6000)}`;

    const result = await ollamaSummarize(prompt);
    const jsonMatch = result.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return parsed.map(e => ({ ...e, source: 'website', sourceUrl: url }));
    }
  } catch (e) {
    log(`    Events page error: ${e.message}`);
  }
  return [];
}

async function discoverEventsForShop(page, shop) {
  log(`\n═══ ${shop.name} (${shop.city}, ${shop.state}) ═══`);
  
  const allEvents = [];

  // 1. Search Google for events
  const searchEvents = await searchForEvents(page, shop.name, shop.city, shop.state);
  allEvents.push(...searchEvents);
  log(`  Found ${searchEvents.length} event mentions from search`);

  // 2. Check the shop's website for events pages
  if (shop.website && !shop.website.includes('yelp.com')) {
    const eventPaths = ['/events', '/events/', '/calendar', '/shows', '/in-store', '/happenings'];
    for (const p of eventPaths) {
      try {
        const url = new URL(p, shop.website).href;
        const events = await scrapeEventsPage(page, url);
        allEvents.push(...events);
        if (events.length > 0) {
          log(`  Found ${events.length} events from ${p}`);
          break; // Found events page, don't check more paths
        }
      } catch (e) {}
      await delay(1000, 2000);
    }
  }

  // 3. Deduplicate by title
  const seen = new Set();
  const unique = allEvents.filter(e => {
    const key = (e.title || e.snippet || '').toLowerCase().slice(0, 50);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    shopName: shop.name,
    shopId: shop.id,
    city: shop.city,
    state: shop.state,
    events: unique,
    totalFound: unique.length,
    scrapedAt: new Date().toISOString(),
  };
}

async function run() {
  const args = parseArgs();
  const { browser, context } = await createStealthBrowser();

  try {
    const page = await context.newPage();

    if (args.shop && args.city && args.state) {
      const shops = await getShopByName(args.shop, args.city, args.state);
      if (!shops || shops.length === 0) { log('Shop not found in Supabase'); return; }
      
      const result = await discoverEventsForShop(page, shops[0]);
      const outPath = contentDir(shops[0].id, 'events', 'upcoming.json');
      saveJSON(outPath, result);
      log(`\nSaved ${result.totalFound} events to ${outPath}`);
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (args['shop-id']) {
      const { supabase } = require('./lib/common');
      const { data: shop } = await supabase.from('shops').select('*').eq('id', args['shop-id']).single();
      if (!shop) { log('Shop not found'); return; }
      
      const result = await discoverEventsForShop(page, shop);
      const outPath = contentDir(shop.id, 'events', 'upcoming.json');
      saveJSON(outPath, result);
      log(`Saved to ${outPath}`);
      return;
    }

    if (args.all) {
      const limit = parseInt(args.limit) || 10;
      const shops = await getAllShops(limit);
      let processed = 0, totalEvents = 0;

      for (const shop of shops) {
        if (!shop.city || !shop.state) continue;

        try {
          const result = await discoverEventsForShop(page, shop);
          const outPath = contentDir(shop.id, 'events', 'upcoming.json');
          saveJSON(outPath, result);
          
          processed++;
          totalEvents += result.totalFound;
          log(`✓ [${processed}] ${shop.name} — ${result.totalFound} events`);
          await delay(3000, 5000);
        } catch (e) {
          log(`✗ ${shop.name}: ${e.message}`);
        }
      }

      log(`\nDone. Processed ${processed} shops, found ${totalEvents} total events.`);
    }

  } finally {
    await browser.close();
  }
}

run().catch(e => { console.error(e); process.exit(1); });
