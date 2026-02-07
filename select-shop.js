#!/usr/bin/env node

const { execSync } = require('child_process');
const readline = require('readline');

const SUPABASE_URL = "https://oytflcaqukxvzmbddrlg.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im95dGZsY2FxdWt4dnptYmRkcmxnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY5NTIwMjQsImV4cCI6MjA4MjUyODAyNH0.YpFZfu2BPxwXxXz5j-xqgu7VdIuTP315eiS3UuLD2wo";

let currentIndex = 0;
let shops = [];

// Fetch shops from Supabase
function fetchShops(filter = 'all') {
  console.log("📚 Fetching shops from Supabase...\n");
  
  let url = `${SUPABASE_URL}/rest/v1/shops?select=id,name,city,state,website,enrichment_status&order=name`;
  
  // Filter options
  if (filter === 'unenriched') {
    url += '&enrichment_status=is.null';
  } else if (filter === 'enriched') {
    url += '&enrichment_status=eq.enriched';
  }
  
  try {
    const result = execSync(`curl -s "${url}" \
      -H "apikey: ${SUPABASE_KEY}" \
      -H "Authorization: Bearer ${SUPABASE_KEY}"`, 
      { encoding: 'utf8' }
    );
    
    return JSON.parse(result);
  } catch (error) {
    console.error("❌ Error fetching shops:", error.message);
    process.exit(1);
  }
}

// Display shop list
function displayShops() {
  console.clear();
  console.log("🎵 RECORD SHOP SELECTOR\n");
  console.log(`Found ${shops.length} shops\n`);
  console.log("Use ↑↓ arrows to navigate, Enter to enrich, Q to quit\n");
  console.log("─".repeat(80) + "\n");
  
  const startIdx = Math.max(0, currentIndex - 5);
  const endIdx = Math.min(shops.length, startIdx + 12);
  
  for (let i = startIdx; i < endIdx; i++) {
    const shop = shops[i];
    const pointer = i === currentIndex ? "→" : " ";
    const status = shop.enrichment_status === 'enriched' ? '✓' : '○';
    const location = `${shop.city}, ${shop.state}`;
    const name = shop.name.substring(0, 40).padEnd(42);
    const loc = location.substring(0, 25).padEnd(27);
    
    console.log(`${pointer} ${status} ${name} ${loc}`);
  }
  
  console.log("\n" + "─".repeat(80));
  
  if (currentIndex >= 0 && currentIndex < shops.length) {
    const selected = shops[currentIndex];
    console.log(`\n📍 ${selected.name}`);
    console.log(`   ${selected.city}, ${selected.state}`);
    console.log(`   ${selected.website || 'No website'}`);
    console.log(`   Status: ${selected.enrichment_status || 'Not enriched'}`);
  }
}

// Run enricher
function enrichShop(shop) {
  console.clear();
  console.log(`\n🎯 Enriching: ${shop.name}\n`);
  
  if (!shop.website || shop.website.includes('yelp.com')) {
    console.log("❌ No valid website URL (Yelp URLs can't be crawled)\n");
    console.log("Press any key to continue...");
    return;
  }
  
  try {
    // Run the enricher
    execSync(`node enrich_shop_v2.js "${shop.name}" "${shop.website}"`, {
      stdio: 'inherit',
      cwd: __dirname
    });
    
    // Update database with enrichment status
    const now = new Date().toISOString();
    const updateData = {
      enrichment_status: 'enriched',
      date_of_enrichment: now
    };
    
    execSync(`curl -s -X PATCH "${SUPABASE_URL}/rest/v1/shops?id=eq.${shop.id}" \
      -H "apikey: ${SUPABASE_KEY}" \
      -H "Authorization: Bearer ${SUPABASE_KEY}" \
      -H "Content-Type: application/json" \
      -d '${JSON.stringify(updateData)}'`,
      { encoding: 'utf8' }
    );
    
    console.log("\n✅ Database updated!\n");
    console.log("Press any key to continue...");
    
  } catch (error) {
    console.error("\n❌ Enrichment failed:", error.message);
    console.log("\nPress any key to continue...");
  }
}

// Handle keyboard input
function setupKeyboard() {
  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  
  process.stdin.on('keypress', (str, key) => {
    if (key.ctrl && key.name === 'c') {
      process.exit(0);
    }
    
    if (key.name === 'q') {
      console.clear();
      console.log("\n👋 Goodbye!\n");
      process.exit(0);
    }
    
    if (key.name === 'up') {
      currentIndex = Math.max(0, currentIndex - 1);
      displayShops();
    }
    
    if (key.name === 'down') {
      currentIndex = Math.min(shops.length - 1, currentIndex + 1);
      displayShops();
    }
    
    if (key.name === 'return') {
      const selected = shops[currentIndex];
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      
      enrichShop(selected);
      
      // Wait for keypress to continue
      process.stdin.once('keypress', () => {
        if (process.stdin.isTTY) {
          process.stdin.setRawMode(true);
        }
        displayShops();
      });
    }
  });
}

// Main
function main() {
  const filter = process.argv[2] || 'all'; // all, enriched, unenriched
  
  shops = fetchShops(filter);
  
  if (shops.length === 0) {
    console.log("❌ No shops found");
    process.exit(0);
  }
  
  displayShops();
  setupKeyboard();
}

main();
