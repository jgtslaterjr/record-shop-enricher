#!/usr/bin/env node
/**
 * recordstores.love Data Import / Cross-Reference Tool
 * 
 * Explores the recordstores.love API/data structure and cross-references
 * with our Supabase database. Generates a report of:
 * - Shops they have that we don't
 * - Shops we have that they don't
 * - Data quality comparison
 * 
 * Does NOT auto-import — generates a report JSON for review.
 * 
 * Usage: node import_recordstores_love.js [--us-only]
 */

const { spawn } = require('child_process');
const { writeFileSync, mkdirSync } = require('fs');
const path = require('path');

const SUPABASE_URL = "https://oytflcaqukxvzmbddrlg.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im95dGZsY2FxdWt4dnptYmRkcmxnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY5NTIwMjQsImV4cCI6MjA4MjUyODAyNH0.YpFZfu2BPxwXxXz5j-xqgu7VdIuTP315eiS3UuLD2wo";
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const usOnly = process.argv.includes('--us-only');

function curlFetch(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const headerArgs = Object.entries(headers).flatMap(([k, v]) => ['-H', `${k}: ${v}`]);
    const curl = spawn('curl', [
      '-sL',
      '-A', USER_AGENT,
      '--max-time', '30',
      '--max-redirs', '5',
      '-o', '-',
      ...headerArgs,
      url
    ]);
    let data = '';
    let stderr = '';
    curl.stdout.on('data', (chunk) => { data += chunk; });
    curl.stderr.on('data', (chunk) => { stderr += chunk; });
    curl.on('close', (code) => {
      if (code !== 0 && !data) reject(new Error(`curl failed: ${stderr}`));
      else resolve(data);
    });
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Normalize name for fuzzy matching
function normalizeName(name) {
  return (name || '')
    .toLowerCase()
    .replace(/[''`]/g, '')
    .replace(/&/g, 'and')
    .replace(/\brecords?\b/g, 'record')
    .replace(/\bvinyl\b/g, '')
    .replace(/\bthe\b/g, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

function normalizeCity(city) {
  return (city || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

// ── Explore recordstores.love ──

async function exploreRecordStoresLove() {
  console.log('🌐 Exploring recordstores.love...\n');

  // Step 1: Fetch the main page to find API endpoints
  console.log('📡 Fetching main page...');
  const mainPage = await curlFetch('https://recordstores.love');
  
  // Look for API URLs in JavaScript
  const apiPatterns = [
    /["'](https?:\/\/[^"']*api[^"']*)/gi,
    /["'](https?:\/\/[^"']*\.json[^"']*)/gi,
    /["'](\/api\/[^"']*)/gi,
    /fetch\(["']([^"']+)/gi,
    /["'](https?:\/\/[^"']*supabase[^"']*)/gi,
    /["'](https?:\/\/[^"']*firebase[^"']*)/gi,
    /["'](https?:\/\/[^"']*airtable[^"']*)/gi,
  ];

  const foundUrls = new Set();
  for (const pattern of apiPatterns) {
    let match;
    while ((match = pattern.exec(mainPage)) !== null) {
      foundUrls.add(match[1]);
    }
  }

  console.log(`📋 Found ${foundUrls.size} potential API/data URLs:`);
  for (const url of foundUrls) {
    console.log(`   ${url}`);
  }

  // Look for JavaScript files that might contain API calls
  const jsMatches = mainPage.match(/src="([^"]*\.js[^"]*)"/gi) || [];
  const jsUrls = jsMatches.map(m => {
    const match = m.match(/src="([^"]+)"/);
    return match ? match[1] : null;
  }).filter(Boolean);

  console.log(`\n📜 Found ${jsUrls.length} JavaScript files:`);
  
  let allApiUrls = [...foundUrls];
  
  for (const jsUrl of jsUrls.slice(0, 5)) { // Check first 5 JS files
    const fullUrl = jsUrl.startsWith('http') ? jsUrl : `https://recordstores.love${jsUrl.startsWith('/') ? '' : '/'}${jsUrl}`;
    console.log(`   Scanning: ${fullUrl.substring(0, 80)}...`);
    
    try {
      const jsContent = await curlFetch(fullUrl);
      for (const pattern of apiPatterns) {
        let match;
        pattern.lastIndex = 0;
        while ((match = pattern.exec(jsContent)) !== null) {
          allApiUrls.push(match[1]);
          if (!foundUrls.has(match[1])) {
            console.log(`   🔗 Found: ${match[1].substring(0, 100)}`);
            foundUrls.add(match[1]);
          }
        }
      }
      
      // Also look for data embedded directly
      const geoJsonMatch = jsContent.match(/\{"type"\s*:\s*"FeatureCollection"/);
      if (geoJsonMatch) {
        console.log('   🗺️  Found GeoJSON data embedded in JS!');
      }
      
      // Look for Google Sheets / Airtable patterns
      if (jsContent.includes('sheets.googleapis.com') || jsContent.includes('docs.google.com/spreadsheets')) {
        console.log('   📊 Google Sheets backend detected!');
      }
      if (jsContent.includes('airtable.com')) {
        console.log('   📊 Airtable backend detected!');
      }
      
    } catch (e) {
      console.log(`   ⚠️  Failed to fetch: ${e.message.substring(0, 50)}`);
    }
    
    await sleep(500);
  }

  // Try the known working API endpoint
  console.log('\n🔍 Trying API endpoints...');
  const tryEndpoints = [
    'https://recordstores.love/api/stores?type=all',
  ];

  let storeData = null;
  
  for (const endpoint of tryEndpoints) {
    try {
      process.stdout.write(`   ${endpoint}... `);
      const data = await curlFetch(endpoint);
      if (data && (data.startsWith('[') || data.startsWith('{'))) {
        const parsed = JSON.parse(data);
        const count = Array.isArray(parsed) ? parsed.length : (parsed.features?.length || parsed.data?.length || 'obj');
        console.log(`✅ ${count} items`);
        if (Array.isArray(parsed) && parsed.length > 0) {
          storeData = parsed;
          console.log(`\n📊 Sample record:`);
          console.log(JSON.stringify(parsed[0], null, 2).substring(0, 500));
        } else if (parsed.features) {
          storeData = parsed.features;
          console.log(`\n📊 GeoJSON with ${parsed.features.length} features`);
          console.log(JSON.stringify(parsed.features[0], null, 2).substring(0, 500));
        }
        break;
      } else {
        console.log(`— Not JSON (${data?.substring(0, 30)}...)`);
      }
    } catch (e) {
      console.log(`❌ ${e.message.substring(0, 40)}`);
    }
  }

  // Also try to look for data in the page itself (many map apps embed data)
  if (!storeData) {
    console.log('\n🔍 Looking for embedded data in page HTML...');
    
    // Look for large JSON objects that might be store data
    const jsonBlocks = mainPage.match(/\[[\s\S]{1000,}?\]/g) || [];
    console.log(`   Found ${jsonBlocks.length} large JSON-like blocks`);
    
    for (const block of jsonBlocks.slice(0, 3)) {
      try {
        const parsed = JSON.parse(block);
        if (Array.isArray(parsed) && parsed.length > 10) {
          console.log(`   ✅ Found array with ${parsed.length} items`);
          console.log(`   Sample: ${JSON.stringify(parsed[0]).substring(0, 200)}`);
          storeData = parsed;
          break;
        }
      } catch { /* not valid JSON */ }
    }

    // Check for window.__DATA__ or similar patterns
    const dataPatterns = [
      /window\.__DATA__\s*=\s*(\[[\s\S]*?\]);/,
      /window\.stores\s*=\s*(\[[\s\S]*?\]);/,
      /var\s+stores\s*=\s*(\[[\s\S]*?\]);/,
      /const\s+stores\s*=\s*(\[[\s\S]*?\]);/,
      /window\.__INITIAL_STATE__\s*=\s*({[\s\S]*?});/,
    ];
    
    for (const pattern of dataPatterns) {
      const match = mainPage.match(pattern);
      if (match) {
        try {
          const parsed = JSON.parse(match[1]);
          const items = Array.isArray(parsed) ? parsed : (parsed.stores || parsed.shops || []);
          if (items.length > 0) {
            console.log(`   ✅ Found embedded data: ${items.length} items`);
            storeData = items;
            break;
          }
        } catch { /* continue */ }
      }
    }
  }

  return storeData;
}

// ── Cross-reference with our data ──

async function crossReference(externalStores) {
  console.log('\n📡 Fetching our shops from Supabase...');
  
  // Fetch all our shops
  let allShops = [];
  let offset = 0;
  const pageSize = 1000;
  
  while (true) {
    const data = await curlFetch(
      `${SUPABASE_URL}/rest/v1/shops?select=id,name,city,state,website,latitude,longitude&order=name.asc&offset=${offset}&limit=${pageSize}`,
      {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
      }
    );
    const page = JSON.parse(data);
    allShops = allShops.concat(page);
    if (page.length < pageSize) break;
    offset += pageSize;
  }
  
  console.log(`📊 Our database: ${allShops.length} shops`);
  console.log(`📊 External data: ${externalStores.length} stores\n`);

  // Build lookup maps
  const ourShopsByNormalizedName = new Map();
  for (const shop of allShops) {
    const key = normalizeName(shop.name) + '|' + normalizeCity(shop.city);
    ourShopsByNormalizedName.set(key, shop);
  }

  // Cross-reference
  const matches = [];
  const theyHaveWeDoNot = [];
  const weHaveTheyDoNot = [...allShops]; // Start with all ours, remove matches

  for (const store of externalStores) {
    // Try to extract name and city from various formats
    const name = store.name || store.properties?.name || store.title || '';
    const city = store.city || store.properties?.city || store.location?.city || '';
    const country = store.country || store.countrycode || store.properties?.country || '';
    
    // Skip non-US if --us-only
    if (usOnly && country && !['US', 'USA', 'United States'].includes(country)) continue;

    const key = normalizeName(name) + '|' + normalizeCity(city);
    
    if (ourShopsByNormalizedName.has(key)) {
      matches.push({
        ourShop: ourShopsByNormalizedName.get(key),
        theirStore: { name, city, country, ...store },
      });
      // Remove from "we have they don't" list
      const idx = weHaveTheyDoNot.findIndex(s => s.id === ourShopsByNormalizedName.get(key).id);
      if (idx >= 0) weHaveTheyDoNot.splice(idx, 1);
    } else {
      theyHaveWeDoNot.push({ name, city, country, source: store });
    }
  }

  return { matches, theyHaveWeDoNot, weHaveTheyDoNot };
}

// ── Main ──

async function main() {
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║  🗺️  recordstores.love Import Tool                   ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');

  // Step 1: Explore their data
  const externalStores = await exploreRecordStoresLove();

  if (!externalStores || externalStores.length === 0) {
    console.log('\n⚠️  Could not find store data from recordstores.love');
    console.log('   The site may use dynamic loading or a protected API.');
    console.log('   Consider:');
    console.log('   1. Manual browser inspection (Network tab) to find API');
    console.log('   2. Using Playwright to render the page and capture data');
    console.log('   3. Checking if they have a public data export');
    
    // Still generate a stub report
    const report = {
      timestamp: new Date().toISOString(),
      status: 'no_data_found',
      notes: 'Could not automatically discover API endpoints. Manual investigation needed.',
      urls_found: [],
    };
    
    const reportPath = path.join('/home/john/Projects/record_shop_enricher', 'recordstores_love_report.json');
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`\n💾 Report saved to: ${reportPath}`);
    return;
  }

  // Step 2: Cross-reference
  console.log('\n🔄 Cross-referencing with our database...');
  const { matches, theyHaveWeDoNot, weHaveTheyDoNot } = await crossReference(externalStores);

  // Step 3: Generate report
  const report = {
    timestamp: new Date().toISOString(),
    summary: {
      totalExternal: externalStores.length,
      matches: matches.length,
      theyHaveWeDoNot: theyHaveWeDoNot.length,
      weHaveTheyDoNot: weHaveTheyDoNot.length,
    },
    matches: matches.slice(0, 50).map(m => ({
      ourName: m.ourShop.name,
      theirName: m.theirStore.name,
      city: m.ourShop.city,
    })),
    missingFromOurDB: theyHaveWeDoNot.slice(0, 200).map(s => ({
      name: s.name,
      city: s.city,
      country: s.country,
    })),
    uniqueToUs: weHaveTheyDoNot.slice(0, 100).map(s => ({
      name: s.name,
      city: s.city,
      state: s.state,
    })),
  };

  const reportPath = path.join('/home/john/Projects/record_shop_enricher', 'recordstores_love_report.json');
  writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║  📊 Cross-Reference Report                           ║');
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log(`║  Their stores:       ${String(externalStores.length).padEnd(31)}║`);
  console.log(`║  Matches:            ${String(matches.length).padEnd(31)}║`);
  console.log(`║  They have, we don't: ${String(theyHaveWeDoNot.length).padEnd(30)}║`);
  console.log(`║  We have, they don't: ${String(weHaveTheyDoNot.length).padEnd(30)}║`);
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log(`║  📄 Full report: ${reportPath.substring(reportPath.lastIndexOf('/') + 1).padEnd(34)}║`);
  console.log('╚══════════════════════════════════════════════════════╝');

  // Show sample of missing shops
  if (theyHaveWeDoNot.length > 0) {
    console.log('\n📋 Sample shops they have that we DON\'T (first 20):');
    for (const s of theyHaveWeDoNot.slice(0, 20)) {
      console.log(`   🏪 ${s.name} — ${s.city}${s.country ? ', ' + s.country : ''}`);
    }
  }
}

main().catch(err => {
  console.error('💀 Fatal:', err.message);
  process.exit(1);
});
