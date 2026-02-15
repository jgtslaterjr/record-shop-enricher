#!/usr/bin/env node
/**
 * Image Gallery Deduplicator with Grok 4.1 Vision AI
 *
 * Removes duplicate and wrong-location images from a shop's image_gallery.
 * Uses Grok Vision to compare all images in a single batch for efficiency.
 *
 * Usage:
 *   node dedup_gallery.js --slug "amoeba-music-san-francisco-shops"
 *   node dedup_gallery.js --shop "Shady Dog" --city "Berwyn" --state "PA"
 *   node dedup_gallery.js --shop-id "uuid"
 */

const { supabase, delay, saveJSON, contentDir, ensureDir, getShopByName,
  updateShop, parseArgs, log } = require('./lib/common');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

require('dotenv').config();
const XAI_API_KEY = process.env.XAI_API_KEY;

if (!XAI_API_KEY) {
  console.error('Error: XAI_API_KEY not found in .env file');
  process.exit(1);
}

// ─── Download Image ─────────────────────────────────────────────────────────

async function downloadImage(imageUrl, tempPath) {
  return new Promise((resolve, reject) => {
    const get = imageUrl.startsWith('https') ? https.get : http.get;
    get(imageUrl, { headers: { 'User-Agent': 'RecordShopEnricher/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadImage(res.headers.location, tempPath).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        fs.writeFileSync(tempPath, buffer);
        resolve(tempPath);
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ─── Grok Vision Batch Analysis ─────────────────────────────────────────────

async function analyzeGalleryWithGrok(shop, imageUrls) {
  if (!XAI_API_KEY) throw new Error('XAI_API_KEY not set');

  const prompt = `You are analyzing ALL images from a shop's image gallery for "${shop.name}" in ${shop.city}, ${shop.state}.

Your task is to:
1. Identify DUPLICATE images (visually similar photos of the same thing, even if slightly different sizes/crops/angles)
2. Identify WRONG-LOCATION images (photos that are clearly from a different store location or unrelated to this specific shop)

I will provide ${imageUrls.length} images numbered 0 through ${imageUrls.length - 1}.

Respond with ONLY valid JSON in this format:
{
  "duplicates": [
    {
      "group": [0, 2, 5],
      "description": "Three similar storefront photos from same angle",
      "keep": 2,
      "reason": "Image 2 has highest resolution and best lighting"
    }
  ],
  "wrong_location": [
    {
      "image": 3,
      "reason": "This is Amoeba Hollywood, not Amoeba San Francisco - different storefront architecture"
    }
  ]
}

IMPORTANT:
- Only mark images as "wrong_location" if you are CERTAIN they are from a different location
- For duplicates, select the highest quality image to keep (best resolution, lighting, composition)
- If there are no duplicates or wrong images, return empty arrays
- Use image index numbers (0-${imageUrls.length - 1}) to reference images`;

  try {
    // Build content array with text prompt and all images
    const content = [{ type: 'text', text: prompt }];

    for (let i = 0; i < imageUrls.length; i++) {
      content.push({
        type: 'image_url',
        image_url: { url: imageUrls[i] }
      });
    }

    log(`  Sending ${imageUrls.length} images to Grok Vision API for batch analysis...`);

    const resp = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${XAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'grok-4-1-fast',
        messages: [{
          role: 'user',
          content
        }],
        temperature: 0.1,
        max_tokens: 2000
      })
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Grok API error ${resp.status}: ${errText.slice(0, 300)}`);
    }

    const data = await resp.json();
    const responseText = data.choices?.[0]?.message?.content || '';

    log(`\n  Grok Response:\n${responseText}\n`);

    // Extract JSON from response (may have markdown code fences)
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error(`Could not extract JSON from Grok response: ${responseText.slice(0, 200)}`);
    }

    const analysis = JSON.parse(jsonMatch[0]);

    // Validate structure
    if (!analysis.duplicates || !Array.isArray(analysis.duplicates)) {
      analysis.duplicates = [];
    }
    if (!analysis.wrong_location || !Array.isArray(analysis.wrong_location)) {
      analysis.wrong_location = [];
    }

    return analysis;
  } catch (e) {
    log(`  Grok API Error: ${e.message}`);
    throw e;
  }
}

// ─── Main Dedup Logic ───────────────────────────────────────────────────────

async function dedupGallery(shop) {
  log(`\n${'='.repeat(60)}`);
  log(`Deduplicating gallery for: ${shop.name} (${shop.city}, ${shop.state})`);
  log(`Shop ID: ${shop.id}`);
  log(`Slug: ${shop.slug || 'N/A'}`);
  log(`${'='.repeat(60)}\n`);

  // Get current image_gallery
  const gallery = shop.image_gallery || [];

  if (gallery.length === 0) {
    log('Gallery is empty. Nothing to dedup.');
    return;
  }

  // Normalize gallery URLs (may be stored as strings or JSON objects)
  const imageUrls = gallery.map(item => {
    if (typeof item === 'string') {
      // Could be plain URL or stringified JSON
      if (item.startsWith('{')) {
        try {
          return JSON.parse(item).url;
        } catch (e) {
          return item;
        }
      }
      return item;
    }
    if (typeof item === 'object' && item.url) {
      return item.url;
    }
    return item;
  }).filter(url => url && typeof url === 'string');

  log(`Current gallery has ${imageUrls.length} images`);

  if (imageUrls.length === 0) {
    log('No valid image URLs found in gallery.');
    return;
  }

  // Show current images
  log('\nCurrent gallery images:');
  imageUrls.forEach((url, i) => {
    log(`  [${i}] ${url}`);
  });

  // Create temp directory for downloads
  const tempDir = path.join('/tmp', `dedup_${shop.id}`);
  ensureDir(tempDir);

  // Download images to temp files (for potential future use)
  log('\nDownloading images for analysis...');
  const downloads = [];
  for (let i = 0; i < imageUrls.length; i++) {
    const url = imageUrls[i];
    const ext = url.includes('.png') ? 'png' : url.includes('.webp') ? 'webp' : 'jpg';
    const tempPath = path.join(tempDir, `image_${i}.${ext}`);

    try {
      log(`  Downloading [${i}] ${url.slice(0, 80)}...`);
      await downloadImage(url, tempPath);
      downloads.push({ index: i, url, path: tempPath });
    } catch (e) {
      log(`    ⚠ Download failed: ${e.message}`);
      downloads.push({ index: i, url, path: null, error: e.message });
    }

    // Rate limit
    await delay(300, 600);
  }

  // Analyze with Grok Vision
  log('\n--- Analyzing gallery with Grok Vision AI ---\n');
  const analysis = await analyzeGalleryWithGrok(shop, imageUrls);

  // Process results
  log('\n--- Analysis Results ---\n');

  const imagesToRemove = new Set();
  const removalReasons = {};

  // Process duplicates
  if (analysis.duplicates && analysis.duplicates.length > 0) {
    log(`Found ${analysis.duplicates.length} duplicate group(s):\n`);

    for (const dupGroup of analysis.duplicates) {
      const { group, description, keep, reason } = dupGroup;
      log(`  Duplicate Group: ${description}`);
      log(`    Images: [${group.join(', ')}]`);
      log(`    Keeping: [${keep}] - ${reason}`);

      // Mark all images in group except the one to keep
      for (const idx of group) {
        if (idx !== keep) {
          imagesToRemove.add(idx);
          removalReasons[idx] = `Duplicate of [${keep}]: ${description}`;
        }
      }
      log('');
    }
  } else {
    log('No duplicates found.\n');
  }

  // Process wrong location images
  if (analysis.wrong_location && analysis.wrong_location.length > 0) {
    log(`Found ${analysis.wrong_location.length} wrong-location image(s):\n`);

    for (const wrong of analysis.wrong_location) {
      const { image, reason } = wrong;
      log(`  [${image}] Wrong location - ${reason}`);
      imagesToRemove.add(image);
      removalReasons[image] = `Wrong location: ${reason}`;
    }
    log('');
  } else {
    log('No wrong-location images found.\n');
  }

  // Build new gallery
  const newGallery = imageUrls.filter((url, idx) => !imagesToRemove.has(idx));

  log(`\n--- Summary ---`);
  log(`Original gallery: ${imageUrls.length} images`);
  log(`Images to remove: ${imagesToRemove.size}`);
  log(`New gallery: ${newGallery.length} images\n`);

  if (imagesToRemove.size > 0) {
    log('Removed images:');
    Array.from(imagesToRemove).sort((a, b) => a - b).forEach(idx => {
      log(`  [${idx}] ${imageUrls[idx]}`);
      log(`       Reason: ${removalReasons[idx]}`);
    });
    log('');
  }

  // Save analysis results
  const resultsDir = contentDir(shop.id, 'dedup');
  ensureDir(resultsDir);
  const resultsPath = path.join(resultsDir, `dedup_results_${Date.now()}.json`);
  saveJSON(resultsPath, {
    shop: { id: shop.id, name: shop.name, slug: shop.slug, city: shop.city, state: shop.state },
    timestamp: new Date().toISOString(),
    original_count: imageUrls.length,
    removed_count: imagesToRemove.size,
    new_count: newGallery.length,
    analysis,
    removed_images: Array.from(imagesToRemove).map(idx => ({
      index: idx,
      url: imageUrls[idx],
      reason: removalReasons[idx]
    }))
  });
  log(`Analysis saved to: ${resultsPath}\n`);

  // Update database
  if (imagesToRemove.size > 0) {
    log('Updating database...');
    await updateShop(shop.id, { image_gallery: newGallery });
    log(`✅ Gallery updated successfully!\n`);
  } else {
    log('No changes needed - gallery is already clean!\n');
  }

  // Cleanup temp files
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
    log(`Cleaned up temp files from ${tempDir}`);
  } catch (e) {
    log(`Note: Could not cleanup temp files: ${e.message}`);
  }

  log(`\n${'='.repeat(60)}`);
  log('Deduplication complete!');
  log(`${'='.repeat(60)}\n`);
}

// ─── CLI Entry Point ────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();
  let shop = null;

  if (args.slug) {
    const { data, error } = await supabase.from('shops').select('*').eq('slug', args.slug).single();
    if (error || !data) {
      log(`❌ Shop not found with slug: ${args.slug}`);
      if (error) log(`Error: ${error.message}`);
      process.exit(1);
    }
    shop = data;
  } else if (args['shop-id']) {
    const { data, error } = await supabase.from('shops').select('*').eq('id', args['shop-id']).single();
    if (error || !data) {
      log(`❌ Shop not found with ID: ${args['shop-id']}`);
      if (error) log(`Error: ${error.message}`);
      process.exit(1);
    }
    shop = data;
  } else if (args.shop && args.city && args.state) {
    const shops = await getShopByName(args.shop, args.city, args.state);
    if (shops.length === 0) {
      log(`❌ Shop not found: ${args.shop} in ${args.city}, ${args.state}`);
      process.exit(1);
    }
    if (shops.length > 1) {
      log(`Multiple shops found:`);
      shops.forEach(s => log(`  - ${s.name} (${s.city}, ${s.state}) [ID: ${s.id}]`));
      log(`Using first match.`);
    }
    shop = shops[0];
  } else {
    console.log('\nUsage:');
    console.log('  node dedup_gallery.js --slug "amoeba-music-san-francisco-shops"');
    console.log('  node dedup_gallery.js --shop "Shady Dog" --city "Berwyn" --state "PA"');
    console.log('  node dedup_gallery.js --shop-id "uuid"\n');
    process.exit(0);
  }

  await dedupGallery(shop);
}

main().catch(e => {
  console.error('\n❌ Fatal Error:', e);
  console.error(e.stack);
  process.exit(1);
});
