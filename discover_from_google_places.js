#!/usr/bin/env node
/**
 * Google Places-Based Record Shop Discovery & Enrichment
 *
 * Searches Google Places API for record shops, cross-references with
 * our Supabase database, backfills missing data on existing shops, and
 * inserts newly discovered shops.
 *
 * Uses LEGACY Google Places Text Search API (maps.googleapis.com/maps/api/place/textsearch/json)
 * and Details API for phone/website/hours enrichment.
 *
 * Usage:
 *   node discover_from_google_places.js --city "Austin, TX"     # Single city
 *   node discover_from_google_places.js --city "Austin, TX" --limit 5  # Limit results
 *   node discover_from_google_places.js --dry-run                # Preview only, no DB writes
 *   node discover_from_google_places.js --resume                 # Resume from last city
 *
 * Requires: GOOGLE_API_KEY in .env
 */

require('dotenv').config();

const { spawn } = require('child_process');
const { writeFileSync, readFileSync, existsSync, mkdirSync } = require('fs');
const path = require('path');
const { generateSlug } = require('./lib/common');

// ── Config ──

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;

const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PROGRESS_FILE = path.join(__dirname, 'google_places_discover_progress.json');
const RESULTS_DIR = path.join(__dirname, 'content', '_google_places_discovery');

// Google Places API endpoints (LEGACY)
const PLACES_SEARCH_URL = "https://maps.googleapis.com/maps/api/place/textsearch/json";
const PLACES_DETAIL_URL = "https://maps.googleapis.com/maps/api/place/details/json";
const PLACES_DETAIL_FIELDS = "formatted_phone_number,website,opening_hours";

// ── Args ──

const args = process.argv.slice(2);
const cityLimit = args.includes('--limit') ? parseInt(args[args.indexOf('--limit') + 1]) : null;
const singleCity = args.includes('--city') ? args[args.indexOf('--city') + 1] : null;
const dryRun = args.includes('--dry-run');
const resume = args.includes('--resume');

// ── Top 50 US cities by population ──

const TOP_CITIES = [
  'New York, NY', 'Los Angeles, CA', 'Chicago, IL', 'Houston, TX', 'Phoenix, AZ',
  'Philadelphia, PA', 'San Antonio, TX', 'San Diego, CA', 'Dallas, TX', 'Austin, TX',
  'Jacksonville, FL', 'San Jose, CA', 'Fort Worth, TX', 'Columbus, OH', 'Charlotte, NC',
  'Indianapolis, IN', 'San Francisco, CA', 'Seattle, WA', 'Denver, CO', 'Nashville, TN',
  'Washington, DC', 'Oklahoma City, OK', 'El Paso, TX', 'Boston, MA', 'Portland, OR',
  'Las Vegas, NV', 'Memphis, TN', 'Louisville, KY', 'Baltimore, MD', 'Milwaukee, WI',
  'Albuquerque, NM', 'Tucson, AZ', 'Fresno, CA', 'Sacramento, CA', 'Mesa, AZ',
  'Kansas City, MO', 'Atlanta, GA', 'Omaha, NE', 'Colorado Springs, CO', 'Raleigh, NC',
  'Long Beach, CA', 'Virginia Beach, VA', 'Miami, FL', 'Oakland, CA', 'Minneapolis, MN',
  'Tampa, FL', 'Tulsa, OK', 'Arlington, TX', 'New Orleans, LA', 'Cleveland, OH',
  // Bonus vinyl-heavy cities
  'Brooklyn, NY', 'Detroit, MI', 'Pittsburgh, PA', 'St. Louis, MO', 'Cincinnati, OH',
  'Richmond, VA', 'Salt Lake City, UT', 'Asheville, NC', 'Burlington, VT', 'Savannah, GA',
];

// ── US State mappings ──

const US_STATES = {
  "alabama": "AL", "alaska": "AK", "arizona": "AZ", "arkansas": "AR",
  "california": "CA", "colorado": "CO", "connecticut": "CT", "delaware": "DE",
  "florida": "FL", "georgia": "GA", "hawaii": "HI", "idaho": "ID",
  "illinois": "IL", "indiana": "IN", "iowa": "IA", "kansas": "KS",
  "kentucky": "KY", "louisiana": "LA", "maine": "ME", "maryland": "MD",
  "massachusetts": "MA", "michigan": "MI", "minnesota": "MN", "mississippi": "MS",
  "missouri": "MO", "montana": "MT", "nebraska": "NE", "nevada": "NV",
  "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", "ohio": "OH", "oklahoma": "OK",
  "oregon": "OR", "pennsylvania": "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", "tennessee": "TN", "texas": "TX", "utah": "UT",
  "vermont": "VT", "virginia": "VA", "washington": "WA", "west virginia": "WV",
  "wisconsin": "WI", "wyoming": "WY", "district of columbia": "DC",
};

const ABBREV_TO_STATE = {};
for (const [stateName, abbrev] of Object.entries(US_STATES)) {
  ABBREV_TO_STATE[abbrev] = stateName.split(' ').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
}

// Canadian provinces
const CA_PROVINCES = {
  "alberta": "AB", "british columbia": "BC", "manitoba": "MB",
  "new brunswick": "NB", "newfoundland": "NL", "nova scotia": "NS",
  "ontario": "ON", "prince edward island": "PE", "quebec": "QC",
  "saskatchewan": "SK",
};

const ABBREV_TO_PROVINCE = {};
for (const [provName, abbrev] of Object.entries(CA_PROVINCES)) {
  ABBREV_TO_PROVINCE[abbrev] = provName.split(' ').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
}

// ── Format detection patterns ──

const FORMAT_PATTERNS = [
  ["LP",           /\bvinyl\b|\bLP s?\b|\bLPs\b|\b33\s*(?:rpm|1\/3)\b/i],
  ["45",           /\b45s?\b|\b7[\"']\s*singles?\b|\bsingles?\b/i],
  ["78",           /\b78s?\b|\b78\s*rpm\b/i],
  ["Cassette",     /\bcassettes?\b|\btapes?\b/i],
  ["8-Track",      /\b8[-\s]?tracks?\b/i],
  ["CD",           /\bCDs?\b|\bcompact\s+discs?\b/i],
  ["DVD",          /\bDVDs?\b/i],
  ["Blu-ray",      /\bblu[-\s]?rays?\b/i],
  ["VHS",          /\bVHS\b|\bvideocassettes?\b/i],
  ["Reel-to-Reel", /\breel[-\s]?to[-\s]?reel\b/i],
];

function detectFormats(text) {
  if (!text) return [];
  const found = [];
  for (const [label, pattern] of FORMAT_PATTERNS) {
    if (pattern.test(text)) found.push(label);
  }
  return found;
}

// ── HTTP helpers ──

function curlFetch(url, headers = {}, options = {}) {
  return new Promise((resolve, reject) => {
    const headerArgs = Object.entries(headers).flatMap(([k, v]) => ['-H', `${k}: ${v}`]);
    const curl = spawn('curl', [
      '-sL',
      '-A', USER_AGENT,
      '--max-time', String(options.timeout || 20),
      '--max-redirs', '5',
      '-o', '-',
      ...headerArgs,
      url
    ]);

    let data = '';
    let stderr = '';
    curl.stdout.on('data', (chunk) => { data += chunk; });
    curl.stderr.on('data', (chunk) => { stderr += chunk; });
    curl.on('close', (code) => {
      if (code !== 0 && !data) reject(new Error(`curl failed (${code}): ${stderr.substring(0, 200)}`));
      else resolve(data);
    });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Supabase helpers ──

async function supabaseGet(query) {
  const url = `${SUPABASE_URL}/rest/v1/shops?${query}`;
  const data = await curlFetch(url, {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
  });
  return JSON.parse(data);
}

async function supabaseUpdate(shopId, updates) {
  const url = `${SUPABASE_URL}/rest/v1/shops?id=eq.${shopId}`;
  const body = JSON.stringify(updates);
  return new Promise((resolve, reject) => {
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

async function supabaseInsert(shop) {
  const url = `${SUPABASE_URL}/rest/v1/shops`;
  const body = JSON.stringify(shop);
  return new Promise((resolve, reject) => {
    const curl = spawn('curl', [
      '-s', '-X', 'POST',
      '-H', `apikey: ${SUPABASE_KEY}`,
      '-H', `Authorization: Bearer ${SUPABASE_KEY}`,
      '-H', 'Content-Type: application/json',
      '-H', 'Prefer: return=representation',
      '-d', body,
      url
    ]);
    let data = '';
    curl.stdout.on('data', (chunk) => { data += chunk; });
    curl.on('close', (code) => {
      try {
        const parsed = JSON.parse(data);
        if (Array.isArray(parsed) && parsed.length > 0) resolve(parsed[0]);
        else if (parsed.message || parsed.code) reject(new Error(parsed.message || data));
        else resolve(parsed);
      } catch (e) {
        if (code !== 0) reject(new Error(`Insert failed: ${data.substring(0, 200)}`));
        else resolve(data);
      }
    });
  });
}

// ── Progress ──

function loadProgress() {
  try {
    if (existsSync(PROGRESS_FILE)) return JSON.parse(readFileSync(PROGRESS_FILE, 'utf8'));
  } catch (e) { /* ignore */ }
  return { completedCities: [], stats: { updated: 0, inserted: 0, skipped: 0 } };
}

function saveProgress(progress) {
  writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

// ── Google Places address parsing ──

function _parseGoogleAddress(address) {
  /**
   * Extract (state_full_name, zip_code) from a Google formatted_address string.
   * e.g. "1912 E 7th St, Austin, TX 78702, USA" → ["Texas", "78702"]
   */
  let zipCode = null;
  let state = null;

  // Try pattern: ", ST NNNNN"
  const m1 = address.match(/,\s*([A-Z]{2})\s+(\d{5})\b/);
  if (m1) {
    const abbrev = m1[1];
    zipCode = m1[2];
    state = ABBREV_TO_STATE[abbrev] || null;
  } else {
    // Try just zip
    const m2 = address.match(/\b(\d{5})\b/);
    if (m2) zipCode = m2[1];
  }

  return [state, zipCode];
}

const GOOGLE_COUNTRY_RE = /,?\s*(United States of America|United States|USA|US)\s*$/i;

function _cityFromGoogleAddress(address) {
  /**
   * Extract the city portion from a Google formatted_address.
   * e.g. "123 Main St, Greensburg, PA 15601, United States" → "Greensburg"
   */
  if (!address) return null;

  const clean = address.replace(GOOGLE_COUNTRY_RE, '').replace(/,\s*$/, '').trim();
  const parts = clean.split(',').map(p => p.trim()).filter(p => p);

  // Expect at least: street, city, "ST NNNNN"
  if (parts.length >= 3 && /^[A-Z]{2}\s+\d{5}/.test(parts[parts.length - 1])) {
    // Join middle parts (between street and state+zip) for multi-word cities
    return parts.slice(1, -1).join(', ');
  }

  return null;
}

// ── Google Place Details API ──

async function _googlePlaceDetails(placeId) {
  /**
   * Fetch phone, website, and opening hours for a place_id.
   * Returns [phone, website, hours]
   */
  try {
    const params = new URLSearchParams({
      place_id: placeId,
      fields: PLACES_DETAIL_FIELDS,
      key: GOOGLE_API_KEY,
    });
    const url = `${PLACES_DETAIL_URL}?${params}`;
    const data = await curlFetch(url, {}, { timeout: 8 });
    const json = JSON.parse(data);
    const result = json.result || {};

    const phone = result.formatted_phone_number || null;
    const website = result.website || null;
    const periods = (result.opening_hours && result.opening_hours.weekday_text) || [];
    const hours = periods.length > 0 ? periods.join('; ') : null;

    return [phone, website, hours];
  } catch (exc) {
    console.log(`    ⚠️  Google Places details error for ${placeId}: ${exc.message}`);
    return [null, null, null];
  }
}

// ── Google Places Text Search ──

async function searchGooglePlaces(city) {
  /**
   * Query the Google Places Text Search API for record/vinyl shops.
   * Fetches up to 3 pages (60 results) per search term, then enriches
   * each with a Details call to get phone number and website.
   *
   * Returns array of shop objects.
   */
  if (!GOOGLE_API_KEY) {
    console.log("  ⚠️  Google Places: no API key set, skipping");
    return [];
  }

  const shops = [];
  const seenPlaceIds = new Set();

  // Port BOTH search terms
  for (const term of ["record shop vinyl", "vinyl record store"]) {
    let params = {
      query: `${term} in ${city}`,
      key: GOOGLE_API_KEY,
    };
    let pagesFetched = 0;

    while (pagesFetched < 3) {
      let data;
      try {
        const queryStr = new URLSearchParams(params).toString();
        const url = `${PLACES_SEARCH_URL}?${queryStr}`;
        const resp = await curlFetch(url, {}, { timeout: 10 });
        data = JSON.parse(resp);
      } catch (exc) {
        console.log(`    ⚠️  Google Places search error: ${exc.message}`);
        break;
      }

      const status = data.status;
      if (status !== "OK" && status !== "ZERO_RESULTS") {
        console.log(`    ⚠️  Google Places status: ${status}`);
        break;
      }

      const results = data.results || [];
      for (const place of results) {
        const placeId = place.place_id;
        if (!placeId || seenPlaceIds.has(placeId)) continue;
        seenPlaceIds.add(placeId);

        const name = (place.name || '').trim();
        const address = (place.formatted_address || '').trim() || null;
        const rating = place.rating ? String(place.rating) : null;
        const reviewCount = place.user_ratings_total ? String(place.user_ratings_total) : null;

        // Lat/lon from search result geometry
        const geo = (place.geometry && place.geometry.location) || {};
        const latitude = geo.lat || null;
        const longitude = geo.lng || null;

        const [state, zipCode] = _parseGoogleAddress(address || '');
        const actualCity = _cityFromGoogleAddress(address || '');

        // Fetch phone + website from Details API
        const [phone, website, hours] = await _googlePlaceDetails(placeId);

        const formats = detectFormats(name);

        shops.push({
          name,
          city: actualCity || city,
          address,
          phone,
          website,
          hours,
          average_rating: rating,
          review_count: reviewCount,
          formats,
          latitude,
          longitude,
          state,
          zip: zipCode,
          slug: generateSlug(name, actualCity || city, state),
        });
      }

      const nextToken = data.next_page_token;
      if (!nextToken) break;

      pagesFetched++;
      // Google requires a short delay before using next_page_token
      await sleep(2000);
      params = { pagetoken: nextToken, key: GOOGLE_API_KEY };
    }
  }

  console.log(`  📊 Google Places: ${shops.length} results for ${city}`);
  return shops;
}

// ── Matching logic ──

function normalizeForMatch(name) {
  return name
    .toLowerCase()
    .replace(/[''`]/g, '')
    .replace(/&/g, 'and')
    .replace(/\b(records?|vinyl|music|shop|store|the|llc|inc)\b/g, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

function findExistingMatch(googleBiz, existingShops) {
  const googleNorm = normalizeForMatch(googleBiz.name);
  if (!googleNorm) return null;

  // Try exact normalized match first
  for (const shop of existingShops) {
    const shopNorm = normalizeForMatch(shop.name);
    if (googleNorm === shopNorm) return shop;
  }

  // Try substring match (one contains the other)
  for (const shop of existingShops) {
    const shopNorm = normalizeForMatch(shop.name);
    if (shopNorm.length > 3 && googleNorm.length > 3) {
      if (googleNorm.includes(shopNorm) || shopNorm.includes(googleNorm)) return shop;
    }
  }

  // Try phone match
  if (googleBiz.phone) {
    const googlePhone = googleBiz.phone.replace(/\D/g, '').slice(-10);
    for (const shop of existingShops) {
      if (shop.phone) {
        const shopPhone = shop.phone.replace(/\D/g, '').slice(-10);
        if (googlePhone === shopPhone && googlePhone.length === 10) return shop;
      }
    }
  }

  // Try address match
  if (googleBiz.address) {
    const googleAddr = googleBiz.address.toLowerCase().replace(/[^a-z0-9]/g, '');
    for (const shop of existingShops) {
      if (shop.address) {
        const shopAddr = shop.address.toLowerCase().replace(/[^a-z0-9]/g, '');
        // Match on street number + first word
        if (googleAddr.substring(0, 15) === shopAddr.substring(0, 15) && googleAddr.length > 10) return shop;
      }
    }
  }

  return null;
}

function buildUpdatePayload(existing, googleData) {
  const updates = {};

  // Only backfill null/empty fields — never overwrite existing data, never write 0 or empty string
  if (!existing.phone && googleData.phone) updates.phone = googleData.phone;
  if (!existing.website && googleData.website) updates.website = googleData.website;
  if (!existing.hours && googleData.hours) updates.hours = googleData.hours;
  if (!existing.zip && googleData.zip) updates.zip = googleData.zip;
  if (!existing.city && googleData.city) updates.city = googleData.city;
  if (!existing.address && googleData.address) updates.address = googleData.address;
  if (!existing.state && googleData.state) updates.state = googleData.state;
  if (!existing.latitude && googleData.latitude) updates.latitude = googleData.latitude;
  if (!existing.longitude && googleData.longitude) updates.longitude = googleData.longitude;

  // Only update rating/review_count if existing is null/0 and new value is > 0
  if ((!existing.average_rating || existing.average_rating === 0) && googleData.average_rating) {
    const rating = parseFloat(googleData.average_rating);
    if (rating > 0) updates.average_rating = rating;
  }
  if ((!existing.review_count || existing.review_count === 0) && googleData.review_count) {
    const count = parseInt(googleData.review_count);
    if (count > 0) updates.review_count = count;
  }

  // Merge formats array (only add new ones)
  if (googleData.formats && googleData.formats.length > 0) {
    const existingFormats = existing.formats || [];
    const newFormats = googleData.formats.filter(f => !existingFormats.includes(f));
    if (newFormats.length > 0) {
      updates.formats = [...existingFormats, ...newFormats];
    }
  }

  return updates;
}

// ── Main ──

async function processCity(cityStr, existingShops, progress) {
  console.log(`\n🏙️  ${cityStr}`);
  console.log('─'.repeat(50));

  const googleResults = await searchGooglePlaces(cityStr);

  if (googleResults.length === 0) {
    console.log('  ❌ No results found');
    return { searched: 0, matched: 0, updated: 0, inserted: 0, skipped: 0, candidates: [] };
  }

  let matched = 0, updated = 0, inserted = 0, skipped = 0;

  for (const biz of googleResults) {
    const existing = findExistingMatch(biz, existingShops);

    if (existing) {
      matched++;
      const updates = buildUpdatePayload(existing, biz);

      if (Object.keys(updates).length > 0) {
        if (!dryRun) {
          try {
            await supabaseUpdate(existing.id, updates);
            console.log(`  ✏️  Updated: ${existing.name} → +${Object.keys(updates).join(', ')}`);
          } catch (e) {
            console.log(`  ⚠️  Update failed for ${existing.name}: ${e.message}`);
          }
        } else {
          console.log(`  ✏️  [DRY] Would update: ${existing.name} → +${Object.keys(updates).join(', ')}`);
        }
        updated++;
      } else {
        skipped++;
      }
    } else {
      // New shop — insert
      if (!dryRun) {
        try {
          const result = await supabaseInsert(biz);
          console.log(`  ➕ Inserted: ${biz.name} (${biz.city}, ${biz.state || '?'})`);
          // Add to existingShops so we don't double-insert
          existingShops.push({ ...biz, id: result.id || 'new' });
        } catch (e) {
          console.log(`  ⚠️  Insert failed for ${biz.name}: ${e.message}`);
        }
      } else {
        console.log(`  ➕ [DRY] Would insert: ${biz.name} (${biz.city || '?'}, ${biz.state || '?'})`);
      }
      inserted++;
    }
  }

  console.log(`  📊 City total: ${googleResults.length} shops — ${matched} matched, ${updated} updated, ${inserted} new, ${skipped} unchanged`);

  return { searched: googleResults.length, matched, updated, inserted, skipped, candidates: googleResults.map(s => ({ ...s, city: cityStr })) };
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║  🔍 Google Places Record Shop Discovery                ║');
  console.log('╚══════════════════════════════════════════════════════════╝');

  if (dryRun) console.log('⚠️  DRY RUN — no database writes\n');

  if (!GOOGLE_API_KEY) {
    console.error('💀 Error: GOOGLE_API_KEY not set in .env');
    process.exit(1);
  }

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('💀 Error: SUPABASE_URL or SUPABASE_KEY not set in .env');
    process.exit(1);
  }

  console.log('🔑 Google API key found\n');

  // Load all existing shops for matching
  console.log('📡 Loading existing shops from Supabase...');
  const existingShops = await supabaseGet('select=id,name,city,state,phone,address,website,hours,zip,latitude,longitude,average_rating,review_count,formats&limit=2000');
  console.log(`📊 Loaded ${existingShops.length} existing shops\n`);

  const progress = loadProgress();

  // Build city list
  let cities = singleCity ? [singleCity] : TOP_CITIES;
  if (resume) {
    cities = cities.filter(c => !progress.completedCities.includes(c));
    console.log(`📍 Resuming — ${cities.length} cities remaining\n`);
  }
  if (cityLimit) cities = cities.slice(0, cityLimit);

  console.log(`📍 Processing ${cities.length} cities...\n`);

  // Create results directory
  if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, { recursive: true });

  const totals = { searched: 0, matched: 0, updated: 0, inserted: 0, skipped: 0, cities: 0 };
  const allCandidates = [];

  for (const city of cities) {
    const result = await processCity(city, existingShops, progress);

    totals.searched += result.searched;
    totals.matched += result.matched;
    totals.updated += result.updated;
    totals.inserted += result.inserted;
    totals.skipped += result.skipped;
    totals.cities++;
    if (result.candidates) allCandidates.push(...result.candidates);

    progress.completedCities.push(city);
    progress.stats = totals;
    if (!dryRun) saveProgress(progress);

    // Rate limit between cities (be nice to Google)
    await sleep(3000);
  }

  // Save full results with timestamp
  const timestamp = new Date().toISOString().replace(/:/g, '-').split('.')[0] + 'Z';
  const reportPath = path.join(RESULTS_DIR, `discovery_${timestamp}.json`);
  writeFileSync(reportPath, JSON.stringify({ timestamp, totals, progress, candidates: allCandidates }, null, 2));

  // Summary
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║  📊 Discovery Summary                                   ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`  Cities searched:  ${totals.cities}`);
  console.log(`  Google results:   ${totals.searched}`);
  console.log(`  Matched existing: ${totals.matched}`);
  console.log(`  Data backfilled:  ${totals.updated}`);
  console.log(`  New shops added:  ${totals.inserted}`);
  console.log(`  Unchanged:        ${totals.skipped}`);
  console.log(`\n  Report: ${reportPath}`);
}

main().catch(err => {
  console.error('💀 Fatal error:', err.message);
  process.exit(1);
});
