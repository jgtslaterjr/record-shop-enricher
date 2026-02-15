#!/usr/bin/env node
/**
 * Batch PA deep scrape - runs each shop sequentially with proper timeout handling
 */
require('dotenv').config();
const { execSync } = require('child_process');
const { createClient } = require('@supabase/supabase-js');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function main() {
  const startTime = Date.now();
  
  // Get PA shops needing scrape
  const { data: shops } = await sb
    .from('shops')
    .select('name,city,state')
    .eq('state', 'Pennsylvania')
    .is('deep_scrape_at', null)
    .order('name');

  console.log(`Found ${shops.length} PA shops to scrape\n`);

  const succeeded = [];
  const failed = [];

  for (let i = 0; i < shops.length; i++) {
    const shop = shops[i];
    const label = `[${i + 1}/${shops.length}] ${shop.name} (${shop.city})`;
    console.log(`\n${'='.repeat(60)}`);
    console.log(`START: ${label}`);
    console.log(`${'='.repeat(60)}`);

    try {
      // 4-minute timeout per shop, kill the whole tree
      execSync(
        `node master_deep_scrape.js --shop "${shop.name.replace(/"/g, '\\"')}" --city "${shop.city}" --state "${shop.state}"`,
        {
          cwd: __dirname,
          timeout: 240000, // 4 min
          stdio: 'inherit',
          killSignal: 'SIGKILL',
        }
      );
      console.log(`\n✅ SUCCESS: ${label}`);
      succeeded.push(shop.name);
    } catch (e) {
      const msg = e.killed ? 'TIMEOUT (4min)' : `exit code ${e.status}`;
      console.log(`\n❌ FAILED: ${label} — ${msg}`);
      failed.push({ name: shop.name, city: shop.city, reason: msg });
    }

    // 10s delay between shops
    if (i < shops.length - 1) {
      console.log('--- waiting 10s ---');
      await new Promise(r => setTimeout(r, 10000));
    }
  }

  const elapsed = Math.round((Date.now() - startTime) / 60000);
  console.log(`\n${'='.repeat(60)}`);
  console.log('PA DEEP SCRAPE COMPLETE');
  console.log(`${'='.repeat(60)}`);
  console.log(`Succeeded: ${succeeded.length}`);
  console.log(`Failed: ${failed.length}`);
  if (failed.length > 0) {
    console.log('Failed shops:');
    failed.forEach(f => console.log(`  - ${f.name} (${f.city}): ${f.reason}`));
  }
  console.log(`Total time: ${elapsed} minutes`);

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
