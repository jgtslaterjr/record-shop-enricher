import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables
const envPath = join(__dirname, '.env');
const envContent = readFileSync(envPath, 'utf8');
const env = {};
envContent.split('\n').forEach(line => {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match) {
    env[match[1].trim()] = match[2].trim();
  }
});

const SUPABASE_URL = env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
  process.exit(1);
}

// Initialize Supabase client
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// Normalize shop name for comparison
function normalizeName(name) {
  if (!name) return '';
  return name
    .toLowerCase()
    .trim()
    .replace(/^(the|a)\s+/i, '') // Remove leading "the" or "a"
    .replace(/[^\w\s]/g, '') // Remove punctuation
    .replace(/\s+/g, ' ') // Normalize whitespace
    .trim();
}

// Calculate distance between two lat/lng points (simple approximation)
function getDistance(lat1, lng1, lat2, lng2) {
  if (!lat1 || !lng1 || !lat2 || !lng2) return Infinity;
  const latDiff = Math.abs(lat1 - lat2);
  const lngDiff = Math.abs(lng1 - lng2);
  return Math.sqrt(latDiff * latDiff + lngDiff * lngDiff);
}

// Determine which shop has more data
function compareShopCompleteness(shop1, shop2) {
  let score1 = 0;
  let score2 = 0;
  
  if (shop1.google_maps_url) score1 += 2;
  if (shop2.google_maps_url) score2 += 2;
  
  if (shop1.enrichment_status === 'enriched') score1 += 3;
  if (shop2.enrichment_status === 'enriched') score2 += 3;
  
  if (shop1.latitude && shop1.longitude) score1 += 1;
  if (shop2.latitude && shop2.longitude) score2 += 1;
  
  if (shop1.website) score1 += 1;
  if (shop2.website) score2 += 1;
  
  if (shop1.phone) score1 += 1;
  if (shop2.phone) score2 += 1;
  
  return score1 - score2;
}

async function findDuplicates() {
  console.log('Fetching all shops from Supabase...');
  
  // Fetch all shops
  let allShops = [];
  let page = 0;
  const pageSize = 1000;
  
  while (true) {
    const { data, error } = await supabase
      .from('shops')
      .select('id, name, city, state, slug, latitude, longitude, enrichment_status, google_maps_url, address, phone, website')
      .range(page * pageSize, (page + 1) * pageSize - 1);
    
    if (error) {
      console.error('Error fetching shops:', error);
      process.exit(1);
    }
    
    if (!data || data.length === 0) break;
    
    allShops = allShops.concat(data);
    console.log(`Fetched ${allShops.length} shops...`);
    
    if (data.length < pageSize) break;
    page++;
  }
  
  console.log(`Total shops fetched: ${allShops.length}`);
  console.log('\nAnalyzing for duplicates...');
  
  const duplicateGroups = [];
  const processed = new Set();
  
  // Check each shop against all others
  for (let i = 0; i < allShops.length; i++) {
    if (processed.has(allShops[i].id)) continue;
    
    const shop1 = allShops[i];
    const group = [shop1];
    
    for (let j = i + 1; j < allShops.length; j++) {
      if (processed.has(allShops[j].id)) continue;
      
      const shop2 = allShops[j];
      let isDuplicate = false;
      const reasons = [];
      
      // Check 1: Same google_maps_url
      if (shop1.google_maps_url && shop2.google_maps_url && 
          shop1.google_maps_url === shop2.google_maps_url) {
        isDuplicate = true;
        reasons.push('same_google_maps_url');
      }
      
      // Check 2: Same normalized name + same city/state
      const name1 = normalizeName(shop1.name);
      const name2 = normalizeName(shop2.name);
      
      if (name1 && name2 && name1 === name2 && 
          shop1.city && shop2.city && shop1.city.toLowerCase() === shop2.city.toLowerCase() &&
          shop1.state && shop2.state && shop1.state.toLowerCase() === shop2.state.toLowerCase()) {
        isDuplicate = true;
        reasons.push('same_name_city_state');
      }
      
      // Check 3: Very close lat/lng (within ~0.001 degrees / ~100m)
      if (shop1.latitude && shop1.longitude && shop2.latitude && shop2.longitude) {
        const distance = getDistance(shop1.latitude, shop1.longitude, shop2.latitude, shop2.longitude);
        if (distance < 0.001) {
          // Also check if names are similar (to avoid false positives from nearby shops)
          if (name1 && name2 && (name1 === name2 || name1.includes(name2) || name2.includes(name1))) {
            isDuplicate = true;
            reasons.push('close_lat_lng');
          }
        }
      }
      
      if (isDuplicate) {
        group.push({ ...shop2, duplicate_reasons: reasons });
        processed.add(shop2.id);
      }
    }
    
    if (group.length > 1) {
      // Sort by completeness (most complete first)
      group.sort((a, b) => compareShopCompleteness(b, a));
      
      duplicateGroups.push({
        group_size: group.length,
        shops: group.map(shop => ({
          id: shop.id,
          name: shop.name,
          city: shop.city,
          state: shop.state,
          slug: shop.slug,
          latitude: shop.latitude,
          longitude: shop.longitude,
          enrichment_status: shop.enrichment_status,
          google_maps_url: shop.google_maps_url,
          website: shop.website,
          phone: shop.phone,
          address: shop.address,
          duplicate_reasons: shop.duplicate_reasons || ['original']
        })),
        recommended_keep: group[0].id,
        recommended_remove: group.slice(1).map(s => s.id)
      });
    }
    
    processed.add(shop1.id);
    
    if ((i + 1) % 100 === 0) {
      console.log(`Processed ${i + 1}/${allShops.length} shops...`);
    }
  }
  
  console.log('\n=== DUPLICATE ANALYSIS COMPLETE ===\n');
  console.log(`Total duplicate groups found: ${duplicateGroups.length}`);
  
  let totalDuplicates = 0;
  duplicateGroups.forEach(group => {
    totalDuplicates += group.group_size - 1; // Count extras only
  });
  
  console.log(`Total duplicate shops (extras): ${totalDuplicates}`);
  console.log(`Total shops that should remain: ${allShops.length - totalDuplicates}`);
  
  // Print summary of each group
  console.log('\n=== DUPLICATE GROUPS ===\n');
  duplicateGroups.forEach((group, idx) => {
    console.log(`Group ${idx + 1} (${group.group_size} shops):`);
    group.shops.forEach((shop, shopIdx) => {
      const isRecommended = shopIdx === 0 ? ' [KEEP]' : ' [REMOVE]';
      const hasData = [];
      if (shop.google_maps_url) hasData.push('google');
      if (shop.website) hasData.push('website');
      if (shop.phone) hasData.push('phone');
      const dataStr = hasData.length > 0 ? hasData.join(',') : 'minimal';
      console.log(`  ${isRecommended} ID: ${shop.id} | ${shop.name} | ${shop.city}, ${shop.state} | ${shop.enrichment_status || 'none'} | Data: ${dataStr}`);
      if (shop.duplicate_reasons && shop.duplicate_reasons[0] !== 'original') {
        console.log(`       Reasons: ${shop.duplicate_reasons.join(', ')}`);
      }
    });
    console.log('');
  });
  
  // Save report
  const report = {
    generated_at: new Date().toISOString(),
    total_shops_analyzed: allShops.length,
    duplicate_groups_found: duplicateGroups.length,
    total_duplicate_shops: totalDuplicates,
    groups: duplicateGroups
  };
  
  const reportPath = join(__dirname, 'duplicate_report.json');
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nReport saved to: ${reportPath}`);
  
  return report;
}

// Run the analysis
findDuplicates().catch(console.error);
