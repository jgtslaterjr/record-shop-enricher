#!/usr/bin/env node
// Geocode shops missing lat/lng using OpenStreetMap Nominatim (free, 1 req/sec)
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function geocode(shop) {
  // Build query string from available fields
  const parts = [];
  if (shop.address) parts.push(shop.address);
  if (shop.city) parts.push(shop.city);
  if (shop.state) parts.push(shop.state);
  if (shop.zip) parts.push(shop.zip);
  
  if (parts.length === 0) return null;
  
  // Try with full query first
  const q = parts.join(', ');
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`;
  
  const res = await fetch(url, {
    headers: { 'User-Agent': 'RecordShopEnricher/1.0 (geocoding record shops)' }
  });
  const data = await res.json();
  
  if (data.length > 0) {
    return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon), match: q };
  }
  
  // Fallback: just city + state
  if (shop.address && shop.city && shop.state) {
    const fallback = `${shop.city}, ${shop.state}`;
    const url2 = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(fallback)}`;
    await sleep(1100);
    const res2 = await fetch(url2, {
      headers: { 'User-Agent': 'RecordShopEnricher/1.0 (geocoding record shops)' }
    });
    const data2 = await res2.json();
    if (data2.length > 0) {
      return { lat: parseFloat(data2[0].lat), lon: parseFloat(data2[0].lon), match: fallback + ' (city fallback)' };
    }
  }
  
  return null;
}

(async () => {
  // Fetch all shops missing coordinates
  const { data: shops, error } = await sb
    .from('shops')
    .select('id, name, address, city, state, zip')
    .is('latitude', null)
    .order('state')
    .order('city');
  
  if (error) { console.error('DB error:', error); process.exit(1); }
  
  console.log(`Found ${shops.length} shops needing geocoding\n`);
  
  let success = 0, failed = 0, cityFallback = 0;
  const failures = [];
  
  for (let i = 0; i < shops.length; i++) {
    const shop = shops[i];
    const progress = `[${i + 1}/${shops.length}]`;
    
    try {
      const result = await geocode(shop);
      
      if (result) {
        const isFallback = result.match.includes('fallback');
        if (isFallback) cityFallback++;
        
        const { error: updateErr } = await sb
          .from('shops')
          .update({ latitude: result.lat, longitude: result.lon })
          .eq('id', shop.id);
        
        if (updateErr) {
          console.log(`${progress} ❌ DB error for "${shop.name}": ${updateErr.message}`);
          failed++;
        } else {
          success++;
          console.log(`${progress} ✅ ${shop.name} → ${result.lat.toFixed(4)}, ${result.lon.toFixed(4)} (${result.match})`);
        }
      } else {
        failed++;
        failures.push(shop.name);
        console.log(`${progress} ❌ No result: "${shop.name}" (${shop.city}, ${shop.state})`);
      }
    } catch (err) {
      failed++;
      failures.push(shop.name);
      console.log(`${progress} ❌ Error for "${shop.name}": ${err.message}`);
    }
    
    // Rate limit: 1 request per second
    await sleep(1100);
  }
  
  console.log(`\n=== DONE ===`);
  console.log(`Success: ${success} (${cityFallback} city-level fallbacks)`);
  console.log(`Failed: ${failed}`);
  if (failures.length) console.log(`Failed shops: ${failures.join(', ')}`);
})();
