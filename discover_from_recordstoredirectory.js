#!/usr/bin/env node
/**
 * RecordStoreDirectory-Based Record Shop Discovery & Enrichment
 *
 * Searches RecordStoreDirectory.com for record shops by US state, cross-references
 * with our Supabase database, backfills missing data on existing shops, and
 * inserts newly discovered shops.
 *
 * Usage:
 *   node discover_from_recordstoredirectory.js                    # Run all 50 states
 *   node discover_from_recordstoredirectory.js --limit 5          # First 5 states only
 *   node discover_from_recordstoredirectory.js --state "PA"       # Single state
 *   node discover_from_recordstoredirectory.js --dry-run          # Preview only, no DB writes
 *   node discover_from_recordstoredirectory.js --resume           # Resume from last state
 */

require('dotenv').config();

const { spawn } = require('child_process');
const { writeFileSync, readFileSync, existsSync, mkdirSync } = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const { generateSlug } = require('./lib/common');

// ── Config ──

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PROGRESS_FILE = path.join(__dirname, 'recordstoredirectory_discover_progress.json');
const RESULTS_DIR = path.join(__dirname, 'content', '_recordstoredirectory_discovery');

// ── Args ──

const args = process.argv.slice(2);
const stateLimit = args.includes('--limit') ? parseInt(args[args.indexOf('--limit') + 1]) : null;
const singleState = args.includes('--state') ? args[args.indexOf('--state') + 1] : null;
const dryRun = args.includes('--dry-run');
const resume = args.includes('--resume');

// ── US States ──

const US_STATES = {
  'alabama': 'AL', 'alaska': 'AK', 'arizona': 'AZ', 'arkansas': 'AR',
  'california': 'CA', 'colorado': 'CO', 'connecticut': 'CT', 'delaware': 'DE',
  'florida': 'FL', 'georgia': 'GA', 'hawaii': 'HI', 'idaho': 'ID',
  'illinois': 'IL', 'indiana': 'IN', 'iowa': 'IA', 'kansas': 'KS',
  'kentucky': 'KY', 'louisiana': 'LA', 'maine': 'ME', 'maryland': 'MD',
  'massachusetts': 'MA', 'michigan': 'MI', 'minnesota': 'MN', 'mississippi': 'MS',
  'missouri': 'MO', 'montana': 'MT', 'nebraska': 'NE', 'nevada': 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', 'ohio': 'OH', 'oklahoma': 'OK',
  'oregon': 'OR', 'pennsylvania': 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', 'tennessee': 'TN', 'texas': 'TX', 'utah': 'UT',
  'vermont': 'VT', 'virginia': 'VA', 'washington': 'WA', 'west virginia': 'WV',
  'wisconsin': 'WI', 'wyoming': 'WY', 'district of columbia': 'DC',
};

const ABBREV_TO_STATE = Object.fromEntries(
  Object.entries(US_STATES).map(([full, abbr]) => [abbr, full.split(' ').map(w => w[0].toUpperCase() + w.slice(1)).join(' ')])
);

// All 50 US states + DC (alphabetical by abbreviation for iteration)
const ALL_STATES = Object.keys(US_STATES).map(name => US_STATES[name]).sort();

// RecordStoreDirectory URL patterns (try all 4 in order until one works)
const RSD_URL_PATTERNS = [
  'https://recordstoredirectory.com/{state}-record-stores-directory-rsd/',
  'https://recordstoredirectory.com/{state}-record-stores/',
  'https://recordstoredirectory.com/record-stores-in-{state}/',
  'https://recordstoredirectory.com/{state}-record-stores-directory/',
];

// ── HTTP helpers ──

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchHtml(url, timeout = 12000) {
  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout,
      maxRedirects: 5,
    });
    return response.data;
  } catch (error) {
    return null;
  }
}

// ── Supabase helpers ──

async function supabaseGet(query) {
  const url = `${SUPABASE_URL}/rest/v1/shops?${query}`;
  const response = await axios.get(url, {
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
    },
  });
  return response.data;
}

async function supabaseUpdate(shopId, updates) {
  const url = `${SUPABASE_URL}/rest/v1/shops?id=eq.${shopId}`;
  await axios.patch(url, updates, {
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
    },
  });
}

async function supabaseInsert(shop) {
  const url = `${SUPABASE_URL}/rest/v1/shops`;
  const response = await axios.post(url, shop, {
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
    },
  });
  return Array.isArray(response.data) ? response.data[0] : response.data;
}

// ── Progress ──

function loadProgress() {
  try {
    if (existsSync(PROGRESS_FILE)) return JSON.parse(readFileSync(PROGRESS_FILE, 'utf8'));
  } catch (e) { /* ignore */ }
  return { completedStates: [], stats: { updated: 0, inserted: 0, skipped: 0 } };
}

function saveProgress(progress) {
  writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

// ── RecordStoreDirectory scraper ──

async function searchRecordStoreDirectory(stateAbbr) {
  // Convert state abbreviation to full name and create slug
  const stateName = ABBREV_TO_STATE[stateAbbr] || '';
  if (!stateName) {
    console.log(`  ⚠️  Unknown state abbreviation: ${stateAbbr}`);
    return [];
  }

  const stateSlug = stateName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  // Try all 4 URL patterns until one returns HTML
  let html = null;
  let foundUrl = null;

  for (const pattern of RSD_URL_PATTERNS) {
    const url = pattern.replace('{state}', stateSlug);
    console.log(`  🔍 Trying: ${url}`);
    html = await fetchHtml(url);
    if (html) {
      foundUrl = url;
      console.log(`  ✅ Fetched: ${url}`);
      break;
    }
    await sleep(500); // Brief pause between attempts
  }

  if (!html) {
    console.log(`  ❌ No page found for ${stateName} (tried all 4 URL patterns)`);
    return [];
  }

  const $ = cheerio.load(html);
  const shops = [];
  const seen = new Set();

  function addShop(name, city, address, phone, website) {
    const key = `${name.toLowerCase()}|${(city || '').toLowerCase()}`;
    if (seen.has(key) || !name) return;
    seen.add(key);

    shops.push({
      name: name.trim(),
      city: city || null,
      state: stateName,
      address: address || null,
      phone: phone || null,
      website: website || null,
      slug: generateSlug(name, city, stateName),
    });
  }

  // Pass 1: JSON-LD LocalBusiness blocks
  $('script[type="application/ld+json"]').each((i, elem) => {
    try {
      const scriptContent = $(elem).html();
      if (!scriptContent) return;

      const data = JSON.parse(scriptContent);
      const entries = data['@graph'] ? data['@graph'] : (Array.isArray(data) ? data : [data]);

      for (const entry of Array.isArray(entries) ? entries : [entries]) {
        const btype = entry['@type'] || '';
        if (!['LocalBusiness', 'Store', 'Music'].some(t => btype.includes(t))) continue;

        const name = (entry.name || '').trim();
        if (!name) continue;

        const addr = entry.address || {};
        const street = (addr.streetAddress || '').trim();
        const locality = (addr.addressLocality || '').trim();
        const phone = (entry.telephone || '').trim();
        const website = (entry.url || '').trim();

        addShop(name, locality, street, phone, website);
      }
    } catch (e) {
      // Skip malformed JSON-LD
    }
  });

  // Pass 2: plain HTML links + adjacent text (fallback / supplements JSON-LD)
  if (shops.length === 0) {
    console.log(`  ℹ️  No JSON-LD found, falling back to HTML link parsing`);

    const phoneRe = /\(?\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4}/;
    const urlRe = /https?:\/\/[^\s"<>]+|www\.[^\s"<>]+/;

    $('a[href]').each((i, elem) => {
      const href = $(elem).attr('href');
      const name = $(elem).text().trim();

      if (!name || name.length > 80) return;

      // Skip navigation and non-shop links
      if (href.includes('recordstoredirectory.com') ||
          href.includes('#') ||
          href.includes('mailto:') ||
          href.includes('tel:')) {
        return;
      }

      // Grab surrounding text for phone/address context
      const parent = $(elem).parent();
      const parentText = parent.text();

      const phoneMatch = parentText.match(phoneRe);
      const phone = phoneMatch ? phoneMatch[0] : null;
      const website = href.startsWith('http') ? href : null;

      addShop(name, null, null, phone, website);
    });
  }

  console.log(`  📊 RecordStoreDirectory: ${shops.length} shops for ${stateName}`);
  return shops;
}

// ── Matching logic ──

function normalizeForMatch(name) {
  return name
    .toLowerCase()
    .replace(/[''`]/g, '')
    .replace(/&/g, 'and')
    .replace(/\b(records?|vinyl|music|shop|store|the|llc|inc)\b/g, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

function findExistingMatch(rsdShop, existingShops) {
  const rsdNorm = normalizeForMatch(rsdShop.name);
  if (!rsdNorm) return null;

  // Try exact normalized match first
  for (const shop of existingShops) {
    const shopNorm = normalizeForMatch(shop.name);
    if (rsdNorm === shopNorm) return shop;
  }

  // Try substring match (one contains the other)
  for (const shop of existingShops) {
    const shopNorm = normalizeForMatch(shop.name);
    if (shopNorm.length > 3 && rsdNorm.length > 3) {
      if (rsdNorm.includes(shopNorm) || shopNorm.includes(rsdNorm)) return shop;
    }
  }

  // Try phone match
  if (rsdShop.phone) {
    const rsdPhone = rsdShop.phone.replace(/\D/g, '').slice(-10);
    for (const shop of existingShops) {
      if (shop.phone) {
        const shopPhone = shop.phone.replace(/\D/g, '').slice(-10);
        if (rsdPhone === shopPhone && rsdPhone.length === 10) return shop;
      }
    }
  }

  // Try address match
  if (rsdShop.address) {
    const rsdAddr = rsdShop.address.toLowerCase().replace(/[^a-z0-9]/g, '');
    for (const shop of existingShops) {
      if (shop.address) {
        const shopAddr = shop.address.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (rsdAddr.substring(0, 15) === shopAddr.substring(0, 15) && rsdAddr.length > 10) return shop;
      }
    }
  }

  return null;
}

function buildUpdatePayload(existing, rsdData) {
  const updates = {};

  // Only backfill null/empty fields — never overwrite existing data
  if (!existing.phone && rsdData.phone) updates.phone = rsdData.phone;
  if (!existing.website && rsdData.website) updates.website = rsdData.website;
  if (!existing.address && rsdData.address) updates.address = rsdData.address;
  if (!existing.city && rsdData.city) updates.city = rsdData.city;
  if (!existing.state && rsdData.state) updates.state = rsdData.state;

  return updates;
}

// ── Main ──

async function processState(stateAbbr, existingShops) {
  console.log(`\n🏛️  ${stateAbbr} (${ABBREV_TO_STATE[stateAbbr] || stateAbbr})`);
  console.log('─'.repeat(50));

  const rsdResults = await searchRecordStoreDirectory(stateAbbr);

  if (rsdResults.length === 0) {
    console.log('  ❌ No results found');
    return { searched: 0, matched: 0, updated: 0, inserted: 0, skipped: 0, candidates: [] };
  }

  let matched = 0, updated = 0, inserted = 0, skipped = 0;

  for (const shop of rsdResults) {
    const existing = findExistingMatch(shop, existingShops);

    if (existing) {
      matched++;
      const updates = buildUpdatePayload(existing, shop);

      if (Object.keys(updates).length > 0) {
        if (!dryRun) {
          try {
            await supabaseUpdate(existing.id, updates);
            console.log(`  ✏️  Updated: ${existing.name} → +${Object.keys(updates).join(', ')}`);
          } catch (e) {
            console.log(`  ⚠️  Update failed for ${existing.name}: ${e.message}`);
          }
        } else {
          console.log(`  ✏️  [DRY] Would update: ${existing.name} → +${Object.keys(updates).join(', ')}`);
        }
        updated++;
      } else {
        skipped++;
      }
    } else {
      // New shop — insert
      if (!dryRun) {
        try {
          const result = await supabaseInsert(shop);
          console.log(`  ➕ Inserted: ${shop.name} (${shop.city || '?'}, ${shop.state})`);
          existingShops.push({ ...shop, id: result.id || 'new' });
        } catch (e) {
          console.log(`  ⚠️  Insert failed for ${shop.name}: ${e.message}`);
        }
      } else {
        console.log(`  ➕ [DRY] Would insert: ${shop.name} (${shop.city || '?'}, ${shop.state})`);
      }
      inserted++;
    }
  }

  console.log(`  📊 State total: ${rsdResults.length} shops — ${matched} matched, ${updated} updated, ${inserted} new, ${skipped} unchanged`);

  return { searched: rsdResults.length, matched, updated, inserted, skipped, candidates: rsdResults };
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║  🔍 RecordStoreDirectory Record Shop Discovery         ║');
  console.log('╚══════════════════════════════════════════════════════════╝');

  if (dryRun) console.log('⚠️  DRY RUN — no database writes\n');

  // Load all existing shops for matching
  console.log('📡 Loading existing shops from Supabase...');
  const existingShops = await supabaseGet('select=id,name,city,state,phone,address,website&limit=2000');
  console.log(`📊 Loaded ${existingShops.length} existing shops\n`);

  const progress = loadProgress();

  // Build state list
  let states = singleState ? [singleState.toUpperCase()] : ALL_STATES;
  if (resume) {
    states = states.filter(s => !progress.completedStates.includes(s));
    console.log(`📍 Resuming — ${states.length} states remaining\n`);
  }
  if (stateLimit) states = states.slice(0, stateLimit);

  console.log(`📍 Processing ${states.length} states...\n`);

  // Create results directory
  if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, { recursive: true });

  const totals = { searched: 0, matched: 0, updated: 0, inserted: 0, skipped: 0, states: 0 };
  const allCandidates = [];

  for (const state of states) {
    const result = await processState(state, existingShops);

    totals.searched += result.searched;
    totals.matched += result.matched;
    totals.updated += result.updated;
    totals.inserted += result.inserted;
    totals.skipped += result.skipped;
    totals.states++;
    if (result.candidates) allCandidates.push(...result.candidates);

    progress.completedStates.push(state);
    progress.stats = totals;
    if (!dryRun) saveProgress(progress);

    // Rate limit between states
    await sleep(2000);
  }

  // Save full results
  const today = new Date().toISOString().split('T')[0];
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5) + 'Z';
  const reportPath = path.join(RESULTS_DIR, `${timestamp}.json`);
  writeFileSync(reportPath, JSON.stringify({ date: today, totals, progress, candidates: allCandidates }, null, 2));

  // Summary
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║  📊 Discovery Summary                                   ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`  States searched:  ${totals.states}`);
  console.log(`  RSD results:      ${totals.searched}`);
  console.log(`  Matched existing: ${totals.matched}`);
  console.log(`  Data backfilled:  ${totals.updated}`);
  console.log(`  New shops added:  ${totals.inserted}`);
  console.log(`  Unchanged:        ${totals.skipped}`);
  console.log(`\n  Report: ${reportPath}`);
}

main().catch(err => {
  console.error('💀 Fatal error:', err.message);
  process.exit(1);
});
