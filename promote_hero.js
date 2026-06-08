#!/usr/bin/env node
/**
 * Promote a hero image for shops missing image_hero_url.
 *
 * Strategy (best → worst):
 *   1. First Supabase-storage URL from google_reviews.json `photos` array
 *      (these are stable, already uploaded to our bucket, expire-safe)
 *   2. First URL from yelp_reviews.json `photos`
 *   3. First URL from instagram step (top post media)
 *
 * Fill-NULLs-only: never overwrites an existing image_hero_url.
 *
 * Usage:
 *   node promote_hero.js --shop-id <uuid>
 *   node promote_hero.js --all  # backfill all NULL heroes
 */

const fs = require('fs');
const path = require('path');
const { supabase, parseArgs, log, contentDir } = require('./lib/common');

function firstUrl(jsonPath, key = 'photos') {
  try {
    if (!fs.existsSync(jsonPath)) return null;
    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    const arr = data[key];
    if (!Array.isArray(arr) || arr.length === 0) return null;
    // Prefer Supabase-storage URL (stable)
    const stable = arr.find(u => typeof u === 'string' && u.includes('supabase.co/storage'));
    if (stable) return stable;
    return typeof arr[0] === 'string' ? arr[0] : (arr[0]?.url || null);
  } catch {
    return null;
  }
}

async function promoteHero(shop) {
  if (shop.image_hero_url) {
    log(`  Hero already set: ${shop.image_hero_url.slice(0, 80)}...`);
    return { skipped: true };
  }

  const shopId = shop.id;
  const candidates = [
    { source: 'google', url: firstUrl(contentDir(shopId, 'reviews', 'google_reviews.json')) },
    { source: 'yelp',   url: firstUrl(contentDir(shopId, 'reviews', 'yelp_reviews.json')) },
  ];

  const winner = candidates.find(c => c.url);
  if (!winner) {
    log(`  No hero candidate found for ${shop.name}`);
    return { skipped: true };
  }

  const { error } = await supabase.from('shops').update({ image_hero_url: winner.url }).eq('id', shopId);
  if (error) {
    log(`  ⚠️  Hero update failed: ${error.message}`);
    return { error: error.message };
  }
  log(`  ✓ Promoted hero (${winner.source}): ${winner.url.slice(0, 80)}...`);
  return { promoted: winner.url, source: winner.source };
}

async function run() {
  const args = parseArgs();

  if (args['shop-id']) {
    const { data: shop, error } = await supabase.from('shops').select('id, name, image_hero_url').eq('id', args['shop-id']).single();
    if (error) { console.error(error); process.exit(1); }
    log(`📸 Promoting hero for ${shop.name}...`);
    await promoteHero(shop);
    return;
  }

  if (args.all) {
    const { data: shops, error } = await supabase.from('shops').select('id, name, image_hero_url').is('image_hero_url', null);
    if (error) { console.error(error); process.exit(1); }
    log(`📸 Backfilling hero for ${shops.length} shops...`);
    let promoted = 0, skipped = 0;
    for (const shop of shops) {
      const r = await promoteHero(shop);
      if (r.promoted) promoted++; else skipped++;
    }
    log(`\n✓ Done: ${promoted} promoted, ${skipped} skipped`);
    return;
  }

  console.log('Usage: node promote_hero.js --shop-id <uuid> | --all');
  process.exit(1);
}

if (require.main === module) run();
module.exports = { promoteHero };
