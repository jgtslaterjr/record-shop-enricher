#!/usr/bin/env node
/**
 * Social Handle Discovery
 * 
 * Searches Google for missing social media handles (Instagram, Facebook, TikTok)
 * and updates the shop in Supabase.
 * 
 * Usage:
 *   node discover_socials.js --shop-id "uuid"
 *   node discover_socials.js --shop "Main Street Music" --city "Philadelphia" --state "PA"
 */

const { supabase, delay, getShopByName, updateShop, parseArgs, log } = require('./lib/common');
const https = require('https');

function webSearch(query) {
  return new Promise((resolve, reject) => {
    const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=5`;
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
      res.on('error', reject);
    });
    req.on('error', reject);
  });
}

function extractInstagram(html, shopName) {
  // Look for Instagram URLs in search results
  const patterns = [
    /instagram\.com\/([a-zA-Z0-9._]{2,30})/g,
  ];
  const handles = new Set();
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(html)) !== null) {
      const handle = match[1].toLowerCase();
      // Filter out generic/unrelated handles
      if (['explore', 'p', 'reel', 'stories', 'accounts', 'about', 'directory', 'developer', 'legal', 'privacy', 'terms'].includes(handle)) continue;
      if (handle.startsWith('_')) continue;
      handles.add(handle);
    }
  }
  return [...handles];
}

function extractFacebook(html) {
  const patterns = [
    /facebook\.com\/([a-zA-Z0-9.]{2,50})/g,
  ];
  const pages = new Set();
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(html)) !== null) {
      const page = match[1];
      if (['sharer', 'share', 'login', 'help', 'pages', 'groups', 'events', 'marketplace', 'watch', 'gaming', 'bookmarks', 'ads', 'privacy', 'policies'].includes(page.toLowerCase())) continue;
      pages.add(page);
    }
  }
  return [...pages];
}

function extractTiktok(html) {
  const patterns = [
    /tiktok\.com\/@([a-zA-Z0-9._]{2,30})/g,
  ];
  const handles = new Set();
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(html)) !== null) {
      handles.add(match[1]);
    }
  }
  return [...handles];
}

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

async function discoverSocials(shop) {
  log(`\n🔍 Discovering social handles for: ${shop.name} (${shop.city}, ${shop.state})`);
  
  const updates = {};
  const searchName = `${shop.name} ${shop.city} ${shop.state}`;
  
  // Discover Instagram
  if (!shop.social_instagram) {
    log('  Searching for Instagram...');
    try {
      const html = await webSearch(`instagram ${searchName} record store`);
      const handles = extractInstagram(html, shop.name);
      if (handles.length > 0) {
        log(`  Found Instagram candidates: ${handles.map(h => '@' + h).join(', ')}`);
        // Take the first (most relevant) result
        updates.social_instagram = handles[0];
        log(`  ✅ Setting Instagram: @${handles[0]}`);
      } else {
        log('  No Instagram found');
      }
      await delay(1000, 2000);
    } catch (e) {
      log(`  ⚠ Instagram search failed: ${e.message}`);
    }
  } else {
    log(`  Instagram already set: @${shop.social_instagram}`);
  }
  
  // Discover Facebook
  if (!shop.social_facebook) {
    log('  Searching for Facebook...');
    try {
      const html = await webSearch(`facebook ${searchName}`);
      const pages = extractFacebook(html);
      if (pages.length > 0) {
        log(`  Found Facebook candidates: ${pages.join(', ')}`);
        updates.social_facebook = `https://facebook.com/${pages[0]}`;
        log(`  ✅ Setting Facebook: ${updates.social_facebook}`);
      } else {
        log('  No Facebook found');
      }
      await delay(1000, 2000);
    } catch (e) {
      log(`  ⚠ Facebook search failed: ${e.message}`);
    }
  } else {
    log(`  Facebook already set: ${shop.social_facebook}`);
  }
  
  // Discover TikTok
  if (!shop.social_tiktok) {
    log('  Searching for TikTok...');
    try {
      const html = await webSearch(`tiktok ${searchName}`);
      const handles = extractTiktok(html);
      if (handles.length > 0) {
        log(`  Found TikTok candidates: ${handles.map(h => '@' + h).join(', ')}`);
        updates.social_tiktok = `https://tiktok.com/@${handles[0]}`;
        log(`  ✅ Setting TikTok: ${updates.social_tiktok}`);
      } else {
        log('  No TikTok found');
      }
      await delay(1000, 2000);
    } catch (e) {
      log(`  ⚠ TikTok search failed: ${e.message}`);
    }
  } else {
    log(`  TikTok already set: ${shop.social_tiktok}`);
  }
  
  // Apply updates
  if (Object.keys(updates).length > 0) {
    log(`\n  Updating ${Object.keys(updates).length} social handle(s) in database...`);
    await updateShop(shop.id, updates);
    log('  ✅ Database updated');
  } else {
    log('\n  No new handles discovered');
  }
  
  return updates;
}

async function main() {
  const args = parseArgs();
  const shop = await resolveShop(args);
  
  if (!shop) {
    console.log('\nUsage:');
    console.log('  node discover_socials.js --shop-id "uuid"');
    console.log('  node discover_socials.js --shop "Name" --city "City" --state "ST"');
    process.exit(0);
  }
  
  await discoverSocials(shop);
}

module.exports = { discoverSocials };
main().catch(e => { console.error('❌ Fatal:', e.message); process.exit(1); });
