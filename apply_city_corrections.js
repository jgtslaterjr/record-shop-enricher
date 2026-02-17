#!/usr/bin/env node
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

// Configuration
const BATCH_SIZE = 10;
const CORRECTIONS_FILE = path.join(__dirname, 'city_corrections.json');
const BACKUP_FILE = path.join(__dirname, 'city_corrections_backup.json');
const DRY_RUN_FILE = path.join(__dirname, 'city_corrections_dryrun.txt');

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Helper: slugify function
function slugify(name, city, state) {
  const cleanText = (text) => {
    if (!text) return '';
    return text.toLowerCase()
      .replace(/[^\w\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .trim();
  };
  
  const parts = [cleanText(name)];
  if (city) parts.push(cleanText(city));
  if (state) parts.push(cleanText(state));
  
  return parts.join('_');
}

// Step 1: Backup
async function backup() {
  console.log('\n=== STEP 1: BACKUP ===');
  
  const corrections = JSON.parse(fs.readFileSync(CORRECTIONS_FILE, 'utf8'));
  const ids = corrections.map(c => c.id);
  
  console.log(`Loading ${ids.length} shops from database...`);
  
  const { data, error } = await supabase
    .from('shops')
    .select('*')
    .in('id', ids);
  
  if (error) {
    throw new Error(`Backup failed: ${error.message}`);
  }
  
  if (data.length !== ids.length) {
    throw new Error(`Backup verification failed: expected ${ids.length} shops, got ${data.length}`);
  }
  
  fs.writeFileSync(BACKUP_FILE, JSON.stringify(data, null, 2));
  console.log(`✓ Backup saved: ${BACKUP_FILE}`);
  console.log(`✓ Verified: ${data.length} shops backed up`);
  
  return data;
}

// Step 2: Dry run
async function dryRun(backupData) {
  console.log('\n=== STEP 2: DRY RUN ===');
  
  const corrections = JSON.parse(fs.readFileSync(CORRECTIONS_FILE, 'utf8'));
  const backupMap = new Map(backupData.map(shop => [shop.id, shop]));
  
  let report = [];
  let cityChanges = 0;
  let stateChanges = 0;
  let slugChanges = 0;
  
  report.push('DRY RUN REPORT');
  report.push('='.repeat(80));
  report.push('');
  
  // First, check state format from one example
  const sampleShop = backupMap.values().next().value;
  const stateFormat = typeof sampleShop.state;
  report.push(`State field format: ${stateFormat} (example: ${JSON.stringify(sampleShop.state)})`);
  report.push('');
  
  corrections.forEach(correction => {
    const current = backupMap.get(correction.id);
    if (!current) {
      report.push(`⚠ WARNING: Shop ${correction.id} not found in backup`);
      return;
    }
    
    const changes = [];
    
    // Check city change
    if (current.city !== correction.proposed.city) {
      changes.push(`city: ${current.city || 'null'} → ${correction.proposed.city}`);
      cityChanges++;
    }
    
    // Check state change (handle different formats)
    const currentState = typeof current.state === 'string' ? current.state : current.state?.name;
    if (currentState !== correction.proposed.state) {
      changes.push(`state: ${currentState} → ${correction.proposed.state}`);
      stateChanges++;
    }
    
    // Check slug change
    const newSlug = slugify(current.name, correction.proposed.city, correction.proposed.state);
    if (current.slug !== newSlug) {
      changes.push(`slug: ${current.slug} → ${newSlug}`);
      slugChanges++;
    }
    
    if (changes.length > 0) {
      report.push(`[${correction.name}]:`);
      changes.forEach(change => report.push(`  ${change}`));
      report.push('');
    }
  });
  
  report.push('='.repeat(80));
  report.push(`SUMMARY:`);
  report.push(`  Total shops: ${corrections.length}`);
  report.push(`  City changes: ${cityChanges}`);
  report.push(`  State changes: ${stateChanges}`);
  report.push(`  Slug changes: ${slugChanges}`);
  report.push('');
  
  const reportText = report.join('\n');
  fs.writeFileSync(DRY_RUN_FILE, reportText);
  console.log(`✓ Dry run report saved: ${DRY_RUN_FILE}`);
  console.log(`\n${reportText}`);
  
  return { cityChanges, stateChanges, slugChanges, stateFormat };
}

// Step 3: Apply corrections
async function applyCorrections(stateFormat) {
  console.log('\n=== STEP 3: APPLY CORRECTIONS ===');
  
  const corrections = JSON.parse(fs.readFileSync(CORRECTIONS_FILE, 'utf8'));
  let processedCount = 0;
  let errorCount = 0;
  
  // Process in batches
  for (let i = 0; i < corrections.length; i += BATCH_SIZE) {
    const batch = corrections.slice(i, i + BATCH_SIZE);
    
    for (const correction of batch) {
      try {
        // Prepare update data
        const updateData = {
          city: correction.proposed.city,
          state: stateFormat === 'string' 
            ? correction.proposed.state 
            : { name: correction.proposed.state },
          slug: slugify(correction.name, correction.proposed.city, correction.proposed.state)
        };
        
        const { error } = await supabase
          .from('shops')
          .update(updateData)
          .eq('id', correction.id);
        
        if (error) {
          throw new Error(error.message);
        }
        
        processedCount++;
      } catch (err) {
        errorCount++;
        console.error(`✗ ERROR updating shop ${correction.name} (${correction.id}): ${err.message}`);
        throw new Error(`STOPPED: Error occurred at shop ${processedCount + 1}. Check logs and backup.`);
      }
    }
    
    console.log(`✓ Batch ${Math.floor(i / BATCH_SIZE) + 1}: Processed ${Math.min(i + BATCH_SIZE, corrections.length)}/${corrections.length} shops`);
  }
  
  console.log(`✓ Successfully updated ${processedCount} shops`);
  return processedCount;
}

// Step 4: Verify
async function verify() {
  console.log('\n=== STEP 4: VERIFICATION ===');
  
  const corrections = JSON.parse(fs.readFileSync(CORRECTIONS_FILE, 'utf8'));
  const ids = corrections.map(c => c.id);
  
  const { data, error } = await supabase
    .from('shops')
    .select('id, name, city, state, slug')
    .in('id', ids);
  
  if (error) {
    throw new Error(`Verification query failed: ${error.message}`);
  }
  
  const correctionMap = new Map(corrections.map(c => [c.id, c]));
  let issues = [];
  
  data.forEach(shop => {
    const expected = correctionMap.get(shop.id);
    if (!expected) return;
    
    // Check city
    if (!shop.city || shop.city !== expected.proposed.city) {
      issues.push(`${shop.name}: city mismatch (got: ${shop.city}, expected: ${expected.proposed.city})`);
    }
    
    // Check state
    const actualState = typeof shop.state === 'string' ? shop.state : shop.state?.name;
    if (actualState !== expected.proposed.state) {
      issues.push(`${shop.name}: state mismatch (got: ${actualState}, expected: ${expected.proposed.state})`);
    }
    
    // Check slug
    const expectedSlug = slugify(shop.name, expected.proposed.city, expected.proposed.state);
    if (shop.slug !== expectedSlug) {
      issues.push(`${shop.name}: slug mismatch (got: ${shop.slug}, expected: ${expectedSlug})`);
    }
  });
  
  console.log(`✓ Queried ${data.length} shops`);
  
  if (issues.length > 0) {
    console.log(`\n⚠ VERIFICATION ISSUES (${issues.length}):`);
    issues.forEach(issue => console.log(`  - ${issue}`));
    return { success: false, issues };
  }
  
  console.log(`✓ All ${data.length} shops verified successfully`);
  console.log(`  - All cities are non-null`);
  console.log(`  - All states match proposed corrections`);
  console.log(`  - All slugs regenerated correctly`);
  
  return { success: true, count: data.length };
}

// Main execution
async function main() {
  console.log('CITY/STATE CORRECTIONS APPLICATION');
  console.log('='.repeat(80));
  console.log(`Started: ${new Date().toISOString()}`);
  
  try {
    // Step 1: Backup
    const backupData = await backup();
    
    // Step 2: Dry run
    const dryRunResults = await dryRun(backupData);
    
    console.log('\n⚠ READY TO APPLY CHANGES');
    console.log('Press Ctrl+C now if you want to review the dry run report first.');
    console.log('Continuing in 5 seconds...');
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Step 3: Apply corrections
    const updatedCount = await applyCorrections(dryRunResults.stateFormat);
    
    // Step 4: Verify
    const verification = await verify();
    
    // Summary
    console.log('\n' + '='.repeat(80));
    console.log('OPERATION COMPLETE');
    console.log(`Finished: ${new Date().toISOString()}`);
    console.log(`Status: ${verification.success ? 'SUCCESS' : 'FAILED'}`);
    console.log(`Shops updated: ${updatedCount}`);
    console.log(`Shops verified: ${verification.count || 0}`);
    
    if (!verification.success) {
      console.log(`\n⚠ Verification found issues. Review above and restore from backup if needed:`);
      console.log(`  ${BACKUP_FILE}`);
      process.exit(1);
    }
    
    console.log('\n✓ All corrections applied and verified successfully!');
    process.exit(0);
    
  } catch (error) {
    console.error('\n✗✗✗ OPERATION FAILED ✗✗✗');
    console.error(error.message);
    console.error(`\nBackup available at: ${BACKUP_FILE}`);
    console.error('Review logs and restore from backup if needed.');
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main();
}
