#!/usr/bin/env node
/**
 * Social Link Discovery via Brave Search API
 * 
 * Searches Brave for a shop's social media pages on Yelp, Facebook, Discogs, and Instagram.
 * Uses site:-scoped queries to find the best match for each platform.
 * 
 * Usage:
 *   node discover_socials_brave.js --shop-id "uuid"
 *   node discover_socials_brave.js --shop "Academy Records" --city "New York" --state "NY"
 *   node discover_socials_brave.js --batch          # Process all shops missing social links
 *   node discover_socials_brave.js --batch --limit 50
 *   node discover_socials_brave.js --dry-run --shop-id "uuid"   # Preview without updating DB
 */

require('dotenv').config();
const { supabase, delay, getShopByName, updateShop, parseArgs, log, extractFacebookPage } = require('./lib/common');

const BRAVE_KEY = process.env.BRAVE_KEY;
if (!BRAVE_KEY) {
  console.error('❌ BRAVE_KEY missing from environment. Add BRAVE_KEY=<token> to .env');
  process.exit(1);
}
const BRAVE_URL = 'https://api.search.brave.com/res/v1/web/search';

// Rate limiting: Brave free tier = 1 req/sec, 2000/month
const RATE_LIMIT_MS = 1200; // slightly over 1s to be safe

/**
 * Search Brave for a specific query
 */
async function braveSearch(query, count = 5) {
  const url = `${BRAVE_URL}?q=${encodeURIComponent(query)}&count=${count}`;
  const res = await fetch(url, {
    headers: {
      'Accept': 'application/json',
      'X-Subscription-Token': BRAVE_KEY,
    },
  });
  
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Brave API ${res.status}: ${text.slice(0, 200)}`);
  }
  
  const data = await res.json();
  return data.web?.results || [];
}

/**
 * Extract the best Yelp business URL from search results
 */
function pickYelpUrl(results, shopName, city) {
  const shopLower = shopName.toLowerCase();
  const cityLower = (city || '').toLowerCase();
  
  for (const r of results) {
    const url = r.url || '';
    // Must be a Yelp business page (not search, not generic)
    if (/yelp\.com\/biz\/[a-z0-9-]+/.test(url) && !url.includes('/search?')) {
      // Basic relevance: title or URL should contain part of shop name
      const titleLower = (r.title || '').toLowerCase();
      const urlLower = url.toLowerCase();
      const nameWords = shopLower.split(/\s+/).filter(w => w.length > 2);
      const hasNameMatch = nameWords.some(w => titleLower.includes(w) || urlLower.includes(w));
      const hasCityMatch = cityLower && (titleLower.includes(cityLower) || urlLower.includes(cityLower));
      
      if (hasNameMatch) return url;
    }
  }
  return null;
}

/**
 * Extract the best Facebook page URL from search results
 */
function pickFacebookUrl(results, shopName) {
  const shopLower = shopName.toLowerCase();
  
  for (const r of results) {
    const url = r.url || '';
    // Want facebook.com/<page> not facebook.com/search/ etc
    if (/facebook\.com\/[a-zA-Z0-9.]+\/?$/.test(url) || /facebook\.com\/[a-zA-Z0-9.]+\/?\?/.test(url)) {
      const page = extractFacebookPage(url);
      if (!page) continue;
      
      // Relevance check
      const titleLower = (r.title || '').toLowerCase();
      const nameWords = shopLower.split(/\s+/).filter(w => w.length > 2);
      const hasMatch = nameWords.some(w => titleLower.includes(w) || page.toLowerCase().includes(w));
      
      if (hasMatch) return `https://www.facebook.com/${page}`;
    }
  }
  return null;
}

/**
 * Extract the best Discogs store URL from search results
 */
function pickDiscogsUrl(results, shopName) {
  const shopLower = shopName.toLowerCase();
  
  for (const r of results) {
    const url = r.url || '';
    const titleLower = (r.title || '').toLowerCase();
    
    // Prefer discogs.com/record-stores/store/ URLs
    if (url.includes('discogs.com/record-stores/store/')) {
      return url;
    }
    // Also accept seller profiles
    if (url.includes('discogs.com/seller/') || url.includes('discogs.com/user/')) {
      const nameWords = shopLower.split(/\s+/).filter(w => w.length > 2);
      const hasMatch = nameWords.some(w => titleLower.includes(w) || url.toLowerCase().includes(w));
      if (hasMatch) return url;
    }
  }
  return null;
}

/**
 * Extract the best Instagram profile URL from search results
 */
function pickInstagramUrl(results, shopName) {
  const shopLower = shopName.toLowerCase();
  
  for (const r of results) {
    const url = r.url || '';
    // Must be a profile page: instagram.com/<handle>/ (not /p/, /reel/, etc)
    const match = url.match(/instagram\.com\/([a-zA-Z0-9._]+)\/?$/);
    if (!match) continue;
    
    const handle = match[1].toLowerCase();
    const blocked = ['explore', 'p', 'reel', 'reels', 'stories', 'accounts', 'about', 'directory', 'developer', 'legal', 'privacy', 'terms', 'tags'];
    if (blocked.includes(handle)) continue;
    
    // Relevance check
    const titleLower = (r.title || '').toLowerCase();
    const nameWords = shopLower.split(/\s+/).filter(w => w.length > 2);
    const hasMatch = nameWords.some(w => titleLower.includes(w) || handle.includes(w));
    
    if (hasMatch) return handle; // Return just the handle for social_instagram field
  }
  return null;
}

/**
 * Discover all social links for a single shop
 */
async function discoverSocialsBrave(shop, { dryRun = false } = {}) {
  const searchName = `"${shop.name}" "${shop.city}"`;
  const updates = {};
  const discovered = {};
  let queriesUsed = 0;
  
  log(`\n🔍 ${shop.name} (${shop.city}, ${shop.state})`);
  
  // Yelp
  if (!shop.yelp_url) {
    try {
      const results = await braveSearch(`${searchName} site:yelp.com`, 3);
      queriesUsed++;
      const url = pickYelpUrl(results, shop.name, shop.city);
      if (url) {
        updates.yelp_url = url;
        discovered.yelp = url;
        log(`  ✅ Yelp: ${url}`);
      } else {
        log(`  ⬜ Yelp: not found`);
      }
      await delay(RATE_LIMIT_MS);
    } catch (e) {
      log(`  ⚠️ Yelp search failed: ${e.message}`);
    }
  } else {
    log(`  ⏭️ Yelp: already set`);
  }
  
  // Facebook
  if (!shop.social_facebook) {
    try {
      const results = await braveSearch(`${searchName} site:facebook.com`, 3);
      queriesUsed++;
      const url = pickFacebookUrl(results, shop.name);
      if (url) {
        updates.social_facebook = url;
        discovered.facebook = url;
        log(`  ✅ Facebook: ${url}`);
      } else {
        log(`  ⬜ Facebook: not found`);
      }
      await delay(RATE_LIMIT_MS);
    } catch (e) {
      log(`  ⚠️ Facebook search failed: ${e.message}`);
    }
  } else {
    log(`  ⏭️ Facebook: already set`);
  }
  
  // Discogs
  if (shop.discogs_url) {
    log(`  ⏭️ Discogs: already set`);
  } else try {
    const results = await braveSearch(`${searchName} record store site:discogs.com`, 3);
    queriesUsed++;
    const url = pickDiscogsUrl(results, shop.name);
    if (url) {
      updates.discogs_url = url;
      discovered.discogs = url;
      log(`  ✅ Discogs: ${url}`);
    } else {
      log(`  ⬜ Discogs: not found`);
    }
    await delay(RATE_LIMIT_MS);
  } catch (e) {
    log(`  ⚠️ Discogs search failed: ${e.message}`);
  }
  
  // Instagram
  if (!shop.social_instagram) {
    try {
      const results = await braveSearch(`${searchName} record store site:instagram.com`, 3);
      queriesUsed++;
      const handle = pickInstagramUrl(results, shop.name);
      if (handle) {
        updates.social_instagram = handle;
        discovered.instagram = `@${handle}`;
        log(`  ✅ Instagram: @${handle}`);
      } else {
        log(`  ⬜ Instagram: not found`);
      }
      await delay(RATE_LIMIT_MS);
    } catch (e) {
      log(`  ⚠️ Instagram search failed: ${e.message}`);
    }
  } else {
    log(`  ⏭️ Instagram: already set`);
  }
  
  // Apply updates
  const updateCount = Object.keys(updates).length;
  const discoverCount = Object.keys(discovered).length;
  
  if (updateCount > 0 && !dryRun) {
    await updateShop(shop.id, updates);
    log(`  💾 Saved ${updateCount} field(s) to database`);
  } else if (updateCount > 0 && dryRun) {
    log(`  🔒 DRY RUN — would update ${updateCount} field(s): ${JSON.stringify(updates)}`);
  }
  
  return { discovered, updates, queriesUsed };
}

/**
 * Batch mode: find shops missing social links and enrich them
 */
async function batchDiscover({ limit = 50, dryRun = false } = {}) {
  log(`\n📦 Batch social discovery (limit: ${limit}, dryRun: ${dryRun})`);
  
  // Find shops missing at least one social link
  const { data: shops, error } = await supabase
    .from('shops')
    .select('id, name, city, state, yelp_url, social_facebook, social_instagram, social_tiktok, discogs_url, website')
    .or('yelp_url.is.null,social_facebook.is.null,social_instagram.is.null,discogs_url.is.null')
    .order('name')
    .limit(limit);
  
  if (error) {
    log(`❌ DB error: ${error.message}`);
    process.exit(1);
  }
  
  log(`  Found ${shops.length} shops missing social links\n`);
  
  let totalQueries = 0;
  let totalUpdated = 0;
  let totalDiscovered = { yelp: 0, facebook: 0, discogs: 0, instagram: 0 };
  
  for (let i = 0; i < shops.length; i++) {
    const shop = shops[i];
    log(`[${i + 1}/${shops.length}]`);
    
    const { discovered, updates, queriesUsed } = await discoverSocialsBrave(shop, { dryRun });
    totalQueries += queriesUsed;
    
    if (Object.keys(updates).length > 0) totalUpdated++;
    for (const platform of Object.keys(discovered)) {
      totalDiscovered[platform] = (totalDiscovered[platform] || 0) + 1;
    }
    
    // Brave rate limit awareness
    if (totalQueries > 0 && totalQueries % 50 === 0) {
      log(`\n⏳ Pausing for rate limit (${totalQueries} queries used)...\n`);
      await delay(5000);
    }
  }
  
  log(`\n${'='.repeat(50)}`);
  log(`📊 Summary:`);
  log(`  Shops processed: ${shops.length}`);
  log(`  Shops updated: ${totalUpdated}`);
  log(`  Brave queries used: ${totalQueries}`);
  log(`  Discovered:`);
  for (const [platform, count] of Object.entries(totalDiscovered)) {
    log(`    ${platform}: ${count}`);
  }
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

async function main() {
  const args = parseArgs();
  const dryRun = !!args['dry-run'];
  
  if (args.batch) {
    const limit = parseInt(args.limit) || 50;
    await batchDiscover({ limit, dryRun });
    return;
  }
  
  const shop = await resolveShop(args);
  if (!shop) {
    console.log('\nUsage:');
    console.log('  node discover_socials_brave.js --shop-id "uuid"');
    console.log('  node discover_socials_brave.js --shop "Name" --city "City" --state "ST"');
    console.log('  node discover_socials_brave.js --batch [--limit 50] [--dry-run]');
    process.exit(0);
  }
  
  await discoverSocialsBrave(shop, { dryRun });
}

module.exports = { discoverSocialsBrave };
main().catch(e => { console.error('❌ Fatal:', e.message); process.exit(1); });
