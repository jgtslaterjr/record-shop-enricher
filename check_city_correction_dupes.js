#!/usr/bin/env node

import { createClient } from '@supabase/supabase-js';
import { readFile } from 'fs/promises';
import { config } from 'dotenv';

config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Normalize shop name for fuzzy matching
function normalizeName(name) {
  if (!name) return '';
  
  return name
    .toLowerCase()
    .replace(/^the\s+/i, '') // Remove leading "the"
    .replace(/\s+the\s+/gi, ' ') // Remove "the" in middle
    .replace(/[^\w\s]/g, '') // Remove punctuation
    .replace(/\s+/g, ' ') // Normalize whitespace
    .trim();
}

// Check if two names are similar enough to be potential duplicates
function namesMatch(name1, name2) {
  const n1 = normalizeName(name1);
  const n2 = normalizeName(name2);
  
  if (n1 === n2) return true;
  
  // Also check if one is a substring of the other (for cases like "Record Shop" vs "The Record Shop & Cafe")
  if (n1.includes(n2) || n2.includes(n1)) {
    // But only if they're reasonably similar in length
    const ratio = Math.min(n1.length, n2.length) / Math.max(n1.length, n2.length);
    if (ratio > 0.6) return true;
  }
  
  return false;
}

async function checkDuplicates() {
  console.log('Loading city corrections...');
  const corrections = JSON.parse(await readFile('./city_corrections.json', 'utf-8'));
  console.log(`Loaded ${corrections.length} corrections\n`);
  
  console.log('Fetching all shops from database...');
  const { data: allShops, error } = await supabase
    .from('shops')
    .select('id, name, city, state, address, phone, website, hours, description, social_instagram, social_facebook, logo_url, yelp_url, google_maps_url');
  
  if (error) {
    console.error('Error fetching shops:', error);
    process.exit(1);
  }
  
  console.log(`Fetched ${allShops.length} shops from database\n`);
  
  const duplicates = [];
  const processedPairs = new Set(); // Track pairs we've already reported
  
  for (const correction of corrections) {
    const correctedCity = correction.proposed.city;
    const correctedState = correction.proposed.state;
    const correctionId = correction.id;
    const correctionName = correction.name;
    
    // Find potential duplicates: same city/state, similar name, different ID
    for (const shop of allShops) {
      if (shop.id === correctionId) continue; // Skip self
      
      // Check city/state match
      const cityMatch = shop.city?.toLowerCase() === correctedCity?.toLowerCase();
      const stateMatch = shop.state?.toLowerCase() === correctedState?.toLowerCase();
      
      if (cityMatch && stateMatch && namesMatch(correctionName, shop.name)) {
        // Create a unique pair key (sorted IDs to avoid duplicates)
        const pairKey = [correctionId, shop.id].sort().join('|');
        
        if (!processedPairs.has(pairKey)) {
          processedPairs.add(pairKey);
          
          // Calculate which has more data
          const correctionDataScore = [
            correction.current.latitude,
            correction.current.longitude,
          ].filter(Boolean).length;
          
          const shopDataScore = [
            shop.address,
            shop.phone,
            shop.website,
            shop.hours,
            shop.description,
            shop.social_instagram,
            shop.social_facebook,
            shop.logo_url,
            shop.yelp_url,
            shop.google_maps_url,
          ].filter(Boolean).length;
          
          duplicates.push({
            correction: {
              id: correctionId,
              name: correctionName,
              city: correctedCity,
              state: correctedState,
              dataScore: correctionDataScore,
            },
            existing: {
              id: shop.id,
              name: shop.name,
              city: shop.city,
              state: shop.state,
              dataScore: shopDataScore,
              hasAddress: !!shop.address,
              hasPhone: !!shop.phone,
              hasWebsite: !!shop.website,
              hasHours: !!shop.hours,
              hasDescription: !!shop.description,
              hasInstagram: !!shop.social_instagram,
              hasFacebook: !!shop.social_facebook,
              hasLogo: !!shop.logo_url,
              hasYelp: !!shop.yelp_url,
              hasGoogleMaps: !!shop.google_maps_url,
            },
            recommendation: shopDataScore > correctionDataScore ? 'existing' : 'correction',
          });
        }
      }
    }
  }
  
  // Print results
  console.log('='.repeat(80));
  console.log(`DUPLICATE CHECK RESULTS`);
  console.log('='.repeat(80));
  console.log(`\nTotal potential duplicates found: ${duplicates.length}\n`);
  
  if (duplicates.length === 0) {
    console.log('✅ No duplicates found! Safe to proceed with city corrections.');
  } else {
    console.log('⚠️  DUPLICATES DETECTED - Review before proceeding!\n');
    
    duplicates.forEach((dup, index) => {
      console.log(`\n${index + 1}. POTENTIAL DUPLICATE`);
      console.log('-'.repeat(80));
      
      console.log('\n  Correction Record:');
      console.log(`    ID:    ${dup.correction.id}`);
      console.log(`    Name:  ${dup.correction.name}`);
      console.log(`    City:  ${dup.correction.city}, ${dup.correction.state}`);
      console.log(`    Data:  ${dup.correction.dataScore} fields`);
      
      console.log('\n  Existing Record:');
      console.log(`    ID:    ${dup.existing.id}`);
      console.log(`    Name:  ${dup.existing.name}`);
      console.log(`    City:  ${dup.existing.city}, ${dup.existing.state}`);
      console.log(`    Data:  ${dup.existing.dataScore} fields`);
      console.log(`    Fields: ${[
        dup.existing.hasAddress && 'address',
        dup.existing.hasPhone && 'phone',
        dup.existing.hasWebsite && 'website',
        dup.existing.hasHours && 'hours',
        dup.existing.hasDescription && 'description',
        dup.existing.hasInstagram && 'instagram',
        dup.existing.hasFacebook && 'facebook',
        dup.existing.hasLogo && 'logo',
        dup.existing.hasYelp && 'yelp',
        dup.existing.hasGoogleMaps && 'google_maps',
      ].filter(Boolean).join(', ') || 'none'}`);
      
      console.log(`\n  📌 Recommendation: Keep "${dup.recommendation === 'existing' ? 'EXISTING' : 'CORRECTION'}" record`);
      console.log(`     (has more enrichment data)`);
    });
    
    console.log('\n' + '='.repeat(80));
    console.log('SUMMARY');
    console.log('='.repeat(80));
    console.log(`Total duplicates: ${duplicates.length}`);
    console.log(`Recommend keeping existing: ${duplicates.filter(d => d.recommendation === 'existing').length}`);
    console.log(`Recommend keeping correction: ${duplicates.filter(d => d.recommendation === 'correction').length}`);
    
    console.log('\n⚠️  ACTION REQUIRED:');
    console.log('   1. Review each duplicate pair above');
    console.log('   2. Merge data if needed or delete duplicate records');
    console.log('   3. Remove merged IDs from city_corrections.json before applying');
  }
  
  console.log('\n');
}

checkDuplicates().catch(console.error);
