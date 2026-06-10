#!/usr/bin/env node
/**
 * Business Status Verification — monthly closure sweep
 *
 * A monetized directory listing closed shops is a credibility problem.
 * This script re-checks every shop's Google Places business_status and
 * flags closures. The public site (record-shop-site) filters out
 * business_status = 'CLOSED_PERMANENTLY', so flagged shops disappear
 * from listings, search, and the sitemap automatically.
 *
 * Requires google_place_id (run backfill_place_ids.js first). Shops
 * without one are counted and reported but not checked.
 *
 * Google statuses: OPERATIONAL | CLOSED_TEMPORARILY | CLOSED_PERMANENTLY.
 * If Google returns NOT_FOUND the place_id is stale — it's cleared so the
 * next backfill run re-resolves it.
 *
 * Cost: Place Details (Basic) ≈ $17 per 1000 → ~$15/month for ~900 shops.
 *
 * Usage (run monthly, e.g. via cron):
 *   node verify_business_status.js                   # shops unchecked in 25+ days
 *   node verify_business_status.js --stale-days 0    # recheck everything now
 *   node verify_business_status.js --limit 50
 *   node verify_business_status.js --dry-run
 */

const path = require('path');
const { supabase, updateShop, parseArgs, log, saveJSON } = require('./lib/common');

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const DETAILS_URL = 'https://maps.googleapis.com/maps/api/place/details/json';
const REPORT_DIR = path.join(__dirname, 'content', '_business_status');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchStatus(placeId) {
  const params = new URLSearchParams({
    place_id: placeId,
    fields: 'business_status,name',
    key: GOOGLE_API_KEY,
  });
  const res = await fetch(`${DETAILS_URL}?${params}`);
  const data = await res.json();
  return data; // { status, result: { business_status, name } }
}

async function main() {
  const args = parseArgs();
  const dryRun = !!args['dry-run'];
  const staleDays = args['stale-days'] !== undefined ? parseInt(args['stale-days']) : 25;
  const limit = args.limit ? parseInt(args.limit) : null;

  if (!GOOGLE_API_KEY) {
    console.error('💀 GOOGLE_API_KEY not set in .env');
    process.exit(1);
  }
  if (dryRun) log('⚠️  DRY RUN — no database writes');

  const staleBefore = new Date(Date.now() - staleDays * 24 * 60 * 60 * 1000).toISOString();

  let query = supabase
    .from('shops')
    .select('id, name, city, state, google_place_id, business_status, business_status_checked_at')
    .not('google_place_id', 'is', null)
    .or(`business_status_checked_at.is.null,business_status_checked_at.lt.${staleBefore}`)
    .order('business_status_checked_at', { ascending: true, nullsFirst: true });
  if (limit) query = query.limit(limit);

  const { data: shops, error } = await query;
  if (error) throw error;

  const { count: missingPlaceId } = await supabase
    .from('shops')
    .select('*', { count: 'exact', head: true })
    .is('google_place_id', null);

  log(`📡 ${shops.length} shops due for a status check (${missingPlaceId || 0} have no place_id and were skipped)\n`);

  const stats = { checked: 0, operational: 0, closedTemp: 0, closedPerm: 0, staleId: 0, errors: 0 };
  const closures = [];
  const staleIds = [];

  for (let i = 0; i < shops.length; i++) {
    const shop = shops[i];

    let data;
    try {
      data = await fetchStatus(shop.google_place_id);
    } catch (e) {
      log(`[${i + 1}/${shops.length}] ${shop.name} — ⚠️  ${e.message}`);
      stats.errors++;
      await sleep(5000);
      continue;
    }

    if (data.status === 'NOT_FOUND') {
      log(`[${i + 1}/${shops.length}] ${shop.name} — ⚠️  place_id no longer valid, clearing for re-backfill`);
      stats.staleId++;
      staleIds.push({ id: shop.id, name: shop.name, place_id: shop.google_place_id });
      if (!dryRun) {
        await updateShop(shop.id, { google_place_id: null, business_status_checked_at: new Date().toISOString() });
      }
      await sleep(120);
      continue;
    }

    if (data.status !== 'OK') {
      log(`[${i + 1}/${shops.length}] ${shop.name} — ⚠️  Details status: ${data.status}`);
      stats.errors++;
      if (data.status === 'OVER_QUERY_LIMIT') await sleep(10000);
      continue;
    }

    // Google omits business_status for some places; treat absence as OPERATIONAL
    const status = (data.result && data.result.business_status) || 'OPERATIONAL';
    const changed = status !== (shop.business_status || 'OPERATIONAL');
    stats.checked++;

    if (status === 'CLOSED_PERMANENTLY') {
      stats.closedPerm++;
      closures.push({ id: shop.id, name: shop.name, city: shop.city, state: shop.state, status, previous: shop.business_status });
      log(`[${i + 1}/${shops.length}] 🚨 CLOSED PERMANENTLY: ${shop.name} (${shop.city}, ${shop.state})${changed ? ' — newly flagged, will be hidden from site' : ''}`);
    } else if (status === 'CLOSED_TEMPORARILY') {
      stats.closedTemp++;
      closures.push({ id: shop.id, name: shop.name, city: shop.city, state: shop.state, status, previous: shop.business_status });
      log(`[${i + 1}/${shops.length}] ⚠️  Closed temporarily: ${shop.name} (${shop.city}, ${shop.state})`);
    } else {
      stats.operational++;
      if ((i + 1) % 50 === 0) log(`[${i + 1}/${shops.length}] ...${stats.operational} operational so far`);
    }

    if (!dryRun) {
      await updateShop(shop.id, {
        business_status: status,
        business_status_checked_at: new Date().toISOString(),
      });
    }

    await sleep(120);
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(REPORT_DIR, `status_sweep_${timestamp}.json`);
  saveJSON(reportPath, { timestamp, dryRun, staleDays, stats, closures, staleIds, missingPlaceId: missingPlaceId || 0 });

  log(`\n📊 Checked: ${stats.checked} | Operational: ${stats.operational} | Closed temp: ${stats.closedTemp} | Closed perm: ${stats.closedPerm} | Stale IDs: ${stats.staleId} | Errors: ${stats.errors}`);
  if (stats.closedPerm > 0) {
    log(`🚨 ${stats.closedPerm} permanently closed shop(s) flagged — hidden from the public site (records preserved in DB)`);
  }
  log(`📝 Report: ${reportPath}`);
}

main().catch(err => {
  console.error('💀 Fatal error:', err.message);
  process.exit(1);
});
