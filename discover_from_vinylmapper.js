#!/usr/bin/env node
/**
 * VinylMapper-Based Record Shop Discovery
 *
 * VinylMapper publishes city-specific record store guides at predictable URLs.
 * Extracts shop names, addresses, descriptions from curated guides.
 *
 * Usage:
 *   node discover_from_vinylmapper.js                         # Batch discovery (all cities)
 *   node discover_from_vinylmapper.js --limit 5               # First 5 cities only
 *   node discover_from_vinylmapper.js --city "Austin, TX"     # Single city
 *   node discover_from_vinylmapper.js --dry-run               # Preview only, no DB writes
 *   node discover_from_vinylmapper.js --resume                # Resume from last city
 */

require('dotenv').config();
const axios = require('axios');
const cheerio = require('cheerio');
const { writeFileSync, readFileSync, existsSync, mkdirSync } = require('fs');
const path = require('path');
const { generateSlug } = require('./lib/common');

// ── Supabase setup ──
const { createClient } = require('@supabase/supabase-js');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ SUPABASE_URL or SUPABASE_SERVICE_KEY missing from .env');
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Config ──
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PROGRESS_FILE = path.join(__dirname, 'vinylmapper_discover_progress.json');
const RESULTS_DIR = path.join(__dirname, 'content', '_vinylmapper_discovery');

// ── Args ──
const args = process.argv.slice(2);
const cityLimit = args.includes('--limit') ? parseInt(args[args.indexOf('--limit') + 1]) : null;
const singleCity = args.includes('--city') ? args[args.indexOf('--city') + 1] : null;
const dryRun = args.includes('--dry-run');
const resume = args.includes('--resume');

// ── Top cities for VinylMapper ──
const TOP_CITIES = [
  'New York, NY', 'Los Angeles, CA', 'Chicago, IL', 'Houston, TX', 'Phoenix, AZ',
  'Philadelphia, PA', 'San Antonio, TX', 'San Diego, CA', 'Dallas, TX', 'Austin, TX',
  'Jacksonville, FL', 'San Jose, CA', 'Fort Worth, TX', 'Columbus, OH', 'Charlotte, NC',
  'Indianapolis, IN', 'San Francisco, CA', 'Seattle, WA', 'Denver, CO', 'Nashville, TN',
  'Washington, DC', 'Oklahoma City, OK', 'El Paso, TX', 'Boston, MA', 'Portland, OR',
  'Las Vegas, NV', 'Memphis, TN', 'Louisville, KY', 'Baltimore, MD', 'Milwaukee, WI',
  'Albuquerque, NM', 'Tucson, AZ', 'Fresno, CA', 'Sacramento, CA', 'Mesa, AZ',
  'Kansas City, MO', 'Atlanta, GA', 'Omaha, NE', 'Colorado Springs, CO', 'Raleigh, NC',
  'Long Beach, CA', 'Virginia Beach, VA', 'Miami, FL', 'Oakland, CA', 'Minneapolis, MN',
  'Tampa, FL', 'Tulsa, OK', 'Arlington, TX', 'New Orleans, LA', 'Cleveland, OH',
  'Brooklyn, NY', 'Detroit, MI', 'Pittsburgh, PA', 'St. Louis, MO', 'Cincinnati, OH',
  'Richmond, VA', 'Salt Lake City, UT', 'Asheville, NC', 'Burlington, VT', 'Savannah, GA',
];

// ── HTTP helpers ──
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function httpGet(url, timeout = 12000) {
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
    console.log(`    ⚠️  GET failed ${url}: ${error.message}`);
    return null;
  }
}

// ── Progress management ──
function loadProgress() {
  try {
    if (existsSync(PROGRESS_FILE)) return JSON.parse(readFileSync(PROGRESS_FILE, 'utf8'));
  } catch (e) { /* ignore */ }
  return { completedCities: [], stats: { updated: 0, inserted: 0, skipped: 0 } };
}

function saveProgress(progress) {
  writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

// ── Matching helpers ──
function normalizeForMatch(name) {
  return name
    .toLowerCase()
    .replace(/[''`]/g, '')
    .replace(/&/g, 'and')
    .replace(/\b(records?|vinyl|music|shop|store|the|llc|inc|co)\b/g, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

async function findExistingShop(name, city) {
  const normName = normalizeForMatch(name);
  if (!normName || normName.length < 2) return null;

  // Query shops in the same city
  const { data: candidates, error } = await supabase
    .from('shops')
    .select('id, name, city, state, address, phone, website, hours, description')
    .ilike('city', city);

  if (error) throw error;
  if (!candidates || candidates.length === 0) return null;

  // Try exact normalized match
  for (const shop of candidates) {
    const shopNorm = normalizeForMatch(shop.name);
    if (normName === shopNorm) return shop;
  }

  // Try substring match
  for (const shop of candidates) {
    const shopNorm = normalizeForMatch(shop.name);
    if (shopNorm.length > 3 && normName.length > 3) {
      if (normName.includes(shopNorm) || shopNorm.includes(normName)) return shop;
    }
  }

  return null;
}

// ── VinylMapper scraping logic (ported from Python) ──

// Replicate _STOP_WORDS from Python
const STOP_WORDS = new Set([
  'why it\'s one of', 'getting there', 'table of contents', 'see also',
  'conclusion', 'introduction', 'about', 'faq', 'faqs', 'newsletter',
  'related articles', 'trending articles', 'join the', 'leave a reply',
  'cancel reply', 'share your sound', 'sign up', 'subscribe', 'contact us',
  'hours', 'location', 'directions', 'overview', 'summary', 'features',
  'videos', 'images', 'gallery', 'map', 'comments', 'tags', 'categories',
  'archives', 'sidebar', 'search', 'menu', 'navigation', 'footer',
  'local hotspots', 'get into the groove', 'happy crate digging',
  'final thoughts', 'our recommendations', 'honorable mentions',
  'worth a visit', 'also worth checking out', 'more options',
  'moose vinyl llc', 'hard stop records', 'vinylmapper',
]);

// Replicate _STOP_PREFIXES from Python
const STOP_PREFIXES = [
  'why ', 'how ', 'what ', 'the best', 'best record', 'top 10', 'top 5',
  'ultimate', 'where to', 'in ', 'near ', 'around ', 'guide to',
  'all about', 'a list', 'our pick', 'editor', 'get into', 'also check',
  'for more', 'if you', 'you can', 'this is', 'these are',
  'a guide', 'an intro', 'london\'s best', 'new york\'s best',
  'chicago\'s best', 'los angeles', 'san francisco',
];

function isLikelyShopName(name, city) {
  if (name.length < 3 || name.length > 60) return false;
  const nameLower = name.toLowerCase();
  if (STOP_WORDS.has(nameLower)) return false;
  if (STOP_PREFIXES.some(prefix => nameLower.startsWith(prefix))) return false;
  // Headings that are sentences (contain too many spaces relative to length)
  const wordCount = name.split(/\s+/).length;
  if (wordCount > 7) return false;
  return true;
}

async function searchVinylmapper(city) {
  // Build URL slug from city
  let citySlug = city.toLowerCase().trim();
  citySlug = citySlug.replace(/[,\s]+/g, '-');
  citySlug = citySlug.replace(/[^a-z0-9\-]/g, '');

  // Try multiple URL patterns
  let url = `https://www.vinylmapper.com/${citySlug}-best-record-stores/`;
  let html = await httpGet(url);

  if (!html) {
    // Try without "best-record-stores" suffix
    url = `https://www.vinylmapper.com/${citySlug}-record-stores/`;
    html = await httpGet(url);
  }

  if (!html) {
    console.log(`    VinylMapper: no page found for ${city}`);
    return [];
  }

  const $ = cheerio.load(html);
  const content = $('.entry-content');
  if (!content.length) return [];

  const shops = [];
  const children = content.children().toArray();

  let i = 0;
  while (i < children.length) {
    const child = children[i];
    if (child.name === 'h2') {
      const name = $(child).text().trim();
      if (!name || name.length > 80 || !isLikelyShopName(name, city)) {
        i++;
        continue;
      }

      let description = null;
      let address = null;
      let website = null;

      // Scan following siblings until next h2
      let j = i + 1;
      while (j < children.length && children[j].name !== 'h2') {
        const sib = children[j];
        const sibText = $(sib).text().trim();

        if (sib.name === 'h4' && sibText.toLowerCase().includes('getting there')) {
          // Next <p> is the address
          if (j + 1 < children.length) {
            address = $(children[j + 1]).text().trim().substring(0, 200);
            j += 1;
          }
        } else if (sib.name === 'p' && !description && sibText && sibText.length > 30) {
          description = sibText.substring(0, 300);
        }

        // Links inside paragraphs — pick the first external one
        if (!website) {
          const links = $(sib).find('a[href]');
          for (let link of links) {
            const href = $(link).attr('href');
            if (href && href.startsWith('http') && !href.includes('vinylmapper')) {
              website = href;
              break;
            }
          }
        }
        j++;
      }

      shops.push({ name, city, address, description, website });
    }
    i++;
  }

  console.log(`    VinylMapper: ${shops.length} shops for ${city}`);
  return shops;
}

// ── Shop data conversion ──
function buildShopRecord(vmShop, cityStr) {
  const [cityName, stateAbbr] = cityStr.split(', ');
  const stateMap = {
    'AL': 'Alabama', 'AK': 'Alaska', 'AZ': 'Arizona', 'AR': 'Arkansas', 'CA': 'California',
    'CO': 'Colorado', 'CT': 'Connecticut', 'DC': 'District of Columbia', 'DE': 'Delaware',
    'FL': 'Florida', 'GA': 'Georgia', 'HI': 'Hawaii', 'ID': 'Idaho', 'IL': 'Illinois',
    'IN': 'Indiana', 'IA': 'Iowa', 'KS': 'Kansas', 'KY': 'Kentucky', 'LA': 'Louisiana',
    'ME': 'Maine', 'MD': 'Maryland', 'MA': 'Massachusetts', 'MI': 'Michigan', 'MN': 'Minnesota',
    'MS': 'Mississippi', 'MO': 'Missouri', 'MT': 'Montana', 'NE': 'Nebraska', 'NV': 'Nevada',
    'NH': 'New Hampshire', 'NJ': 'New Jersey', 'NM': 'New Mexico', 'NY': 'New York',
    'NC': 'North Carolina', 'ND': 'North Dakota', 'OH': 'Ohio', 'OK': 'Oklahoma',
    'OR': 'Oregon', 'PA': 'Pennsylvania', 'RI': 'Rhode Island', 'SC': 'South Carolina',
    'SD': 'South Dakota', 'TN': 'Tennessee', 'TX': 'Texas', 'UT': 'Utah', 'VT': 'Vermont',
    'VA': 'Virginia', 'WA': 'Washington', 'WV': 'West Virginia', 'WI': 'Wisconsin', 'WY': 'Wyoming',
  };

  const record = {
    name: vmShop.name,
    city: cityName,
    state: stateMap[stateAbbr] || stateAbbr,
    slug: generateSlug(vmShop.name, cityName, stateMap[stateAbbr] || stateAbbr),
  };

  if (vmShop.address) record.address = vmShop.address;
  if (vmShop.website) record.website = vmShop.website;
  if (vmShop.description) record.description = vmShop.description;

  return record;
}

function buildUpdatePayload(existing, vmData) {
  const updates = {};

  // Only backfill null/empty fields — never overwrite existing data
  if (!existing.website && vmData.website) updates.website = vmData.website;
  if (!existing.address && vmData.address) updates.address = vmData.address;
  if (!existing.description && vmData.description) updates.description = vmData.description;

  return updates;
}

// ── Main city processor ──
async function processCity(cityStr, progress) {
  console.log(`\n🏙️  ${cityStr}`);
  console.log('─'.repeat(50));

  const vmResults = await searchVinylmapper(cityStr);

  if (vmResults.length === 0) {
    console.log('  ❌ No results found');
    return { searched: 0, matched: 0, updated: 0, inserted: 0, skipped: 0, candidates: [] };
  }

  let matched = 0, updated = 0, inserted = 0, skipped = 0;

  for (const vmShop of vmResults) {
    const vmData = buildShopRecord(vmShop, cityStr);
    const existing = await findExistingShop(vmShop.name, vmShop.city);

    if (existing) {
      matched++;
      const updates = buildUpdatePayload(existing, vmData);

      if (Object.keys(updates).length > 0) {
        if (!dryRun) {
          try {
            const { error } = await supabase.from('shops').update(updates).eq('id', existing.id);
            if (error) throw error;
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
          const { data, error } = await supabase.from('shops').insert(vmData).select();
          if (error) throw error;
          console.log(`  ➕ Inserted: ${vmData.name} (${vmData.city}, ${vmData.state})`);
        } catch (e) {
          console.log(`  ⚠️  Insert failed for ${vmData.name}: ${e.message}`);
        }
      } else {
        console.log(`  ➕ [DRY] Would insert: ${vmData.name} (${vmData.city || '?'}, ${vmData.state || '?'})`);
      }
      inserted++;
    }
  }

  console.log(`  📊 City total: ${vmResults.length} shops — ${matched} matched, ${updated} updated, ${inserted} new, ${skipped} unchanged`);

  return { searched: vmResults.length, matched, updated, inserted, skipped, candidates: vmResults.map(s => ({ ...s, city: cityStr })) };
}

// ── Main entry ──
async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║  🗺️  VinylMapper Record Shop Discovery                  ║');
  console.log('╚══════════════════════════════════════════════════════════╝');

  if (dryRun) console.log('⚠️  DRY RUN — no database writes\n');

  const progress = loadProgress();

  // Build city list
  let cities = singleCity ? [singleCity] : TOP_CITIES;
  if (resume) {
    cities = cities.filter(c => !progress.completedCities.includes(c));
    console.log(`📍 Resuming — ${cities.length} cities remaining\n`);
  }
  if (cityLimit) cities = cities.slice(0, cityLimit);

  console.log(`📍 Processing ${cities.length} cities...\n`);

  // Create results directory
  if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, { recursive: true });

  const totals = { searched: 0, matched: 0, updated: 0, inserted: 0, skipped: 0, cities: 0 };
  const allCandidates = [];

  for (const city of cities) {
    const result = await processCity(city, progress);

    totals.searched += result.searched;
    totals.matched += result.matched;
    totals.updated += result.updated;
    totals.inserted += result.inserted;
    totals.skipped += result.skipped;
    totals.cities++;
    if (result.candidates) allCandidates.push(...result.candidates);

    progress.completedCities.push(city);
    progress.stats = totals;
    if (!dryRun) saveProgress(progress);

    // Rate limit between cities
    await sleep(2000);
  }

  // Save full results
  const today = new Date().toISOString().split('T')[0];
  const reportPath = path.join(RESULTS_DIR, `${today}.json`);
  writeFileSync(reportPath, JSON.stringify({ date: today, totals, progress, candidates: allCandidates }, null, 2));

  // Summary
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║  📊 Discovery Summary                                   ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`  Cities searched: ${totals.cities}`);
  console.log(`  VinylMapper results: ${totals.searched}`);
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
