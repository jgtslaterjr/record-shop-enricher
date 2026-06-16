#!/usr/bin/env node
/**
 * Deep Google scraper — Places API (LEGACY) edition.
 *
 * Replaces the bot-blocked headless google.com/maps DOM scraper
 * (deep_scrape_google.js) with the legacy Google Places API, which returns
 * rating, review_count, up to 5 reviews, hours, phone, website, address and
 * geometry reliably.
 *
 * Usage:
 *   node deep_scrape_google_api.js --shop-id "uuid" [--force]
 *   node deep_scrape_google_api.js --shop "Waterloo Records" --city "Austin" --state "TX" [--force]
 *
 * Writes content/{shopId}/reviews/google_reviews.json (same path the headless
 * scraper used, so the synthesis step picks it up unchanged) and fills NULL
 * columns on the shops row following the fill-NULLs-only / truthy-positive
 * update discipline.
 */

require('dotenv').config();
const fs = require('fs');
const { contentDir, getShopByName, updateShop, parseArgs, log, supabase } = require('./lib/common');
const { findPlace, getPlaceDetails } = require('./lib/google_places');

function googleMapsUrlFromPlaceId(placeId) {
  return `https://www.google.com/maps/place/?q=place_id:${placeId}`;
}

function isPlaceholderWebsite(url) {
  if (!url) return true;
  return url.includes('yelp.com') || url.includes('facebook.com');
}

/**
 * Build the google_reviews.json payload from a Places Details `result`.
 */
function buildPayload(placeId, result) {
  const hoursText = Array.isArray(result.opening_hours?.weekday_text) && result.opening_hours.weekday_text.length
    ? result.opening_hours.weekday_text.join('; ')
    : null;

  const reviews = (result.reviews || []).map(r => ({
    author_name: r.author_name || null,
    rating: typeof r.rating === 'number' ? r.rating : null,
    text: r.text || '',
    time: r.time || null,
    relative_time_description: r.relative_time_description || null,
  }));

  const photoRefs = (result.photos || [])
    .map(p => p.photo_reference)
    .filter(Boolean);

  return {
    source: 'google_places_api',
    fetched_at: new Date().toISOString(),
    place_id: placeId,
    metadata: {
      name: result.name || null,
      address: result.formatted_address || null,
      phone: result.formatted_phone_number || null,
      website: result.website || null,
      rating: typeof result.rating === 'number' ? result.rating : null,
      user_ratings_total: typeof result.user_ratings_total === 'number' ? result.user_ratings_total : null,
      hours_text: hoursText,
      geometry: result.geometry || null,
      types: result.types || null,
    },
    reviews,
    photo_refs: photoRefs,
  };
}

/**
 * Build a Supabase update object that respects the fill-NULLs-only /
 * truthy-positive discipline:
 *   - never write 0 or '' into a populated (or null) numeric/text column
 *   - only fill text fields when currently null/empty
 *   - rating/review_count: only write a real positive value, never downgrade
 */
function buildUpdates(shop, placeId, meta) {
  const updates = {};
  const setIfEmpty = (col, val) => {
    if (val && (shop[col] == null || shop[col] === '')) updates[col] = val;
  };

  // google_maps_url — fill if empty
  setIfEmpty('google_maps_url', googleMapsUrlFromPlaceId(placeId));

  // phone / address — fill if empty
  setIfEmpty('phone', meta.phone);
  setIfEmpty('address', meta.address);

  // website — fill if empty OR replace a platform placeholder URL
  if (meta.website && isPlaceholderWebsite(shop.website)) {
    updates.website = meta.website;
  }

  // hours — fill if empty
  setIfEmpty('hours', meta.hours_text);

  // average_rating — only write a real positive rating (never 0/null)
  if (typeof meta.rating === 'number' && meta.rating > 0) {
    updates.average_rating = meta.rating;
  }

  // review_count — only write a real positive count, never downgrade
  if (typeof meta.user_ratings_total === 'number' && meta.user_ratings_total > 0) {
    updates.review_count = Math.max(meta.user_ratings_total, shop.review_count || 0);
  }

  // latitude / longitude — fill if empty
  const loc = meta.geometry?.location;
  if (loc && typeof loc.lat === 'number' && shop.latitude == null) updates.latitude = loc.lat;
  if (loc && typeof loc.lng === 'number' && shop.longitude == null) updates.longitude = loc.lng;

  return updates;
}

async function resolveShop(args) {
  if (args['shop-id']) {
    const { data, error } = await supabase.from('shops').select('*').eq('id', args['shop-id']).single();
    if (error) throw new Error(`Shop lookup failed: ${error.message}`);
    return data;
  }
  if (args.shop) {
    const shops = await getShopByName(args.shop, args.city, args.state);
    return shops && shops.length ? shops[0] : null;
  }
  return null;
}

async function run() {
  const args = parseArgs();

  const shop = await resolveShop(args);
  if (!shop) {
    log('❌ Shop not found in Supabase. Pass --shop-id, or --shop/--city/--state for a row that exists.');
    process.exit(1);
  }

  log(`🔍 Google Places API: ${shop.name} (${shop.city || '?'}, ${shop.state || '?'})`);

  const outPath = contentDir(shop.id, 'reviews', 'google_reviews.json');
  if (fs.existsSync(outPath) && !args.force) {
    log(`⏭ ${outPath} already exists, skipping (use --force to refetch)`);
    return;
  }

  // 1. Find the place_id for this specific shop.
  const found = await findPlace(shop.name, shop.city, shop.state);
  if (!found) {
    log(`❌ No Google Places match for "${shop.name}" in ${shop.city}, ${shop.state}`);
    process.exit(1);
  }
  log(`  Found place_id: ${found.place_id} (${found.name || 'unnamed'})`);

  // 2. Fetch full details.
  const result = await getPlaceDetails(found.place_id);

  // 3. Write the raw payload to the same path the headless scraper used.
  const payload = buildPayload(found.place_id, result);
  fs.mkdirSync(require('path').dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
  log(`✅ Wrote ${payload.reviews.length} reviews + metadata to ${outPath}`);
  log(`   rating=${payload.metadata.rating} count=${payload.metadata.user_ratings_total} hours=${payload.metadata.hours_text ? 'yes' : 'no'} photos=${payload.photo_refs.length}`);

  // 4. Fill NULL columns on the shops row.
  const updates = buildUpdates(shop, found.place_id, payload.metadata);
  if (Object.keys(updates).length) {
    await updateShop(shop.id, updates);
    log(`✅ Updated shop columns: ${Object.keys(updates).join(', ')}`);
  } else {
    log('   No DB columns needed updating (all already populated).');
  }
}

run().catch(e => { console.error(`❌ ${e.message}`); process.exit(1); });
