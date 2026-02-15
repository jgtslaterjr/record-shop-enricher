#!/usr/bin/env node
/**
 * Google Discovery — Step 0 of the deep scrape pipeline
 * 
 * Searches Google for "[shop name] [city]" and categorizes all discovered links:
 * yelp, google_maps, facebook, instagram, tiktok, tripadvisor, website, directory, press
 * 
 * Supersedes discover_socials.js with comprehensive link discovery.
 * 
 * Usage:
 *   node discover_links.js --shop-id "uuid"
 *   node discover_links.js --shop "Main Street Music" --city "Philadelphia" --state "PA"
 *   node discover_links.js --all --limit 10
 *   node discover_links.js --force                # overwrite existing values
 */

const { supabase, delay, getShopByName, getAllShops, updateShop, saveJSON, contentDir, parseArgs, log, randomUA } = require('./lib/common');
const https = require('https');
const path = require('path');

// ── Google Search ──────────────────────────────────────────

function webSearch(query) {
  return new Promise((resolve, reject) => {
    const postData = `q=${encodeURIComponent(query)}`;
    const options = {
      hostname: 'html.duckduckgo.com',
      path: '/html/',
      method: 'POST',
      headers: {
        'User-Agent': randomUA(),
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
      }
    };
    const req = https.request(options, (res) => {
      if (res.statusCode === 429 || res.statusCode === 202) {
        resolve({ html: '', blocked: true });
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ html: data, blocked: false }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// ── URL Extraction ─────────────────────────────────────────

function extractAllURLs(html) {
  const urls = new Set();
  const patterns = [
    /uddg=(https?[^&"]+)/g,         // DuckDuckGo redirect URLs
    /href="(https?:\/\/[^"]+)"/g,
    /url\?q=(https?:\/\/[^&"]+)/g,  // Google redirect URLs
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(html)) !== null) {
      try {
        const decoded = decodeURIComponent(match[1]);
        urls.add(decoded);
      } catch {
        urls.add(match[1]);
      }
    }
  }
  return [...urls];
}

// ── Link Categorization ───────────────────────────────────

const SKIP_DOMAINS = [
  'google.com/search', 'google.com/preferences', 'google.com/advanced_search',
  'google.com/webhp', 'google.com/intl', 'google.com/policies',
  'accounts.google.com', 'support.google.com', 'play.google.com',
  'wikipedia.org', 'wikimedia.org', 'wiktionary.org',
  'youtube.com/results', 'schema.org',
];

const INSTAGRAM_SKIP = [
  'explore', 'p', 'reel', 'reels', 'stories', 'accounts', 'about',
  'directory', 'developer', 'legal', 'privacy', 'terms', 'tags', 'locations',
];

const FACEBOOK_SKIP = [
  'sharer', 'share', 'login', 'help', 'pages', 'groups', 'events',
  'marketplace', 'watch', 'gaming', 'bookmarks', 'ads', 'privacy',
  'policies', 'settings', 'photo', 'photos',
];

const DIRECTORY_DOMAINS = [
  'recordstores.love', 'vinylhub.discogs.com', 'recordshopmap.com',
  'yellowpages.com', 'bbb.org', 'mapquest.com', 'chamberofcommerce.com',
  'manta.com', 'hotfrog.com', 'brownbook.net', 'foursquare.com',
  'justdial.com', 'superpages.com', 'citysearch.com',
  'vinylmapper.com', 'vinylworld.org', 'vinylpackman.com', 'loc8nearme.com',
  'recordshopsnearme.com', 'recordstoreday.com',
];

const PRESS_DOMAINS = [
  'sofaburn.com', 'patch.com', 'phillymag.com', 'inquirer.com',
  'nytimes.com', 'washingtonpost.com', 'rollingstone.com',
  'pitchfork.com', 'stereogum.com', 'brooklynvegan.com',
  'timeout.com', 'eater.com', 'thrillist.com', 'atlasobscura.com',
  'wmmr.com', 'sjuhawknews.com', 'philadelphiaweekly.com', 'billypenn.com',
];

function categorizeURL(url) {
  const lower = url.toLowerCase();
  
  // Skip generic/noise URLs
  for (const skip of SKIP_DOMAINS) {
    if (lower.includes(skip)) return null;
  }

  // Yelp
  if (lower.includes('yelp.com/biz/')) {
    return { category: 'yelp', url };
  }

  // Google Maps
  if (lower.includes('google.com/maps') || lower.includes('maps.google.com') || lower.includes('goo.gl/maps')) {
    return { category: 'google_maps', url };
  }

  // Instagram
  if (lower.includes('instagram.com/')) {
    const m = lower.match(/instagram\.com\/([a-zA-Z0-9._]{2,30})/);
    if (m && !INSTAGRAM_SKIP.includes(m[1].toLowerCase())) {
      return { category: 'instagram', url, handle: m[1].toLowerCase() };
    }
    return null;
  }

  // Facebook
  if (lower.includes('facebook.com/')) {
    const m = lower.match(/facebook\.com\/([a-zA-Z0-9.]{2,50})/);
    if (m && !FACEBOOK_SKIP.includes(m[1].toLowerCase())) {
      return { category: 'facebook', url: `https://facebook.com/${m[1]}` };
    }
    return null;
  }

  // TikTok
  if (lower.includes('tiktok.com/@')) {
    const m = lower.match(/tiktok\.com\/@([a-zA-Z0-9._]{2,30})/);
    if (m) {
      return { category: 'tiktok', url: `https://tiktok.com/@${m[1]}`, handle: m[1] };
    }
    return null;
  }

  // TripAdvisor
  if (lower.includes('tripadvisor.com/')) {
    return { category: 'tripadvisor', url };
  }

  // Directories
  for (const domain of DIRECTORY_DOMAINS) {
    if (lower.includes(domain)) {
      return { category: 'directory', url, domain };
    }
  }

  // Press
  for (const domain of PRESS_DOMAINS) {
    if (lower.includes(domain)) {
      return { category: 'press', url, domain };
    }
  }

  // Potential website (not a known platform)
  if (lower.startsWith('http') && !lower.includes('google.') && !lower.includes('youtube.com')
      && !lower.includes('twitter.com') && !lower.includes('x.com') && !lower.includes('reddit.com')
      && !lower.includes('pinterest.com') && !lower.includes('linkedin.com')
      && !lower.includes('apple.com') && !lower.includes('spotify.com')
      && !lower.includes('yelp.com') && !lower.includes('facebook.com')
      && !lower.includes('instagram.com') && !lower.includes('tiktok.com')
      && !lower.includes('tripadvisor.com') && !lower.includes('amazonaws.com')
      && !lower.includes('cloudfront.net') && !lower.includes('gstatic.com')) {
    // Check if it looks like a press/blog by checking known patterns
    if (lower.match(/\.(com|net|org|co|shop|store|music|records|vinyl)\//)) {
      return { category: 'website', url };
    }
  }

  return null;
}

// ── Main Discovery Function ───────────────────────────────

async function discoverLinks(shop, { force = false } = {}) {
  log(`\n🔍 Google Discovery for: ${shop.name} (${shop.city}, ${shop.state})`);

  const allLinks = [];
  const queries = [
    `${shop.name} ${shop.city} ${shop.state} record store`,
    `${shop.name} ${shop.city} instagram facebook`,
  ];

  for (const query of queries) {
    log(`  📎 Searching: "${query}"`);
    try {
      const { html, blocked } = await webSearch(query);
      if (blocked) {
        log('  ⚠ Google returned 429 (rate limited), skipping query');
        continue;
      }
      if (html.includes('unusual traffic') || html.includes('captcha')) {
        log('  ⚠ Google captcha detected, skipping query');
        continue;
      }
      const urls = extractAllURLs(html);
      log(`  Found ${urls.length} raw URLs`);
      
      for (const url of urls) {
        const cat = categorizeURL(url);
        if (cat) {
          // Deduplicate by category+url
          if (!allLinks.find(l => l.category === cat.category && l.url === cat.url)) {
            allLinks.push(cat);
          }
        }
      }
    } catch (e) {
      log(`  ⚠ Search failed: ${e.message}`);
    }
    await delay(1500, 2500);
  }

  // ── Summarize findings ──
  const byCategory = {};
  for (const link of allLinks) {
    if (!byCategory[link.category]) byCategory[link.category] = [];
    byCategory[link.category].push(link);
  }

  log(`\n  📋 Discovery Results:`);
  for (const [cat, links] of Object.entries(byCategory)) {
    for (const link of links) {
      log(`    [${cat}] ${link.handle ? '@' + link.handle + ' — ' : ''}${link.url}`);
    }
  }

  // ── Build updates ──
  const updates = {};
  const skipped = {};

  function setField(field, value) {
    const current = shop[field];
    if (force || !current || current === '') {
      updates[field] = value;
    } else {
      skipped[field] = { current, discovered: value };
    }
  }

  // Yelp
  if (byCategory.yelp && byCategory.yelp.length > 0) {
    setField('yelp_url', byCategory.yelp[0].url);
  }

  // Google Maps
  if (byCategory.google_maps && byCategory.google_maps.length > 0) {
    setField('google_maps_url', byCategory.google_maps[0].url);
  }

  // Instagram
  if (byCategory.instagram && byCategory.instagram.length > 0) {
    setField('social_instagram', byCategory.instagram[0].handle);
  }

  // Facebook
  if (byCategory.facebook && byCategory.facebook.length > 0) {
    setField('social_facebook', byCategory.facebook[0].url);
  }

  // TikTok
  if (byCategory.tiktok && byCategory.tiktok.length > 0) {
    setField('social_tiktok', `https://tiktok.com/@${byCategory.tiktok[0].handle}`);
  }

  // Website — prefer shop's own domain over platform pages
  if (byCategory.website && byCategory.website.length > 0) {
    const currentWebsite = shop.website || '';
    const isPlatformWebsite = currentWebsite.includes('yelp.com') || currentWebsite.includes('facebook.com')
      || currentWebsite.includes('google.com') || currentWebsite.includes('instagram.com') || currentWebsite === '';
    
    if (force || isPlatformWebsite) {
      // Pick the first website URL that looks like the shop's own domain
      const candidate = byCategory.website[0].url;
      if (isPlatformWebsite || force) {
        updates.website = candidate;
      }
    }
  }

  // ── Save discovery report ──
  if (shop.id && shop.id !== 'manual') {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const report = {
      shop: { id: shop.id, name: shop.name, city: shop.city, state: shop.state },
      queries,
      discoveredAt: new Date().toISOString(),
      links: allLinks,
      byCategory,
      updates,
      skipped,
    };
    const reportPath = contentDir(shop.id, 'discovery', `google_discovery_${timestamp}.json`);
    saveJSON(reportPath, report);
    log(`  💾 Report saved: ${reportPath}`);
  }

  // ── Apply updates ──
  if (shop.id && shop.id !== 'manual' && Object.keys(updates).length > 0) {
    log(`\n  📝 Updating ${Object.keys(updates).length} field(s):`);
    for (const [field, value] of Object.entries(updates)) {
      log(`    ${field}: ${value}`);
    }
    await updateShop(shop.id, updates);
    log('  ✅ Database updated');
  } else if (Object.keys(updates).length === 0) {
    log('\n  ℹ No new fields to update');
  }

  if (Object.keys(skipped).length > 0) {
    log(`  ⏭ Skipped ${Object.keys(skipped).length} field(s) (already set, use --force to overwrite):`);
    for (const [field, info] of Object.entries(skipped)) {
      log(`    ${field}: keeping "${info.current}" (found "${info.discovered}")`);
    }
  }

  return { links: allLinks, updates, skipped, byCategory };
}

// ── Resolve shop from CLI args ────────────────────────────

async function resolveShop(args) {
  if (args['shop-id']) {
    const { data, error } = await supabase.from('shops').select('*').eq('id', args['shop-id']).single();
    if (error || !data) { log(`❌ Shop not found: ${args['shop-id']}`); process.exit(1); }
    return data;
  }
  if (args.shop && args.city && args.state) {
    const shops = await getShopByName(args.shop, args.city, args.state);
    if (shops.length === 0) { log(`❌ Shop not found`); process.exit(1); }
    return shops[0];
  }
  return null;
}

// ── CLI Entry Point ───────────────────────────────────────

async function main() {
  const args = parseArgs();
  const force = !!args.force;

  if (args.all) {
    const limit = parseInt(args.limit) || 10;
    const shops = await getAllShops(limit);
    log(`\n🔍 Batch discovery for ${shops.length} shops`);

    let updated = 0;
    for (let i = 0; i < shops.length; i++) {
      const shop = shops[i];
      log(`\n[${ i + 1}/${shops.length}] ${shop.name} (${shop.city}, ${shop.state})`);
      try {
        const result = await discoverLinks(shop, { force });
        if (Object.keys(result.updates).length > 0) updated++;
      } catch (e) {
        log(`  ❌ Error: ${e.message}`);
      }
      if (i < shops.length - 1) await delay(2000, 4000);
    }

    log(`\n✅ Batch complete: ${updated}/${shops.length} shops updated`);
    return;
  }

  const shop = await resolveShop(args);
  if (!shop) {
    console.log('\nUsage:');
    console.log('  node discover_links.js --shop-id "uuid"');
    console.log('  node discover_links.js --shop "Name" --city "City" --state "ST"');
    console.log('  node discover_links.js --all --limit 10');
    console.log('  node discover_links.js --force   # overwrite existing values');
    process.exit(0);
  }

  await discoverLinks(shop, { force });
}

module.exports = { discoverLinks };

if (require.main === module) {
  main().catch(e => { console.error('❌ Fatal:', e.message); process.exit(1); });
}
