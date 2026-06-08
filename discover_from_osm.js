#!/usr/bin/env node
/**
 * OpenStreetMap-Based Record Shop Discovery & Enrichment
 *
 * Searches OpenStreetMap Overpass API for record shops in specified cities,
 * cross-references with our Supabase database, backfills missing data on
 * existing shops, and inserts newly discovered shops.
 *
 * Usage:
 *   node discover_from_osm.js                         # Run all 50 cities
 *   node discover_from_osm.js --limit 5               # First 5 cities only
 *   node discover_from_osm.js --city "Austin, TX"     # Single city
 *   node discover_from_osm.js --dry-run               # Preview only, no DB writes
 *   node discover_from_osm.js --resume                # Resume from last city
 */

require('dotenv').config();
const { writeFileSync, readFileSync, existsSync, mkdirSync } = require('fs');
const path = require('path');
const axios = require('axios');
const { supabase, findExistingShop, mergeShopData, generateSlug } = require('./lib/common');

// ── Config ──

const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const OSM_QUERY_TEMPLATE = `[out:json][timeout:30];
(
  area["name"="{city}"]["admin_level"~"[468]"];
  area["name"="{city}"]["place"~"city|town|municipality"];
)->.searchArea;
(
  node["shop"="music"](area.searchArea);
  node["shop"="record_store"](area.searchArea);
  node["shop"="records"](area.searchArea);
  node["amenity"="music_store"](area.searchArea);
  way["shop"="music"](area.searchArea);
  way["shop"="record_store"](area.searchArea);
);
out body;`;

const OSM_QUERY_FALLBACK = `[out:json][timeout:30];
area["name"="{city}"];
(
  node["shop"="music"](area);
  node["shop"="record_store"](area);
  node["shop"="records"](area);
  node["amenity"="music_store"](area);
  way["shop"="music"](area);
);
out body;`;

const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PROGRESS_FILE = path.join(__dirname, 'osm_discover_progress.json');
const RESULTS_DIR = path.join(__dirname, 'content', '_osm_discovery');

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

// ── State Mapping ──

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
for (const [name, abbr] of Object.entries(US_STATES)) {
  ABBREV_TO_STATE[abbr] = name.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

const STATE_MAP = {
  'AL':'Alabama','AK':'Alaska','AZ':'Arizona','AR':'Arkansas','CA':'California',
  'CO':'Colorado','CT':'Connecticut','DE':'Delaware','FL':'Florida','GA':'Georgia',
  'HI':'Hawaii','ID':'Idaho','IL':'Illinois','IN':'Indiana','IA':'Iowa','KS':'Kansas',
  'KY':'Kentucky','LA':'Louisiana','ME':'Maine','MD':'Maryland','MA':'Massachusetts',
  'MI':'Michigan','MN':'Minnesota','MS':'Mississippi','MO':'Missouri','MT':'Montana',
  'NE':'Nebraska','NV':'Nevada','NH':'New Hampshire','NJ':'New Jersey','NM':'New Mexico',
  'NY':'New York','NC':'North Carolina','ND':'North Dakota','OH':'Ohio','OK':'Oklahoma',
  'OR':'Oregon','PA':'Pennsylvania','RI':'Rhode Island','SC':'South Carolina',
  'SD':'South Dakota','TN':'Tennessee','TX':'Texas','UT':'Utah','VT':'Vermont',
  'VA':'Virginia','WA':'Washington','WV':'West Virginia','WI':'Wisconsin','WY':'Wyoming',
  'DC':'District of Columbia',
};

// ── Helper Functions ──

function _parseLocation(cityInput) {
  /**
   * Parse a city input like "Bar Harbor, Maine" or "Wayne, PA" into
   * components. Returns a dict with: city_name, state_name, state_abbrev
   */
  const parts = cityInput.split(',').map(p => p.trim());
  const cityName = parts[0].toLowerCase();
  const region = parts.length > 1 ? parts[1].trim() : '';
  const regionL = region.toLowerCase();

  let stateAbbrev = null;
  let stateName = null;

  if (US_STATES[regionL]) {
    stateName = regionL;
    stateAbbrev = US_STATES[regionL];
  } else if (ABBREV_TO_STATE[region.toUpperCase()]) {
    stateAbbrev = region.toUpperCase();
    stateName = ABBREV_TO_STATE[stateAbbrev].toLowerCase();
  }

  return {
    city_name: cityName,
    state_name: stateName,
    state_abbrev: stateAbbrev,
  };
}

async function _getJson(url, payload = null, timeout = 25000) {
  /**
   * Fetch JSON from URL, optionally POST with payload
   */
  try {
    let response;
    if (payload) {
      const formData = new URLSearchParams(payload).toString();
      response = await axios.post(url, formData, {
        headers: {
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        timeout: timeout,
      });
    } else {
      response = await axios.get(url, {
        headers: { 'User-Agent': USER_AGENT },
        timeout: timeout,
      });
    }
    return response.data;
  } catch (err) {
    console.log(`  ⚠️  JSON fetch failed for ${url}: ${err.message}`);
    return null;
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
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

// ── OSM Discovery Function ──

async function searchOsm(city) {
  /**
   * Query OpenStreetMap Overpass API for music/record shops.
   * Ported from Python scraper.py search_osm()
   */
  const shops = [];

  // Try the primary query first
  const cityName = city.split(',')[0].trim(); // strip state/country suffix
  let query = OSM_QUERY_TEMPLATE.replace('{city}', cityName);
  let data = await _getJson(OVERPASS_URL, { data: query });

  if (!data || !data.elements || data.elements.length === 0) {
    // Fallback query
    query = OSM_QUERY_FALLBACK.replace('{city}', cityName);
    data = await _getJson(OVERPASS_URL, { data: query });
  }

  if (!data) {
    return shops;
  }

  const loc = _parseLocation(city);
  const fallbackState = loc.state_abbrev || '';

  for (const el of (data.elements || [])) {
    const tags = el.tags || {};
    const name = tags.name;
    if (!name) {
      continue;
    }

    // Build address from OSM address tags
    const houseNum = tags['addr:housenumber'] || '';
    const streetTag = tags['addr:street'] || '';
    const osmCity = tags['addr:city'] || '';
    const stateTag = tags['addr:state'] || fallbackState;
    const postcode = tags['addr:postcode'] || '';

    const streetPart = [houseNum, streetTag].filter(p => p).join(' ').trim();

    // Build a Google-like formatted address ("123 Main St, Des Plaines, IL 60018")
    // only when a street component exists; otherwise leave address blank
    let address = null;
    if (streetPart) {
      const addrCity = osmCity || city.split(',')[0].trim();
      const stateZip = [stateTag, postcode].filter(p => p).join(' ');
      address = [streetPart, addrCity, stateZip].filter(p => p).join(', ') || null;
    }

    let phone = tags.phone || tags['contact:phone'] || null;
    let website = tags.website || tags['contact:website'] || null;
    if (website && !website.startsWith('http')) {
      website = 'https://' + website;
    }

    const openingHours = tags.opening_hours;
    const description = openingHours ? `Hours: ${openingHours}` : null;

    shops.push({
      name: name,
      city: city,
      address: address,
      phone: phone,
      website: website,
      description: description,
      state: stateTag || null,
      zip: postcode || null,
      sources: ['OpenStreetMap'],
    });
  }

  console.log(`  📍 OSM: ${shops.length} shops for ${city}`);
  return shops;
}

// ── Main Processing ──

async function processCity(cityStr, progress) {
  console.log(`\n🏙️  ${cityStr}`);
  console.log('─'.repeat(50));

  const osmResults = await searchOsm(cityStr);

  if (osmResults.length === 0) {
    console.log('  ❌ No results found');
    return { searched: 0, matched: 0, updated: 0, inserted: 0, skipped: 0, candidates: [] };
  }

  let matched = 0, updated = 0, inserted = 0, skipped = 0;

  for (const osmShop of osmResults) {
    // Parse city/state for matching
    const [cityName, stateAbbr] = cityStr.split(', ');
    const stateFull = STATE_MAP[stateAbbr] || stateAbbr || osmShop.state;

    // Find existing shop
    const existing = await findExistingShop(
      osmShop.name,
      cityName,
      stateFull,
      null, // no google_place_id from OSM
      null, // no lat
      null  // no lng
    );

    if (existing) {
      matched++;

      // Build update payload - only fill null/empty fields
      const updates = {};
      if (!existing.website && osmShop.website) updates.website = osmShop.website;
      if (!existing.phone && osmShop.phone) updates.phone = osmShop.phone;
      if (!existing.address && osmShop.address) updates.address = osmShop.address;
      if (!existing.zip && osmShop.zip) updates.zip = osmShop.zip;
      if (!existing.description && osmShop.description) updates.description = osmShop.description;

      if (Object.keys(updates).length > 0) {
        if (!dryRun) {
          try {
            const { error } = await supabase.from('shops').update(updates).eq('id', existing.id);
            if (error) throw error;
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
      const newShop = {
        name: osmShop.name,
        city: cityName,
        state: stateFull,
        address: osmShop.address,
        phone: osmShop.phone,
        website: osmShop.website,
        description: osmShop.description,
        zip: osmShop.zip,
        slug: generateSlug(osmShop.name, cityName, stateFull),
      };

      if (!dryRun) {
        try {
          const { data: result, error } = await supabase.from('shops').insert(newShop).select();
          if (error) throw error;
          console.log(`  ➕ Inserted: ${newShop.name} (${newShop.city}, ${newShop.state})`);
        } catch (e) {
          console.log(`  ⚠️  Insert failed for ${newShop.name}: ${e.message}`);
        }
      } else {
        console.log(`  ➕ [DRY] Would insert: ${newShop.name} (${newShop.city || '?'}, ${newShop.state || '?'})`);
      }
      inserted++;
    }
  }

  console.log(`  📊 City total: ${osmResults.length} shops — ${matched} matched, ${updated} updated, ${inserted} new, ${skipped} unchanged`);

  return { searched: osmResults.length, matched, updated, inserted, skipped, candidates: osmResults.map(s => ({ ...s, city: cityStr })) };
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║  🗺️  OpenStreetMap Record Shop Discovery              ║');
  console.log('╚══════════════════════════════════════════════════════════╝');

  if (dryRun) console.log('⚠️  DRY RUN — no database writes\n');

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
    const result = await processCity(city, progress);

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

    // Rate limit between cities - be respectful to Overpass API
    await sleep(3000);
  }

  // Save full results
  const today = new Date().toISOString().split('T')[0];
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').split('Z')[0];
  const reportPath = path.join(RESULTS_DIR, `${timestamp}.json`);
  writeFileSync(reportPath, JSON.stringify({ date: today, totals, progress, candidates: allCandidates }, null, 2));

  // Summary
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║  📊 Discovery Summary                                   ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`  Cities searched: ${totals.cities}`);
  console.log(`  OSM results:     ${totals.searched}`);
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
