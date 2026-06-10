#!/usr/bin/env node
/**
 * Record Store Day Discovery — the curated US indie record store list
 *
 * recordstoreday.com/Stores?state=XX embeds the participating-store list
 * for each state as a JS literal (`var venues = [...]`) with name, address,
 * city, state, lat/lng, website, and the zip inside
 * google_maps_searchstring. RSD participation is a strong quality signal —
 * these are verified independent record stores.
 *
 * The site sits behind AWS WAF and starts serving JS challenges (HTTP 202)
 * after a few quick requests, so this script paces itself (~12s between
 * states), retries with backoff, and falls back to the stealth Playwright
 * browser (which solves the WAF challenge automatically) when plain
 * fetches stay blocked.
 *
 * Matches get rsd_participant=true plus null-field backfill; unmatched
 * stores are inserted as stubs with discovery_source='record_store_day'.
 *
 * Usage:
 *   node discover_rsd.js                 # all 50 states + DC (slow on purpose, ~15 min)
 *   node discover_rsd.js --state TX      # one state
 *   node discover_rsd.js --resume        # skip states already completed
 *   node discover_rsd.js --dry-run       # no DB writes
 */

const path = require('path');
const fs = require('fs');
const { supabase, updateShop, parseArgs, log, saveJSON, generateSlug, STATE_MAP, createStealthBrowser } = require('./lib/common');

const STORES_URL = 'https://recordstoreday.com/Stores';
const RESULTS_DIR = path.join(__dirname, 'content', '_rsd_discovery');
const PROGRESS_FILE = path.join(__dirname, 'rsd_discover_progress.json');
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const ALL_STATES = Object.keys(STATE_MAP); // abbreviations, includes DC

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(s) {
  if (!s) return s;
  return s
    .replace(/&#(\d+);/g, (_, n) => {
      const code = parseInt(n);
      // Windows-1252 smart quotes that show up as low numeric entities
      const cp1252 = { 145: 0x2018, 146: 0x2019, 147: 0x201C, 148: 0x201D, 150: 0x2013, 151: 0x2014 };
      return String.fromCodePoint(cp1252[code] || code);
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, name) => NAMED_ENTITIES[name]);
}

/** Parse the `var venues = [...]` literal out of the page HTML. */
function parseVenues(html) {
  const start = html.indexOf('var venues = [');
  if (start === -1) return null;
  const arrayStart = html.indexOf('[', start);
  // Walk to the matching closing bracket
  let depth = 0, end = -1;
  for (let i = arrayStart; i < html.length; i++) {
    if (html[i] === '[') depth++;
    else if (html[i] === ']') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) return null;
  // The literal has trailing commas (valid JS, invalid JSON) — strip them
  const jsonish = html.slice(arrayStart, end + 1).replace(/,(\s*[}\]])/g, '$1');
  try {
    return JSON.parse(jsonish);
  } catch (e) {
    log(`  ⚠️  venues parse error: ${e.message}`);
    return null;
  }
}

let _stealth = null;
async function getStealthPage() {
  if (!_stealth) {
    log('  🥷 Launching stealth browser for WAF bypass...');
    const { browser, context } = await createStealthBrowser();
    _stealth = { browser, page: await context.newPage() };
  }
  return _stealth.page;
}

async function closeStealth() {
  if (_stealth) {
    await _stealth.browser.close().catch(() => {});
    _stealth = null;
  }
}

async function fetchStateVenues(state) {
  const url = `${STORES_URL}?state=${state}`;

  // Plain fetch first, with backoff on WAF 202s
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });
      if (res.status === 200) {
        const venues = parseVenues(await res.text());
        if (venues) return venues;
        // 200 without venues = unexpected page shape; fall through to retry
      } else if (res.status !== 202) {
        log(`  ⚠️  HTTP ${res.status} for ${state}`);
      }
    } catch (e) {
      log(`  ⚠️  Fetch error for ${state}: ${e.message}`);
    }
    const waitMs = 20000 * (attempt + 1) + Math.floor(Math.random() * 8000);
    log(`  ⏳ WAF challenge or bad response — waiting ${Math.round(waitMs / 1000)}s (attempt ${attempt + 1}/3)`);
    await sleep(waitMs);
  }

  // Stealth browser fallback — a real browser solves the WAF JS challenge
  try {
    const page = await getStealthPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(5000);
    const venues = await page.evaluate(() => (typeof venues !== 'undefined' ? venues : (window.venues || null)));
    if (venues) return venues;
    // The WAF challenge may have rendered first; give it time to redirect
    await page.waitForTimeout(10000);
    return await page.evaluate(() => (typeof venues !== 'undefined' ? venues : (window.venues || null)));
  } catch (e) {
    log(`  ⚠️  Stealth fallback failed for ${state}: ${e.message}`);
    return null;
  }
}

function zipFromSearchString(s) {
  if (!s) return null;
  const m = s.match(/\b(\d{5})(?:-\d{4})?\b/);
  return m ? m[1] : null;
}

function rootDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

function findExistingMatch(venue, existingShops, stateFull) {
  const venueNorm = normalizeForMatch(venue.name);
  const venueDomain = venue.website_address ? rootDomain(venue.website_address) : null;
  const lat = parseFloat(venue.latitude), lng = parseFloat(venue.longitude);

  for (const shop of existingShops) {
    const sameState = !shop.state || !stateFull ||
      shop.state.toLowerCase() === stateFull.toLowerCase() ||
      shop.state.toLowerCase() === (venue.state || '').toLowerCase();
    const sameCity = !venue.city || !shop.city ||
      shop.city.trim().toLowerCase() === venue.city.trim().toLowerCase();

    const shopNorm = normalizeForMatch(shop.name);
    if (venueNorm && shopNorm && sameState && sameCity &&
        (venueNorm === shopNorm ||
         (venueNorm.length > 3 && shopNorm.length > 3 &&
          (venueNorm.includes(shopNorm) || shopNorm.includes(venueNorm))))) {
      return shop;
    }

    if (lat && lng && shop.latitude && shop.longitude &&
        kmBetween(lat, lng, shop.latitude, shop.longitude) < 0.15) {
      return shop;
    }

    if (venueDomain && shop.website && rootDomain(shop.website) === venueDomain) {
      return shop;
    }
  }
  return null;
}

function loadProgress() {
  try {
    if (fs.existsSync(PROGRESS_FILE)) return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
  } catch (e) { /* ignore */ }
  return { completedStates: [], stats: { matched: 0, updated: 0, inserted: 0, unchanged: 0, failed: 0 } };
}

async function processState(state, existingShops, stats, insertedLog, dryRun) {
  const stateFull = STATE_MAP[state];
  log(`\n🏛️  ${state} (${stateFull})`);

  const venues = await fetchStateVenues(state);
  if (!venues) {
    log(`  ❌ Could not load venues for ${state}`);
    return false;
  }
  log(`  📊 ${venues.length} RSD stores`);

  for (const venue of venues) {
    if (!venue.name) continue;
    venue.name = decodeEntities(venue.name);
    venue.city = decodeEntities(venue.city);
    venue.address = decodeEntities(venue.address);
    const zip = zipFromSearchString(venue.google_maps_searchstring);
    const lat = parseFloat(venue.latitude) || null;
    const lng = parseFloat(venue.longitude) || null;
    const website = (venue.website_address || '').trim() || null;

    const existing = findExistingMatch(venue, existingShops, stateFull);
    if (existing) {
      stats.matched++;
      const updates = {};
      if (existing.rsd_participant !== true) updates.rsd_participant = true;
      if (!existing.website && website) updates.website = website;
      if (!existing.address && venue.address) updates.address = venue.address.trim();
      if (!existing.zip && zip) updates.zip = zip;
      if (!existing.latitude && lat) updates.latitude = lat;
      if (!existing.longitude && lng) updates.longitude = lng;

      if (Object.keys(updates).length === 0) {
        stats.unchanged++;
        continue;
      }
      if (dryRun) {
        log(`  ✏️  [DRY] Would update ${existing.name}: +${Object.keys(updates).join(', ')}`);
        existing.rsd_participant = true;
        stats.updated++;
      } else {
        try {
          await updateShop(existing.id, updates);
          existing.rsd_participant = true;
          log(`  ✏️  Updated ${existing.name}: +${Object.keys(updates).join(', ')}`);
          stats.updated++;
        } catch (e) {
          log(`  ⚠️  Update failed for ${existing.name}: ${e.message}`);
          stats.failed++;
        }
      }
      continue;
    }

    const stub = {
      name: venue.name.trim(),
      city: (venue.city || '').trim() || null,
      state: stateFull,
      address: (venue.address || '').trim() || null,
      zip,
      latitude: lat,
      longitude: lng,
      website,
      slug: generateSlug(venue.name, venue.city, stateFull),
      discovery_source: 'record_store_day',
      rsd_participant: true,
    };

    if (dryRun) {
      log(`  ➕ [DRY] Would insert: ${stub.name} (${stub.city}, ${state})`);
      stats.inserted++;
      existingShops.push({ ...stub, id: 'dry-run' });
      continue;
    }

    const { data, error } = await supabase.from('shops').insert(stub).select();
    if (error) {
      log(`  ⚠️  Insert failed for ${stub.name}: ${error.message}`);
      stats.failed++;
    } else {
      log(`  ➕ Inserted stub: ${stub.name} (${stub.city}, ${state})`);
      stats.inserted++;
      insertedLog.push({ id: data[0].id, name: stub.name, city: stub.city, state });
      existingShops.push(data[0]);
    }
  }
  return true;
}

async function main() {
  const args = parseArgs();
  const dryRun = !!args['dry-run'];
  const singleState = args.state ? args.state.toUpperCase() : null;
  const resume = !!args.resume;

  if (dryRun) log('⚠️  DRY RUN — no database writes');

  const progress = loadProgress();
  let states = singleState ? [singleState] : ALL_STATES;
  if (resume) {
    states = states.filter(s => !progress.completedStates.includes(s));
    log(`📍 Resuming — ${states.length} states remaining`);
  }

  const { data: existingShops, error } = await supabase
    .from('shops')
    .select('id, name, city, state, address, zip, website, latitude, longitude, rsd_participant')
    .limit(5000);
  if (error) throw error;
  log(`📡 Loaded ${existingShops.length} existing shops for matching`);

  const stats = progress.stats;
  const insertedLog = [];

  for (let i = 0; i < states.length; i++) {
    const ok = await processState(states[i], existingShops, stats, insertedLog, dryRun);
    if (ok && !dryRun && !singleState) {
      progress.completedStates.push(states[i]);
      progress.stats = stats;
      fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
    }
    // Pace well under the WAF threshold
    if (i < states.length - 1) await sleep(10000 + Math.floor(Math.random() * 5000));
  }

  await closeStealth();

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(RESULTS_DIR, `rsd_${timestamp}.json`);
  saveJSON(reportPath, { timestamp, dryRun, states, stats, inserted: insertedLog });

  log(`\n📊 Matched: ${stats.matched} (${stats.updated} updated) | New stubs: ${stats.inserted} | Unchanged: ${stats.unchanged} | Failed: ${stats.failed}`);
  log(`📝 Report: ${reportPath}`);
}

main().catch(async err => {
  await closeStealth();
  console.error('💀 Fatal error:', err.message);
  process.exit(1);
});
