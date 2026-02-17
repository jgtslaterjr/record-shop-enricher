require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Helper to sleep for rate limiting
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Reverse geocode using Nominatim
async function reverseGeocode(lat, lng) {
  const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`;
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'RecordShopEnricher/1.0 (contact@recordshops.org)'
      }
    });
    await sleep(1100); // Respect 1 req/sec rate limit
    
    if (!response.ok) {
      console.error(`Geocoding failed for ${lat},${lng}: ${response.status}`);
      return null;
    }
    
    const data = await response.json();
    return data;
  } catch (error) {
    console.error(`Error geocoding ${lat},${lng}:`, error.message);
    return null;
  }
}

// Lookup city from ZIP using Nominatim
async function lookupZip(zip) {
  const url = `https://nominatim.openstreetmap.org/search?postalcode=${zip}&country=US&format=json&addressdetails=1`;
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'RecordShopEnricher/1.0 (contact@recordshops.org)'
      }
    });
    await sleep(1100); // Respect rate limit
    
    if (!response.ok) {
      return null;
    }
    
    const data = await response.json();
    return data[0] || null;
  } catch (error) {
    console.error(`Error looking up ZIP ${zip}:`, error.message);
    return null;
  }
}

async function main() {
  console.log('Querying shops with state=California and no city...\n');
  
  // Query shops with California state and null/empty city
  const { data: shops, error } = await supabase
    .from('shops')
    .select('id, name, latitude, longitude, address, zip, state, city')
    .ilike('state', '%california%')
    .or('city.is.null,city.eq.');
  
  if (error) {
    console.error('Error querying shops:', error);
    return;
  }
  
  console.log(`Found ${shops.length} shops with state=California and no city\n`);
  
  // Categorize shops
  const withLatLng = shops.filter(s => s.latitude && s.longitude);
  const withZip = shops.filter(s => s.zip && (!s.latitude || !s.longitude));
  const withAddress = shops.filter(s => s.address && !s.zip && (!s.latitude || !s.longitude));
  const withNothing = shops.filter(s => !s.latitude && !s.longitude && !s.zip && !s.address);
  
  console.log('=== CATEGORIZATION ===');
  console.log(`Shops with lat/lng: ${withLatLng.length}`);
  console.log(`Shops with ZIP only: ${withZip.length}`);
  console.log(`Shops with address only: ${withAddress.length}`);
  console.log(`Shops with nothing: ${withNothing.length}`);
  console.log();
  
  // Sample reverse geocoding
  console.log('=== SAMPLE REVERSE GEOCODING (first 10 with lat/lng) ===\n');
  const sample = withLatLng.slice(0, 10);
  const sampleResults = [];
  
  for (const shop of sample) {
    console.log(`Testing: ${shop.name} (${shop.latitude}, ${shop.longitude})`);
    const geo = await reverseGeocode(shop.latitude, shop.longitude);
    
    if (geo && geo.address) {
      const city = geo.address.city || geo.address.town || geo.address.village || geo.address.hamlet;
      const state = geo.address.state;
      const country = geo.address.country_code?.toUpperCase();
      
      sampleResults.push({
        id: shop.id,
        name: shop.name,
        current: { city: shop.city, state: shop.state },
        proposed: { city, state, country },
        raw: geo.address
      });
      
      console.log(`  Current: city="${shop.city}", state="${shop.state}"`);
      console.log(`  Proposed: city="${city}", state="${state}", country="${country}"`);
      console.log(`  Full address: ${geo.display_name}`);
      console.log();
    } else {
      console.log(`  ❌ Failed to geocode\n`);
      sampleResults.push({
        id: shop.id,
        name: shop.name,
        current: { city: shop.city, state: shop.state },
        proposed: null,
        error: 'Failed to geocode'
      });
    }
  }
  
  // Generate full corrections list
  console.log('=== GENERATING FULL CORRECTIONS ===\n');
  const corrections = [];
  
  // Process all shops with lat/lng
  console.log(`Processing ${withLatLng.length} shops with lat/lng...`);
  for (let i = 0; i < withLatLng.length; i++) {
    const shop = withLatLng[i];
    console.log(`  [${i+1}/${withLatLng.length}] ${shop.name}...`);
    
    const geo = await reverseGeocode(shop.latitude, shop.longitude);
    
    if (geo && geo.address) {
      const city = geo.address.city || geo.address.town || geo.address.village || geo.address.hamlet;
      const state = geo.address.state;
      const country = geo.address.country_code?.toUpperCase();
      
      corrections.push({
        id: shop.id,
        name: shop.name,
        method: 'reverse_geocode',
        current: {
          city: shop.city,
          state: shop.state,
          latitude: shop.latitude,
          longitude: shop.longitude
        },
        proposed: {
          city,
          state,
          country
        },
        confidence: 'high',
        raw_geocode: geo.address
      });
    } else {
      corrections.push({
        id: shop.id,
        name: shop.name,
        method: 'reverse_geocode',
        current: {
          city: shop.city,
          state: shop.state,
          latitude: shop.latitude,
          longitude: shop.longitude
        },
        proposed: null,
        confidence: 'failed',
        error: 'Geocoding failed'
      });
    }
  }
  
  // Process shops with ZIP
  console.log(`\nProcessing ${withZip.length} shops with ZIP...`);
  for (let i = 0; i < withZip.length; i++) {
    const shop = withZip[i];
    console.log(`  [${i+1}/${withZip.length}] ${shop.name} (ZIP: ${shop.zip})...`);
    
    const geo = await lookupZip(shop.zip);
    
    if (geo && geo.address) {
      const city = geo.address.city || geo.address.town || geo.address.village;
      const state = geo.address.state;
      
      corrections.push({
        id: shop.id,
        name: shop.name,
        method: 'zip_lookup',
        current: {
          city: shop.city,
          state: shop.state,
          zip: shop.zip
        },
        proposed: {
          city,
          state,
          latitude: parseFloat(geo.lat),
          longitude: parseFloat(geo.lon)
        },
        confidence: 'medium',
        raw_geocode: geo.address
      });
    } else {
      corrections.push({
        id: shop.id,
        name: shop.name,
        method: 'zip_lookup',
        current: {
          city: shop.city,
          state: shop.state,
          zip: shop.zip
        },
        proposed: null,
        confidence: 'failed',
        error: 'ZIP lookup failed'
      });
    }
  }
  
  // Flag shops with only address for manual review
  for (const shop of withAddress) {
    corrections.push({
      id: shop.id,
      name: shop.name,
      method: 'manual_review',
      current: {
        city: shop.city,
        state: shop.state,
        address: shop.address
      },
      proposed: null,
      confidence: 'needs_geocoding',
      note: 'Has address but needs geocoding'
    });
  }
  
  // Flag shops with nothing
  for (const shop of withNothing) {
    corrections.push({
      id: shop.id,
      name: shop.name,
      method: 'manual_review',
      current: {
        city: shop.city,
        state: shop.state
      },
      proposed: null,
      confidence: 'no_data',
      note: 'No location data available'
    });
  }
  
  // Save corrections
  const outputPath = './city_corrections.json';
  fs.writeFileSync(outputPath, JSON.stringify(corrections, null, 2));
  console.log(`\n✅ Saved ${corrections.length} corrections to ${outputPath}`);
  
  // Generate summary report
  const report = {
    summary: {
      total_shops: shops.length,
      with_latLng: withLatLng.length,
      with_zip: withZip.length,
      with_address_only: withAddress.length,
      with_no_data: withNothing.length
    },
    sample_results: sampleResults,
    corrections_breakdown: {
      successful_reverse_geocode: corrections.filter(c => c.method === 'reverse_geocode' && c.proposed).length,
      failed_reverse_geocode: corrections.filter(c => c.method === 'reverse_geocode' && !c.proposed).length,
      successful_zip_lookup: corrections.filter(c => c.method === 'zip_lookup' && c.proposed).length,
      failed_zip_lookup: corrections.filter(c => c.method === 'zip_lookup' && !c.proposed).length,
      needs_manual_review: corrections.filter(c => c.method === 'manual_review').length
    },
    edge_cases: {
      outside_california: corrections.filter(c => c.proposed && c.proposed.state && !c.proposed.state.toLowerCase().includes('california')).length,
      outside_us: corrections.filter(c => c.proposed && c.proposed.country && c.proposed.country !== 'US').length
    }
  };
  
  console.log('\n=== SUMMARY REPORT ===');
  console.log(JSON.stringify(report, null, 2));
  
  // Save report
  const reportPath = './city_corrections_report.json';
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\n✅ Saved summary report to ${reportPath}`);
}

main().catch(console.error);
