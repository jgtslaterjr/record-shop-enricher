#!/usr/bin/env node
/**
 * Multi-source Image Scraper with AI-powered review (Grok 4.1 Vision)
 * 
 * Usage:
 *   node scrape_images.js --shop "Shady Dog" --city "Berwyn" --state "PA"
 *   node scrape_images.js --slug "shady_dog_record_disc_exchange_berwyn_berwyn_pa"
 *   node scrape_images.js --all --limit 10
 */

const { supabase, delay, saveJSON, loadJSON, contentDir, ensureDir, getAllShops,
  getShopByName, updateShop, createStealthBrowser, parseArgs, log } = require('./lib/common');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { URL } = require('url');

const XAI_API_KEY = process.env.XAI_API_KEY;
const APIFY_API_TOKEN = process.env.APIFY_API_TOKEN;

// ─── Image Source: Google Maps Photos ───────────────────────────────────────

async function scrapeGooglePhotos(page, shopName, city, state) {
  const images = [];
  try {
    const query = encodeURIComponent(`${shopName} record store ${city} ${state}`);
    const url = `https://www.google.com/maps/search/${query}`;
    log(`  [Google] Searching: ${shopName}, ${city}, ${state}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await delay(3000, 5000);

    // Click first result
    try {
      const firstResult = await page.$('a[href*="/maps/place/"], div[role="feed"] > div:first-child');
      if (firstResult) { await firstResult.click(); await delay(2000, 3000); }
    } catch (e) {}

    // Click photos tab/button
    try {
      const photosBtn = await page.$('button[aria-label*="Photos"], button[data-tab-index="1"]');
      if (photosBtn) { await photosBtn.click(); await delay(2000, 3000); }
    } catch (e) {}

    // Scroll to load more photos
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => {
        const scrollable = document.querySelector('div[role="main"]');
        if (scrollable) scrollable.scrollTop += 500;
      });
      await delay(1000, 2000);
    }

    // Extract photo URLs
    const photoUrls = await page.evaluate(() => {
      const urls = [];
      // Google Maps photos are in img tags or background-image divs
      document.querySelectorAll('img[src*="googleusercontent"], img[src*="gstatic"]').forEach(img => {
        const src = img.src;
        if (src && !src.includes('=s') || src.includes('=s')) {
          // Upscale to larger size
          const highRes = src.replace(/=s\d+/, '=s800').replace(/=w\d+-h\d+/, '=w800-h600');
          urls.push(highRes);
        }
      });
      // Also check background images
      document.querySelectorAll('[style*="background-image"]').forEach(el => {
        const match = el.style.backgroundImage.match(/url\("?([^"]+)"?\)/);
        if (match && (match[1].includes('googleusercontent') || match[1].includes('gstatic'))) {
          urls.push(match[1].replace(/=s\d+/, '=s800'));
        }
      });
      return [...new Set(urls)];
    });

    for (const url of photoUrls.slice(0, 15)) {
      images.push({ url, source: 'google_maps' });
    }
    log(`  [Google] Found ${images.length} photos`);
  } catch (e) {
    log(`  [Google] Error: ${e.message}`);
  }
  return images;
}

// ─── Image Source: Yelp Photos ──────────────────────────────────────────────

async function scrapeYelpPhotos(page, yelpUrl) {
  const images = [];
  if (!yelpUrl) { log('  [Yelp] No yelp_url, skipping'); return images; }
  try {
    // Strip query params from yelp URL before adding /photos
    const yelpClean = yelpUrl.split('?')[0].replace(/\/$/, '');
    const photosUrl = yelpClean + '/photos';
    log(`  [Yelp] Scraping: ${photosUrl}`);
    await page.goto(photosUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await delay(3000, 5000);

    // Scroll to load more
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => window.scrollBy(0, 800));
      await delay(1000, 2000);
    }

    const photoUrls = await page.evaluate(() => {
      const urls = [];
      document.querySelectorAll('img[src*="yelpcdn"], img[src*="yelp"]').forEach(img => {
        let src = img.src;
        if (src && src.includes('bphoto')) {
          // Get original size
          src = src.replace(/\/[a-z]+\.jpg/, '/o.jpg').replace(/\/ls\.jpg/, '/o.jpg');
          urls.push(src);
        }
      });
      return [...new Set(urls)];
    });

    for (const url of photoUrls.slice(0, 15)) {
      images.push({ url, source: 'yelp' });
    }
    log(`  [Yelp] Found ${images.length} photos`);
  } catch (e) {
    log(`  [Yelp] Error: ${e.message}`);
  }
  return images;
}

// ─── Image Source: Instagram via Apify ──────────────────────────────────────

async function scrapeInstagramPhotos(instagramUrl) {
  const images = [];
  if (!instagramUrl || !APIFY_API_TOKEN) {
    log('  [Instagram] No URL or Apify token, skipping');
    return images;
  }
  try {
    log(`  [Instagram] Scraping via Apify: ${instagramUrl}`);
    // Extract username
    const match = instagramUrl.match(/instagram\.com\/([^/?]+)/);
    if (!match) return images;
    const username = match[1];

    // Start Apify actor run
    const runResponse = await fetch(`https://api.apify.com/v2/acts/apify~instagram-post-scraper/runs?token=${APIFY_API_TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: [username],
        resultsLimit: 12,
      })
    });
    const run = await runResponse.json();
    if (!run.data?.id) { log('  [Instagram] Failed to start Apify run'); return images; }

    // Wait for completion (up to 2 minutes)
    const runId = run.data.id;
    for (let i = 0; i < 24; i++) {
      await delay(5000, 5000);
      const statusResp = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_API_TOKEN}`);
      const status = await statusResp.json();
      if (status.data?.status === 'SUCCEEDED') break;
      if (status.data?.status === 'FAILED' || status.data?.status === 'ABORTED') {
        log('  [Instagram] Apify run failed'); return images;
      }
    }

    // Get results
    const dataResp = await fetch(`https://api.apify.com/v2/actor-runs/${runId}/dataset/items?token=${APIFY_API_TOKEN}`);
    const posts = await dataResp.json();
    for (const post of posts) {
      if (post.displayUrl) {
        images.push({ url: post.displayUrl, source: 'instagram' });
      }
      // Also check carousel images
      if (post.images) {
        for (const img of post.images) {
          if (img) images.push({ url: img, source: 'instagram' });
        }
      }
    }
    log(`  [Instagram] Found ${images.length} photos`);
  } catch (e) {
    log(`  [Instagram] Error: ${e.message}`);
  }
  return images;
}

// ─── Image Source: Instagram via Playwright (free fallback) ─────────────────

async function scrapeInstagramPhotosDirect(instagramUrl) {
  const images = [];
  if (!instagramUrl) return images;
  try {
    log(`  [Instagram/Direct] Scraping via Playwright: ${instagramUrl}`);
    const match = instagramUrl.match(/instagram\.com\/([^/?]+)/);
    if (!match) return images;
    const username = match[1];

    const { browser, context, page } = await createStealthBrowser();
    try {
      // Instagram embeds JSON data in the page for public profiles
      await page.goto(`https://www.instagram.com/${username}/`, { waitUntil: 'networkidle', timeout: 30000 });
      await delay(2000, 3000);

      // Try to extract image URLs from the rendered page
      const photoUrls = await page.evaluate(() => {
        const urls = [];
        // Instagram renders images in article elements or main content
        document.querySelectorAll('img[src*="cdninstagram.com"]').forEach(img => {
          if (img.src && img.naturalWidth > 100) {
            urls.push(img.src);
          }
        });
        return [...new Set(urls)];
      });

      for (const url of photoUrls.slice(0, 12)) {
        images.push({ url, source: 'instagram_direct' });
      }
      log(`  [Instagram/Direct] Found ${images.length} photos`);
    } finally {
      await browser.close();
    }
  } catch (e) {
    log(`  [Instagram/Direct] Error: ${e.message}`);
  }
  return images;
}

// ─── Image Source: Reddit ───────────────────────────────────────────────────

async function scrapeRedditImages(shopName, city) {
  const images = [];
  const subreddits = ['vinyl', 'vinylcollecting', 'crate_digging'];
  const searchQuery = `${shopName} ${city}`;
  
  try {
    // Global search
    const searches = [
      `https://www.reddit.com/search.json?q=${encodeURIComponent(searchQuery)}&sort=relevance&limit=25`,
      ...subreddits.map(sub =>
        `https://www.reddit.com/r/${sub}/search.json?q=${encodeURIComponent(searchQuery)}&restrict_sr=on&sort=relevance&limit=25`
      )
    ];

    for (const searchUrl of searches) {
      try {
        log(`  [Reddit] Searching: ${searchUrl.split('?')[0]}`);
        const resp = await fetch(searchUrl, {
          headers: { 'User-Agent': 'RecordShopEnricher/1.0' }
        });
        if (!resp.ok) { await delay(2000, 3000); continue; }
        const data = await resp.json();
        const posts = data?.data?.children || [];

        for (const post of posts) {
          const p = post.data;
          // Direct image URLs
          if (p.url && /\.(jpg|jpeg|png|gif|webp)(\?.*)?$/i.test(p.url)) {
            images.push({ url: p.url, source: 'reddit', postTitle: p.title });
          }
          // Preview images
          if (p.preview?.images) {
            for (const img of p.preview.images) {
              if (img.source?.url) {
                images.push({ url: img.source.url.replace(/&amp;/g, '&'), source: 'reddit', postTitle: p.title });
              }
            }
          }
          // Gallery data
          if (p.is_gallery && p.media_metadata) {
            for (const [id, meta] of Object.entries(p.media_metadata)) {
              if (meta.s?.u) {
                images.push({ url: meta.s.u.replace(/&amp;/g, '&'), source: 'reddit', postTitle: p.title });
              }
            }
          }
        }
        await delay(1500, 2500); // Rate limit
      } catch (e) {
        log(`  [Reddit] Search error: ${e.message}`);
      }
    }
    log(`  [Reddit] Found ${images.length} candidate images`);
  } catch (e) {
    log(`  [Reddit] Error: ${e.message}`);
  }
  return images;
}

// ─── Image Source: Shop Website ─────────────────────────────────────────────

async function scrapeWebsiteImages(page, websiteUrl) {
  const images = [];
  if (!websiteUrl) { log('  [Website] No website URL, skipping'); return images; }
  try {
    log(`  [Website] Crawling: ${websiteUrl}`);
    await page.goto(websiteUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await delay(2000, 3000);

    // Scroll page
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => window.scrollBy(0, 600));
      await delay(800, 1200);
    }

    const photoUrls = await page.evaluate(() => {
      const urls = [];
      document.querySelectorAll('img').forEach(img => {
        const src = img.src || img.dataset.src || img.dataset.lazySrc;
        if (!src) return;
        // Filter small images (icons, etc)
        const w = img.naturalWidth || parseInt(img.getAttribute('width')) || 0;
        const h = img.naturalHeight || parseInt(img.getAttribute('height')) || 0;
        if (w > 0 && w < 200) return;
        if (h > 0 && h < 200) return;
        // Skip common non-photo patterns
        if (/logo|icon|sprite|pixel|spacer|arrow|button|badge/i.test(src)) return;
        if (src.startsWith('data:')) return;
        urls.push(src);
      });
      return [...new Set(urls)];
    });

    for (const url of photoUrls.slice(0, 20)) {
      images.push({ url, source: 'website' });
    }
    log(`  [Website] Found ${images.length} candidate images`);
  } catch (e) {
    log(`  [Website] Error: ${e.message}`);
  }
  return images;
}

// ─── AI Image Review (Grok 4.1 Vision) ─────────────────────────────────────

async function reviewImageWithGrok(imageUrl) {
  if (!XAI_API_KEY) throw new Error('XAI_API_KEY not set');
  
  const prompt = `You are reviewing an image that may be related to a record shop (vinyl record store).
Rate this image from 1-10 based on quality and relevance for a record shop's image gallery.
Classify it into one of these categories:
- storefront: exterior shop photo
- interior: inside the shop, showing records/bins/shelves
- product: close-up of records, gear, merch
- event: in-store event, performance, Record Store Day
- people: staff, customers, owner
- other: not useful for a record shop page (menus, logos, unrelated, blurry, etc.)

Respond with ONLY valid JSON:
{"score": <1-10>, "category": "<category>", "description": "<brief description>"}`;

  try {
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
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: imageUrl } }
          ]
        }],
        temperature: 0.1,
        max_tokens: 200
      })
    });

    if (!resp.ok) {
      const errText = await resp.text();
      log(`    [Grok] API error ${resp.status}: ${errText.slice(0, 200)}`);
      return null;
    }

    const data = await resp.json();
    const content = data.choices?.[0]?.message?.content || '';
    
    // Extract JSON from response
    const jsonMatch = content.match(/\{[^}]+\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    log(`    [Grok] Could not parse response: ${content.slice(0, 100)}`);
    return null;
  } catch (e) {
    log(`    [Grok] Error: ${e.message}`);
    return null;
  }
}

// ─── Upload to Supabase Storage ─────────────────────────────────────────────

async function downloadImage(imageUrl) {
  return new Promise((resolve, reject) => {
    const get = imageUrl.startsWith('https') ? https.get : http.get;
    get(imageUrl, { headers: { 'User-Agent': 'RecordShopEnricher/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadImage(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function uploadToSupabase(imageUrl, shopSlug, index) {
  try {
    const buffer = await downloadImage(imageUrl);
    if (buffer.length < 5000) {
      log(`    Skipping tiny image (${buffer.length} bytes)`);
      return null;
    }

    // Determine extension
    let ext = 'jpg';
    if (imageUrl.includes('.png')) ext = 'png';
    else if (imageUrl.includes('.webp')) ext = 'webp';

    const filePath = `gallery/${shopSlug}/${Date.now()}_${index}.${ext}`;
    
    const { data, error } = await supabase.storage
      .from('shop-logos')
      .upload(filePath, buffer, {
        contentType: `image/${ext === 'jpg' ? 'jpeg' : ext}`,
        upsert: false
      });

    if (error) {
      log(`    Upload error: ${error.message}`);
      return null;
    }

    const { data: { publicUrl } } = supabase.storage
      .from('shop-logos')
      .getPublicUrl(filePath);

    return publicUrl;
  } catch (e) {
    log(`    Upload failed: ${e.message}`);
    return null;
  }
}

// ─── Main Scraper ───────────────────────────────────────────────────────────

async function scrapeImagesForShop(shop) {
  log(`\n${'='.repeat(60)}`);
  log(`Scraping images for: ${shop.name} (${shop.city}, ${shop.state})`);
  log(`${'='.repeat(60)}`);

  const allCandidates = [];
  const seenUrls = new Set();

  function addCandidates(candidates) {
    for (const c of candidates) {
      if (!c.url || seenUrls.has(c.url)) continue;
      // Fix protocol-relative URLs
      if (c.url.startsWith('//')) c.url = 'https:' + c.url;
      // Skip non-http URLs
      if (!c.url.startsWith('http')) continue;
      seenUrls.add(c.url);
      allCandidates.push(c);
    }
  }

  // Launch browser for Playwright-based sources
  let browser, context, page;
  try {
    ({ browser, context } = await createStealthBrowser());
    page = await context.newPage();
  } catch (e) {
    log(`Failed to launch browser: ${e.message}`);
    return;
  }

  try {
    // 1. Google Maps Photos
    addCandidates(await scrapeGooglePhotos(page, shop.name, shop.city, shop.state));

    // 2. Yelp Photos
    addCandidates(await scrapeYelpPhotos(page, shop.yelp_url));

    // 3. Shop Website
    addCandidates(await scrapeWebsiteImages(page, shop.website));

  } finally {
    await browser.close();
  }

  // 4. Instagram (Apify, with Playwright fallback)
  let igPhotos = await scrapeInstagramPhotos(shop.social_instagram);
  if (igPhotos.length === 0 && shop.social_instagram) {
    igPhotos = await scrapeInstagramPhotosDirect(shop.social_instagram);
  }
  addCandidates(igPhotos);

  // 5. Reddit
  addCandidates(await scrapeRedditImages(shop.name, shop.city));

  log(`\nTotal unique candidate images: ${allCandidates.length}`);

  if (allCandidates.length === 0) {
    log('No candidate images found. Done.');
    return;
  }

  // ─── AI Review ────────────────────────────────────────────────────────
  log('\n--- AI Image Review (Grok 4.1 Vision) ---');
  const approved = [];
  const reviewed = [];
  const maxReview = parseInt(parseArgs()['max-review']) || allCandidates.length;
  const toReview = allCandidates.slice(0, maxReview);
  if (maxReview < allCandidates.length) log(`  Limiting review to ${maxReview}/${allCandidates.length} images`);

  for (let i = 0; i < toReview.length; i++) {
    const candidate = toReview[i];
    log(`  Reviewing ${i + 1}/${allCandidates.length}: ${candidate.source} - ${candidate.url.slice(0, 80)}...`);

    const review = await reviewImageWithGrok(candidate.url);
    if (!review) {
      log(`    ⚠ Could not review`);
      continue;
    }

    reviewed.push({ ...candidate, review });
    log(`    Score: ${review.score}/10, Category: ${review.category} - ${review.description || ''}`);

    if (review.score >= 6 && review.category !== 'other') {
      approved.push({ ...candidate, review });
      log(`    ✅ Approved`);
    } else {
      log(`    ❌ Rejected`);
    }

    // Rate limit xAI API calls
    await delay(500, 1000);
  }

  log(`\nApproved: ${approved.length}/${allCandidates.length} images`);

  // Save review results
  const reviewDir = contentDir(shop.id, 'images');
  ensureDir(reviewDir);
  saveJSON(path.join(reviewDir, 'review_results.json'), {
    shop: { id: shop.id, name: shop.name, slug: shop.slug },
    timestamp: new Date().toISOString(),
    totalCandidates: allCandidates.length,
    approved: approved.length,
    reviewed
  });

  if (approved.length === 0) {
    log('No images approved. Done.');
    return;
  }

  // ─── Upload & Update ─────────────────────────────────────────────────
  log('\n--- Uploading approved images ---');
  const uploadedUrls = [];

  for (let i = 0; i < approved.length; i++) {
    const img = approved[i];
    log(`  Uploading ${i + 1}/${approved.length}: ${img.review.category} (score ${img.review.score})`);
    
    const publicUrl = await uploadToSupabase(img.url, shop.slug, i);
    if (publicUrl) {
      uploadedUrls.push({
        url: publicUrl,
        source: img.source,
        category: img.review.category,
        score: img.review.score,
        description: img.review.description,
        uploadedAt: new Date().toISOString()
      });
      log(`    ✅ Uploaded: ${publicUrl}`);
    }
  }

  if (uploadedUrls.length > 0) {
    // Append to existing image_gallery
    const existing = shop.image_gallery || [];
    // Normalize existing entries to plain URL strings
    const existingNorm = existing.map(e => {
      if (typeof e === 'string' && e.startsWith('{')) { try { return JSON.parse(e).url; } catch(_) { return e; } }
      if (typeof e === 'object' && e.url) return e.url;
      return e;
    });
    const existingUrls = new Set(existingNorm);
    const newUrls = uploadedUrls.map(u => u.url).filter(url => !existingUrls.has(url));
    
    const updatedGallery = [...existingNorm, ...newUrls];
    await updateShop(shop.id, { image_gallery: updatedGallery });
    log(`\n✅ Updated image_gallery: ${existingNorm.length} existing + ${newUrls.length} new = ${updatedGallery.length} total`);
    
    // Save metadata separately
    saveJSON(path.join(reviewDir, 'gallery_metadata.json'), uploadedUrls);
  }

  log(`\nDone with ${shop.name}!`);
}

// ─── CLI Entry Point ────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();
  let shops = [];

  if (args.slug) {
    const { data, error } = await supabase.from('shops').select('*').eq('slug', args.slug).single();
    if (error || !data) { log(`Shop not found: ${args.slug}`); process.exit(1); }
    shops = [data];
  } else if (args.shop) {
    shops = await getShopByName(args.shop, args.city, args.state);
    if (shops.length === 0) { log(`Shop not found: ${args.shop}`); process.exit(1); }
    if (shops.length > 1) {
      log(`Multiple shops found:`);
      shops.forEach(s => log(`  - ${s.name} (${s.city}, ${s.state}) [${s.slug}]`));
      log(`Using first match.`);
      shops = [shops[0]];
    }
  } else if (args.all) {
    shops = await getAllShops(parseInt(args.limit) || undefined);
  } else if (args['shop-id']) {
    const { data, error } = await supabase.from('shops').select('*').eq('id', args['shop-id']).single();
    if (error || !data) { log(`Shop not found by ID: ${args['shop-id']}`); process.exit(1); }
    shops = [data];
  } else {
    console.log('Usage:');
    console.log('  node scrape_images.js --shop "Shady Dog" --city "Berwyn" --state "PA"');
    console.log('  node scrape_images.js --slug "shop_slug_here"');
    console.log('  node scrape_images.js --shop-id "uuid"');
    console.log('  node scrape_images.js --all --limit 10');
    process.exit(0);
  }

  log(`Processing ${shops.length} shop(s)...`);
  for (const shop of shops) {
    await scrapeImagesForShop(shop);
  }
  log('\nAll done!');
}

main().catch(e => { console.error(e); process.exit(1); });
