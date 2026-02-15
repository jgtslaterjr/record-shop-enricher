#!/usr/bin/env node
/**
 * Gallery Feedback — Apply Human Dedup Decisions
 *
 * Takes human feedback about duplicates/removals and applies to the database.
 * Note: uses 1-based indices matching gallery_review.js serial numbers.
 *
 * Usage:
 *   node gallery_feedback.js --slug "amoeba-music-san-francisco-shops" \
 *     --dupes "3,7:keep=7" --dupes "1,5,9:keep=5" --remove "12,15"
 *
 *   --dupes "idx1,idx2,...:keep=N"  — mark group as duplicates, keep image N
 *   --remove "idx1,idx2"           — remove wrong-location or unwanted images
 *   --dry-run                      — preview changes without updating DB
 */

const { supabase, saveJSON, ensureDir, contentDir, getShopByName, updateShop, log } = require('./lib/common');
const path = require('path');

// Custom arg parser that supports repeated --dupes flags
function parseArgsMulti() {
  const args = { dupes: [], remove: [] };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dupes' && argv[i + 1]) {
      args.dupes.push(argv[++i]);
    } else if (argv[i] === '--remove' && argv[i + 1]) {
      args.remove.push(argv[++i]);
    } else if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        args[key] = argv[++i];
      } else {
        args[key] = true;
      }
    }
  }
  return args;
}

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

function parseDupeGroup(spec) {
  // "3,7:keep=7" → { indices: [3,7], keep: 7 }
  const [idxPart, keepPart] = spec.split(':');
  const indices = idxPart.split(',').map(Number);
  const keep = keepPart ? Number(keepPart.replace('keep=', '')) : null;
  if (!keep || !indices.includes(keep)) {
    throw new Error(`Invalid dupe spec "${spec}": keep index must be in group`);
  }
  return { indices, keep };
}

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

async function main() {
  const args = parseArgsMulti();
  const shop = await resolveShop(args);

  if (!shop || (args.dupes.length === 0 && args.remove.length === 0)) {
    console.log('\nUsage:');
    console.log('  node gallery_feedback.js --slug "shop-slug" \\');
    console.log('    --dupes "3,7:keep=7" --dupes "1,5,9:keep=5" --remove "12,15"');
    console.log('\n  Indices are 1-based (matching gallery_review.js serial numbers)');
    console.log('  --dry-run to preview without applying\n');
    process.exit(0);
  }

  const imageUrls = normalizeUrls(shop.image_gallery);
  log(`${shop.name}: ${imageUrls.length} images`);

  // Parse all groups
  const dupeGroups = args.dupes.map(parseDupeGroup);
  const removeIndices = args.remove.flatMap(r => r.split(',').map(Number));

  // Collect indices to remove (1-based from user, convert to 0-based)
  const toRemove = new Set();
  const reasons = {};

  for (const group of dupeGroups) {
    for (const idx of group.indices) {
      if (idx < 1 || idx > imageUrls.length) {
        log(`⚠ Index ${idx} out of range (1-${imageUrls.length})`);
        continue;
      }
      if (idx !== group.keep) {
        toRemove.add(idx - 1); // convert to 0-based
        reasons[idx - 1] = `Duplicate of #${group.keep}`;
      }
    }
  }

  for (const idx of removeIndices) {
    if (idx < 1 || idx > imageUrls.length) {
      log(`⚠ Index ${idx} out of range (1-${imageUrls.length})`);
      continue;
    }
    toRemove.add(idx - 1);
    reasons[idx - 1] = 'Removed (wrong location / unwanted)';
  }

  // Show preview
  log(`\nWill remove ${toRemove.size} images:`);
  for (const idx of [...toRemove].sort((a, b) => a - b)) {
    log(`  #${String(idx + 1).padStart(3, '0')} ${imageUrls[idx].slice(0, 80)}`);
    log(`        Reason: ${reasons[idx]}`);
  }

  const newGallery = imageUrls.filter((_, i) => !toRemove.has(i));
  log(`\nNew gallery: ${newGallery.length} images (was ${imageUrls.length})`);

  // Save feedback
  const feedbackDir = contentDir(shop.id, 'dedup');
  ensureDir(feedbackDir);
  const feedback = {
    shop: { id: shop.id, name: shop.name, slug: shop.slug, city: shop.city, state: shop.state },
    timestamp: new Date().toISOString(),
    original_count: imageUrls.length,
    new_count: newGallery.length,
    dupe_groups: dupeGroups,
    removed_indices: removeIndices,
    removed_images: [...toRemove].sort((a, b) => a - b).map(i => ({
      index_1based: i + 1, url: imageUrls[i], reason: reasons[i]
    }))
  };

  const feedbackPath = path.join(feedbackDir, `human_feedback_${Date.now()}.json`);
  saveJSON(feedbackPath, feedback);
  log(`Feedback saved to: ${feedbackPath}`);

  if (args['dry-run']) {
    log('\n🔍 Dry run — no database changes made.');
    return;
  }

  // Apply to database
  log('\nUpdating database...');
  await updateShop(shop.id, { image_gallery: newGallery });
  log(`✅ Gallery updated! ${imageUrls.length} → ${newGallery.length} images`);
}

main().catch(e => { console.error('❌ Fatal:', e.message); process.exit(1); });
