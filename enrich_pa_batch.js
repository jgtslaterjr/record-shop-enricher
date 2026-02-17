#!/usr/bin/env node
/**
 * Batch enrichment for Pennsylvania record shops
 * Runs master_deep_scrape for all PA shops with deep_scrape_at = null
 */

const { supabase, delay, log } = require('./lib/common');
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const LOG_FILE = path.join(__dirname, 'pa_enrichment_log.txt');

function logToFile(msg) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${msg}\n`;
  fs.appendFileSync(LOG_FILE, line);
  console.log(msg);
}

async function getPAShopsToEnrich() {
  const { data, error } = await supabase
    .from('shops')
    .select('id,name,city,state,website,yelp_url,social_instagram')
    .eq('state', 'Pennsylvania')
    .is('deep_scrape_at', null)
    .order('city', { ascending: true });
  
  if (error) throw error;
  return data;
}

async function runMasterDeepScrape(shopId) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', ['master_deep_scrape.js', '--shop-id', shopId], {
      cwd: __dirname,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
      timeout: 300000, // 5 min per shop
    });

    let stdout = '';
    let stderr = '';
    
    proc.stdout.on('data', d => { 
      stdout += d.toString();
      process.stdout.write(d);
    });
    
    proc.stderr.on('data', d => { 
      stderr += d.toString();
      process.stderr.write(d);
    });
    
    proc.on('close', (code) => {
      if (code === 0) resolve({ success: true, stdout });
      else reject(new Error(`Exit code ${code}: ${stderr.slice(-500)}`));
    });

    proc.on('error', reject);
  });
}

async function run() {
  logToFile('╔════════════════════════════════════════════════════════╗');
  logToFile('║   Pennsylvania Record Shop Batch Enrichment           ║');
  logToFile('╚════════════════════════════════════════════════════════╝');
  
  const shops = await getPAShopsToEnrich();
  logToFile(`Found ${shops.length} unenriched PA shops\n`);

  let processed = 0;
  let succeeded = 0;
  let failed = 0;

  for (const shop of shops) {
    processed++;
    logToFile(`\n${'='.repeat(60)}`);
    logToFile(`[${processed}/${shops.length}] ${shop.name} (${shop.city})`);
    logToFile(`ID: ${shop.id}`);
    logToFile('='.repeat(60));

    try {
      await runMasterDeepScrape(shop.id);
      succeeded++;
      logToFile(`✓ Completed: ${shop.name}`);
      
      // Update enrichment status after successful scrape
      await supabase
        .from('shops')
        .update({ 
          deep_scrape_at: new Date().toISOString()
        })
        .eq('id', shop.id);
      
    } catch (e) {
      failed++;
      logToFile(`✗ Failed: ${shop.name} — ${e.message}`);
    }

    // Progress report every 10 shops
    if (processed % 10 === 0) {
      logToFile(`\n📊 Progress: ${processed}/${shops.length} | ✓ ${succeeded} | ✗ ${failed}`);
    }

    // Rate limit between shops
    await delay(3000, 5000);
  }

  logToFile(`\n${'='.repeat(60)}`);
  logToFile('BATCH COMPLETE');
  logToFile(`Total: ${shops.length} | Processed: ${processed} | Succeeded: ${succeeded} | Failed: ${failed}`);
  logToFile('='.repeat(60));
}

run()
  .then(() => {
    console.log('\n✓ PA enrichment batch complete. See pa_enrichment_log.txt for details.');
    setTimeout(() => process.exit(0), 3000);
  })
  .catch(e => {
    console.error('Fatal error:', e);
    process.exit(1);
  });
