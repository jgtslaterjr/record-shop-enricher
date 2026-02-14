#!/usr/bin/env node
/**
 * compute_nearby_shops.js
 * 
 * Precomputes nearby shops for each record shop using haversine distance.
 * Optionally backfills missing lat/lng using Nominatim geocoding.
 * 
 * Usage:
 *   node compute_nearby_shops.js [--backfill-geo] [--limit N]
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const args = process.argv.slice(2);
const backfillGeo = args.includes('--backfill-geo');
const limitIdx = args.indexOf('--limit');
const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : null;

const MAX_NEARBY = 4;
const MAX_MILES = 50;

function haversine(lat1, lon1, lat2, lon2) {
  const R = 3959;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function geocode(address, city, state, zip) {
  const parts = [address, city, state, zip].filter(Boolean);
  const q = parts.join(', ');
  const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=1&countrycodes=us`;
  
  const res = await fetch(url, {
    headers: { 'User-Agent': 'RecordShopEnricher/1.0 (record shop directory geocoding)' }
  });
  
  if (!res.ok) {
    console.error(`  Geocoding failed for "${q}": HTTP ${res.status}`);
    return null;
  }
  
  const data = await res.json();
  if (data.length === 0) {
    console.error(`  No results for "${q}"`);
    return null;
  }
  
  return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) };
}

async function fetchAllShops() {
  const allShops = [];
  let from = 0;
  const pageSize = 1000;
  
  while (true) {
    const { data, error } = await supabase
      .from('shops')
      .select('id, name, slug, city, state, address, zip, latitude, longitude')
      .range(from, from + pageSize - 1);
    
    if (error) throw error;
    if (!data || data.length === 0) break;
    allShops.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  
  return allShops;
}

async function main() {
  console.log('Fetching all shops...');
  let shops = await fetchAllShops();
  console.log(`Found ${shops.length} shops total`);

  if (limit) {
    shops = shops.slice(0, limit);
    console.log(`Limited to ${shops.length} shops`);
  }

  let geocodedCount = 0;
  let geocodeFailCount = 0;

  // Backfill geo
  if (backfillGeo) {
    const missing = shops.filter(s => s.latitude == null || s.longitude == null);
    console.log(`\nBackfilling geo for ${missing.length} shops with missing lat/lng...`);
    
    for (const shop of missing) {
      const result = await geocode(shop.address, shop.city, shop.state, shop.zip);
      
      if (result) {
        const { error } = await supabase
          .from('shops')
          .update({ latitude: result.lat, longitude: result.lon })
          .eq('id', shop.id);
        
        if (error) {
          console.error(`  Failed to update ${shop.name}: ${error.message}`);
          geocodeFailCount++;
        } else {
          shop.latitude = result.lat;
          shop.longitude = result.lon;
          geocodedCount++;
          console.log(`  ✓ ${shop.name} → ${result.lat}, ${result.lon}`);
        }
      } else {
        geocodeFailCount++;
      }
      
      await sleep(1100);
    }
  }

  // Compute nearby shops
  console.log('\nComputing nearby shops...');
  const withGeo = shops.filter(s => s.latitude != null && s.longitude != null);
  const withoutGeo = shops.filter(s => s.latitude == null || s.longitude == null);
  console.log(`${withGeo.length} shops have coordinates, ${withoutGeo.length} do not`);

  let nearbyCount = 0;
  let noNearbyCount = 0;
  let updateErrors = 0;

  for (let i = 0; i < withGeo.length; i++) {
    const shop = withGeo[i];
    
    const distances = withGeo
      .filter(s => s.id !== shop.id)
      .map(s => ({
        id: s.id,
        name: s.name,
        slug: s.slug,
        city: s.city,
        state: s.state,
        latitude: s.latitude,
        longitude: s.longitude,
        distance_miles: Math.round(haversine(shop.latitude, shop.longitude, s.latitude, s.longitude) * 100) / 100
      }))
      .filter(s => s.distance_miles <= MAX_MILES)
      .sort((a, b) => a.distance_miles - b.distance_miles)
      .slice(0, MAX_NEARBY);

    const nearby = distances.length > 0 ? distances : null;
    
    const { error } = await supabase
      .from('shops')
      .update({ nearby_shops: nearby })
      .eq('id', shop.id);

    if (error) {
      if (i === 0) {
        console.error(`\nERROR: Could not update nearby_shops column.`);
        console.error(`You may need to add it: ALTER TABLE shops ADD COLUMN IF NOT EXISTS nearby_shops JSONB;`);
        console.error(`Error: ${error.message}`);
        process.exit(1);
      }
      updateErrors++;
    } else {
      if (distances.length > 0) nearbyCount++;
      else noNearbyCount++;
    }

    if ((i + 1) % 100 === 0) {
      console.log(`  Processed ${i + 1}/${withGeo.length} shops...`);
    }
  }

  console.log('\n=== Stats ===');
  if (backfillGeo) {
    console.log(`Geocoded: ${geocodedCount} shops (${geocodeFailCount} failed)`);
  }
  console.log(`Shops with nearby shops: ${nearbyCount}`);
  console.log(`Shops with NO nearby shops within ${MAX_MILES} miles: ${noNearbyCount}`);
  if (updateErrors > 0) console.log(`Update errors: ${updateErrors}`);
  console.log(`Shops without coordinates (skipped): ${withoutGeo.length}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
