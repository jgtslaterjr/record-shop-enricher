#!/usr/bin/env node
/**
 * Social Handle Discovery Script
 * Fetches shop websites and extracts Instagram, Facebook, TikTok links.
 * Updates Supabase with discovered handles.
 * 
 * Usage: 
 *   node discover_social_handles.js          # Process all shops missing social handles
 *   node discover_social_handles.js --limit 5 # Process only 5 shops
 *   node discover_social_handles.js --dry-run  # Don't update Supabase
 */

const { spawn } = require('child_process');
const { writeFileSync, existsSync, readFileSync } = require('fs');

const SUPABASE_URL = "https://oytflcaqukxvzmbddrlg.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im95dGZsY2FxdWt4dnptYmRkcmxnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY5NTIwMjQsImV4cCI6MjA4MjUyODAyNH0.YpFZfu2BPxwXxXz5j-xqgu7VdIuTP315eiS3UuLD2wo";

const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PROGRESS_FILE = '/home/john/Projects/record_shop_enricher/discover_progress.json';

// Parse args
const args = process.argv.slice(2);
const limit = args.includes('--limit') ? parseInt(args[args.indexOf('--limit') + 1]) : null;
const dryRun = args.includes('--dry-run');

// ── HTTP helpers ──

function curlFetch(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const headerArgs = Object.entries(headers).flatMap(([k, v]) => ['-H', `${k}: ${v}`]);
    const curl = spawn('curl', [
      '-sL',
      '-A', USER_AGENT,
      '--max-time', '15',
      '--max-redirs', '5',
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

function supabaseGet(query) {
  return new Promise((resolve, reject) => {
    const url = `${SUPABASE_URL}/rest/v1/shops?${query}`;
    curlFetch(url, {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
    }).then(data => {
      try { resolve(JSON.parse(data)); }
      catch (e) { reject(new Error(`JSON parse failed: ${data.substring(0, 200)}`)); }
    }).catch(reject);
  });
}

function supabaseUpdate(shopId, updates) {
  return new Promise((resolve, reject) => {
    const url = `${SUPABASE_URL}/rest/v1/shops?id=eq.${shopId}`;
    const body = JSON.stringify(updates);
    const curl = spawn('curl', [
      '-s', '-X', 'PATCH',
      '-H', `apikey: ${SUPABASE_KEY}`,
      '-H', `Authorization: Bearer ${SUPABASE_KEY}`,
      '-H', 'Content-Type: application/json',
      '-H', 'Prefer: return=minimal',
      '-d', body,
      url
    ]);

    let data = '';
    curl.stdout.on('data', (chunk) => { data += chunk; });
    curl.on('close', (code) => {
      if (code !== 0) reject(new Error(`Update failed for ${shopId}`));
      else resolve(data);
    });
  });
}

// ── Social handle extraction ──

function extractInstagram(html) {
  const patterns = [
    /https?:\/\/(?:www\.)?instagram\.com\/([a-zA-Z0-9._]{1,30})\/?/gi,
  ];
  const handles = new Set();
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(html)) !== null) {
      const handle = match[1].toLowerCase();
      // Skip generic pages
      if (!['p', 'explore', 'accounts', 'about', 'developer', 'legal', 'privacy', 'terms', 'reel', 'reels', 'stories', 'tv'].includes(handle)) {
        handles.add(handle);
      }
    }
  }
  return [...handles];
}

function extractFacebook(html) {
  const patterns = [
    /https?:\/\/(?:www\.)?facebook\.com\/([a-zA-Z0-9._-]{2,50})\/?/gi,
  ];
  const handles = new Set();
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(html)) !== null) {
      const handle = match[1].toLowerCase();
      if (!['sharer', 'sharer.php', 'share', 'dialog', 'login', 'help', 'privacy', 'terms', 'policies', 'pages', 'groups', 'events', 'marketplace', 'watch', 'gaming', 'flx', 'profile.php'].includes(handle)) {
        handles.add(handle);
      }
    }
  }
  return [...handles];
}

function extractTikTok(html) {
  const patterns = [
    /https?:\/\/(?:www\.)?tiktok\.com\/@([a-zA-Z0-9._]{1,30})\/?/gi,
  ];
  const handles = new Set();
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(html)) !== null) {
      handles.add(match[1].toLowerCase());
    }
  }
  return [...handles];
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Progress tracking ──

function loadProgress() {
  if (existsSync(PROGRESS_FILE)) {
    try { return JSON.parse(readFileSync(PROGRESS_FILE, 'utf8')); }
    catch { return { processed: [] }; }
  }
  return { processed: [] };
}

function saveProgress(progress) {
  writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

// ── Main ──

async function main() {
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║  🔍 Social Handle Discovery                         ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  if (dryRun) console.log('⚠️  DRY RUN — no Supabase updates\n');

  // Fetch shops missing social handles
  console.log('📡 Fetching shops from Supabase...');
  let queryStr = 'social_instagram=is.null&website=not.is.null&select=id,name,city,state,website&order=name.asc';
  if (limit) queryStr += `&limit=${limit}`;
  
  const shops = await supabaseGet(queryStr);
  console.log(`📊 Found ${shops.length} shops without Instagram handles\n`);

  // Filter out shops with yelp/google as website (not real shop sites)
  const validShops = shops.filter(s => {
    const url = (s.website || '').toLowerCase();
    return url && !url.includes('yelp.com') && !url.includes('google.com') && !url.includes('facebook.com');
  });
  console.log(`📊 ${validShops.length} shops have real websites (excluded Yelp/Google/FB)\n`);

  const progress = loadProgress();
  const stats = { processed: 0, instagram: 0, facebook: 0, tiktok: 0, errors: 0, skipped: 0 };

  for (let i = 0; i < validShops.length; i++) {
    const shop = validShops[i];
    
    // Skip already processed
    if (progress.processed.includes(shop.id)) {
      stats.skipped++;
      continue;
    }

    const pct = ((i / validShops.length) * 100).toFixed(1);
    process.stdout.write(`[${pct}%] ${i + 1}/${validShops.length} 🏪 ${shop.name} (${shop.city}, ${shop.state})...`);

    try {
      const html = await curlFetch(shop.website);
      if (!html || html.length < 100) {
        console.log(' ⚠️  Empty response');
        stats.errors++;
        continue;
      }

      const instagram = extractInstagram(html);
      const facebook = extractFacebook(html);
      const tiktok = extractTikTok(html);

      const updates = {};
      const found = [];

      if (instagram.length > 0) {
        updates.social_instagram = `https://instagram.com/${instagram[0]}`;
        found.push(`📸 @${instagram[0]}`);
        stats.instagram++;
      }
      if (facebook.length > 0) {
        updates.social_facebook = `https://facebook.com/${facebook[0]}`;
        found.push(`📘 ${facebook[0]}`);
        stats.facebook++;
      }
      if (tiktok.length > 0) {
        updates.social_tiktok = `https://tiktok.com/@${tiktok[0]}`;
        found.push(`🎵 @${tiktok[0]}`);
        stats.tiktok++;
      }

      if (Object.keys(updates).length > 0) {
        if (!dryRun) {
          await supabaseUpdate(shop.id, updates);
        }
        console.log(` ✅ ${found.join(', ')}`);
      } else {
        console.log(' — No social links found');
      }

    } catch (err) {
      console.log(` ❌ ${err.message.substring(0, 60)}`);
      stats.errors++;
    }

    stats.processed++;
    progress.processed.push(shop.id);

    // Save progress every 10 shops
    if (stats.processed % 10 === 0) {
      saveProgress(progress);
    }

    // Rate limit
    await sleep(500);
  }

  saveProgress(progress);

  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║  📊 Results                                          ║');
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log(`║  Processed: ${String(stats.processed).padEnd(40)}║`);
  console.log(`║  Skipped:   ${String(stats.skipped).padEnd(40)}║`);
  console.log(`║  Instagram: ${String(stats.instagram).padEnd(40)}║`);
  console.log(`║  Facebook:  ${String(stats.facebook).padEnd(40)}║`);
  console.log(`║  TikTok:    ${String(stats.tiktok).padEnd(40)}║`);
  console.log(`║  Errors:    ${String(stats.errors).padEnd(40)}║`);
  console.log('╚══════════════════════════════════════════════════════╝');
}

main().catch(err => {
  console.error('💀 Fatal error:', err.message);
  process.exit(1);
});
