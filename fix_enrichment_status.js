#!/usr/bin/env node
/**
 * Fix [object Object] enrichment_status bug
 * Sets all object-type enrichment_status values to null
 */

const { supabase, log } = require('./lib/common');

async function fixEnrichmentStatus() {
  log('🔧 Fixing enrichment_status [object Object] bug...\n');
  
  // Get all shops
  const { data: shops, error } = await supabase
    .from('shops')
    .select('id, name, enrichment_status')
    .limit(2000);
  
  if (error) {
    console.error('Error fetching shops:', error);
    process.exit(1);
  }
  
  const badRecords = shops.filter(s => {
    const val = s.enrichment_status;
    return val && typeof val !== 'string';
  });
  
  log(`Found ${badRecords.length} shops with object-type enrichment_status`);
  log('Setting all to null...\n');
  
  let fixed = 0;
  for (const shop of badRecords) {
    const { error } = await supabase
      .from('shops')
      .update({ enrichment_status: null })
      .eq('id', shop.id);
    
    if (error) {
      console.error(`Failed to fix ${shop.name}:`, error.message);
    } else {
      fixed++;
      if (fixed % 50 === 0) {
        log(`  Fixed ${fixed}/${badRecords.length}...`);
      }
    }
  }
  
  log(`\n✓ Fixed ${fixed} records`);
}

fixEnrichmentStatus().then(() => process.exit(0)).catch(e => {
  console.error(e);
  process.exit(1);
});
