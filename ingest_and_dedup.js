#!/usr/bin/env node
/**
 * Step 1: Ingest PA shops that failed RLS insert
 * Step 2: Full database dedup
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { readFileSync } = require('fs');
const path = require('path');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

function slugify(name) {
  return name.toLowerCase().replace(/['']/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function normalizeForMatch(name) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({length: m+1}, () => Array(n+1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[m][n];
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = x => x * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Score how "enriched" a shop record is
function enrichmentScore(shop) {
  let score = 0;
  const fields = ['website', 'phone', 'hours', 'hours_text', 'description', 'long_description',
    'social_instagram', 'social_facebook', 'social_tiktok', 'social_tumblr',
    'logo_url', 'image_hero_url', 'yelp_url', 'google_maps_url',
    'review_summary', 'review_pros', 'review_cons', 'genre_specialties',
    'owner_name', 'founded_year', 'formats_detailed', 'services', 'amenities',
    'address', 'latitude', 'longitude', 'neighborhood'];
  for (const f of fields) {
    if (shop[f] != null && shop[f] !== '' && shop[f] !== false) score++;
  }
  if (shop.image_gallery?.length > 0) score += 2;
  if (shop.review_count > 0) score += 1;
  if (shop.average_rating > 0) score += 1;
  if (shop.formats?.length > 0) score += 1;
  if (shop.enrichment_status === 'enriched') score += 3;
  if (shop.deep_scrape_at) score += 2;
  return score;
}

async function getAllShops() {
  const all = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase.from('shops').select('*').range(from, from + 999);
    if (error) throw error;
    all.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }
  return all;
}

async function step1_ingest() {
  console.log('\n═══ STEP 1: Ingest PA Discovery Results ═══\n');
  
  // Parse the log to get failed shops with their search context
  const log = readFileSync(path.join(__dirname, 'pa_discovery_20260216.log'), 'utf8');
  const lines = log.split('\n');
  
  const failedShops = [];
  let currentCity = null;
  
  for (const line of lines) {
    const searchMatch = line.match(/Searching: record stores? in (.+)/);
    if (searchMatch) {
      currentCity = searchMatch[1].replace(/, PA$/, '').trim();
    }
    const failMatch = line.match(/Insert failed: (.+?) — /);
    if (failMatch && currentCity) {
      failedShops.push({ name: failMatch[1], searchCity: currentCity });
    }
  }
  
  console.log(`Found ${failedShops.length} failed inserts from log`);
  
  // Get all existing shops
  const existing = await getAllShops();
  console.log(`${existing.length} shops currently in database`);
  
  // Build lookup by normalized name
  const existingByNorm = new Map();
  for (const s of existing) {
    existingByNorm.set(normalizeForMatch(s.name), s);
  }
  
  let added = 0, skipped = 0, errors = 0;
  const addedNames = [];
  const skippedNames = [];
  
  // Dedupe the failed list itself
  const seen = new Set();
  const uniqueFailed = [];
  for (const s of failedShops) {
    const key = normalizeForMatch(s.name);
    if (!seen.has(key)) {
      seen.add(key);
      uniqueFailed.push(s);
    }
  }
  console.log(`${uniqueFailed.length} unique shops to check`);
  
  for (const shop of uniqueFailed) {
    const norm = normalizeForMatch(shop.name);
    
    // Check exact match
    if (existingByNorm.has(norm)) {
      skipped++;
      skippedNames.push(shop.name);
      continue;
    }
    
    // Check fuzzy match
    let fuzzyMatch = false;
    for (const [existNorm, existShop] of existingByNorm) {
      if (norm.length > 4 && existNorm.length > 4) {
        const dist = levenshtein(norm, existNorm);
        const maxLen = Math.max(norm.length, existNorm.length);
        if (dist / maxLen < 0.15) {
          skipped++;
          skippedNames.push(`${shop.name} (fuzzy match: ${existShop.name})`);
          fuzzyMatch = true;
          break;
        }
      }
    }
    if (fuzzyMatch) continue;
    
    // Insert
    const slug = slugify(shop.name) + '_' + slugify(shop.searchCity) + '_pennsylvania';
    const newShop = {
      name: shop.name,
      city: shop.searchCity,
      state: 'Pennsylvania',
      slug,
    };
    
    try {
      const { error } = await supabase.from('shops').insert(newShop);
      if (error) {
        if (error.code === '23505') {
          skipped++;
          skippedNames.push(`${shop.name} (slug conflict)`);
        } else {
          errors++;
          console.log(`  ❌ ${shop.name}: ${error.message}`);
        }
      } else {
        added++;
        addedNames.push(`${shop.name} (${shop.searchCity})`);
        // Add to lookup so we don't insert dupes from same run
        existingByNorm.set(norm, newShop);
      }
    } catch (e) {
      errors++;
      console.log(`  ❌ ${shop.name}: ${e.message}`);
    }
  }
  
  console.log(`\n--- Step 1 Results ---`);
  console.log(`Added: ${added}`);
  console.log(`Skipped (already exist): ${skipped}`);
  console.log(`Errors: ${errors}`);
  
  if (addedNames.length > 0) {
    console.log(`\nAdded shops:`);
    addedNames.forEach(n => console.log(`  ➕ ${n}`));
  }
  
  return { added, skipped, errors, addedNames, skippedNames };
}

async function step2_dedup() {
  console.log('\n═══ STEP 2: Full Database Dedup ═══\n');
  
  const allShops = await getAllShops();
  console.log(`Total shops in database: ${allShops.length}`);
  
  // Find duplicate groups
  const dupGroups = [];
  const processed = new Set();
  
  for (let i = 0; i < allShops.length; i++) {
    if (processed.has(allShops[i].id)) continue;
    
    const group = [allShops[i]];
    
    for (let j = i + 1; j < allShops.length; j++) {
      if (processed.has(allShops[j].id)) continue;
      
      const a = allShops[i], b = allShops[j];
      let isDup = false;
      
      // 1. Exact name + city
      if (normalizeForMatch(a.name) === normalizeForMatch(b.name) && 
          a.city && b.city && a.city.toLowerCase() === b.city.toLowerCase()) {
        isDup = true;
      }
      
      // 2. Fuzzy name + same city
      if (!isDup && a.city && b.city && a.city.toLowerCase() === b.city.toLowerCase()) {
        const na = normalizeForMatch(a.name), nb = normalizeForMatch(b.name);
        if (na.length > 4 && nb.length > 4) {
          const dist = levenshtein(na, nb);
          const maxLen = Math.max(na.length, nb.length);
          if (dist / maxLen < 0.12) isDup = true;
        }
      }
      
      // 3. Close coordinates (~100m)
      if (!isDup && a.latitude && b.latitude && a.longitude && b.longitude) {
        const dist = haversineMeters(a.latitude, a.longitude, b.latitude, b.longitude);
        if (dist < 100) {
          // Also check name similarity (don't merge completely different shops at same location)
          const na = normalizeForMatch(a.name), nb = normalizeForMatch(b.name);
          const nameDist = levenshtein(na, nb);
          const maxLen = Math.max(na.length, nb.length);
          if (nameDist / maxLen < 0.4) isDup = true;
        }
      }
      
      // 4. Same address (non-null, non-empty)
      if (!isDup && a.address && b.address && a.address.length > 5 && b.address.length > 5) {
        const addrA = a.address.toLowerCase().replace(/[^a-z0-9]/g, '');
        const addrB = b.address.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (addrA === addrB && addrA.length > 8) {
          const na = normalizeForMatch(a.name), nb = normalizeForMatch(b.name);
          const nameDist = levenshtein(na, nb);
          const maxLen = Math.max(na.length, nb.length);
          if (nameDist / maxLen < 0.4) isDup = true;
        }
      }
      
      if (isDup) {
        group.push(b);
        processed.add(b.id);
      }
    }
    
    if (group.length > 1) {
      dupGroups.push(group);
      processed.add(allShops[i].id);
    }
  }
  
  console.log(`Found ${dupGroups.length} duplicate groups`);
  
  let totalRemoved = 0;
  const removalLog = [];
  
  for (const group of dupGroups) {
    // Sort by enrichment score descending - keep the best
    group.sort((a, b) => enrichmentScore(b) - enrichmentScore(a));
    const keep = group[0];
    const remove = group.slice(1);
    
    console.log(`\n  Group: "${keep.name}" (${keep.city}, ${keep.state})`);
    console.log(`    KEEP: id=${keep.id.slice(0,8)} score=${enrichmentScore(keep)} enrichment=${keep.enrichment_status}`);
    
    for (const r of remove) {
      console.log(`    DEL:  id=${r.id.slice(0,8)} score=${enrichmentScore(r)} name="${r.name}" enrichment=${r.enrichment_status}`);
      
      const { error } = await supabase.from('shops').delete().eq('id', r.id);
      if (error) {
        console.log(`    ❌ Failed to delete ${r.id}: ${error.message}`);
      } else {
        totalRemoved++;
        removalLog.push({ kept: keep.name, removed: r.name, keptScore: enrichmentScore(keep), removedScore: enrichmentScore(r) });
      }
    }
  }
  
  const afterCount = allShops.length - totalRemoved;
  console.log(`\n--- Step 2 Results ---`);
  console.log(`Before: ${allShops.length}`);
  console.log(`Duplicates removed: ${totalRemoved}`);
  console.log(`After: ${afterCount}`);
  
  return { before: allShops.length, removed: totalRemoved, after: afterCount, dupGroups: dupGroups.length, removalLog };
}

async function main() {
  const s1 = await step1_ingest();
  const s2 = await step2_dedup();
  
  // Output summary as JSON for easy parsing
  console.log('\n\n=== FINAL SUMMARY ===');
  console.log(JSON.stringify({ step1: s1, step2: s2 }, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
