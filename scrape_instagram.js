#!/usr/bin/env node
/**
 * Instagram Public Profile Scraper
 * Fetches public profile data (bio, followers, posts) without login.
 * 
 * Usage:
 *   node scrape_instagram.js <username>              # Single profile
 *   node scrape_instagram.js --batch                  # All shops with social_instagram
 *   node scrape_instagram.js --batch --limit 10       # First 10 shops
 */

const { spawn } = require('child_process');
const { writeFileSync, mkdirSync, existsSync } = require('fs');
const path = require('path');

const SUPABASE_URL = "https://oytflcaqukxvzmbddrlg.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im95dGZsY2FxdWt4dnptYmRkcmxnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY5NTIwMjQsImV4cCI6MjA4MjUyODAyNH0.YpFZfu2BPxwXxXz5j-xqgu7VdIuTP315eiS3UuLD2wo";
const CONTENT_DIR = '/home/john/Projects/record-shop-enricher/content';

const args = process.argv.slice(2);
const isBatch = args.includes('--batch');
const batchLimit = args.includes('--limit') ? parseInt(args[args.indexOf('--limit') + 1]) : null;
const singleUsername = !isBatch ? args[0] : null;

function curlFetch(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const headerArgs = Object.entries(headers).flatMap(([k, v]) => ['-H', `${k}: ${v}`]);
    const curl = spawn('curl', [
      '-sL',
      '--max-time', '15',
      '--max-redirs', '3',
      '-o', '-',
      ...headerArgs,
      url
    ]);
    let data = '';
    let stderr = '';
    curl.stdout.on('data', (chunk) => { data += chunk; });
    curl.stderr.on('data', (chunk) => { stderr += chunk; });
    curl.on('close', (code) => {
      if (code !== 0 && !data) reject(new Error(`curl failed: ${stderr}`));
      else resolve(data);
    });
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Extract handle from Instagram URL
function handleFromUrl(url) {
  if (!url) return null;
  const match = url.match(/instagram\.com\/([a-zA-Z0-9._]+)/i);
  return match ? match[1].toLowerCase() : null;
}

// Parse Instagram profile data from HTML
function parseInstagramHTML(html, username) {
  const result = {
    username,
    fullName: null,
    bio: null,
    followers: null,
    following: null,
    posts: null,
    verified: false,
    profilePicUrl: null,
    scrapedAt: new Date().toISOString(),
    method: null,
    raw: false,
  };

  // Method 1: Try to find JSON-LD or embedded data
  try {
    // Look for window._sharedData
    const sharedDataMatch = html.match(/window\._sharedData\s*=\s*({.+?});\s*<\/script>/);
    if (sharedDataMatch) {
      const data = JSON.parse(sharedDataMatch[1]);
      const user = data?.entry_data?.ProfilePage?.[0]?.graphql?.user;
      if (user) {
        result.fullName = user.full_name;
        result.bio = user.biography;
        result.followers = user.edge_followed_by?.count;
        result.following = user.edge_follow?.count;
        result.posts = user.edge_owner_to_timeline_media?.count;
        result.verified = user.is_verified;
        result.profilePicUrl = user.profile_pic_url_hd;
        result.method = 'sharedData';
        return result;
      }
    }
  } catch (e) { /* continue to next method */ }

  // Method 2: Look for additional data scripts
  try {
    const additionalDataMatch = html.match(/"ProfilePage":\[({.+?})\]/);
    if (additionalDataMatch) {
      const data = JSON.parse(additionalDataMatch[1]);
      const user = data?.graphql?.user;
      if (user) {
        result.fullName = user.full_name;
        result.bio = user.biography;
        result.followers = user.edge_followed_by?.count;
        result.following = user.edge_follow?.count;
        result.posts = user.edge_owner_to_timeline_media?.count;
        result.verified = user.is_verified;
        result.method = 'additionalData';
        return result;
      }
    }
  } catch (e) { /* continue */ }

  // Method 3: Meta tag extraction (most reliable fallback)
  try {
    const descMatch = html.match(/<meta\s+(?:property="og:description"|name="description")\s+content="([^"]+)"/i)
      || html.match(/<meta\s+content="([^"]+)"\s+(?:property="og:description"|name="description")/i);
    
    if (descMatch) {
      const desc = descMatch[1];
      // Pattern: "123 Followers, 45 Following, 67 Posts - See Instagram photos and videos from Name (@handle)"
      const statsMatch = desc.match(/([\d,.]+[KkMm]?)\s*Followers?,\s*([\d,.]+[KkMm]?)\s*Following,\s*([\d,.]+[KkMm]?)\s*Posts?/i);
      if (statsMatch) {
        result.followers = parseCount(statsMatch[1]);
        result.following = parseCount(statsMatch[2]);
        result.posts = parseCount(statsMatch[3]);
      }
      
      const nameMatch = desc.match(/from\s+(.+?)\s*\(@/);
      if (nameMatch) result.fullName = nameMatch[1].trim();
      
      result.method = 'metaTags';
    }

    // Also try title tag
    const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
    if (titleMatch && !result.fullName) {
      const nameFromTitle = titleMatch[1].match(/^(.+?)\s*\(@/);
      if (nameFromTitle) result.fullName = nameFromTitle[1].trim();
    }

    // Profile pic from og:image
    const ogImageMatch = html.match(/<meta\s+(?:property="og:image")\s+content="([^"]+)"/i)
      || html.match(/<meta\s+content="([^"]+)"\s+property="og:image"/i);
    if (ogImageMatch) result.profilePicUrl = ogImageMatch[1];

  } catch (e) { /* continue */ }

  // Method 4: Try parsing from JSON embedded in newer Instagram HTML
  try {
    const jsonMatches = html.matchAll(/"edge_followed_by":\{"count":(\d+)\}/g);
    for (const m of jsonMatches) {
      result.followers = parseInt(m[1]);
      result.method = 'embeddedJSON';
    }
    const followingMatch = html.match(/"edge_follow":\{"count":(\d+)\}/);
    if (followingMatch) result.following = parseInt(followingMatch[1]);
    
    const postsMatch = html.match(/"edge_owner_to_timeline_media":\{"count":(\d+)/);
    if (postsMatch) result.posts = parseInt(postsMatch[1]);
    
    const bioMatch = html.match(/"biography":"((?:[^"\\]|\\.)*)"/);
    if (bioMatch) result.bio = bioMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
    
    const nameMatch = html.match(/"full_name":"((?:[^"\\]|\\.)*)"/);
    if (nameMatch) result.fullName = nameMatch[1];
    
    const verifiedMatch = html.match(/"is_verified":(true|false)/);
    if (verifiedMatch) result.verified = verifiedMatch[1] === 'true';
  } catch (e) { /* continue */ }

  if (!result.method && (result.followers || result.bio)) {
    result.method = 'mixed';
  }

  return result;
}

function parseCount(str) {
  if (!str) return null;
  str = str.replace(/,/g, '');
  const num = parseFloat(str);
  if (str.toLowerCase().includes('k')) return Math.round(num * 1000);
  if (str.toLowerCase().includes('m')) return Math.round(num * 1000000);
  return Math.round(num);
}

async function scrapeProfile(username) {
  // Try ?__a=1&__d=dis JSON endpoint first
  try {
    const jsonUrl = `https://www.instagram.com/${username}/?__a=1&__d=dis`;
    const jsonData = await curlFetch(jsonUrl, {
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15',
      'Accept': 'application/json',
      'X-IG-App-ID': '936619743392459',
    });
    
    if (jsonData && jsonData.startsWith('{')) {
      const parsed = JSON.parse(jsonData);
      const user = parsed?.graphql?.user || parsed?.data?.user;
      if (user) {
        return {
          username,
          fullName: user.full_name,
          bio: user.biography,
          followers: user.edge_followed_by?.count,
          following: user.edge_follow?.count,
          posts: user.edge_owner_to_timeline_media?.count,
          verified: user.is_verified,
          profilePicUrl: user.profile_pic_url_hd,
          scrapedAt: new Date().toISOString(),
          method: 'jsonAPI',
        };
      }
    }
  } catch (e) { /* fall through to HTML method */ }

  // Fall back to HTML scraping
  const html = await curlFetch(`https://www.instagram.com/${username}/`, {
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Connection': 'keep-alive',
  });

  if (!html || html.length < 500) {
    throw new Error('Empty or blocked response');
  }
  if (html.includes('Page Not Found') || html.includes('"HttpErrorPage"')) {
    throw new Error('Profile not found (404)');
  }
  if (html.includes('login') && html.length < 5000) {
    throw new Error('Login wall detected');
  }

  return parseInstagramHTML(html, username);
}

function saveResult(result, shopId) {
  const date = new Date().toISOString().split('T')[0];
  const dir = shopId 
    ? path.join(CONTENT_DIR, shopId, 'social')
    : path.join(CONTENT_DIR, '_standalone', 'social');
  
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `instagram_${date}.json`);
  writeFileSync(filePath, JSON.stringify(result, null, 2));
  return filePath;
}

// ── Single mode ──

async function runSingle(username) {
  console.log(`📸 Scraping Instagram profile: @${username}\n`);
  
  try {
    const result = await scrapeProfile(username);
    const filePath = saveResult(result);
    
    console.log('✅ Profile data extracted:');
    console.log(`   Name:      ${result.fullName || '—'}`);
    console.log(`   Bio:       ${(result.bio || '—').substring(0, 80)}`);
    console.log(`   Followers: ${result.followers?.toLocaleString() || '—'}`);
    console.log(`   Following: ${result.following?.toLocaleString() || '—'}`);
    console.log(`   Posts:     ${result.posts?.toLocaleString() || '—'}`);
    console.log(`   Verified:  ${result.verified ? '✓' : '✗'}`);
    console.log(`   Method:    ${result.method || 'unknown'}`);
    console.log(`\n💾 Saved to: ${filePath}`);
  } catch (err) {
    console.error(`❌ Error: ${err.message}`);
    process.exit(1);
  }
}

// ── Batch mode ──

async function runBatch() {
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║  📸 Instagram Batch Scraper                         ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');

  // Fetch shops with Instagram handles
  let query = 'social_instagram=not.is.null&select=id,name,city,state,social_instagram&order=name.asc';
  if (batchLimit) query += `&limit=${batchLimit}`;
  
  const data = await curlFetch(`${SUPABASE_URL}/rest/v1/shops?${query}`, {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
  });
  
  const shops = JSON.parse(data);
  console.log(`📊 Found ${shops.length} shops with Instagram handles\n`);

  const stats = { success: 0, errors: 0, noData: 0 };

  for (let i = 0; i < shops.length; i++) {
    const shop = shops[i];
    const handle = handleFromUrl(shop.social_instagram);
    if (!handle) {
      console.log(`⚠️  ${shop.name}: invalid Instagram URL: ${shop.social_instagram}`);
      stats.errors++;
      continue;
    }

    const pct = ((i / shops.length) * 100).toFixed(1);
    process.stdout.write(`[${pct}%] ${i + 1}/${shops.length} 📸 @${handle} (${shop.name})...`);

    try {
      const result = await scrapeProfile(handle);
      const filePath = saveResult(result, shop.id);
      
      if (result.followers || result.bio) {
        console.log(` ✅ ${result.followers?.toLocaleString() || '?'} followers, ${result.posts?.toLocaleString() || '?'} posts [${result.method}]`);
        stats.success++;
      } else {
        console.log(' ⚠️  No data extracted');
        stats.noData++;
      }
    } catch (err) {
      console.log(` ❌ ${err.message.substring(0, 60)}`);
      stats.errors++;
    }

    // Rate limit: 3 seconds between requests
    await sleep(3000);
  }

  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║  📊 Batch Results                                    ║');
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log(`║  Success:  ${String(stats.success).padEnd(41)}║`);
  console.log(`║  No Data:  ${String(stats.noData).padEnd(41)}║`);
  console.log(`║  Errors:   ${String(stats.errors).padEnd(41)}║`);
  console.log('╚══════════════════════════════════════════════════════╝');
}

// ── Entry point ──

if (!isBatch && !singleUsername) {
  console.log('Usage:');
  console.log('  node scrape_instagram.js <username>');
  console.log('  node scrape_instagram.js --batch [--limit N]');
  process.exit(1);
}

(isBatch ? runBatch() : runSingle(singleUsername)).catch(err => {
  console.error('💀 Fatal:', err.message);
  process.exit(1);
});
