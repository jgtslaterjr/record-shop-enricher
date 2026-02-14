#!/usr/bin/env node
/**
 * Deep Yelp Scraper — Full business page extraction with reviews
 * 
 * Usage:
 *   node deep_scrape_yelp.js --city "Austin, TX"
 *   node deep_scrape_yelp.js --all --limit 5
 *   node deep_scrape_yelp.js --shop-id "uuid"        # scrape Yelp for a specific shop
 *   node deep_scrape_yelp.js --yelp-url "https://..."  # scrape a specific Yelp page
 */

const { delay, saveJSON, loadJSON, contentDir, getAllShops, getShopByName,
  upsertShop, createStealthBrowser, parseArgs, log, randomUA } = require('./lib/common');

const TOP_CITIES = [
  'New York, NY', 'Los Angeles, CA', 'Chicago, IL', 'Houston, TX', 'Phoenix, AZ',
  'Philadelphia, PA', 'San Antonio, TX', 'San Diego, CA', 'Dallas, TX', 'Austin, TX',
  'San Jose, CA', 'Jacksonville, FL', 'San Francisco, CA', 'Columbus, OH', 'Indianapolis, IN',
  'Charlotte, NC', 'Seattle, WA', 'Denver, CO', 'Nashville, TN', 'Portland, OR',
  'Oklahoma City, OK', 'Las Vegas, NV', 'Memphis, TN', 'Louisville, KY', 'Baltimore, MD',
  'Milwaukee, WI', 'Albuquerque, NM', 'Tucson, AZ', 'Fresno, CA', 'Sacramento, CA',
  'Atlanta, GA', 'Kansas City, MO', 'Miami, FL', 'Raleigh, NC', 'Omaha, NE',
  'Minneapolis, MN', 'Cleveland, OH', 'Tampa, FL', 'St. Louis, MO', 'Pittsburgh, PA',
  'Cincinnati, OH', 'New Orleans, LA', 'Detroit, MI', 'Richmond, VA', 'Boise, ID',
  'Honolulu, HI', 'Salt Lake City, UT', 'Birmingham, AL', 'Providence, RI', 'Berwyn, PA'
];

async function scrapeYelpSearchPage(page, city, startIndex = 0) {
  const loc = encodeURIComponent(city);
  const url = `https://www.yelp.com/search?find_desc=record+store&find_loc=${loc}&start=${startIndex}`;
  log(`Fetching Yelp search: ${city} (offset ${startIndex})`);

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await delay(2000, 4000);

  const results = await page.evaluate(() => {
    const shops = [];
    // Yelp search results are in list items with business links
    const cards = document.querySelectorAll('[data-testid="serp-ia-card"], .css-1m051bw, .container__09f24__mpR8_, li .css-1qn0b6x');
    
    // Fallback: find all links that look like business pages
    const allLinks = document.querySelectorAll('a[href*="/biz/"]');
    const seen = new Set();
    
    allLinks.forEach(link => {
      const href = link.getAttribute('href');
      if (!href || !href.startsWith('/biz/') || href.includes('?') || seen.has(href)) return;
      // Skip non-business links
      if (href.includes('/biz_photos/') || href.includes('/writeareview/')) return;
      seen.add(href);
      
      // Try to get name from the link text or parent
      const name = link.textContent?.trim();
      if (name && name.length > 1 && name.length < 100) {
        shops.push({
          name: name,
          yelpUrl: 'https://www.yelp.com' + href.split('?')[0],
          yelpSlug: href.replace('/biz/', '').split('?')[0]
        });
      }
    });

    // Check if there's a "Next" link for pagination
    const nextLink = document.querySelector('a[aria-label="Next"], .next-link, a.next');
    const hasMore = !!nextLink;

    return { shops, hasMore };
  });

  return results;
}

async function scrapeYelpBusinessPage(page, yelpUrl) {
  log(`  Scraping business page: ${yelpUrl}`);
  await page.goto(yelpUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await delay(2000, 3500);

  const data = await page.evaluate(() => {
    const getText = (sel) => document.querySelector(sel)?.textContent?.trim() || null;
    const getAll = (sel) => [...document.querySelectorAll(sel)].map(el => el.textContent?.trim()).filter(Boolean);

    // Business info from JSON-LD
    let jsonLd = {};
    try {
      const scripts = document.querySelectorAll('script[type="application/ld+json"]');
      for (const s of scripts) {
        const parsed = JSON.parse(s.textContent);
        if (parsed['@type'] === 'LocalBusiness' || parsed['@type']?.includes?.('Store')) {
          jsonLd = parsed;
          break;
        }
      }
    } catch (e) {}

    // Rating & review count
    const ratingEl = document.querySelector('[aria-label*="star rating"]');
    const rating = ratingEl ? parseFloat(ratingEl.getAttribute('aria-label')) : jsonLd.aggregateRating?.ratingValue || null;
    
    const reviewCountEl = document.querySelector('a[href="#reviews"]');
    const reviewCount = reviewCountEl ? parseInt(reviewCountEl.textContent.replace(/[^\d]/g, '')) : null;

    // Phone
    const phone = jsonLd.telephone || null;
    
    // Address
    let address = null, city = null, state = null, zip = null;
    if (jsonLd.address) {
      address = jsonLd.address.streetAddress;
      city = jsonLd.address.addressLocality;
      state = jsonLd.address.addressRegion;
      zip = jsonLd.address.postalCode;
    }

    // Website
    let website = null;
    const bizLinks = document.querySelectorAll('a[href*="biz_redir"]');
    bizLinks.forEach(l => {
      const href = l.getAttribute('href');
      if (href && href.includes('url=')) {
        try { website = decodeURIComponent(href.split('url=')[1].split('&')[0]); } catch (e) {}
      }
    });
    if (!website) {
      const extLinks = document.querySelectorAll('a[rel="noopener"]');
      extLinks.forEach(l => {
        const text = l.textContent?.trim();
        if (text && text.includes('.') && !text.includes('yelp')) website = website || text;
      });
    }

    // Hours
    const hoursRows = document.querySelectorAll('table th, table td');
    const hours = {};
    for (let i = 0; i < hoursRows.length - 1; i += 2) {
      const day = hoursRows[i]?.textContent?.trim();
      const time = hoursRows[i + 1]?.textContent?.trim();
      if (day && time) hours[day] = time;
    }

    // Price range
    const priceEl = document.querySelector('[aria-label*="price"]');
    const priceRange = priceEl ? priceEl.textContent?.trim() : null;

    // Categories
    const categories = getAll('[class*="categories"] a, a[href*="cflt="]');

    // Photos
    const photos = [...document.querySelectorAll('img[src*="bphoto"], img[loading="lazy"]')]
      .map(img => img.src)
      .filter(src => src && src.includes('yelp') && !src.includes('avatar'))
      .slice(0, 20);

    // Amenities
    const amenities = {};
    const amenityEls = document.querySelectorAll('[class*="amenities"] span, [class*="attribute"] span');
    amenityEls.forEach(el => {
      const text = el.textContent?.trim();
      if (text) amenities[text] = true;
    });

    // Specialties
    const specialtiesEl = document.querySelector('[class*="specialties"]');
    const specialties = specialtiesEl?.textContent?.trim() || null;

    // Reviews
    const reviews = [];
    const reviewEls = document.querySelectorAll('[class*="review__"] li, [data-testid="review"], #reviews > section ul > li');
    
    // Broader selector for reviews
    const allReviewContainers = document.querySelectorAll('ul > li');
    allReviewContainers.forEach(li => {
      const starEl = li.querySelector('[aria-label*="star rating"]');
      if (!starEl) return;
      
      const stars = parseFloat(starEl.getAttribute('aria-label'));
      const textEl = li.querySelector('p[lang], span[lang], [class*="comment"] p');
      const text = textEl?.textContent?.trim();
      if (!text || text.length < 10) return;

      const dateEl = li.querySelector('span[class*="date"], span:not([class])');
      let date = null;
      if (dateEl) {
        const dateText = dateEl.textContent?.trim();
        if (dateText && /\d{1,2}\/\d{1,2}\/\d{4}|\w+\s+\d{1,2},\s+\d{4}/.test(dateText)) {
          date = dateText;
        }
      }

      const userEl = li.querySelector('a[href*="/user_details"]');
      const reviewer = userEl?.textContent?.trim() || null;

      reviews.push({ stars, text, date, reviewer });
    });

    // Highlights from reviews
    const highlights = getAll('[class*="highlight"] span, [class*="review-tag"] span');

    return {
      name: jsonLd.name || getText('h1'),
      rating,
      reviewCount,
      phone,
      address,
      city,
      state,
      zip,
      website,
      hours: Object.keys(hours).length > 0 ? hours : null,
      priceRange,
      categories,
      photos,
      amenities: Object.keys(amenities).length > 0 ? amenities : null,
      specialties,
      reviews,
      highlights,
      yelpUrl: window.location.href,
    };
  });

  // Try to scrape more reviews by clicking "Next" pages
  let allReviews = [...(data.reviews || [])];
  let reviewPage = 1;
  const maxReviewPages = 5; // Limit to avoid rate limiting

  while (reviewPage < maxReviewPages) {
    const nextBtn = await page.$('a[aria-label="Next page"], a.next, [class*="pagination"] a:last-child');
    if (!nextBtn) break;
    
    try {
      await nextBtn.click();
      await delay(2000, 4000);
      reviewPage++;
      
      const moreReviews = await page.evaluate(() => {
        const reviews = [];
        const allLis = document.querySelectorAll('ul > li');
        allLis.forEach(li => {
          const starEl = li.querySelector('[aria-label*="star rating"]');
          if (!starEl) return;
          const stars = parseFloat(starEl.getAttribute('aria-label'));
          const textEl = li.querySelector('p[lang], span[lang]');
          const text = textEl?.textContent?.trim();
          if (!text || text.length < 10) return;
          const userEl = li.querySelector('a[href*="/user_details"]');
          reviews.push({ stars, text, reviewer: userEl?.textContent?.trim() || null });
        });
        return reviews;
      });
      
      if (moreReviews.length === 0) break;
      allReviews.push(...moreReviews);
      log(`    Got ${moreReviews.length} more reviews (page ${reviewPage + 1})`);
    } catch (e) {
      break;
    }
  }

  data.reviews = allReviews;
  data.totalReviewsScraped = allReviews.length;
  data.scrapedAt = new Date().toISOString();

  return data;
}

async function run() {
  const args = parseArgs();
  const { browser, context } = await createStealthBrowser();

  try {
    const page = await context.newPage();

    if (args['yelp-url']) {
      // Scrape a single Yelp business page
      const data = await scrapeYelpBusinessPage(page, args['yelp-url']);
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    if (args['shop-id']) {
      // Find shop in Supabase and scrape its Yelp page
      const { supabase } = require('./lib/common');
      const { data: shop } = await supabase.from('shops').select('*').eq('id', args['shop-id']).single();
      if (!shop) { log('Shop not found'); return; }
      if (!shop.yelp_url) { log('No Yelp URL for this shop'); return; }
      
      const data = await scrapeYelpBusinessPage(page, shop.yelp_url);
      const outPath = contentDir(shop.id, 'reviews', 'yelp_reviews.json');
      saveJSON(outPath, data);
      log(`Saved to ${outPath}`);
      return;
    }

    // City-based search
    const cities = args.city ? [args.city] : TOP_CITIES;
    const limit = parseInt(args.limit) || Infinity;
    let totalFound = 0;
    let totalNew = 0;

    for (const city of cities) {
      if (totalFound >= limit) break;
      log(`\n═══ Searching Yelp for record shops in ${city} ═══`);
      
      let offset = 0;
      let cityShops = [];

      // Paginate through all search results
      while (true) {
        try {
          const { shops, hasMore } = await scrapeYelpSearchPage(page, city, offset);
          if (shops.length === 0) break;
          
          cityShops.push(...shops);
          log(`  Found ${shops.length} shops (total for city: ${cityShops.length})`);
          
          if (!hasMore || shops.length < 5) break;
          offset += 10;
          await delay(3000, 5000);
        } catch (e) {
          log(`  Search page error: ${e.message}`);
          break;
        }
      }

      // Deduplicate by slug
      const seen = new Set();
      cityShops = cityShops.filter(s => {
        if (seen.has(s.yelpSlug)) return false;
        seen.add(s.yelpSlug);
        return true;
      });

      log(`  Unique shops found in ${city}: ${cityShops.length}`);

      // Scrape each shop's business page
      for (const shop of cityShops) {
        if (totalFound >= limit) break;
        
        try {
          // Rotate UA occasionally
          if (Math.random() < 0.3) {
            await context.setExtraHTTPHeaders({ 'User-Agent': randomUA() });
          }

          const data = await scrapeYelpBusinessPage(page, shop.yelpUrl);
          
          // Cross-reference with Supabase
          const [cityName, stateAbbr] = city.split(',').map(s => s.trim());
          const shopData = {
            name: data.name || shop.name,
            address: data.address,
            city: data.city || cityName,
            state: data.state || stateAbbr,
            zip: data.zip,
            phone: data.phone,
            website: data.website,
            yelp_url: data.yelpUrl || shop.yelpUrl,
            average_rating: data.rating,
            review_count: data.reviewCount,
          };

          const result = await upsertShop(shopData);
          const shopId = result.id;
          
          // Save full Yelp data
          const outPath = contentDir(shopId, 'reviews', 'yelp_reviews.json');
          saveJSON(outPath, data);
          
          totalFound++;
          if (result.isNew) totalNew++;
          log(`  ✓ ${data.name || shop.name} — ${data.totalReviewsScraped} reviews, ${data.photos?.length || 0} photos ${result.isNew ? '(NEW)' : '(updated)'}`);
          
          await delay(2500, 4500);
        } catch (e) {
          log(`  ✗ Error scraping ${shop.name}: ${e.message}`);
          await delay(1000, 2000);
        }
      }
    }

    log(`\n═══ DONE ═══`);
    log(`Total shops processed: ${totalFound}`);
    log(`New shops added: ${totalNew}`);
    
  } finally {
    await browser.close();
  }
}

run().catch(e => { console.error(e); process.exit(1); });
