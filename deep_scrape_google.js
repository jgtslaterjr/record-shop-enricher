#!/usr/bin/env node
/**
 * Deep Google Maps Scraper — Ratings, reviews, popular times, photos, Q&A
 * 
 * Usage:
 *   node deep_scrape_google.js --shop "Shady Dog" --city "Berwyn" --state "PA"
 *   node deep_scrape_google.js --all --limit 10
 *   node deep_scrape_google.js --shop-id "uuid"
 */

const { delay, saveJSON, contentDir, getAllShops, getShopByName,
  updateShop, createStealthBrowser, parseArgs, log, supabase, downloadAndStoreImage } = require('./lib/common');

async function scrapeGoogleMaps(page, shopName, city, state, slug = null) {
  const query = encodeURIComponent(`${shopName} record store ${city} ${state}`);
  const url = `https://www.google.com/maps/search/${query}`;
  
  log(`  Searching Google Maps: ${shopName}, ${city}, ${state}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await delay(3000, 5000);

  // Click the first result if we're on a search results page
  try {
    const firstResult = await page.$('a[href*="/maps/place/"], div[role="feed"] > div:first-child');
    if (firstResult) {
      await firstResult.click();
      await delay(2000, 3000);
    }
  } catch (e) {}

  // Wait for business details to load
  await delay(2000, 3000);

  // Extract data from the business panel
  const data = await page.evaluate(() => {
    const getText = (sel) => document.querySelector(sel)?.textContent?.trim() || null;

    // Name
    const name = getText('h1') || getText('[data-attrid="title"]');

    // Rating
    const ratingEl = document.querySelector('span[aria-label*="stars"], div[role="img"][aria-label*="stars"]');
    let rating = null;
    if (ratingEl) {
      const match = ratingEl.getAttribute('aria-label')?.match(/([\d.]+)/);
      if (match) rating = parseFloat(match[1]);
    }
    // Fallback
    if (!rating) {
      const rText = document.querySelector('span.ceNzKf, span[class*="fontDisplayLarge"]');
      if (rText) rating = parseFloat(rText.textContent);
    }

    // Review count
    let reviewCount = null;
    const reviewCountEl = document.querySelector('button[aria-label*="reviews"], span[aria-label*="reviews"]');
    if (reviewCountEl) {
      const match = reviewCountEl.getAttribute('aria-label')?.match(/([\d,]+)/);
      if (match) reviewCount = parseInt(match[1].replace(/,/g, ''));
    }
    if (!reviewCount) {
      const spans = [...document.querySelectorAll('span')];
      for (const s of spans) {
        const m = s.textContent.match(/\(([\d,]+)\s*review/i);
        if (m) { reviewCount = parseInt(m[1].replace(/,/g, '')); break; }
      }
    }

    // Address
    const addressEl = document.querySelector('button[data-item-id="address"] div, [data-tooltip*="address"]');
    const address = addressEl?.textContent?.trim() || null;

    // Phone
    const phoneEl = document.querySelector('button[data-item-id*="phone"] div, [data-tooltip*="phone"]');
    const phone = phoneEl?.textContent?.trim() || null;

    // Website
    const websiteEl = document.querySelector('a[data-item-id="authority"]');
    const website = websiteEl?.getAttribute('href') || null;

    // Hours
    const hoursTable = document.querySelector('[aria-label*="hours"], table[class*="hours"]');
    let hours = null;
    if (hoursTable) {
      hours = {};
      const rows = hoursTable.querySelectorAll('tr');
      rows.forEach(row => {
        const cells = row.querySelectorAll('td, th');
        if (cells.length >= 2) {
          hours[cells[0].textContent.trim()] = cells[1].textContent.trim();
        }
      });
    }

    // Categories
    const categoryEls = document.querySelectorAll('button[jsaction*="category"]');
    const categories = [...categoryEls].map(el => el.textContent.trim()).filter(Boolean);

    // Photos
    const photoEls = document.querySelectorAll('img[decoding="async"][src*="googleusercontent"], button[class*="gallery"] img');
    const photos = [...photoEls].map(img => img.src).filter(Boolean).slice(0, 20);

    // Popular times (these are in aria-labels on time elements)
    const popularTimesEls = document.querySelectorAll('[aria-label*="busy"], [aria-label*="Usually"]');
    const popularTimes = [...popularTimesEls].map(el => el.getAttribute('aria-label')).filter(Boolean);

    return {
      name, rating, reviewCount, address, phone, website, hours,
      categories, photos, popularTimes,
      googleMapsUrl: window.location.href,
    };
  });

  // Download and upload photos to permanent storage
  if (slug && data.photos && data.photos.length > 0) {
    const originalPhotoCount = data.photos.length;
    log(`    Downloading and uploading ${originalPhotoCount} photos...`);
    const uploadedPhotos = [];
    
    for (let i = 0; i < originalPhotoCount; i++) {
      const photoUrl = data.photos[i];
      const uploadedUrl = await downloadAndStoreImage(photoUrl, slug, 'google');
      if (uploadedUrl) {
        uploadedPhotos.push(uploadedUrl);
      }
      // Small delay between uploads
      if (i < originalPhotoCount - 1) {
        await delay(500, 1000);
      }
    }
    
    data.photos = uploadedPhotos;
    log(`    ✓ Successfully uploaded ${uploadedPhotos.length}/${originalPhotoCount} photos`);
  }

  // Now try to get reviews by clicking the reviews tab/button
  let reviews = [];
  try {
    // Try multiple selectors for the reviews tab
    const reviewsBtn = await page.$('button[aria-label*="Reviews"], button[aria-label*="reviews"], [data-tab-index="1"], button[role="tab"]:has-text("Reviews")');
    if (reviewsBtn) {
      await reviewsBtn.click();
      await delay(3000, 4000);

      // Scroll the reviews pane to load more
      for (let i = 0; i < 5; i++) {
        await page.evaluate(() => {
          // Google Maps uses various scrollable containers
          const containers = document.querySelectorAll('[role="main"] div[tabindex="-1"], .m6QErb.DxyBCb, .m6QErb.WNBkOb');
          containers.forEach(c => c.scrollBy(0, 1000));
        });
        await delay(1000, 2000);
      }

      // Click all "More" buttons to expand review text
      await page.evaluate(() => {
        document.querySelectorAll('button[aria-label="See more"], button[jsaction*="pane.review.expandReview"], button.w8nwRe').forEach(b => b.click());
      });
      await delay(1000);

      reviews = await page.evaluate(() => {
        // Try multiple known Google Maps review container selectors
        const allReviews = document.querySelectorAll('[data-review-id], div.jftiEf, div[data-google-review-id]');
        const results = [];
        
        allReviews.forEach(el => {
          // Stars: look for aria-label with "star" or count filled star SVGs
          let stars = null;
          const starEl = el.querySelector('span[aria-label*="star"], span[role="img"][aria-label*="star"]');
          if (starEl) {
            const m = starEl.getAttribute('aria-label')?.match(/(\d)/);
            if (m) stars = parseInt(m[1]);
          }

          // Review text: multiple possible class names
          const textEl = el.querySelector('.wiI7pd, .MyEned span, [data-expandable-section] span, .review-full-text');
          const text = textEl?.textContent?.trim();
          if (!text || text.length < 5) return;

          // Author
          const authorEl = el.querySelector('.d4r55, a[href*="/contrib/"], .WNxzHc a');
          const author = authorEl?.textContent?.trim() || null;

          // Date  
          const dateEl = el.querySelector('.rsqaWe, .xRkPPb, span.dehysf');
          const dateText = dateEl?.textContent?.trim() || null;

          results.push({ stars, text, author, date: dateText });
        });

        return results;
      });

      log(`    Got ${reviews.length} Google reviews`);
    }
  } catch (e) {
    log(`    Could not get reviews: ${e.message}`);
  }

  // Normalize hours — infer missing AM/PM from the one that's present
  // e.g. "1:00 - 5:00 PM" → "1:00 PM - 5:00 PM"
  const { normalizeHours } = require('./lib/normalize_hours');
  if (data.hours) {
    data.hours = normalizeHours(data.hours);
  }

  data.reviews = reviews;
  data.totalReviewsScraped = reviews.length;
  data.scrapedAt = new Date().toISOString();

  return data;
}

async function run() {
  const args = parseArgs();
  const { browser, context } = await createStealthBrowser();

  try {
    const page = await context.newPage();

    if (args.shop && args.city && args.state) {
      // Single shop - first get the shop to have slug for image uploads
      const shops = await getShopByName(args.shop, args.city, args.state);
      const shop = shops && shops.length > 0 ? shops[0] : null;
      const slug = shop ? shop.slug : null;
      
      const data = await scrapeGoogleMaps(page, args.shop, args.city, args.state, slug);
      
      if (shop) {
        const outPath = contentDir(shop.id, 'reviews', 'google_reviews.json');
        saveJSON(outPath, data);
        
        await updateShop(shop.id, {
          google_maps_url: data.googleMapsUrl,
          average_rating: data.rating || shop.average_rating,
          review_count: Math.max(data.reviewCount || 0, shop.review_count || 0),
        });
        
        log(`Saved to ${outPath}`);
      } else {
        console.log(JSON.stringify(data, null, 2));
      }
      return;
    }

    if (args['shop-id']) {
      const { data: shop } = await supabase.from('shops').select('*').eq('id', args['shop-id']).single();
      if (!shop) { log('Shop not found'); return; }
      
      const data = await scrapeGoogleMaps(page, shop.name, shop.city, shop.state, shop.slug);
      const outPath = contentDir(shop.id, 'reviews', 'google_reviews.json');
      saveJSON(outPath, data);
      log(`Saved to ${outPath}`);
      return;
    }

    if (args.all) {
      const limit = parseInt(args.limit) || 10;
      const shops = await getAllShops(limit);
      let processed = 0;

      for (const shop of shops) {
        if (!shop.city || !shop.state) {
          log(`Skipping ${shop.name} — no city/state`);
          continue;
        }

        try {
          const data = await scrapeGoogleMaps(page, shop.name, shop.city, shop.state, shop.slug);
          const outPath = contentDir(shop.id, 'reviews', 'google_reviews.json');
          saveJSON(outPath, data);

          // Update shop with gallery images
          const updateData = {
            google_maps_url: data.googleMapsUrl,
            average_rating: data.rating || shop.average_rating,
          };
          
          // Add photos to image_gallery if any were uploaded
          if (data.photos && data.photos.length > 0) {
            const existingGallery = Array.isArray(shop.image_gallery) ? shop.image_gallery : [];
            updateData.image_gallery = [...data.photos, ...existingGallery];
          }

          await updateShop(shop.id, updateData);

          processed++;
          log(`✓ [${processed}/${shops.length}] ${shop.name} — ${data.rating}★ (${data.totalReviewsScraped} reviews, ${data.photos?.length || 0} photos)`);
          await delay(3000, 6000);
        } catch (e) {
          log(`✗ ${shop.name}: ${e.message}`);
          await delay(2000, 3000);
        }
      }

      log(`\nDone. Processed ${processed}/${shops.length} shops.`);
    }

  } finally {
    await browser.close();
  }
}

run().catch(e => { console.error(e); process.exit(1); });
