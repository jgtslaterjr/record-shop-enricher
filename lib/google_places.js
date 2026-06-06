/**
 * Google Places API (LEGACY endpoints) client.
 *
 * Uses ONLY the legacy maps.googleapis.com/maps/api/place/* endpoints.
 * The v1 places.googleapis.com ("Places API New") is disabled on this
 * project's API key and will 403 — do not use it here.
 *
 * Reads GOOGLE_API_KEY from process.env. Entry-point scripts are
 * responsible for calling require('dotenv').config(); this module does not.
 *
 * Ported from record-shop-new-enricher/scraper.py
 *   (search_google_places / _google_place_details).
 */

// Use node-fetch if installed, otherwise the global fetch (Node 18+).
let fetchFn = global.fetch;
try {
  // eslint-disable-next-line global-require
  fetchFn = require('node-fetch');
} catch (e) {
  // node-fetch not installed — fall back to global fetch.
}
if (typeof fetchFn !== 'function') {
  throw new Error('No fetch implementation available (need Node 18+ or node-fetch)');
}

const PLACES_FIND_URL = 'https://maps.googleapis.com/maps/api/place/findplacefromtext/json';
const PLACES_DETAIL_URL = 'https://maps.googleapis.com/maps/api/place/details/json';

// Field mask for the Place Details call (legacy endpoint).
const PLACES_DETAIL_FIELDS = [
  'name',
  'formatted_address',
  'formatted_phone_number',
  'website',
  'rating',
  'user_ratings_total',
  'opening_hours',
  'reviews',
  'photos',
  'geometry',
  'types',
].join(',');

function apiKey() {
  const key = process.env.GOOGLE_API_KEY;
  if (!key) {
    throw new Error('GOOGLE_API_KEY not set in environment');
  }
  return key;
}

async function getJSON(url) {
  const resp = await fetchFn(url);
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Google Places HTTP ${resp.status}: ${body.slice(0, 300)}`);
  }
  return resp.json();
}

/**
 * Find a SPECIFIC shop's place_id via the Find Place From Text endpoint.
 * The pipeline is per-shop, so we search by the known name + city + state
 * rather than doing a city-wide listing.
 *
 * @returns {Promise<{place_id: string, name: string|null, formatted_address: string|null}>}
 */
async function findPlace(shopName, city, state) {
  if (!shopName) {
    throw new Error('findPlace: shopName is required');
  }
  const inputParts = [shopName, city, state].filter(Boolean).join(' ');
  const params = new URLSearchParams({
    input: inputParts,
    inputtype: 'textquery',
    fields: 'place_id,name,formatted_address',
    key: apiKey(),
  });

  const data = await getJSON(`${PLACES_FIND_URL}?${params.toString()}`);
  const status = data.status;

  if (status === 'ZERO_RESULTS') {
    return null;
  }
  if (status !== 'OK') {
    throw new Error(
      `Google Places findplacefromtext status=${status}${data.error_message ? ` — ${data.error_message}` : ''}`
    );
  }

  const candidate = (data.candidates || [])[0];
  if (!candidate || !candidate.place_id) {
    return null;
  }
  return {
    place_id: candidate.place_id,
    name: candidate.name || null,
    formatted_address: candidate.formatted_address || null,
  };
}

/**
 * Fetch full details for a place_id. Returns the raw `result` object from the
 * legacy Place Details endpoint. Note: the API returns at most 5 reviews per
 * call — that is the documented limit and is accepted here.
 *
 * @returns {Promise<object>} the `result` object (name, rating, reviews, ...)
 */
async function getPlaceDetails(placeId) {
  if (!placeId) {
    throw new Error('getPlaceDetails: placeId is required');
  }
  const params = new URLSearchParams({
    place_id: placeId,
    fields: PLACES_DETAIL_FIELDS,
    key: apiKey(),
  });

  const data = await getJSON(`${PLACES_DETAIL_URL}?${params.toString()}`);
  const status = data.status;

  if (status !== 'OK') {
    throw new Error(
      `Google Places details status=${status}${data.error_message ? ` — ${data.error_message}` : ''}`
    );
  }
  if (!data.result) {
    throw new Error('Google Places details returned no result object');
  }
  return data.result;
}

module.exports = {
  findPlace,
  getPlaceDetails,
  PLACES_FIND_URL,
  PLACES_DETAIL_URL,
  PLACES_DETAIL_FIELDS,
};
