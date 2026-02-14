#!/usr/bin/env node
/**
 * Google/Yelp Review Scraper for Record Shops
 * Searches for shops on Google Maps and Yelp, extracts ratings and review counts.
 * Stores results in content/{shop_id}/reviews/ and updates Supabase.
 *
 * Usage:
 *   node scrape_reviews.js                    # Process all shops
 *   node scrape_reviews.js --limit 5          # Process 5 shops
 *   node scrape_reviews.js --dry-run          # Don't update Supabase
 *   node scrape_reviews.js --shop-id <id>     # Single shop
 */

const { spawn } = require('child_process');
const { writeFileSync, mkdirSync, existsSync, readFileSync } = require('fs');
const path = require('path');

const SUPABASE_URL = "https://oytflcaqukxvzmbddrlg.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im95dGZsY2FxdWt4dnptYmRkcmxnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY5NTIwMjQsImV4cCI6MjA4MjUyODAyNH0.YpFZfu2BPxwXxXz5j-xqgu7VdIuTP315eiS3UuLD2wo";
const CONTENT_DIR = '/home/john/Projects/record-shop-enricher/content';
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const OLLAMA_URL = 'http://localhost:11434';
const PROGRESS_FILE = '/home/john/Projects/record-shop-enricher/reviews_progress.json';

// Parse args
const args = process.argv.slice(2);
const limit = args.includes('--limit') ? parseInt(args[args.indexOf('--limit') + 1]) : null;
const dryRun = args.includes('--dry-run');
const singleShopId = args.includes('--shop-id') ? args[args.indexOf('--shop-id') + 1] : null;

// ── HTTP helpers ──

function curlFetch(url, headers = {}, options = {}) {
  return new Promise((resolve, reject) => {
    const headerArgs = Object.entries(headers).flatMap(([k, v]) => ['-H', `${k}: ${v}`]);
    const curlArgs = [
      '-sL',
      '-A', USER_AGENT,
      '--max-time', String(options.timeout || 20),
      '--max-redirs', '5',
      '-o', '-',
      ...headerArgs,
      url
    ];
    const curl = spawn('curl', curlArgs);

    let data = '';
    let stderr = '';
    curl.stdout.on('data', (chunk) => { data += chunk; });
    curl.stderr.on('data', (chunk) => { stderr += chunk; });
    curl.on('close', (code) => {
      if (code !== 0 && !data) reject(new Error(`curl failed: ${stderr}`));
      else resolve(data);
    });
  });
}

function supabaseGet(query) {
  return new Promise((resolve, reject) => {
    const url = `${SUPABASE_URL}/rest/v1/shops?${query}`;
    curlFetch(url, {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
    }).then(data => {
      try { resolve(JSON.parse(data)); }
      catch (e) { reject(new Error(`JSON parse failed: ${data.substring(0, 200)}`)); }
    }).catch(reject);
  });
}

function supabaseUpdate(shopId, updates) {
  return new Promise((resolve, reject) => {
    const url = `${SUPABASE_URL}/rest/v1/shops?id=eq.${shopId}`;
    const body = JSON.stringify(updates);
    const curl = spawn('curl', [
      '-s', '-X', 'PATCH',
      '-H', `apikey: ${SUPABASE_KEY}`,
      '-H', `Authorization: Bearer ${SUPABASE_KEY}`,
      '-H', 'Content-Type: application/json',
      '-H', 'Prefer: return=minimal',
      '-d', body,
      url
    ]);

    let data = '';
    curl.stdout.on('data', (chunk) => { data += chunk; });
    curl.on('close', (code) => {
      if (code !== 0) reject(new Error(`Update failed for ${shopId}`));
      else resolve(data);
    });
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Ollama helper ──

function ollamaExtract(prompt, text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'llama3.2',
      prompt: `${prompt}\n\nText to analyze:\n${text.substring(0, 4000)}`,
      stream: false,
      options: { temperature: 0.1 }
    });

    const curl = spawn('curl', [
      '-s', '-X', 'POST',
      '-H', 'Content-Type: application/json',
      '-d', body,
      `${OLLAMA_URL}/api/generate`
    ]);

    let data = '';
    curl.stdout.on('data', (chunk) => { data += chunk; });
    curl.on('close', (code) => {
      try {
        const parsed = JSON.parse(data);
        resolve(parsed.response || '');
      } catch (e) {
        resolve('');
      }
    });
  });
}

// ── Google Maps search ──

async function searchGoogleMaps(shopName, city, state) {
  const query = encodeURIComponent(`${shopName} ${city} ${state} record store`);
  const url = `https://www.google.com/maps/search/${query}`;

  try {
    const html = await curlFetch(url, {
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    });

    // Try to extract rating from Google Maps HTML
    const result = {
      source: 'google_maps',
      rating: null,
      reviewCount: null,
      url: `https://www.google.com/maps/search/${query}`,
      rawSnippets: []
    };

    // Google Maps embeds rating data in various formats
    // Pattern: "4.7 stars" or rating like "4.7(123)"
    const ratingMatch = html.match(/(\d\.\d)\s*(?:stars?|out of 5)/i)
      || html.match(/"rating"\s*:\s*(\d\.?\d*)/i)
      || html.match(/(\d\.\d)\((\d+)\)/);

    if (ratingMatch) {
      result.rating = parseFloat(ratingMatch[1]);
    }

    const reviewMatch = html.match(/(\d[\d,]*)\s*(?:reviews?|Google reviews?)/i)
      || html.match(/"userRatingsCount"\s*:\s*(\d+)/i);

    if (reviewMatch) {
      result.reviewCount = parseInt(reviewMatch[1].replace(/,/g, ''));
    }

    // If we couldn't parse HTML, try Ollama
    if (!result.rating && html.length > 500) {
      const extracted = await ollamaExtract(
        `Extract the Google rating (1-5 stars) and review count for this business from the following HTML. Return ONLY a JSON object like {"rating": 4.5, "reviewCount": 123}. If not found, return {"rating": null, "reviewCount": null}.`,
        html
      );
      try {
        const jsonMatch = extracted.match(/\{[^}]+\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          if (parsed.rating) result.rating = parsed.rating;
          if (parsed.reviewCount) result.reviewCount = parsed.reviewCount;
        }
      } catch (e) { /* ignore parse errors */ }
    }

    return result;
  } catch (e) {
    return { source: 'google_maps', rating: null, reviewCount: null, error: e.message };
  }
}

// ── Google Search fallback (search for "shop name city reviews") ──

async function searchGoogleForReviews(shopName, city, state) {
  const query = encodeURIComponent(`"${shopName}" ${city} ${state} reviews rating`);
  const url = `https://www.google.com/search?q=${query}&hl=en`;

  try {
    const html = await curlFetch(url, {
      'Accept': 'text/html',
      'Accept-Language': 'en-US,en;q=0.9',
    });

    const result = { source: 'google_search', rating: null, reviewCount: null, snippets: [] };

    // Google search results often show "Rating: 4.5 · ‎123 reviews"
    const ratingPattern = /(?:Rating|Rated)\s*[:·]?\s*(\d\.?\d*)\s*(?:\/5|stars?)?/gi;
    const reviewPattern = /(\d[\d,]*)\s*(?:reviews?|ratings?)/gi;

    let match;
    while ((match = ratingPattern.exec(html)) !== null) {
      const r = parseFloat(match[1]);
      if (r >= 1 && r <= 5) {
        result.rating = r;
        break;
      }
    }

    while ((match = reviewPattern.exec(html)) !== null) {
      const count = parseInt(match[1].replace(/,/g, ''));
      if (count > 0 && count < 100000) {
        result.reviewCount = count;
        break;
      }
    }

    return result;
  } catch (e) {
    return { source: 'google_search', rating: null, reviewCount: null, error: e.message };
  }
}

// ── Yelp search ──

async function searchYelp(shopName, city, state) {
  // Try Yelp Fusion API first if key available
  const yelpKey = process.env.YELP_API_KEY;

  if (yelpKey) {
    return searchYelpApi(shopName, city, state, yelpKey);
  }

  // Fallback: scrape Yelp search page
  return searchYelpWeb(shopName, city, state);
}

async function searchYelpApi(shopName, city, state, apiKey) {
  const params = new URLSearchParams({
    term: shopName,
    location: `${city}, ${state}`,
    categories: 'musicvideo,vinyl_records',
    limit: '3'
  });

  try {
    const data = await curlFetch(
      `https://api.yelp.com/v3/businesses/search?${params}`,
      { 'Authorization': `Bearer ${apiKey}` }
    );

    const parsed = JSON.parse(data);
    if (parsed.businesses && parsed.businesses.length > 0) {
      // Find best match
      const biz = parsed.businesses[0];
      return {
        source: 'yelp_api',
        name: biz.name,
        rating: biz.rating,
        reviewCount: biz.review_count,
        url: biz.url,
        price: biz.price || null,
        categories: (biz.categories || []).map(c => c.title),
        phone: biz.phone,
        address: biz.location ? biz.location.display_address.join(', ') : null,
      };
    }
    return { source: 'yelp_api', rating: null, reviewCount: null, notFound: true };
  } catch (e) {
    return { source: 'yelp_api', rating: null, reviewCount: null, error: e.message };
  }
}

async function searchYelpWeb(shopName, city, state) {
  const query = encodeURIComponent(`${shopName}`);
  const location = encodeURIComponent(`${city}, ${state}`);
  const url = `https://www.yelp.com/search?find_desc=${query}&find_loc=${location}`;

  try {
    const html = await curlFetch(url, {
      'Accept': 'text/html',
      'Accept-Language': 'en-US,en;q=0.9',
    });

    const result = { source: 'yelp_web', rating: null, reviewCount: null, url };

    // Yelp embeds JSON-LD or aria labels with ratings
    const ratingMatch = html.match(/aria-label="(\d\.?\d*)\s*star rating"/i)
      || html.match(/"rating"\s*:\s*(\d\.?\d*)/);
    const reviewMatch = html.match(/(\d+)\s*reviews?/i);

    if (ratingMatch) result.rating = parseFloat(ratingMatch[1]);
    if (reviewMatch) result.reviewCount = parseInt(reviewMatch[1]);

    // If HTML parsing failed, try Ollama
    if (!result.rating && html.length > 1000) {
      const extracted = await ollamaExtract(
        `Extract the Yelp star rating (1-5) and review count for a record store from this search results HTML. Return ONLY JSON: {"rating": 4.0, "reviewCount": 50}. If not found: {"rating": null, "reviewCount": null}.`,
        html
      );
      try {
        const jsonMatch = extracted.match(/\{[^}]+\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          if (parsed.rating) result.rating = parsed.rating;
          if (parsed.reviewCount) result.reviewCount = parsed.reviewCount;
        }
      } catch (e) { /* ignore */ }
    }

    return result;
  } catch (e) {
    return { source: 'yelp_web', rating: null, reviewCount: null, error: e.message };
  }
}

// ── Save results ──

function saveReviewData(shopId, data) {
  const dir = path.join(CONTENT_DIR, String(shopId), 'reviews');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const timestamp = new Date().toISOString().split('T')[0];
  const filePath = path.join(dir, `reviews_${timestamp}.json`);
  writeFileSync(filePath, JSON.stringify(data, null, 2));
  return filePath;
}

// ── Progress tracking ──

function loadProgress() {
  try {
    if (existsSync(PROGRESS_FILE)) {
      return JSON.parse(readFileSync(PROGRESS_FILE, 'utf8'));
    }
  } catch (e) { /* ignore */ }
  return { completed: [], lastRun: null };
}

function saveProgress(progress) {
  writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

// ── Main ──

async function processShop(shop) {
  const { id, name, city, state } = shop;
  console.log(`\n  🏪 ${name} (${city}, ${state})`);

  const results = {
    shopId: id,
    shopName: name,
    city,
    state,
    scrapedAt: new Date().toISOString(),
    google: null,
    yelp: null,
  };

  // Google Maps search
  console.log(`    📍 Searching Google Maps...`);
  results.google = await searchGoogleMaps(name, city, state);
  if (results.google.rating) {
    console.log(`    ⭐ Google: ${results.google.rating}/5 (${results.google.reviewCount || '?'} reviews)`);
  } else {
    // Fallback to Google Search
    console.log(`    📍 Google Maps failed, trying Google Search...`);
    const googleSearch = await searchGoogleForReviews(name, city, state);
    if (googleSearch.rating) {
      results.google = { ...results.google, ...googleSearch, source: 'google_search_fallback' };
      console.log(`    ⭐ Google: ${results.google.rating}/5 (${results.google.reviewCount || '?'} reviews)`);
    } else {
      console.log(`    ❌ Google: no rating found`);
    }
  }

  await sleep(1000);

  // Yelp search
  console.log(`    🍽️  Searching Yelp...`);
  results.yelp = await searchYelp(name, city, state);
  if (results.yelp.rating) {
    console.log(`    ⭐ Yelp: ${results.yelp.rating}/5 (${results.yelp.reviewCount || '?'} reviews)`);
  } else {
    console.log(`    ❌ Yelp: no rating found`);
  }

  return results;
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║  ⭐ Review Scraper — Google & Yelp                  ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  if (dryRun) console.log('⚠️  DRY RUN — no Supabase updates\n');

  const progress = loadProgress();

  // Fetch shops
  let query = 'select=id,name,city,state&order=name';
  if (singleShopId) {
    query = `select=id,name,city,state&id=eq.${singleShopId}`;
  }
  if (limit) query += `&limit=${limit}`;

  console.log('📡 Fetching shops from Supabase...');
  const shops = await supabaseGet(query);
  console.log(`📊 Found ${shops.length} shops to process\n`);

  if (shops.length === 0) {
    console.log('No shops found. Exiting.');
    return;
  }

  let processed = 0;
  let googleFound = 0;
  let yelpFound = 0;

  for (const shop of shops) {
    // Skip already processed (unless single shop mode)
    if (!singleShopId && progress.completed.includes(shop.id)) {
      console.log(`  ⏭️  Skipping ${shop.name} (already processed)`);
      continue;
    }

    const results = await processShop(shop);

    // Save to content directory
    if (!dryRun) {
      const filePath = saveReviewData(shop.id, results);
      console.log(`    💾 Saved: ${filePath}`);
    }

    // Update Supabase
    if (!dryRun) {
      const updates = {};
      if (results.google && results.google.rating) {
        updates.google_rating = results.google.rating;
        updates.google_review_count = results.google.reviewCount;
      }
      if (results.yelp && results.yelp.rating) {
        updates.yelp_rating = results.yelp.rating;
        updates.yelp_review_count = results.yelp.reviewCount;
      }

      if (Object.keys(updates).length > 0) {
        try {
          await supabaseUpdate(shop.id, updates);
          console.log(`    📤 Supabase updated`);
        } catch (e) {
          console.log(`    ⚠️  Supabase update failed: ${e.message}`);
        }
      }
    }

    // Track progress
    if (results.google && results.google.rating) googleFound++;
    if (results.yelp && results.yelp.rating) yelpFound++;
    processed++;

    if (!singleShopId) {
      progress.completed.push(shop.id);
      progress.lastRun = new Date().toISOString();
      if (!dryRun) saveProgress(progress);
    }

    // Rate limit
    await sleep(2000);
  }

  // Summary
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║  📊 Summary                                         ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log(`  Processed: ${processed}`);
  console.log(`  Google ratings found: ${googleFound}`);
  console.log(`  Yelp ratings found: ${yelpFound}`);
  console.log(`  Success rate: ${processed > 0 ? Math.round((googleFound + yelpFound) / (processed * 2) * 100) : 0}%`);
}

main().catch(err => {
  console.error('💀 Fatal error:', err.message);
  process.exit(1);
});
