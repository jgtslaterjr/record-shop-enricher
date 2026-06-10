#!/usr/bin/env node
/**
 * Google place_id Backfill — gives every shop a bulletproof dedup key
 *
 * For each shop missing google_place_id, queries the Google Places
 * "Find Place from Text" API and verifies the candidate against what we
 * already know (name, coordinates, street address) before saving.
 * Also captures business_status while we're paying for the call, so the
 * first closure sweep comes free with the backfill.
 *
 * Shops where Google's best candidate can't be verified are skipped and
 * written to a review report — never guessed.
 *
 * Cost: Find Place (Basic fields) ≈ $17 per 1000 calls → full ~900-shop
 * backfill ≈ $15. Re-runs only touch shops still missing a place_id.
 *
 * Usage:
 *   node backfill_place_ids.js                  # all shops missing place_id
 *   node backfill_place_ids.js --limit 25      # first 25
 *   node backfill_place_ids.js --shop-id uuid  # single shop
 *   node backfill_place_ids.js --force         # re-resolve even if set
 *   node backfill_place_ids.js --dry-run       # no DB writes
 */

const path = require('path');
const { supabase, updateShop, parseArgs, log, saveJSON } = require('./lib/common');

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const FIND_PLACE_URL = 'https://maps.googleapis.com/maps/api/place/findplacefromtext/json';
const REPORT_DIR = path.join(__dirname, 'content', '_place_id_backfill');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function normalizeName(name) {
  return (name || '')
    .toLowerCase()
    .replace(/[''`]/g, '')
    .replace(/&/g, 'and')
    .replace(/\b(records?|vinyl|music|shop|store|the|llc|inc|co)\b/g, '')
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

async function findPlace(shop) {
  const locationHint = shop.address || [shop.city, shop.state].filter(Boolean).join(', ');
  const params = new URLSearchParams({
    input: `${shop.name}, ${locationHint}`,
    inputtype: 'textquery',
    fields: 'place_id,name,formatted_address,geometry,business_status',
    key: GOOGLE_API_KEY,
  });
  if (shop.latitude && shop.longitude) {
    params.set('locationbias', `circle:5000@${shop.latitude},${shop.longitude}`);
  }

  const res = await fetch(`${FIND_PLACE_URL}?${params}`);
  const data = await res.json();
  if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
    throw new Error(`Find Place status: ${data.status}${data.error_message ? ` — ${data.error_message}` : ''}`);
  }
  return (data.candidates && data.candidates[0]) || null;
}

/**
 * Accept Google's candidate only when it corroborates something we already
 * know about the shop. Returns the matched signal name, or null to reject.
 */
function verifyCandidate(shop, candidate) {
  const shopNorm = normalizeName(shop.name);
  const candNorm = normalizeName(candidate.name);
  if (shopNorm && candNorm &&
      (shopNorm === candNorm ||
       (shopNorm.length > 3 && candNorm.length > 3 &&
        (shopNorm.includes(candNorm) || candNorm.includes(shopNorm))))) {
    return 'name';
  }

  const loc = candidate.geometry && candidate.geometry.location;
  if (loc && shop.latitude && shop.longitude &&
      kmBetween(shop.latitude, shop.longitude, loc.lat, loc.lng) < 0.5) {
    return 'coordinates';
  }

  if (shop.address && candidate.formatted_address) {
    const a = shop.address.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 15);
    const b = candidate.formatted_address.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (a.length > 8 && b.includes(a)) return 'address';
  }

  return null;
}

async function main() {
  const args = parseArgs();
  const dryRun = !!args['dry-run'];
  const limit = args.limit ? parseInt(args.limit) : null;

  if (!GOOGLE_API_KEY) {
    console.error('💀 GOOGLE_API_KEY not set in .env');
    process.exit(1);
  }
  if (dryRun) log('⚠️  DRY RUN — no database writes');

  let query = supabase
    .from('shops')
    .select('id, name, city, state, address, latitude, longitude, google_place_id')
    .order('name');
  if (args['shop-id']) query = query.eq('id', args['shop-id']);
  else if (!args.force) query = query.is('google_place_id', null);
  if (limit) query = query.limit(limit);

  const { data: shops, error } = await query;
  if (error) throw error;

  log(`📡 ${shops.length} shops to resolve\n`);

  const stats = { resolved: 0, unverified: 0, notFound: 0, errors: 0 };
  const needsReview = [];

  for (let i = 0; i < shops.length; i++) {
    const shop = shops[i];
    log(`[${i + 1}/${shops.length}] ${shop.name} (${shop.city}, ${shop.state})`);

    let candidate;
    try {
      candidate = await findPlace(shop);
    } catch (e) {
      log(`  ⚠️  ${e.message}`);
      stats.errors++;
      // OVER_QUERY_LIMIT etc. — back off before continuing
      await sleep(5000);
      continue;
    }

    if (!candidate) {
      log('  ✗ No Google candidate found');
      stats.notFound++;
      needsReview.push({ shop: { id: shop.id, name: shop.name, city: shop.city, state: shop.state }, reason: 'no_candidate' });
      await sleep(120);
      continue;
    }

    const signal = verifyCandidate(shop, candidate);
    if (!signal) {
      log(`  ✗ Unverified candidate "${candidate.name}" (${candidate.formatted_address}) — skipping`);
      stats.unverified++;
      needsReview.push({
        shop: { id: shop.id, name: shop.name, city: shop.city, state: shop.state, address: shop.address },
        candidate,
        reason: 'no_corroborating_signal',
      });
      await sleep(120);
      continue;
    }

    const updates = {
      google_place_id: candidate.place_id,
      business_status_checked_at: new Date().toISOString(),
    };
    if (candidate.business_status) updates.business_status = candidate.business_status;

    if (dryRun) {
      log(`  ✓ [DRY] ${candidate.place_id} (verified by ${signal}${candidate.business_status ? `, ${candidate.business_status}` : ''})`);
    } else {
      try {
        await updateShop(shop.id, updates);
        log(`  ✓ ${candidate.place_id} (verified by ${signal}${candidate.business_status ? `, ${candidate.business_status}` : ''})`);
      } catch (e) {
        // Unique index violation means another row already owns this place_id — a duplicate shop
        log(`  ⚠️  DB update failed: ${e.message}`);
        stats.errors++;
        needsReview.push({
          shop: { id: shop.id, name: shop.name, city: shop.city, state: shop.state },
          candidate,
          reason: `db_error: ${e.message}`,
        });
        await sleep(120);
        continue;
      }
    }
    stats.resolved++;
    await sleep(120);
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(REPORT_DIR, `backfill_${timestamp}.json`);
  saveJSON(reportPath, { timestamp, dryRun, stats, needsReview });

  log(`\n📊 Resolved: ${stats.resolved} | Unverified: ${stats.unverified} | Not found: ${stats.notFound} | Errors: ${stats.errors}`);
  if (needsReview.length) log(`📝 ${needsReview.length} shops need manual review → ${reportPath}`);
}

main().catch(err => {
  console.error('💀 Fatal error:', err.message);
  process.exit(1);
});
