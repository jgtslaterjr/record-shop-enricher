#!/usr/bin/env node
/**
 * Gallery Review — Visual Contact Sheet Generator
 *
 * Generates an HTML contact sheet showing all images from a shop's gallery
 * with serial numbers for easy reference during dedup review.
 *
 * Usage:
 *   node gallery_review.js --slug "amoeba-music-san-francisco-shops"
 *   node gallery_review.js --shop-id "uuid"
 *   node gallery_review.js --shop "Shady Dog" --city "Berwyn" --state "PA"
 */

const { supabase, ensureDir, contentDir, getShopByName, parseArgs, log } = require('./lib/common');
const fs = require('fs');
const path = require('path');

function normalizeUrls(gallery) {
  return (gallery || []).map(item => {
    if (typeof item === 'string') {
      if (item.startsWith('{')) {
        try { return JSON.parse(item).url; } catch (e) { return item; }
      }
      return item;
    }
    if (typeof item === 'object' && item.url) return item.url;
    return item;
  }).filter(url => url && typeof url === 'string');
}

function truncateUrl(url, maxLen = 60) {
  if (url.length <= maxLen) return url;
  return url.slice(0, maxLen - 3) + '...';
}

function generateHTML(shop, imageUrls) {
  const cards = imageUrls.map((url, i) => {
    const num = String(i + 1).padStart(3, '0');
    return `
      <div class="card">
        <div class="img-wrap">
          <img src="${url}" loading="lazy" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%22200%22 height=%22150%22><rect fill=%22%23ddd%22 width=%22200%22 height=%22150%22/><text x=%2250%%22 y=%2250%%22 dominant-baseline=%22middle%22 text-anchor=%22middle%22 fill=%22%23999%22 font-size=%2214%22>Failed</text></svg>'">
          <div class="serial">#${num}</div>
        </div>
        <div class="url" title="${url}">${truncateUrl(url)}</div>
      </div>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Gallery Review: ${shop.name}</title>
<style>
  body { font-family: -apple-system, sans-serif; background: #1a1a1a; color: #eee; margin: 20px; }
  h1 { margin-bottom: 4px; }
  .meta { color: #aaa; margin-bottom: 20px; }
  .grid { display: flex; flex-wrap: wrap; gap: 12px; }
  .card { width: 210px; }
  .img-wrap { position: relative; background: #333; min-height: 100px; }
  .img-wrap img { width: 200px; display: block; }
  .serial { position: absolute; bottom: 0; left: 0; right: 0; background: rgba(255,255,255,0.9);
    color: #000; font-weight: bold; font-size: 14px; padding: 2px 6px; text-align: center; }
  .url { font-size: 10px; color: #888; word-break: break-all; margin-top: 4px; }
</style>
</head>
<body>
<h1>${shop.name}</h1>
<div class="meta">${shop.city}, ${shop.state} &mdash; ${imageUrls.length} images &mdash; ID: ${shop.id}</div>
<div class="grid">
${cards}
</div>
</body>
</html>`;
}

async function resolveShop(args) {
  if (args.slug) {
    const { data, error } = await supabase.from('shops').select('*').eq('slug', args.slug).single();
    if (error || !data) { log(`❌ Shop not found with slug: ${args.slug}`); process.exit(1); }
    return data;
  }
  if (args['shop-id']) {
    const { data, error } = await supabase.from('shops').select('*').eq('id', args['shop-id']).single();
    if (error || !data) { log(`❌ Shop not found with ID: ${args['shop-id']}`); process.exit(1); }
    return data;
  }
  if (args.shop && args.city && args.state) {
    const shops = await getShopByName(args.shop, args.city, args.state);
    if (shops.length === 0) { log(`❌ Shop not found: ${args.shop}`); process.exit(1); }
    return shops[0];
  }
  return null;
}

async function main() {
  const args = parseArgs();
  const shop = await resolveShop(args);

  if (!shop) {
    console.log('\nUsage:');
    console.log('  node gallery_review.js --slug "amoeba-music-san-francisco-shops"');
    console.log('  node gallery_review.js --shop-id "uuid"');
    console.log('  node gallery_review.js --shop "Shady Dog" --city "Berwyn" --state "PA"\n');
    process.exit(0);
  }

  const imageUrls = normalizeUrls(shop.image_gallery);
  log(`${shop.name}: ${imageUrls.length} images`);

  if (imageUrls.length === 0) {
    log('Gallery is empty. Nothing to review.');
    return;
  }

  const outDir = contentDir(shop.id, 'review');
  ensureDir(outDir);
  const outPath = path.join(outDir, 'gallery_review.html');
  fs.writeFileSync(outPath, generateHTML(shop, imageUrls));
  log(`✅ Review sheet saved to: ${outPath}`);
  console.log(outPath);
}

main().catch(e => { console.error('❌ Fatal:', e.message); process.exit(1); });
