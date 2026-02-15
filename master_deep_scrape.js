#!/usr/bin/env node
/**
 * Master Deep Scrape Orchestrator
 * 
 * Runs all deep scrapers in sequence for a shop or list of shops.
 * Handles errors gracefully, logs progress, supports resume.
 * 
 * Usage:
 *   node master_deep_scrape.js --shop "Shady Dog" --city "Berwyn" --state "PA"
 *   node master_deep_scrape.js --shop-id "uuid"
 *   node master_deep_scrape.js --all --limit 50
 *   node master_deep_scrape.js --all --limit 50 --resume
 *   node master_deep_scrape.js --all --limit 50 --skip-yelp --skip-google  # skip specific scrapers
 */

const { delay, saveJSON, loadJSON, contentDir, getAllShops, getShopByName,
  createStealthBrowser, parseArgs, log, ensureDir } = require('./lib/common');
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

const PROGRESS_FILE = path.join(__dirname, 'deep_scrape_progress.json');

function loadProgress() {
  return loadJSON(PROGRESS_FILE) || { completed: {}, lastRun: null };
}

function saveProgress(progress) {
  progress.lastRun = new Date().toISOString();
  saveJSON(PROGRESS_FILE, progress);
}

async function runScript(scriptName, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [path.join(__dirname, scriptName), ...args], {
      cwd: __dirname,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
      timeout: 300000, // 5 min timeout per script
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
    
    proc.on('close', code => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${scriptName} exited with code ${code}: ${stderr.slice(-500)}`));
    });

    proc.on('error', reject);
  });
}

async function deepScrapeShop(shop, args) {
  const results = {
    shopId: shop.id,
    shopName: shop.name,
    city: shop.city,
    state: shop.state,
    startedAt: new Date().toISOString(),
    scrapers: {},
  };

  const scrapers = [
    {
      name: 'yelp',
      skip: args['skip-yelp'],
      run: async () => {
        if (shop.yelp_url) {
          await runScript('deep_scrape_yelp.js', ['--shop-id', shop.id]);
        } else {
          log('  No Yelp URL, searching by city...');
          await runScript('deep_scrape_yelp.js', ['--city', `${shop.city}, ${shop.state}`, '--limit', '1']);
        }
      }
    },
    {
      name: 'google',
      skip: args['skip-google'],
      run: async () => {
        await runScript('deep_scrape_google.js', ['--shop', shop.name, '--city', shop.city, '--state', shop.state]);
      }
    },
    {
      name: 'website',
      skip: args['skip-website'],
      run: async () => {
        if (!shop.website || shop.website.includes('yelp.com') || shop.website.includes('facebook.com')) {
          log('  No real website URL, skipping website crawl');
          return;
        }
        await runScript('scrape_shop_website.js', ['--url', shop.website, '--shop-id', shop.id, '--shop-name', shop.name]);
      }
    },
    {
      name: 'socials',
      skip: args['skip-socials'],
      run: async () => {
        await runScript('discover_socials.js', ['--shop-id', shop.id]);
        // Refresh shop data so instagram scraper can use newly discovered handles
        const { data } = await supabase.from('shops').select('*').eq('id', shop.id).single();
        if (data) Object.assign(shop, data);
      }
    },
    {
      name: 'instagram',
      skip: args['skip-instagram'],
      run: async () => {
        if (!shop.social_instagram) {
          log('  No Instagram handle, skipping');
          return;
        }
        await runScript('scrape_instagram_deep.js', ['--handle', shop.social_instagram, '--shop-id', shop.id]);
      }
    },
    {
      name: 'events',
      skip: args['skip-events'],
      run: async () => {
        await runScript('discover_events.js', ['--shop-id', shop.id]);
      }
    },
    {
      name: 'reviews',
      skip: args['skip-reviews'],
      run: async () => {
        // Only run if we have reviews to analyze
        const yelpExists = fs.existsSync(contentDir(shop.id, 'reviews', 'yelp_reviews.json'));
        const googleExists = fs.existsSync(contentDir(shop.id, 'reviews', 'google_reviews.json'));
        if (!yelpExists && !googleExists) {
          log('  No reviews to analyze, skipping');
          return;
        }
        await runScript('summarize_reviews.js', ['--shop-id', shop.id]);
      }
    },
  ];

  for (const scraper of scrapers) {
    if (scraper.skip) {
      log(`  ⏭ Skipping ${scraper.name}`);
      results.scrapers[scraper.name] = { status: 'skipped' };
      continue;
    }

    log(`\n  ▶ Running ${scraper.name} scraper...`);
    const start = Date.now();

    try {
      await scraper.run();
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      results.scrapers[scraper.name] = { status: 'success', elapsed: `${elapsed}s` };
      log(`  ✓ ${scraper.name} completed in ${elapsed}s`);
    } catch (e) {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      results.scrapers[scraper.name] = { status: 'error', error: e.message, elapsed: `${elapsed}s` };
      log(`  ✗ ${scraper.name} failed (${elapsed}s): ${e.message}`);
    }

    // Rate limit between scrapers
    await delay(2000, 4000);
  }

  results.completedAt = new Date().toISOString();
  
  // Save results summary
  const summaryPath = contentDir(shop.id, 'deep_scrape_summary.json');
  saveJSON(summaryPath, results);

  return results;
}

async function run() {
  const args = parseArgs();
  
  log('╔══════════════════════════════════════════════════════════╗');
  log('║     Master Deep Scrape Orchestrator                      ║');
  log('╚══════════════════════════════════════════════════════════╝');

  if (args.shop && args.city && args.state) {
    // Single shop by name
    const shops = await getShopByName(args.shop, args.city, args.state);
    if (!shops || shops.length === 0) {
      log(`Shop "${args.shop}" not found in Supabase. Searching as-is...`);
      // Create a minimal shop object
      const shop = { id: 'manual', name: args.shop, city: args.city, state: args.state };
      await deepScrapeShop(shop, args);
      return;
    }

    const shop = shops[0];
    log(`\nFound shop: ${shop.name} (${shop.city}, ${shop.state})`);
    log(`ID: ${shop.id}`);
    log(`Website: ${shop.website || 'none'}`);
    log(`Yelp: ${shop.yelp_url || 'none'}`);
    log(`Instagram: ${shop.social_instagram || 'none'}`);
    
    const results = await deepScrapeShop(shop, args);
    
    log('\n═══ Summary ═══');
    for (const [name, result] of Object.entries(results.scrapers)) {
      const icon = result.status === 'success' ? '✓' : result.status === 'skipped' ? '⏭' : '✗';
      log(`  ${icon} ${name}: ${result.status} ${result.elapsed || ''}`);
    }
    return;
  }

  if (args['shop-id']) {
    const { supabase } = require('./lib/common');
    const { data: shop } = await supabase.from('shops').select('*').eq('id', args['shop-id']).single();
    if (!shop) { log('Shop not found'); return; }
    
    await deepScrapeShop(shop, args);
    return;
  }

  if (args.all) {
    const limit = parseInt(args.limit) || 50;
    const shops = await getAllShops(limit);
    const progress = args.resume ? loadProgress() : { completed: {} };
    let processed = 0, errors = 0;

    log(`\nProcessing ${shops.length} shops (${Object.keys(progress.completed).length} already done)`);

    for (const shop of shops) {
      if (args.resume && progress.completed[shop.id]) {
        log(`⏭ Skipping ${shop.name} (already completed)`);
        continue;
      }

      log(`\n${'═'.repeat(60)}`);
      log(`Shop ${processed + 1}/${shops.length}: ${shop.name} (${shop.city}, ${shop.state})`);
      log('═'.repeat(60));

      try {
        const results = await deepScrapeShop(shop, args);
        
        const successCount = Object.values(results.scrapers).filter(s => s.status === 'success').length;
        const errorCount = Object.values(results.scrapers).filter(s => s.status === 'error').length;
        
        progress.completed[shop.id] = {
          name: shop.name,
          completedAt: new Date().toISOString(),
          success: successCount,
          errors: errorCount,
        };
        saveProgress(progress);
        
        processed++;
        log(`\n✓ ${shop.name}: ${successCount} scrapers succeeded, ${errorCount} failed`);
      } catch (e) {
        errors++;
        log(`\n✗ ${shop.name}: Fatal error — ${e.message}`);
      }

      // Longer delay between shops
      await delay(5000, 10000);
    }

    log(`\n${'═'.repeat(60)}`);
    log(`COMPLETE: ${processed} shops processed, ${errors} fatal errors`);
    log(`Progress saved to ${PROGRESS_FILE}`);
  }
}

run().catch(e => { console.error(e); process.exit(1); });
