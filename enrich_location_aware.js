#!/usr/bin/env node

/**
 * Location-Aware Enrichment Wrapper
 * Handles multi-location shops by providing location context to enrichers
 */

const { spawn } = require('child_process');

function enrichWithLocationContext(shopName, shopUrl, locationData, tier = 'web') {
  return new Promise((resolve, reject) => {
    const context = {
      neighborhood: locationData.neighborhood || null,
      city: locationData.city || null,
      state: locationData.state || null,
      address: locationData.address || null
    };
    
    // Build enrichment message with location context
    let locationContext = '';
    if (context.neighborhood) {
      locationContext = `\nLocation: ${context.neighborhood}, ${context.city}, ${context.state}`;
    } else if (context.city) {
      locationContext = `\nLocation: ${context.city}, ${context.state}`;
    }
    
    if (context.address) {
      locationContext += `\nAddress: ${context.address}`;
    }
    
    console.log(`\n🎯 LOCATION-AWARE ENRICHMENT`);
    if (locationContext) {
      console.log(`${locationContext}`);
      console.log(`\n⚠️  NOTE: If this shop has multiple locations, data will be extracted`);
      console.log(`   specifically for the location above. Website data that applies to`);
      console.log(`   ALL locations will be flagged in the analysis.\n`);
    } else {
      console.log(`⚠️  No location context provided. If this shop has multiple locations,`);
      console.log(`   enrichment data may be mixed. Consider adding neighborhood/address.\n`);
    }
    
    // Choose enricher based on tier
    const enricherScript = tier === 'social' ? './enrich_social.js' : './enrich_shop_v2.js';
    
    // Pass location context as environment variable
    const env = {
      ...process.env,
      LOCATION_NEIGHBORHOOD: context.neighborhood || '',
      LOCATION_CITY: context.city || '',
      LOCATION_STATE: context.state || '',
      LOCATION_ADDRESS: context.address || ''
    };
    
    const args = tier === 'social' 
      ? [shopName, shopUrl, locationData.socialInstagram || '', locationData.socialFacebook || '', locationData.socialTiktok || '']
      : [shopName, shopUrl];
    
    const enricher = spawn('node', [enricherScript, ...args], {
      env,
      cwd: __dirname,
      stdio: 'inherit'
    });
    
    enricher.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Enricher exited with code ${code}`));
      }
    });
    
    enricher.on('error', (err) => {
      reject(err);
    });
  });
}

// CLI usage
if (require.main === module) {
  const shopName = process.argv[2];
  const shopUrl = process.argv[3];
  const neighborhood = process.argv[4];
  const city = process.argv[5];
  const state = process.argv[6];
  const address = process.argv[7];
  const tier = process.argv[8] || 'web';
  
  if (!shopName || !shopUrl) {
    console.log(`
Location-Aware Enrichment Wrapper

Usage: ./enrich_location_aware.js "Shop Name" "URL" [neighborhood] [city] [state] [address] [tier]

Examples:
  # Single location shop
  ./enrich_location_aware.js "Local Records" "https://example.com"
  
  # Multi-location shop - specify which location
  ./enrich_location_aware.js "Amoeba Music" "https://amoeba.com" "Berkeley" "Berkeley" "CA" "2455 Telegraph Ave"
  
  # With social media enrichment
  ./enrich_location_aware.js "Amoeba Music" "https://amoeba.com" "Hollywood" "Los Angeles" "CA" "" "social"
`);
    process.exit(1);
  }
  
  enrichWithLocationContext(shopName, shopUrl, {
    neighborhood,
    city,
    state,
    address
  }, tier)
  .then(() => {
    console.log('\n✅ Location-aware enrichment complete!\n');
  })
  .catch((err) => {
    console.error('\n❌ Enrichment failed:', err.message);
    process.exit(1);
  });
}

module.exports = { enrichWithLocationContext };
