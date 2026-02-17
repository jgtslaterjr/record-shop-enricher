#!/usr/bin/env node

const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
require('dotenv').config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY; // Use service key to bypass RLS

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function removeDuplicates() {
  console.log('🔍 Reading duplicate report...');
  const report = JSON.parse(fs.readFileSync('./duplicate_report.json', 'utf8'));
  
  console.log(`📊 Found ${report.duplicate_groups_found} duplicate groups with ${report.total_duplicate_shops} duplicate shops\n`);
  
  const idsToRemove = [];
  
  // Collect all IDs marked for removal
  for (const group of report.groups) {
    if (group.recommended_remove && group.recommended_remove.length > 0) {
      idsToRemove.push(...group.recommended_remove);
    }
  }
  
  console.log(`🗑️  Preparing to remove ${idsToRemove.length} duplicate shops...\n`);
  
  let removed = 0;
  let errors = [];
  
  // Delete in batches
  for (let i = 0; i < idsToRemove.length; i++) {
    const id = idsToRemove[i];
    
    try {
      const { error } = await supabase
        .from('shops')
        .delete()
        .eq('id', id);
      
      if (error) {
        console.error(`❌ Error deleting ${id}: ${error.message}`);
        errors.push({ id, error: error.message });
      } else {
        removed++;
        process.stdout.write(`\r✅ Removed ${removed}/${idsToRemove.length} shops...`);
      }
    } catch (err) {
      console.error(`❌ Exception deleting ${id}: ${err.message}`);
      errors.push({ id, error: err.message });
    }
  }
  
  console.log(`\n\n✨ Duplicate removal complete!`);
  console.log(`   Successfully removed: ${removed}`);
  console.log(`   Errors: ${errors.length}`);
  
  if (errors.length > 0) {
    console.log('\n⚠️  Errors encountered:');
    errors.forEach(({ id, error }) => {
      console.log(`   ${id}: ${error}`);
    });
  }
  
  // Write results log
  const logPath = './duplicate_removal_log.json';
  fs.writeFileSync(logPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    total_attempted: idsToRemove.length,
    successfully_removed: removed,
    errors: errors
  }, null, 2));
  
  console.log(`\n📝 Log written to ${logPath}`);
}

removeDuplicates().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
