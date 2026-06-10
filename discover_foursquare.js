#!/usr/bin/env node
/**
 * Foursquare Places Discovery — independent cross-check on Google
 *
 * Searches the Foursquare Places API city-by-city for record stores,
 * matches results against the DB, backfills missing fields (phone,
 * website, address, coordinates, rating), and inserts unmatched shops as
 * stubs with discovery_source='foursquare'. Foursquare's index skews
 * urban/independent, which makes it a good complement to Google Places.
 *
 * Requires FOURSQUARE_API_KEY in .env. Both key generations work:
 *   - Legacy v3 key (starts with "fsq3") → api.foursquare.com/v3
 *   - New service key → places-api.foursquare.com with Bearer auth
 * The script detects which to use and falls back automatically on 401.
 *
 * Usage:
 *   node discover_foursquare.js --city "Austin, TX"
 *   node discover_foursquare.js                # top-50 US cities + vinyl hubs
 *   node discover_foursquare.js --resume       # skip completed cities
 *   node discover_foursquare.js --limit 5      # first N cities
 *   node discover_foursquare.js --dry-run
 */

const path = require('path');
const fs = require('fs');
const { supabase, updateShop, parseArgs, log, saveJSON, generateSlug, STATE_MAP } = require('./lib/common');

const FOURSQUARE_API_KEY = process.env.FOURSQUARE_API_KEY;
const PROGRESS_FILE = path.join(__dirname, 'foursquare_discover_progress.json');
const RESULTS_DIR = path.join(__dirname, 'content', '_foursquare_discovery');

// Same city list as discover_from_google_places.js
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
  'Brooklyn, NY', 'Detroit, MI', 'Pittsburgh, PA', 'St. Louis, MO', 'Cincinnati, OH',
  'Richmond, VA', 'Salt Lake City, UT', 'Asheville, NC', 'Burlington, VT', 'Savannah, GA',
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Foursquare API (handles both key generations) ──────────

let apiStyle = FOURSQUARE_API_KEY && FOURSQUARE_API_KEY.startsWith('fsq3') ? 'v3' : 'new';

async function fsqSearch(params) {
  const qs = new URLSearchParams(params).toString();

  const attempt = async (style) => {
    const url = style === 'v3'
      ? `https://api.foursquare.com/v3/places/search?${qs}`
      : `https://places-api.foursquare.com/places/search?${qs}`;
    const headers = style === 'v3'
      ? { Accept: 'application/json', Authorization: FOURSQUARE_API_KEY }
      : { Accept: 'application/json', Authorization: `Bearer ${FOURSQUARE_API_KEY}`, 'X-Places-Api-Version': '2025-06-17' };
    return fetch(url, { headers });
  };

  let res = await attempt(apiStyle);
  if (res.status === 401 || res.status === 410) {
    const other = apiStyle === 'v3' ? 'new' : 'v3';
    log(`  ℹ️  ${apiStyle}-style auth rejected (${res.status}), trying ${other}-style endpoint`);
    res = await attempt(other);
    if (res.ok) apiStyle = other;
  }
  if (res.status === 429) {
    log('  ⏳ Foursquare rate limited — waiting 30s');
    await sleep(30000);
    res = await attempt(apiStyle);
  }
  if (!res.ok) throw new Error(`Foursquare API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/** Normalize a place from either API generation into one shape. */
function normalizePlace(p) {
  const loc = p.location || {};
  const geoMain = (p.geocodes && p.geocodes.main) || {};
  const social = p.social_media || {};
  return {
    fsqId: p.fsq_id || p.fsq_place_id,
    name: (p.name || '').trim(),
    address: loc.address || null,
    city: loc.locality || null,
    state: loc.region || null,           // two-letter for US
    zip: loc.postcode || null,
    latitude: p.latitude ?? geoMain.latitude ?? null,
    longitude: p.longitude ?? geoMain.longitude ?? null,
    phone: p.tel || null,
    website: p.website || null,
    rating: p.rating ?? null,            // 0–10 scale
    ratingCount: (p.stats && (p.stats.total_ratings || p.stats.total_tips)) || null,
    instagram: social.instagram || null,
    facebook: social.facebook_id || null,
    categories: (p.categories || []).map(c => c.name),
  };
}

const RECORD_RE = /record|vinyl|music store|used cds/i;

async function searchCity(city) {
  const fields = 'fsq_id,fsq_place_id,name,location,geocodes,latitude,longitude,tel,website,rating,stats,social_media,categories';
  const seen = new Set();
  const places = [];

  for (const query of ['record store', 'vinyl records']) {
    let data;
    try {
      data = await fsqSearch({ query, near: city, limit: '50', fields });
    } catch (e) {
      log(`  ⚠️  Search "${query}" failed: ${e.message}`);
      continue;
    }
    for (const raw of data.results || []) {
      const place = normalizePlace(raw);
      if (!place.fsqId || seen.has(place.fsqId)) continue;
      seen.add(place.fsqId);
      // Keep only actual record/music retail — Foursquare text search can drift
      const catText = place.categories.join(' ');
      if (RECORD_RE.test(place.name) || RECORD_RE.test(catText)) places.push(place);
    }
    await sleep(1200);
  }

  log(`  📊 Foursquare: ${places.length} record stores in ${city}`);
  return places;
}

// ── Matching (same strategy family as the Google discoverer) ──

function normalizeForMatch(name) {
  return (name || '')
    .toLowerCase()
    .replace(/[''`]/g, '')
    .replace(/&/g, 'and')
    .replace(/\b(records?|vinyl|music|shop|store|the|llc|inc)\b/g, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

function kmBetween(lat1, lng1, lat2, lng2) {
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function findExistingMatch(place, existingShops) {
  const placeNorm = normalizeForMatch(place.name);
  const stateFull = place.state && STATE_MAP[place.state.toUpperCase()];

  for (const shop of existingShops) {
    const sameState = !stateFull || !shop.state ||
      shop.state.toLowerCase() === stateFull.toLowerCase() ||
      shop.state.toLowerCase() === place.state.toLowerCase();
    const sameCity = !place.city || !shop.city ||
      shop.city.trim().toLowerCase() === place.city.trim().toLowerCase();

    const shopNorm = normalizeForMatch(shop.name);
    if (placeNorm && shopNorm && sameState && sameCity &&
        (placeNorm === shopNorm ||
         (placeNorm.length > 3 && shopNorm.length > 3 &&
          (placeNorm.includes(shopNorm) || shopNorm.includes(placeNorm))))) {
      return shop;
    }

    if (place.phone && shop.phone) {
      const a = place.phone.replace(/\D/g, '').slice(-10);
      const b = shop.phone.replace(/\D/g, '').slice(-10);
      if (a.length === 10 && a === b) return shop;
    }

    if (place.latitude && place.longitude && shop.latitude && shop.longitude &&
        kmBetween(place.latitude, place.longitude, shop.latitude, shop.longitude) < 0.15) {
      return shop;
    }
  }
  return null;
}

function buildBackfill(existing, place) {
  const updates = {};
  if (!existing.phone && place.phone) updates.phone = place.phone;
  if (!existing.website && place.website) updates.website = place.website;
  if (!existing.address && place.address) updates.address = place.address;
  if (!existing.zip && place.zip) updates.zip = place.zip;
  if (!existing.latitude && place.latitude) updates.latitude = place.latitude;
  if (!existing.longitude && place.longitude) updates.longitude = place.longitude;
  if (!existing.social_instagram && place.instagram) updates.social_instagram = place.instagram;
  return updates;
}

function loadProgress() {
  try {
    if (fs.existsSync(PROGRESS_FILE)) return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
  } catch (e) { /* ignore */ }
  return { completedCities: [], stats: { matched: 0, updated: 0, inserted: 0, unchanged: 0, failed: 0 } };
}

// ── Main ───────────────────────────────────────────────────

async function main() {
  const args = parseArgs();
  const dryRun = !!args['dry-run'];
  const singleCity = args.city || null;
  const cityLimit = args.limit ? parseInt(args.limit) : null;
  const resume = !!args.resume;

  if (!FOURSQUARE_API_KEY) {
    console.error('💀 FOURSQUARE_API_KEY not set in .env (get one at foursquare.com/developers)');
    process.exit(1);
  }
  if (dryRun) log('⚠️  DRY RUN — no database writes');

  const progress = loadProgress();
  let cities = singleCity ? [singleCity] : TOP_CITIES;
  if (resume) {
    cities = cities.filter(c => !progress.completedCities.includes(c));
    log(`📍 Resuming — ${cities.length} cities remaining`);
  }
  if (cityLimit) cities = cities.slice(0, cityLimit);

  const { data: existingShops, error } = await supabase
    .from('shops')
    .select('id, name, city, state, address, zip, phone, website, latitude, longitude, social_instagram')
    .limit(5000);
  if (error) throw error;
  log(`📡 Loaded ${existingShops.length} existing shops for matching`);

  const stats = progress.stats;
  const insertedLog = [];

  for (const city of cities) {
    log(`\n🏙️  ${city}`);
    const places = await searchCity(city);

    for (const place of places) {
      const existing = findExistingMatch(place, existingShops);

      if (existing) {
        stats.matched++;
        const updates = buildBackfill(existing, place);
        if (Object.keys(updates).length === 0) { stats.unchanged++; continue; }
        if (dryRun) {
          log(`  ✏️  [DRY] Would backfill ${existing.name}: +${Object.keys(updates).join(', ')}`);
          stats.updated++;
        } else {
          try {
            await updateShop(existing.id, updates);
            log(`  ✏️  Backfilled ${existing.name}: +${Object.keys(updates).join(', ')}`);
            stats.updated++;
          } catch (e) {
            log(`  ⚠️  Update failed for ${existing.name}: ${e.message}`);
            stats.failed++;
          }
        }
        continue;
      }

      const stateFull = (place.state && STATE_MAP[place.state.toUpperCase()]) || place.state || null;
      const stub = {
        name: place.name,
        city: place.city,
        state: stateFull,
        address: place.address,
        zip: place.zip,
        phone: place.phone,
        website: place.website,
        latitude: place.latitude,
        longitude: place.longitude,
        social_instagram: place.instagram,
        slug: generateSlug(place.name, place.city, stateFull),
        discovery_source: 'foursquare',
      };

      if (dryRun) {
        log(`  ➕ [DRY] Would insert: ${place.name} (${place.city}, ${place.state})`);
        stats.inserted++;
        existingShops.push({ ...stub, id: 'dry-run' });
        continue;
      }

      const { data, error: insErr } = await supabase.from('shops').insert(stub).select();
      if (insErr) {
        log(`  ⚠️  Insert failed for ${place.name}: ${insErr.message}`);
        stats.failed++;
      } else {
        log(`  ➕ Inserted stub: ${place.name} (${place.city}, ${place.state})`);
        stats.inserted++;
        insertedLog.push({ id: data[0].id, name: place.name, city: place.city, state: place.state });
        existingShops.push(data[0]);
      }
    }

    if (!dryRun && !singleCity) {
      progress.completedCities.push(city);
      progress.stats = stats;
      fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
    }
    await sleep(2000);
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(RESULTS_DIR, `foursquare_${timestamp}.json`);
  saveJSON(reportPath, { timestamp, dryRun, stats, inserted: insertedLog });

  log(`\n📊 Matched: ${stats.matched} (${stats.updated} backfilled) | New stubs: ${stats.inserted} | Unchanged: ${stats.unchanged} | Failed: ${stats.failed}`);
  log(`📝 Report: ${reportPath}`);
}

main().catch(err => {
  console.error('💀 Fatal error:', err.message);
  process.exit(1);
});
