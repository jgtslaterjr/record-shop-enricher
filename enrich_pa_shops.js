#!/usr/bin/env node
/**
 * PA Shop Enrichment Script
 * Enriches all Pennsylvania shops that haven't been enriched yet
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const LOG_FILE = path.join(__dirname, 'pa_enrichment_log.txt');

function log(msg) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${msg}\n`;
  console.log(msg);
  fs.appendFileSync(LOG_FILE, line);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runDeepScrape(shop) {
  return new Promise((resolve, reject) => {
    const args = ['master_deep_scrape.js', '--shop-id', shop.id];
    const proc = spawn('node', args, {
      cwd: __dirname,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
      timeout: 180000, // 3 min timeout
    });

    let stdout = '';
    let stderr = '';
    
    proc.stdout.on('data', d => { 
      stdout += d; 
      process.stdout.write(d); 
    });
    
    proc.stderr.on('data', d => { 
      stderr += d;
      process.stderr.write(d);
    });
    
    proc.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`Exit code ${code}: ${stderr.slice(-200)}`));
    });

    proc.on('error', reject);
  });
}

async function enrichShop(shop) {
  log(`\n${'='.repeat(60)}`);
  log(`Starting enrichment: ${shop.name} (${shop.city})`);
  log(`Shop ID: ${shop.id}`);
  
  try {
    await runDeepScrape(shop);
    
    // Mark as enriched with STRING value
    const { error: updateError } = await sb
      .from('shops')
      .update({ enrichment_status: 'enriched' })
      .eq('id', shop.id);
    
    if (updateError) {
      log(`✗ Error updating enrichment_status: ${updateError.message}`);
      return { success: false, error: updateError.message };
    }
    
    log(`✓ Successfully enriched: ${shop.name}`);
    return { success: true };
    
  } catch (error) {
    log(`✗ Error enriching ${shop.name}: ${error.message}`);
    return { success: false, error: error.message };
  }
}

async function main() {
  log('╔══════════════════════════════════════════════════════════╗');
  log('║     PA Shop Enrichment - Batch Processing               ║');
  log('╚══════════════════════════════════════════════════════════╝');
  
  // Get all unenriched PA shops
  log('\nFetching unenriched PA shops...');
  const { data: allShops, error } = await sb
    .from('shops')
    .select('id,name,city,state,enrichment_status')
    .eq('state', 'Pennsylvania');
  
  if (error) {
    log(`ERROR: Failed to fetch shops - ${error.message}`);
    process.exit(1);
  }
  
  // Filter for unenriched
  const unenriched = allShops.filter(shop => {
    if (!shop.enrichment_status) return true;
    if (typeof shop.enrichment_status === 'string' && shop.enrichment_status !== 'enriched') return true;
    if (typeof shop.enrichment_status === 'object') return true; // Old format - needs enrichment
    return false;
  });
  
  log(`\nTotal PA shops: ${allShops.length}`);
  log(`Unenriched shops: ${unenriched.length}`);
  log(`Starting enrichment process...\n`);
  
  let processed = 0;
  let succeeded = 0;
  let failed = 0;
  const startTime = Date.now();
  
  for (const shop of unenriched) {
    const result = await enrichShop(shop);
    
    processed++;
    if (result.success) succeeded++;
    else failed++;
    
    // Progress report every 20 shops
    if (processed % 20 === 0) {
      const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
      log(`\n--- PROGRESS REPORT ---`);
      log(`Processed: ${processed}/${unenriched.length}`);
      log(`Succeeded: ${succeeded}`);
      log(`Failed: ${failed}`);
      log(`Elapsed: ${elapsed} minutes`);
      log(`Avg per shop: ${(elapsed / processed).toFixed(1)} min`);
      log(`-----------------------\n`);
    }
    
    // Delay between shops to avoid rate limits
    await delay(5000);
  }
  
  const totalTime = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  log(`\n${'='.repeat(60)}`);
  log(`ENRICHMENT COMPLETE`);
  log(`Total processed: ${processed}`);
  log(`Succeeded: ${succeeded}`);
  log(`Failed: ${failed}`);
  log(`Total time: ${totalTime} minutes`);
  log(`${'='.repeat(60)}`);
  
  process.exit(0);
}

main().catch(error => {
  log(`FATAL ERROR: ${error.message}`);
  console.error(error);
  process.exit(1);
});
