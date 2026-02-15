#!/usr/bin/env node
/**
 * Dedup All Shops — Scan all shops with image galleries for perceptual hash duplicates.
 *
 * Usage:
 *   node dedup_all_shops.js                  # scan all shops
 *   node dedup_all_shops.js --limit 5        # scan first 5 shops only
 *   node dedup_all_shops.js --slug "shop-slug"  # scan a single shop
 */

const { supabase, delay, saveJSON, ensureDir, parseArgs, log } = require('./lib/common');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
require('dotenv').config();

const HASH_SIZE = 8;
const DEFAULT_THRESHOLD = 8;
const DOWNLOAD_DELAY = 300;

// ─── Image Download ─────────────────────────────────────────────────────────

function downloadBuffer(url) {
  return new Promise((resolve, reject) => {
    const get = url.startsWith('https') ? https.get : http.get;
    const timer = setTimeout(() => reject(new Error('Download timeout')), 15000);
    get(url, { headers: { 'User-Agent': 'RecordShopEnricher/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        clearTimeout(timer);
        return downloadBuffer(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) { clearTimeout(timer); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => { clearTimeout(timer); resolve(Buffer.concat(chunks)); });
      res.on('error', e => { clearTimeout(timer); reject(e); });
    }).on('error', e => { clearTimeout(timer); reject(e); });
  });
}

// ─── dHash ──────────────────────────────────────────────────────────────────

async function computeDHash(buffer) {
  const pixels = await sharp(buffer)
    .grayscale()
    .resize(HASH_SIZE + 1, HASH_SIZE, { fit: 'fill' })
    .raw()
    .toBuffer();
  const bits = [];
  for (let y = 0; y < HASH_SIZE; y++) {
    for (let x = 0; x < HASH_SIZE; x++) {
      bits.push(pixels[y * (HASH_SIZE + 1) + x] < pixels[y * (HASH_SIZE + 1) + x + 1] ? 1 : 0);
    }
  }
  return bits;
}

function hammingDistance(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

function hashToHex(bits) {
  let hex = '';
  for (let i = 0; i < bits.length; i += 4) {
    hex += ((bits[i] << 3) | (bits[i+1] << 2) | (bits[i+2] << 1) | bits[i+3]).toString(16);
  }
  return hex;
}

// ─── Normalize gallery URLs ─────────────────────────────────────────────────

function normalizeUrls(gallery) {
  return (gallery || []).map(item => {
    if (typeof item === 'string') {
      if (item.startsWith('{')) { try { return JSON.parse(item).url; } catch (e) { return item; } }
      return item;
    }
    if (typeof item === 'object' && item.url) return item.url;
    return item;
  }).filter(url => url && typeof url === 'string');
}

// ─── Process a single shop ──────────────────────────────────────────────────

async function processShop(shop, threshold) {
  const imageUrls = normalizeUrls(shop.image_gallery);
  if (imageUrls.length < 2) return null;

  const dHashes = [];
  const errors = [];

  for (let i = 0; i < imageUrls.length; i++) {
    try {
      const buf = await downloadBuffer(imageUrls[i]);
      dHashes.push({ index: i, hash: await computeDHash(buf) });
    } catch (e) {
      dHashes.push({ index: i, hash: null });
      errors.push({ index: i, error: e.message });
    }
    if (i < imageUrls.length - 1) await new Promise(r => setTimeout(r, DOWNLOAD_DELAY));
  }

  // Compare all pairs
  const pairs = [];
  for (let a = 0; a < dHashes.length; a++) {
    if (!dHashes[a].hash) continue;
    for (let b = a + 1; b < dHashes.length; b++) {
      if (!dHashes[b].hash) continue;
      const dist = hammingDistance(dHashes[a].hash, dHashes[b].hash);
      if (dist <= threshold) {
        pairs.push({ i: dHashes[a].index, j: dHashes[b].index, distance: dist });
      }
    }
  }

  return {
    slug: shop.slug,
    name: shop.name,
    city: shop.city,
    state: shop.state,
    image_count: imageUrls.length,
    duplicate_pairs: pairs,
    errors,
    has_duplicates: pairs.length > 0
  };
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();
  const threshold = parseInt(args.threshold) || DEFAULT_THRESHOLD;
  const limit = args.limit ? parseInt(args.limit) : null;

  // Fetch shops
  let query = supabase.from('shops').select('id, slug, name, city, state, image_gallery')
    .not('image_gallery', 'is', null);

  if (args.slug) {
    query = query.eq('slug', args.slug);
  }

  query = query.order('slug');
  if (limit) query = query.limit(limit);

  const { data: shops, error } = await query;
  if (error) { console.error('❌ Supabase error:', error.message); process.exit(1); }

  // Filter to shops with 2+ images
  const eligible = shops.filter(s => {
    const urls = normalizeUrls(s.image_gallery);
    return urls.length >= 2;
  });

  console.log(`\n🔍 Scanning ${eligible.length} shops with 2+ images (threshold=${threshold})\n`);

  const results = {
    timestamp: new Date().toISOString(),
    threshold,
    total_shops_scanned: eligible.length,
    shops_with_duplicates: [],
    clean_shops: [],
    errored_shops: [],
    summary: {}
  };

  let totalImages = 0;
  let totalDupes = 0;

  for (let si = 0; si < eligible.length; si++) {
    const shop = eligible[si];
    const prefix = `[${si + 1}/${eligible.length}]`;

    try {
      const result = await processShop(shop, threshold);
      if (!result) continue;

      totalImages += result.image_count;

      if (result.has_duplicates) {
        totalDupes++;
        results.shops_with_duplicates.push(result);
        console.log(`${prefix} ⚠️  ${shop.name} (${shop.city}, ${shop.state}) — ${result.image_count} imgs, ${result.duplicate_pairs.length} dupe pair(s)`);
        for (const p of result.duplicate_pairs) {
          console.log(`       #${p.i + 1} vs #${p.j + 1} (distance=${p.distance})`);
        }
      } else {
        results.clean_shops.push({ slug: shop.slug, name: shop.name, image_count: result.image_count });
        console.log(`${prefix} ✅ ${shop.name} — ${result.image_count} imgs, clean`);
      }

      if (result.errors.length > 0) {
        console.log(`       ⚠ ${result.errors.length} download error(s)`);
      }
    } catch (e) {
      results.errored_shops.push({ slug: shop.slug, name: shop.name, error: e.message });
      console.log(`${prefix} ❌ ${shop.name} — ERROR: ${e.message}`);
    }
  }

  results.summary = {
    total_shops_scanned: eligible.length,
    total_images_processed: totalImages,
    shops_with_duplicates: results.shops_with_duplicates.length,
    clean_shops: results.clean_shops.length,
    errored_shops: results.errored_shops.length,
    total_duplicate_pairs: results.shops_with_duplicates.reduce((s, r) => s + r.duplicate_pairs.length, 0)
  };

  // Save results
  const outPath = path.join(__dirname, 'content', 'dedup_all_results.json');
  ensureDir(path.dirname(outPath));
  saveJSON(outPath, results);
  console.log(`\n📄 Results saved to: ${outPath}`);

  // Print summary
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  DEDUP SUMMARY`);
  console.log(`${'═'.repeat(60)}`);
  console.log(`  Shops scanned:        ${results.summary.total_shops_scanned}`);
  console.log(`  Total images:         ${results.summary.total_images_processed}`);
  console.log(`  Shops with dupes:     ${results.summary.shops_with_duplicates}`);
  console.log(`  Clean shops:          ${results.summary.clean_shops}`);
  console.log(`  Errored shops:        ${results.summary.errored_shops}`);
  console.log(`  Total dupe pairs:     ${results.summary.total_duplicate_pairs}`);
  console.log(`${'═'.repeat(60)}\n`);

  if (results.shops_with_duplicates.length > 0) {
    console.log('Shops with duplicates:');
    for (const s of results.shops_with_duplicates) {
      console.log(`  • ${s.name} (${s.slug}) — ${s.duplicate_pairs.length} pair(s)`);
    }
  }
}

main().catch(e => { console.error('❌ Fatal:', e.message); process.exit(1); });
