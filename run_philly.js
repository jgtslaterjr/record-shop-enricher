#!/usr/bin/env node
require('dotenv').config();
const { spawn } = require('child_process');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const SCRIPT = path.join(__dirname, 'master_deep_scrape.js');

function runShop(name, city, state) {
  return new Promise((resolve) => {
    const proc = spawn('node', [
      SCRIPT, '--shop', name, '--city', city, '--state', state, '--skip-google'
    ], {
      cwd: __dirname,
      stdio: ['ignore', 'inherit', 'inherit'],
      detached: true, // own process group
    });

    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        try { process.kill(-proc.pid, 'SIGKILL'); } catch {}
        resolve({ ok: false, reason: 'TIMEOUT' });
      }
    }, 180000);

    proc.on('close', (code) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve(code === 0 ? { ok: true } : { ok: false, reason: `exit ${code}` });
      }
    });

    proc.on('error', (e) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve({ ok: false, reason: e.message });
      }
    });
  });
}

function cleanup() {
  try {
    require('child_process').execSync('pkill -9 -f chrome-headless-shell 2>/dev/null || true');
  } catch {}
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const startTime = Date.now();
  
  const { data: shops } = await sb
    .from('shops')
    .select('name,city,state')
    .eq('state', 'Pennsylvania')
    .eq('city', 'Philadelphia')
    .is('deep_scrape_at', null)
    .order('name');

  console.log(`Found ${shops.length} Philadelphia shops to scrape\n`);

  const results = [];

  for (let i = 0; i < shops.length; i++) {
    const { name, city, state } = shops[i];
    console.log(`\n[${i + 1}/${shops.length}] ${name}`);

    const result = await runShop(name, city, state);
    console.log(`  -> ${result.ok ? 'OK' : 'FAIL: ' + result.reason}`);
    results.push({ name, ...result });

    cleanup();

    if (i < shops.length - 1) await sleep(10000);
  }

  const elapsed = Math.round((Date.now() - startTime) / 60000);
  const ok = results.filter(r => r.ok).length;
  const fail = results.filter(r => !r.ok);
  
  console.log(`\n${'='.repeat(50)}`);
  console.log(`DONE: ${ok} succeeded, ${fail.length} failed, ${elapsed} min`);
  if (fail.length) {
    fail.forEach(f => console.log(`  FAIL: ${f.name} (${f.reason})`));
  }
  
  process.exit(0);
}

main();
