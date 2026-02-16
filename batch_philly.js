#!/usr/bin/env node
/**
 * Batch deep scrape for Philadelphia shops
 * Saves progress after each shop, detailed logging
 */
require('dotenv').config({ quiet: true });
const { createClient } = require('@supabase/supabase-js');
const { execSync } = require('child_process');
const fs = require('fs');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const LOG = '/tmp/philly_batch.log';
const PROGRESS = '/tmp/philly_progress.json';

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG, line + '\n');
}

function telegramUpdate(progress) {
  const total = Object.keys(progress).length;
  const done = progress.done.length;
  const pct = Math.round((done / 40) * 100);
  const msg = `🦞 Philly scrape: ${done}/40 (${pct}%)`;
  execSync(`curl -s -X POST https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage -d chat_id=${process.env.TELEGRAM_CHAT_ID} -d text="${msg}"`, {stdio: 'ignore'});
}

function loadProgress() {
  try { return JSON.parse(fs.readFileSync(PROGRESS, 'utf8')); } catch { return { done: [], failed: [] }; }
}

function saveProgress(progress) {
  fs.writeFileSync(PROGRESS, JSON.stringify(progress, null, 2));
}

async function main() {
  const { data: shops } = await sb.from('shops')
    .select('name,city,state,slug')
    .eq('state', 'Pennsylvania')
    .eq('city', 'Philadelphia')
    .is('deep_scrape_at', null)
    .order('name');

  log(`\n=== Philadelphia Batch Scrape: ${shops.length} shops ===\n`);

  const progress = loadProgress();
  let succeeded = 0, failed = 0, skipped = 0;

  for (let i = 0; i < shops.length; i++) {
    const shop = shops[i];
    
    if (progress.done.includes(shop.slug)) {
      log(`[${i+1}/${shops.length}] SKIP (already done): ${shop.name}`);
      skipped++;
      continue;
    }

    log(`[${i+1}/${shops.length}] START: ${shop.name}`);
    
    try {
      execSync(
        `node master_deep_scrape.js --shop "${shop.name.replace(/"/g, '\\"')}" --city "${shop.city}" --state "${shop.state}" --skip-discovery`,
        { cwd: __dirname, timeout: 180000, stdio: ['pipe', 'pipe', 'pipe'] }
      );
      
      log(`[${i+1}/${shops.length}] ✅ DONE: ${shop.name}`);
      progress.done.push(shop.slug);
      succeeded++;
      if (progress.done.length % 10 === 0) telegramUpdate(progress);
    } catch (e) {
      const reason = e.killed ? 'TIMEOUT' : `EXIT ${e.status}`;
      log(`[${i+1}/${shops.length}] ❌ FAILED (${reason}): ${shop.name}`);
      progress.failed.push({ slug: shop.slug, name: shop.name, reason });
      failed++;
    }

    saveProgress(progress);

    // Cooldown between shops
    if (i < shops.length - 1) {
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  log(`\n=== COMPLETE ===`);
  log(`Succeeded: ${succeeded}`);
  log(`Failed: ${failed}`);
  log(`Skipped: ${skipped}`);
  log(`Total: ${shops.length}`);
}

main().catch(e => { log(`FATAL: ${e.message}`); process.exit(1); });
