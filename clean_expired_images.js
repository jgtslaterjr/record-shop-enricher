#!/usr/bin/env node
/**
 * Clean expired Google photo links from all shops in the database
 * 
 * Usage: node clean_expired_images.js [--batch-size=50] [--limit=100]
 */

const { supabase, parseArgs, log } = require('./lib/common');
const https = require('https');
const http = require('http');

async function checkUrl(url) {
  return new Promise((resolve) => {
    try {
      const urlObj = new URL(url);
      const client = urlObj.protocol === 'https:' ? https : http;
      
      const req = client.request(url, { method: 'HEAD', timeout: 5000 }, (res) => {
        resolve(res.statusCode >= 200 && res.statusCode < 400);
      });
      
      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
      
      req.end();
    } catch (e) {
      resolve(false);
    }
  });
}

async function cleanShopImages(shop, batchStats) {
  if (!Array.isArray(shop.image_gallery) || shop.image_gallery.length === 0) {
    return { checked: 0, removed: 0 };
  }

  const gallery = shop.image_gallery;
  const workingUrls = [];
  let removed = 0;

  for (const url of gallery) {
    const isWorking = await checkUrl(url);
    if (isWorking) {
      workingUrls.push(url);
    } else {
      removed++;
      log(`    ❌ Expired: ${url.substring(0, 80)}...`);
    }
  }

  // Update shop if any URLs were removed
  if (removed > 0) {
    const { error } = await supabase
      .from('shops')
      .update({ image_gallery: workingUrls })
      .eq('id', shop.id);
    
    if (error) {
      log(`    ⚠️  Failed to update ${shop.name}: ${error.message}`);
      return { checked: gallery.length, removed: 0 };
    }
  }

  batchStats.checked += gallery.length;
  batchStats.removed += removed;

  return { checked: gallery.length, removed };
}

async function run() {
  const args = parseArgs();
  const batchSize = parseInt(args['batch-size']) || 50;
  const limit = args.limit ? parseInt(args.limit) : null;

  log('🔍 Starting image gallery cleanup...');
  log(`   Batch size: ${batchSize}${limit ? `, Limit: ${limit}` : ''}`);

  // Fetch all shops with image_gallery
  let query = supabase
    .from('shops')
    .select('id, name, slug, image_gallery')
    .not('image_gallery', 'is', null)
    .order('name');

  if (limit) {
    query = query.limit(limit);
  }

  const { data: shops, error } = await query;

  if (error) {
    log(`❌ Failed to fetch shops: ${error.message}`);
    process.exit(1);
  }

  if (!shops || shops.length === 0) {
    log('No shops with image galleries found.');
    return;
  }

  log(`📊 Found ${shops.length} shops with image galleries\n`);

  const totalStats = {
    shopsProcessed: 0,
    shopsWithRemovals: 0,
    totalImagesChecked: 0,
    totalImagesRemoved: 0
  };

  // Process in batches
  for (let i = 0; i < shops.length; i += batchSize) {
    const batch = shops.slice(i, Math.min(i + batchSize, shops.length));
    const batchNum = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(shops.length / batchSize);
    
    log(`\n📦 Batch ${batchNum}/${totalBatches} (shops ${i + 1}-${Math.min(i + batchSize, shops.length)})`);

    const batchStats = { checked: 0, removed: 0 };

    for (const shop of batch) {
      const result = await cleanShopImages(shop, batchStats);
      totalStats.shopsProcessed++;
      totalStats.totalImagesChecked += result.checked;
      totalStats.totalImagesRemoved += result.removed;

      if (result.removed > 0) {
        totalStats.shopsWithRemovals++;
        log(`  ✓ ${shop.name}: ${result.removed}/${result.checked} removed`);
      } else if (result.checked > 0) {
        log(`  ✓ ${shop.name}: all ${result.checked} images OK`);
      }
    }

    log(`  Batch summary: ${batchStats.checked} checked, ${batchStats.removed} removed`);
    
    // Small delay between batches
    if (i + batchSize < shops.length) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  log('\n' + '='.repeat(60));
  log('✅ Cleanup complete!');
  log(`   Shops processed: ${totalStats.shopsProcessed}`);
  log(`   Shops with removals: ${totalStats.shopsWithRemovals}`);
  log(`   Total images checked: ${totalStats.totalImagesChecked}`);
  log(`   Total images removed: ${totalStats.totalImagesRemoved}`);
  log('='.repeat(60));
}

run().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
