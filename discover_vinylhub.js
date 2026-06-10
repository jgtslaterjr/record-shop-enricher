#!/usr/bin/env node
/**
 * VinylHub Discovery — Discogs' crowd-sourced record store directory
 *
 * VinylHub (vinylhub.discogs.com) now lives at discogs.com/record-stores/,
 * a WordPress install whose map page server-renders EVERY store in the
 * directory (~2,600 worldwide) as marker divs with full data attributes:
 * name, street address, city, state, country, lat/lng, website, Discogs
 * seller URL, short description, and per-day hours.
 *
 * The www.discogs.com front is behind Cloudflare, but the WordPress origin
 * content.discogs.com serves the same page unchallenged — so this is a
 * single plain HTTP fetch, no browser needed.
 *
 * US stores are matched against the DB (name/coords/website); matches get
 * null fields backfilled (website, Discogs URL, address, coords, hours,
 * description), unmatched stores are inserted as stubs with
 * discovery_source='vinylhub' for later enrichment via master_deep_scrape.
 *
 * Usage:
 *   node discover_vinylhub.js                # full US run
 *   node discover_vinylhub.js --state TX     # one state (abbrev)
 *   node discover_vinylhub.js --limit 20     # first N stores
 *   node discover_vinylhub.js --dry-run      # no DB writes
 */

const path = require('path');
const cheerio = require('cheerio');
const { supabase, updateShop, parseArgs, log, saveJSON, generateSlug, STATE_MAP } = require('./lib/common');

const MAP_URL = 'https://content.discogs.com/record-stores/map/';
const RESULTS_DIR = path.join(__dirname, 'content', '_vinylhub_discovery');
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DAY_LABELS = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };

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

function rootDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

function buildHours(attribs) {
  const parts = [];
  let any = false;
  for (const day of DAYS) {
    const open = (attribs[`data-${day}-open`] || '').trim();
    const close = (attribs[`data-${day}-close`] || '').trim();
    if (close.toLowerCase() === 'closed' || (!open && !close)) {
      parts.push(`${DAY_LABELS[day]}: Closed`);
    } else if (open && close) {
      parts.push(`${DAY_LABELS[day]}: ${open} – ${close}`);
      any = true;
    } else {
      parts.push(`${DAY_LABELS[day]}: Unknown`);
    }
  }
  return any ? parts.join('; ') : null;
}

async function fetchVinylHubStores() {
  log(`📡 Fetching VinylHub map page (~4MB, every store in the directory)...`);
  const res = await fetch(MAP_URL, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`VinylHub map fetch failed: HTTP ${res.status}`);
  const html = await res.text();

  const $ = cheerio.load(html);
  const stores = [];
  $('.marker').each((_, el) => {
    const a = el.attribs;
    if (!a['data-title']) return;
    stores.push({
      name: a['data-title'].trim(),
      streetNumber: (a['data-street-number'] || '').trim(),
      streetName: (a['data-street-name'] || '').trim(),
      city: (a['data-city'] || '').trim(),
      state: (a['data-state'] || '').trim(),
      zip: (a['data-post-code'] || '').trim() || null,
      country: (a['data-country'] || '').trim(),
      latitude: a['data-lat'] ? parseFloat(a['data-lat']) : null,
      longitude: a['data-lng'] ? parseFloat(a['data-lng']) : null,
      website: (a['data-website'] || '').trim() || null,
      discogsUrl: (a['data-discogs-url'] || '').trim() || null,
      profileUrl: (a['data-profile'] || '').trim() || null,
      description: (a['data-short-description'] || '').trim() || null,
      hours: buildHours(a),
    });
  });

  log(`📊 Parsed ${stores.length} stores from VinylHub`);
  return stores;
}

function findExistingMatch(store, existingShops) {
  const storeNorm = normalizeForMatch(store.name);
  const stateFull = (STATE_MAP[store.state] || store.state || '').toLowerCase();
  const storeDomain = store.website ? rootDomain(store.website) : null;

  for (const shop of existingShops) {
    const shopNorm = normalizeForMatch(shop.name);
    const sameState = !stateFull || !shop.state ||
      shop.state.toLowerCase() === stateFull ||
      shop.state.toLowerCase() === (store.state || '').toLowerCase();
    // Scope name matches to the same city so multi-location chains
    // (two stores, same name, different cities) stay separate rows
    const sameCity = !store.city || !shop.city ||
      shop.city.trim().toLowerCase() === store.city.trim().toLowerCase();

    if (storeNorm && shopNorm && sameState && sameCity &&
        (storeNorm === shopNorm ||
         (storeNorm.length > 3 && shopNorm.length > 3 &&
          (storeNorm.includes(shopNorm) || shopNorm.includes(storeNorm))))) {
      return shop;
    }

    // Coordinate proximity (~150m)
    if (store.latitude && store.longitude && shop.latitude && shop.longitude &&
        kmBetween(store.latitude, store.longitude, shop.latitude, shop.longitude) < 0.15) {
      return shop;
    }

    // Same website domain
    if (storeDomain && shop.website && rootDomain(shop.website) === storeDomain) {
      return shop;
    }
  }
  return null;
}

function buildBackfill(existing, store) {
  const updates = {};
  const address = [store.streetNumber, store.streetName].filter(Boolean).join(' ') || null;

  if (!existing.website && store.website) updates.website = store.website;
  if (!existing.social_discogs && store.discogsUrl) updates.social_discogs = store.discogsUrl;
  if (!existing.address && address) updates.address = address;
  if (!existing.zip && store.zip) updates.zip = store.zip;
  if (!existing.latitude && store.latitude) updates.latitude = store.latitude;
  if (!existing.longitude && store.longitude) updates.longitude = store.longitude;
  if (!existing.hours && store.hours) updates.hours = store.hours;
  if (!existing.description && store.description) updates.description = store.description;

  return updates;
}

async function main() {
  const args = parseArgs();
  const dryRun = !!args['dry-run'];
  const stateFilter = args.state ? args.state.toUpperCase() : null;
  const limit = args.limit ? parseInt(args.limit) : null;

  if (dryRun) log('⚠️  DRY RUN — no database writes');

  const allStores = await fetchVinylHubStores();

  let usStores = allStores.filter(s => /^(united states|usa|us)$/i.test(s.country));
  log(`🇺🇸 ${usStores.length} US stores`);

  // Per-state counts over the FULL US set (before --state/--limit), used by the
  // quality dashboard as a coverage denominator
  const byState = {};
  for (const s of usStores) {
    const ab = (s.state || '').toUpperCase();
    if (ab) byState[ab] = (byState[ab] || 0) + 1;
  }
  const usStoreCountTotal = usStores.length;
  if (stateFilter) {
    usStores = usStores.filter(s => s.state.toUpperCase() === stateFilter);
    log(`📍 ${usStores.length} in ${stateFilter}`);
  }
  if (limit) usStores = usStores.slice(0, limit);

  const { data: existingShops, error } = await supabase
    .from('shops')
    .select('id, name, city, state, address, zip, website, latitude, longitude, social_discogs, hours, description')
    .limit(5000);
  if (error) throw error;
  log(`📡 Loaded ${existingShops.length} existing shops for matching\n`);

  const stats = { matched: 0, updated: 0, inserted: 0, unchanged: 0, failed: 0 };
  const inserted = [];

  for (const store of usStores) {
    const existing = findExistingMatch(store, existingShops);

    if (existing) {
      stats.matched++;
      const updates = buildBackfill(existing, store);
      if (Object.keys(updates).length === 0) {
        stats.unchanged++;
        continue;
      }
      if (dryRun) {
        log(`✏️  [DRY] Would backfill ${existing.name}: +${Object.keys(updates).join(', ')}`);
        stats.updated++;
      } else {
        try {
          await updateShop(existing.id, updates);
          log(`✏️  Backfilled ${existing.name}: +${Object.keys(updates).join(', ')}`);
          stats.updated++;
        } catch (e) {
          log(`⚠️  Update failed for ${existing.name}: ${e.message}`);
          stats.failed++;
        }
      }
      continue;
    }

    // New shop — insert a stub for later enrichment
    const stateFull = STATE_MAP[store.state] || store.state || null;
    const address = [store.streetNumber, store.streetName].filter(Boolean).join(' ') || null;
    const stub = {
      name: store.name,
      city: store.city || null,
      state: stateFull,
      address,
      zip: store.zip,
      latitude: store.latitude,
      longitude: store.longitude,
      website: store.website,
      social_discogs: store.discogsUrl,
      hours: store.hours,
      description: store.description,
      slug: generateSlug(store.name, store.city, stateFull),
      discovery_source: 'vinylhub',
    };

    if (dryRun) {
      log(`➕ [DRY] Would insert: ${store.name} (${store.city}, ${store.state})`);
      stats.inserted++;
      existingShops.push({ ...stub, id: 'dry-run' });
      continue;
    }

    const { data, error: insErr } = await supabase.from('shops').insert(stub).select();
    if (insErr) {
      log(`⚠️  Insert failed for ${store.name}: ${insErr.message}`);
      stats.failed++;
    } else {
      log(`➕ Inserted stub: ${store.name} (${store.city}, ${store.state})`);
      stats.inserted++;
      inserted.push({ id: data[0].id, name: store.name, city: store.city, state: store.state });
      existingShops.push(data[0]);
    }
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(RESULTS_DIR, `vinylhub_${timestamp}.json`);
  saveJSON(reportPath, { timestamp, dryRun, stateFilter, stats, inserted, usStoreCount: usStoreCountTotal, byState });

  log(`\n📊 Matched: ${stats.matched} (${stats.updated} backfilled) | New stubs: ${stats.inserted} | Unchanged: ${stats.unchanged} | Failed: ${stats.failed}`);
  if (stats.inserted > 0 && !dryRun) {
    log(`👉 Enrich the new stubs with: node master_deep_scrape.js --shop-id <id>`);
  }
  log(`📝 Report: ${reportPath}`);
}

main().catch(err => {
  console.error('💀 Fatal error:', err.message);
  process.exit(1);
});
