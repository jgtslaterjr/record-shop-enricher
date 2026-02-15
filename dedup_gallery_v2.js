#!/usr/bin/env node
/**
 * Gallery Dedup V2 — Perceptual Hashing + URL Analysis
 *
 * Improved dedup that uses perceptual hashing (dHash) instead of relying
 * solely on vision AI. Generates a review file for human approval —
 * does NOT auto-remove images.
 *
 * Usage:
 *   node dedup_gallery_v2.js --slug "amoeba-music-san-francisco-shops"
 *   node dedup_gallery_v2.js --shop-id "uuid"
 *   node dedup_gallery_v2.js --slug "..." --threshold 10  (dHash hamming distance, default 8)
 *   node dedup_gallery_v2.js --slug "..." --phash-threshold 12  (pHash threshold, default 10)
 *   node dedup_gallery_v2.js --slug "..." --combined-threshold 12  (avg of both, default 10)
 *   node dedup_gallery_v2.js --slug "..." --grok            (use Grok Vision for borderline)
 */

const { supabase, delay, saveJSON, ensureDir, contentDir, getShopByName,
  parseArgs, log } = require('./lib/common');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
require('dotenv').config();

const HASH_SIZE = 8; // 8x8 = 64-bit dHash
const PHASH_SIZE = 32; // 32x32 for perceptual hash
const DEFAULT_THRESHOLD = 8; // hamming distance for "likely duplicate"
const DEFAULT_PHASH_THRESHOLD = 10; // pHash threshold
const DEFAULT_COMBINED_THRESHOLD = 10; // (dHash + pHash) / 2

// ─── Image Download ─────────────────────────────────────────────────────────

function downloadBuffer(url) {
  return new Promise((resolve, reject) => {
    const get = url.startsWith('https') ? https.get : http.get;
    get(url, { headers: { 'User-Agent': 'RecordShopEnricher/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadBuffer(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ─── dHash (difference hash) ────────────────────────────────────────────────

async function computeDHash(buffer) {
  // Resize to (HASH_SIZE+1) x HASH_SIZE, grayscale
  const pixels = await sharp(buffer)
    .grayscale()
    .resize(HASH_SIZE + 1, HASH_SIZE, { fit: 'fill' })
    .raw()
    .toBuffer();

  // Compare adjacent pixels: left < right = 1
  const bits = [];
  for (let y = 0; y < HASH_SIZE; y++) {
    for (let x = 0; x < HASH_SIZE; x++) {
      const left = pixels[y * (HASH_SIZE + 1) + x];
      const right = pixels[y * (HASH_SIZE + 1) + x + 1];
      bits.push(left < right ? 1 : 0);
    }
  }
  return bits;
}

// ─── pHash (average/perceptual hash) ────────────────────────────────────────

async function computePHash(buffer) {
  // Resize to 32x32, grayscale, compute mean, threshold
  const pixels = await sharp(buffer)
    .grayscale()
    .resize(PHASH_SIZE, PHASH_SIZE, { fit: 'fill' })
    .raw()
    .toBuffer();

  // Compute mean pixel value
  let sum = 0;
  for (let i = 0; i < pixels.length; i++) sum += pixels[i];
  const mean = sum / pixels.length;

  // Set bits: 1 if above mean, 0 if below
  const bits = [];
  for (let i = 0; i < pixels.length; i++) {
    bits.push(pixels[i] >= mean ? 1 : 0);
  }
  return bits;
}

function hammingDistance(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) d++;
  }
  return d;
}

function hashToHex(bits) {
  let hex = '';
  for (let i = 0; i < bits.length; i += 4) {
    const nibble = (bits[i] << 3) | (bits[i+1] << 2) | (bits[i+2] << 1) | bits[i+3];
    hex += nibble.toString(16);
  }
  return hex;
}

// ─── URL-based duplicate detection ──────────────────────────────────────────

function normalizeUrlForComparison(url) {
  try {
    const u = new URL(url);
    // Strip common size/format suffixes and query params
    let p = u.pathname
      .replace(/[-_]\d+x\d+/g, '')           // _800x600, -1200x900
      .replace(/\/s\d+[-x]\d+\//g, '/')       // /s800x600/
      .replace(/=w\d+[-]h\d+/g, '')           // =w800-h600 (Google)
      .replace(/\.(jpg|jpeg|png|webp|avif)/gi, '')
      .replace(/\/+/g, '/');
    return u.hostname.replace(/^www\./, '') + p;
  } catch (e) {
    return url;
  }
}

function findUrlDuplicates(imageUrls) {
  const groups = {};
  imageUrls.forEach((url, i) => {
    const norm = normalizeUrlForComparison(url);
    if (!groups[norm]) groups[norm] = [];
    groups[norm].push(i);
  });
  return Object.values(groups).filter(g => g.length > 1);
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

// ─── Resolve shop ───────────────────────────────────────────────────────────

async function resolveShop(args) {
  if (args.slug) {
    const { data, error } = await supabase.from('shops').select('*').eq('slug', args.slug).single();
    if (error || !data) { log(`❌ Shop not found: ${args.slug}`); process.exit(1); }
    return data;
  }
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

// ─── Generate review HTML ───────────────────────────────────────────────────

function generateReviewHTML(shop, imageUrls, hashDupes, urlDupes) {
  const allGroups = [...hashDupes.map(g => ({ ...g, type: 'hash' })),
                     ...urlDupes.map(indices => ({ indices, type: 'url', dDistance: 0, pDistance: 0 }))];

  const groupRows = allGroups.map((g, gi) => {
    const distInfo = g.type === 'hash'
      ? `dHash=${g.dDistance}, pHash=${g.pDistance}${g.reasons ? ' — ' + g.reasons.join(', ') : ''}`
      : 'URL match';
    const imgs = g.indices.map(i =>
      `<div style="text-align:center;margin:4px">
        <img src="${imageUrls[i]}" style="width:180px" loading="lazy"><br>
        <b>#${String(i+1).padStart(3,'0')}</b>
      </div>`
    ).join('');
    return `<div style="border:1px solid #555;padding:8px;margin:8px 0;border-radius:4px">
      <div style="color:#ff0"><b>Group ${gi+1}</b> (${g.type}): ${distInfo} — indices ${g.indices.map(i=>i+1).join(', ')}</div>
      <div style="display:flex;flex-wrap:wrap">${imgs}</div>
    </div>`;
  }).join('\n');

  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Dedup Review: ${shop.name}</title>
<style>body{font-family:sans-serif;background:#1a1a1a;color:#eee;margin:20px}</style>
</head><body>
<h1>Dedup Review: ${shop.name}</h1>
<p>${shop.city}, ${shop.state} — ${imageUrls.length} images — ${allGroups.length} potential duplicate groups</p>
<p><b>To apply:</b> <code>node gallery_feedback.js --slug "${shop.slug}" --dupes "idx1,idx2:keep=N"</code></p>
${allGroups.length === 0 ? '<p style="color:#0f0">No duplicates detected!</p>' : groupRows}
</body></html>`;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();
  const shop = await resolveShop(args);

  if (!shop) {
    console.log('\nUsage:');
    console.log('  node dedup_gallery_v2.js --slug "shop-slug"');
    console.log('  node dedup_gallery_v2.js --shop-id "uuid"');
    console.log('  node dedup_gallery_v2.js --slug "..." --threshold 10       (dHash threshold, default 8)');
    console.log('  node dedup_gallery_v2.js --slug "..." --phash-threshold 12  (pHash threshold, default 10)');
    console.log('  node dedup_gallery_v2.js --slug "..." --combined-threshold 12 (combined avg, default 10)');
    console.log('  node dedup_gallery_v2.js --slug "..." --grok\n');
    process.exit(0);
  }

  const threshold = parseInt(args.threshold) || DEFAULT_THRESHOLD;
  const imageUrls = normalizeUrls(shop.image_gallery);

  log(`${shop.name}: ${imageUrls.length} images, threshold=${threshold}`);

  if (imageUrls.length === 0) {
    log('Gallery is empty.');
    return;
  }

  // Step 1: URL-based duplicates
  log('\n--- URL Analysis ---');
  const urlDupes = findUrlDuplicates(imageUrls);
  if (urlDupes.length > 0) {
    for (const group of urlDupes) {
      log(`  URL dupes: ${group.map(i => `#${i+1}`).join(', ')}`);
    }
  } else {
    log('  No URL-based duplicates found.');
  }

  // Step 2: Download and compute perceptual hashes
  log('\n--- Computing Perceptual Hashes ---');
  const dHashes = new Array(imageUrls.length).fill(null);
  const pHashes = new Array(imageUrls.length).fill(null);
  const errors = [];

  for (let i = 0; i < imageUrls.length; i++) {
    try {
      log(`  [${i+1}/${imageUrls.length}] Hashing ${imageUrls[i].slice(0, 70)}...`);
      const buf = await downloadBuffer(imageUrls[i]);
      dHashes[i] = await computeDHash(buf);
      pHashes[i] = await computePHash(buf);
      log(`    dHash: ${hashToHex(dHashes[i])}  pHash: ${hashToHex(pHashes[i]).slice(0, 16)}...`);
    } catch (e) {
      log(`    ⚠ Failed: ${e.message}`);
      errors.push({ index: i, error: e.message });
    }
    if (i < imageUrls.length - 1) await delay(200, 400);
  }

  // Step 3: Compare all pairs using both hashes
  log('\n--- Comparing Hashes ---');
  const pHashThreshold = parseInt(args['phash-threshold']) || DEFAULT_PHASH_THRESHOLD;
  const combinedThreshold = parseInt(args['combined-threshold']) || DEFAULT_COMBINED_THRESHOLD;
  log(`  Thresholds: dHash≤${threshold}, pHash≤${pHashThreshold}, combined≤${combinedThreshold}`);

  const pairs = [];
  for (let i = 0; i < dHashes.length; i++) {
    if (!dHashes[i]) continue;
    for (let j = i + 1; j < dHashes.length; j++) {
      if (!dHashes[j]) continue;
      const dDist = hammingDistance(dHashes[i], dHashes[j]);
      const pDist = pHashes[i] && pHashes[j] ? hammingDistance(pHashes[i], pHashes[j]) : Infinity;
      const combinedDist = (dDist + pDist) / 2;

      const isDHashMatch = dDist <= threshold;
      const isPHashMatch = pDist <= pHashThreshold;
      const isCombinedMatch = combinedDist <= combinedThreshold;

      if (isDHashMatch || isPHashMatch || isCombinedMatch) {
        const reasons = [];
        if (isDHashMatch) reasons.push(`dHash=${dDist}≤${threshold}`);
        if (isPHashMatch) reasons.push(`pHash=${pDist}≤${pHashThreshold}`);
        if (isCombinedMatch) reasons.push(`combined=${combinedDist.toFixed(1)}≤${combinedThreshold}`);
        const severity = (dDist <= threshold/2 || pDist <= pHashThreshold/2) ? '🔴 VERY SIMILAR' : '🟡 SIMILAR';
        log(`  #${i+1} vs #${j+1}: ${severity} [${reasons.join(', ')}]`);
        pairs.push({ i, j, dDistance: dDist, pDistance: pDist, combinedDistance: combinedDist, reasons });
      }
    }
  }

  // Cluster pairs into groups
  const hashDupes = [];
  const assigned = new Set();
  for (const pair of pairs.sort((a, b) => a.combinedDistance - b.combinedDistance)) {
    let found = hashDupes.find(g => g.indices.includes(pair.i) || g.indices.includes(pair.j));
    if (found) {
      if (!found.indices.includes(pair.i)) found.indices.push(pair.i);
      if (!found.indices.includes(pair.j)) found.indices.push(pair.j);
      found.dDistance = Math.max(found.dDistance, pair.dDistance);
      found.pDistance = Math.max(found.pDistance, pair.pDistance);
    } else {
      hashDupes.push({ indices: [pair.i, pair.j], dDistance: pair.dDistance, pDistance: pair.pDistance, reasons: pair.reasons });
    }
  }

  log(`\nFound ${hashDupes.length} hash-based duplicate group(s), ${urlDupes.length} URL-based group(s)`);

  // Save results
  const resultsDir = contentDir(shop.id, 'dedup');
  ensureDir(resultsDir);

  const results = {
    shop: { id: shop.id, name: shop.name, slug: shop.slug, city: shop.city, state: shop.state },
    timestamp: new Date().toISOString(),
    image_count: imageUrls.length,
    threshold,
    hash_duplicate_groups: hashDupes.map(g => ({
      indices_1based: g.indices.map(i => i + 1),
      dHash_distance: g.dDistance,
      pHash_distance: g.pDistance,
      reasons: g.reasons,
      urls: g.indices.map(i => imageUrls[i])
    })),
    url_duplicate_groups: urlDupes.map(g => ({
      indices_1based: g.map(i => i + 1),
      urls: g.map(i => imageUrls[i])
    })),
    hashes: dHashes.map((h, i) => h ? { index: i + 1, dHash: hashToHex(h), pHash: pHashes[i] ? hashToHex(pHashes[i]).slice(0, 32) : null } : null).filter(Boolean),
    errors
  };

  const resultsPath = path.join(resultsDir, `dedup_v2_results_${Date.now()}.json`);
  saveJSON(resultsPath, results);
  log(`Results saved to: ${resultsPath}`);

  // Generate review HTML
  const reviewDir = contentDir(shop.id, 'review');
  ensureDir(reviewDir);
  const reviewPath = path.join(reviewDir, 'dedup_review.html');
  fs.writeFileSync(reviewPath, generateReviewHTML(shop, imageUrls, hashDupes, urlDupes));
  log(`Review HTML saved to: ${reviewPath}`);

  // Summary
  log(`\n--- Summary ---`);
  log(`Total images: ${imageUrls.length}`);
  log(`Hash duplicate groups: ${hashDupes.length}`);
  log(`URL duplicate groups: ${urlDupes.length}`);
  if (hashDupes.length > 0 || urlDupes.length > 0) {
    log(`\nReview the results and apply with:`);
    log(`  node gallery_feedback.js --slug "${shop.slug}" --dupes "idx1,idx2:keep=N"`);
  } else {
    log(`\n✅ No duplicates detected!`);
  }
}

main().catch(e => { console.error('❌ Fatal:', e.message); process.exit(1); });
