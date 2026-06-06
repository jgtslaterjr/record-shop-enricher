#!/usr/bin/env node
/**
 * Discogs Scraper — Finds and scrapes Discogs seller/user profiles
 * 
 * Searches for a shop's Discogs profile using multiple strategies:
 * - Direct URL patterns (discogs.com/user/{name}, discogs.com/seller/{name})
 * - Shop name variations (with/without spaces, hyphens, etc.)
 * - DuckDuckGo search for discogs.com mentions
 * 
 * Extracts: seller rating, total ratings count, active seller status
 * 
 * Usage:
 *   node scrape_discogs.js --shop-id "uuid"
 *   node scrape_discogs.js --shop-name "939 Records"
 *   node scrape_discogs.js --all --limit 10
 */

const { supabase, delay, saveJSON, contentDir, getAllShops, updateShop,
  parseArgs, log, randomUA } = require('./lib/common');
const https = require('https');
const cheerio = require('cheerio');

// ── Helper Functions ───────────────────────────────────────

function normalizeShopName(name) {
  // Generate variations of shop name for URL matching
  const variations = [];
  
  // Original name
  variations.push(name);
  
  // Remove common words
  const cleaned = name
    .replace(/\b(the|records?|vinyl|music|shop|store|llc|inc|co)\b/gi, '')
    .trim();
  if (cleaned && cleaned !== name) variations.push(cleaned);
  
  // No spaces
  variations.push(name.replace(/\s+/g, ''));
  variations.push(cleaned.replace(/\s+/g, ''));
  
  // Hyphens instead of spaces
  variations.push(name.replace(/\s+/g, '-'));
  variations.push(cleaned.replace(/\s+/g, '-'));
  
  // Lowercase versions
  const uniqueVariations = [...new Set(variations)];
  return uniqueVariations.flatMap(v => [v, v.toLowerCase()]);
}

async function fetchHTML(url, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'User-Agent': randomUA(),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout,
    };
    
    https.get(url, options, (res) => {
      if (res.statusCode === 404) {
        resolve({ html: null, statusCode: 404 });
        return;
      }
      if (res.statusCode !== 200) {
        resolve({ html: null, statusCode: res.statusCode });
        return;
      }
      
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ html: data, statusCode: 200 }));
    }).on('error', reject).on('timeout', () => {
      reject(new Error('Request timeout'));
    });
  });
}

async function searchDuckDuckGo(query) {
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

function extractDiscogsURLsFromSearch(html) {
  const urls = [];
  const patterns = [
    /uddg=(https?:\/\/(?:www\.)?discogs\.com\/(?:user|seller)\/[^&"]+)/g,
    /href="(https?:\/\/(?:www\.)?discogs\.com\/(?:user|seller)\/[^"]+)"/g,
  ];
  
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(html)) !== null) {
      try {
        const decoded = decodeURIComponent(match[1]);
        const cleaned = decoded.split('?')[0].split('#')[0];
        if (!urls.includes(cleaned)) {
          urls.push(cleaned);
        }
      } catch {
        const cleaned = match[1].split('?')[0].split('#')[0];
        if (!urls.includes(cleaned)) {
          urls.push(cleaned);
        }
      }
    }
  }
  
  return urls;
}

// ── Scrape Discogs Profile ────────────────────────────────

async function scrapeDiscogsProfile(url) {
  log(`  Fetching: ${url}`);
  
  const { html, statusCode } = await fetchHTML(url);
  
  if (!html || statusCode === 404) {
    return { found: false, url, statusCode };
  }
  
  if (statusCode !== 200) {
    return { found: false, url, statusCode, error: `HTTP ${statusCode}` };
  }
  
  const $ = cheerio.load(html);
  
  // Extract profile information
  const profile = {
    found: true,
    url,
    username: null,
    location: null,
    memberSince: null,
    rating: null,
    ratingsCount: null,
    isSeller: false,
    sellerStats: {},
  };
  
  // Username
  const usernameEl = $('h1.user_heading, h1[itemprop="name"]').first();
  if (usernameEl.length) {
    profile.username = usernameEl.text().trim();
  }
  
  // Location
  const locationEl = $('[itemprop="address"], .user_info .location').first();
  if (locationEl.length) {
    profile.location = locationEl.text().trim();
  }
  
  // Member since
  const memberEl = $('.user_info').text();
  const memberMatch = memberEl.match(/Member Since:\s*([^<\n]+)/i);
  if (memberMatch) {
    profile.memberSince = memberMatch[1].trim();
  }
  
  // Seller rating and stats
  const ratingText = $('.seller_rating, .star_rating').text();
  const ratingMatch = ratingText.match(/(\d+(?:\.\d+)?)%/);
  if (ratingMatch) {
    profile.rating = parseFloat(ratingMatch[1]);
  }
  
  const ratingsMatch = ratingText.match(/(\d+(?:,\d+)*)\s*(?:rating|Rating)/i);
  if (ratingsMatch) {
    profile.ratingsCount = parseInt(ratingsMatch[1].replace(/,/g, ''));
  }
  
  // Check if active seller
  const sellerLink = $('a[href*="/seller/"]').length > 0;
  const marketplaceActivity = $('.marketplace_stats, .seller_stats').length > 0;
  profile.isSeller = sellerLink || marketplaceActivity || url.includes('/seller/');
  
  // Extract seller stats if available
  $('.seller_stats .stat, .marketplace_stats .stat').each((_, el) => {
    const label = $(el).find('.stat_label, .label').text().trim();
    const value = $(el).find('.stat_value, .value').text().trim();
    if (label && value) {
      profile.sellerStats[label] = value;
    }
  });
  
  // Alternative rating extraction
  if (!profile.rating) {
    const ratingEl = $('.rating_value, [itemprop="ratingValue"]');
    if (ratingEl.length) {
      const val = ratingEl.text().trim().replace('%', '');
      profile.rating = parseFloat(val);
    }
  }
  
  // Alternative ratings count
  if (!profile.ratingsCount) {
    const countEl = $('.rating_count, [itemprop="ratingCount"]');
    if (countEl.length) {
      const val = countEl.text().trim().replace(/[,\s]/g, '');
      profile.ratingsCount = parseInt(val);
    }
  }
  
  return profile;
}

// ── Main Discovery Function ───────────────────────────────

async function discoverDiscogs(shop) {
  log(`\n🎵 Discogs Discovery for: ${shop.name}`);
  
  const results = {
    shopId: shop.id,
    shopName: shop.name,
    searchedAt: new Date().toISOString(),
    urlsTried: [],
    searchResults: [],
    profile: null,
  };
  
  // Strategy 1: Try direct URL variations
  const variations = normalizeShopName(shop.name);
  log(`  Generated ${variations.length} name variations`);
  
  for (const variant of variations.slice(0, 10)) { // Limit to first 10 variations
    const userUrl = `https://www.discogs.com/user/${encodeURIComponent(variant)}`;
    const sellerUrl = `https://www.discogs.com/seller/${encodeURIComponent(variant)}`;
    
    for (const url of [sellerUrl, userUrl]) {
      results.urlsTried.push(url);
      
      try {
        const profile = await scrapeDiscogsProfile(url);
        
        if (profile.found) {
          log(`  ✓ Found profile: ${url}`);
          results.profile = profile;
          
          // Save and update DB
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          const outputPath = contentDir(shop.id, 'discogs', `discogs_profile_${timestamp}.json`);
          saveJSON(outputPath, results);
          log(`  💾 Saved: ${outputPath}`);
          
          // Update shop record
          if (shop.id && shop.id !== 'manual') {
            const updates = { social_discogs: url };
            await updateShop(shop.id, updates);
            log(`  ✓ Updated shop record with Discogs URL`);
          }
          
          return results;
        }
        
        await delay(800, 1500);
      } catch (e) {
        log(`  ⚠ Error checking ${url}: ${e.message}`);
      }
    }
  }
  
  // Strategy 2: DuckDuckGo search
  log(`  🔎 Searching DuckDuckGo: site:discogs.com "${shop.name}"`);
  
  try {
    const { html, blocked } = await searchDuckDuckGo(`site:discogs.com "${shop.name}"`);
    
    if (blocked) {
      log('  ⚠ DuckDuckGo rate limited');
    } else {
      const urls = extractDiscogsURLsFromSearch(html);
      log(`  Found ${urls.length} Discogs URLs in search results`);
      results.searchResults = urls;
      
      // Try each found URL
      for (const url of urls.slice(0, 5)) { // Check first 5 results
        if (results.urlsTried.includes(url)) continue;
        
        results.urlsTried.push(url);
        
        try {
          const profile = await scrapeDiscogsProfile(url);
          
          if (profile.found) {
            log(`  ✓ Found profile via search: ${url}`);
            results.profile = profile;
            
            // Save and update DB
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const outputPath = contentDir(shop.id, 'discogs', `discogs_profile_${timestamp}.json`);
            saveJSON(outputPath, results);
            log(`  💾 Saved: ${outputPath}`);
            
            // Update shop record
            if (shop.id && shop.id !== 'manual') {
              const updates = { social_discogs: url };
              await updateShop(shop.id, updates);
              log(`  ✓ Updated shop record with Discogs URL`);
            }
            
            return results;
          }
          
          await delay(800, 1500);
        } catch (e) {
          log(`  ⚠ Error checking ${url}: ${e.message}`);
        }
      }
    }
  } catch (e) {
    log(`  ⚠ Search failed: ${e.message}`);
  }
  
  // No profile found
  log(`  ✗ No Discogs profile found after checking ${results.urlsTried.length} URLs`);
  
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputPath = contentDir(shop.id, 'discogs', `discogs_search_${timestamp}.json`);
  saveJSON(outputPath, results);
  log(`  💾 Saved search results: ${outputPath}`);
  
  return results;
}

// ── CLI Entry Point ───────────────────────────────────────

async function main() {
  const args = parseArgs();
  
  if (args.all) {
    const limit = parseInt(args.limit) || 10;
    const shops = await getAllShops(limit);
    log(`\n🎵 Batch Discogs discovery for ${shops.length} shops\n`);
    
    let found = 0;
    for (let i = 0; i < shops.length; i++) {
      const shop = shops[i];
      log(`\n[${i + 1}/${shops.length}] ${shop.name} (${shop.city}, ${shop.state})`);
      
      // Skip if already has Discogs URL
      if (shop.social_discogs && !args.force) {
        log('  ⏭ Already has Discogs URL, skipping (use --force to overwrite)');
        continue;
      }
      
      try {
        const results = await discoverDiscogs(shop);
        if (results.profile) found++;
      } catch (e) {
        log(`  ❌ Error: ${e.message}`);
      }
      
      if (i < shops.length - 1) await delay(2000, 4000);
    }
    
    log(`\n✅ Batch complete: ${found}/${shops.length} profiles found`);
    return;
  }
  
  let shop;
  
  if (args['shop-id']) {
    const { data, error } = await supabase.from('shops').select('*').eq('id', args['shop-id']).single();
    if (error || !data) {
      log(`❌ Shop not found: ${args['shop-id']}`);
      process.exit(1);
    }
    shop = data;
  } else if (args['shop-name']) {
    shop = {
      id: 'manual',
      name: args['shop-name'],
      city: args.city || '',
      state: args.state || '',
    };
  } else {
    console.log('\nUsage:');
    console.log('  node scrape_discogs.js --shop-id "uuid"');
    console.log('  node scrape_discogs.js --shop-name "939 Records"');
    console.log('  node scrape_discogs.js --all --limit 10');
    console.log('  node scrape_discogs.js --all --force  # re-scan shops with existing URLs');
    process.exit(0);
  }
  
  await discoverDiscogs(shop);
}

if (require.main === module) {
  main().catch(e => {
    console.error('❌ Fatal:', e.message);
    process.exit(1);
  });
}

module.exports = { discoverDiscogs };
