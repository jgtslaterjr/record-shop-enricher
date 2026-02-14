#!/usr/bin/env node
/**
 * Yelp-Based Record Shop Discovery & Enrichment
 * 
 * Searches Yelp for record shops in top US cities, cross-references with
 * our Supabase database, backfills missing data on existing shops, and
 * inserts newly discovered shops.
 *
 * Usage:
 *   node discover_from_yelp.js                         # Run all 50 cities
 *   node discover_from_yelp.js --limit 5               # First 5 cities only
 *   node discover_from_yelp.js --city "Austin, TX"     # Single city
 *   node discover_from_yelp.js --dry-run               # Preview only, no DB writes
 *   node discover_from_yelp.js --resume                 # Resume from last city
 *   node discover_from_yelp.js --api                    # Force Yelp Fusion API
 *   node discover_from_yelp.js --scrape                 # Force web scraping
 *
 * Requires: YELP_API_KEY in .env for API mode (500 calls/day free tier).
 * Falls back to web scraping if no API key.
 */

const { spawn } = require('child_process');
const { writeFileSync, readFileSync, existsSync, mkdirSync } = require('fs');
const path = require('path');

// ── Config ──

const SUPABASE_URL = "https://oytflcaqukxvzmbddrlg.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im95dGZsY2FxdWt4dnptYmRkcmxnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY5NTIwMjQsImV4cCI6MjA4MjUyODAyNH0.YpFZfu2BPxwXxXz5j-xqgu7VdIuTP315eiS3UuLD2wo";
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PROGRESS_FILE = path.join(__dirname, 'yelp_discover_progress.json');
const RESULTS_DIR = path.join(__dirname, 'content', '_yelp_discovery');

// Load .env
try {
  const envPath = path.join(__dirname, '.env');
  if (existsSync(envPath)) {
    readFileSync(envPath, 'utf8').split('\n').forEach(line => {
      const [key, ...vals] = line.split('=');
      if (key && !key.startsWith('#')) process.env[key.trim()] = vals.join('=').trim();
    });
  }
} catch (e) { /* ignore */ }

const YELP_API_KEY = process.env.YELP_API_KEY || null;

// ── Args ──

const args = process.argv.slice(2);
const cityLimit = args.includes('--limit') ? parseInt(args[args.indexOf('--limit') + 1]) : null;
const singleCity = args.includes('--city') ? args[args.indexOf('--city') + 1] : null;
const dryRun = args.includes('--dry-run');
const resume = args.includes('--resume');
const forceApi = args.includes('--api');
const forceScrape = args.includes('--scrape');

// ── Top 50 US cities by population ──

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
  // Bonus vinyl-heavy cities
  'Brooklyn, NY', 'Detroit, MI', 'Pittsburgh, PA', 'St. Louis, MO', 'Cincinnati, OH',
  'Richmond, VA', 'Salt Lake City, UT', 'Asheville, NC', 'Burlington, VT', 'Savannah, GA',
];

// ── HTTP helpers ──

function curlFetch(url, headers = {}, options = {}) {
  return new Promise((resolve, reject) => {
    const headerArgs = Object.entries(headers).flatMap(([k, v]) => ['-H', `${k}: ${v}`]);
    const curl = spawn('curl', [
      '-sL',
      '-A', USER_AGENT,
      '--max-time', String(options.timeout || 20),
      '--max-redirs', '5',
      '-o', '-',
      ...headerArgs,
      url
    ]);

    let data = '';
    let stderr = '';
    curl.stdout.on('data', (chunk) => { data += chunk; });
    curl.stderr.on('data', (chunk) => { stderr += chunk; });
    curl.on('close', (code) => {
      if (code !== 0 && !data) reject(new Error(`curl failed (${code}): ${stderr.substring(0, 200)}`));
      else resolve(data);
    });
  });
}

function curlPost(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const headerArgs = Object.entries(headers).flatMap(([k, v]) => ['-H', `${k}: ${v}`]);
    const curl = spawn('curl', [
      '-s', '-X', 'POST',
      '-A', USER_AGENT,
      '--max-time', '20',
      ...headerArgs,
      '-d', typeof body === 'string' ? body : JSON.stringify(body),
      url
    ]);

    let data = '';
    curl.stdout.on('data', (chunk) => { data += chunk; });
    curl.on('close', (code) => {
      if (code !== 0 && !data) reject(new Error(`curl POST failed (${code})`));
      else resolve(data);
    });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Supabase helpers ──

async function supabaseGet(query) {
  const url = `${SUPABASE_URL}/rest/v1/shops?${query}`;
  const data = await curlFetch(url, {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
  });
  return JSON.parse(data);
}

async function supabaseUpdate(shopId, updates) {
  const url = `${SUPABASE_URL}/rest/v1/shops?id=eq.${shopId}`;
  const body = JSON.stringify(updates);
  return new Promise((resolve, reject) => {
    const curl = spawn('curl', [
      '-s', '-X', 'PATCH',
      '-H', `apikey: ${SUPABASE_KEY}`,
      '-H', `Authorization: Bearer ${SUPABASE_KEY}`,
      '-H', 'Content-Type: application/json',
      '-H', 'Prefer: return=minimal',
      '-d', body,
      url
    ]);
    let data = '';
    curl.stdout.on('data', (chunk) => { data += chunk; });
    curl.on('close', (code) => {
      if (code !== 0) reject(new Error(`Update failed for ${shopId}`));
      else resolve(data);
    });
  });
}

async function supabaseInsert(shop) {
  const url = `${SUPABASE_URL}/rest/v1/shops`;
  const body = JSON.stringify(shop);
  return new Promise((resolve, reject) => {
    const curl = spawn('curl', [
      '-s', '-X', 'POST',
      '-H', `apikey: ${SUPABASE_KEY}`,
      '-H', `Authorization: Bearer ${SUPABASE_KEY}`,
      '-H', 'Content-Type: application/json',
      '-H', 'Prefer: return=representation',
      '-d', body,
      url
    ]);
    let data = '';
    curl.stdout.on('data', (chunk) => { data += chunk; });
    curl.on('close', (code) => {
      try {
        const parsed = JSON.parse(data);
        if (Array.isArray(parsed) && parsed.length > 0) resolve(parsed[0]);
        else if (parsed.message || parsed.code) reject(new Error(parsed.message || data));
        else resolve(parsed);
      } catch (e) {
        if (code !== 0) reject(new Error(`Insert failed: ${data.substring(0, 200)}`));
        else resolve(data);
      }
    });
  });
}

// ── Progress ──

function loadProgress() {
  try {
    if (existsSync(PROGRESS_FILE)) return JSON.parse(readFileSync(PROGRESS_FILE, 'utf8'));
  } catch (e) { /* ignore */ }
  return { completedCities: [], apiCallsToday: 0, apiCallDate: null, stats: { updated: 0, inserted: 0, skipped: 0 } };
}

function saveProgress(progress) {
  writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

// ── Yelp Fusion API ──

async function searchYelpApi(location, offset = 0) {
  if (!YELP_API_KEY) throw new Error('No YELP_API_KEY');

  const params = new URLSearchParams({
    term: 'record store vinyl',
    location,
    categories: 'vinyl_records,musicvideo,media',
    limit: '50',
    offset: String(offset),
    sort_by: 'best_match',
  });

  const url = `https://api.yelp.com/v3/businesses/search?${params}`;
  const data = await curlFetch(url, {
    'Authorization': `Bearer ${YELP_API_KEY}`,
    'Accept': 'application/json',
  });

  const parsed = JSON.parse(data);
  if (parsed.error) throw new Error(parsed.error.description || parsed.error.code);
  return parsed;
}

async function getYelpBusinessDetails(bizId) {
  if (!YELP_API_KEY) return null;

  const url = `https://api.yelp.com/v3/businesses/${bizId}`;
  const data = await curlFetch(url, {
    'Authorization': `Bearer ${YELP_API_KEY}`,
    'Accept': 'application/json',
  });
  return JSON.parse(data);
}

// ── Yelp Web Scraping fallback ──

async function searchYelpWeb(location) {
  const desc = encodeURIComponent('record store vinyl');
  const loc = encodeURIComponent(location);
  const results = [];

  // Fetch first 2 pages (20 results each)
  for (let start = 0; start <= 10; start += 10) {
    const url = `https://www.yelp.com/search?find_desc=${desc}&find_loc=${loc}&start=${start}`;

    try {
      const html = await curlFetch(url, {
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      });

      // Extract JSON-LD or embedded search result data
      const businesses = parseYelpSearchHtml(html);
      results.push(...businesses);

      if (businesses.length < 10) break; // No more results
      await sleep(1500); // Be respectful between pages
    } catch (e) {
      console.log(`    ⚠️  Yelp web scrape page ${start / 10 + 1} failed: ${e.message}`);
      break;
    }
  }

  return results;
}

function parseYelpSearchHtml(html) {
  const businesses = [];

  // Method 1: Try to find embedded JSON data
  // Yelp often includes structured data in script tags
  const jsonLdMatches = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g);
  if (jsonLdMatches) {
    for (const match of jsonLdMatches) {
      try {
        const jsonStr = match.replace(/<script[^>]*>/, '').replace(/<\/script>/, '');
        const data = JSON.parse(jsonStr);
        if (data['@type'] === 'LocalBusiness' || data['@type'] === 'Store') {
          businesses.push({
            name: data.name,
            rating: data.aggregateRating?.ratingValue || null,
            reviewCount: data.aggregateRating?.reviewCount || null,
            address: data.address?.streetAddress || null,
            city: data.address?.addressLocality || null,
            state: data.address?.addressRegion || null,
            zip: data.address?.postalCode || null,
            phone: data.telephone || null,
            url: data.url || null,
          });
        }
      } catch (e) { /* skip malformed JSON-LD */ }
    }
  }

  // Method 2: Regex-based extraction from search result cards
  // Yelp search results have patterns like: href="/biz/shop-name-city"
  const bizLinks = html.match(/href="\/biz\/([\w-]+)"/g) || [];
  const uniqueSlugs = [...new Set(bizLinks.map(l => l.match(/\/biz\/([\w-]+)/)[1]))];

  // Extract names from heading patterns near biz links
  const namePattern = /href="\/biz\/([\w-]+)"[^>]*>([^<]+)</g;
  let nameMatch;
  while ((nameMatch = namePattern.exec(html)) !== null) {
    const slug = nameMatch[1];
    const name = nameMatch[2].trim();
    // Skip if we already have this from JSON-LD
    if (businesses.find(b => b.name === name)) continue;
    // Skip non-record-store results (ads, etc.)
    if (name.length < 2 || name.length > 100) continue;

    businesses.push({
      name,
      slug,
      yelpUrl: `https://www.yelp.com/biz/${slug}`,
      source: 'html_parse',
    });
  }

  // Method 3: Extract from Yelp's React hydration data
  const hydrationMatch = html.match(/<!--(\{.*?"searchPageProps".*?\})-->/s)
    || html.match(/"legacyProps"\s*:\s*(\{.*?"searchPageProps".*?\})/s);

  if (hydrationMatch) {
    try {
      const data = JSON.parse(hydrationMatch[1]);
      const searchResults = data?.searchPageProps?.mainContentComponentsListProps || [];
      for (const item of searchResults) {
        if (item.bizId && item.searchResultBusiness) {
          const biz = item.searchResultBusiness;
          businesses.push({
            name: biz.name,
            rating: biz.rating,
            reviewCount: biz.reviewCount,
            phone: biz.phone || null,
            address: biz.formattedAddress || null,
            neighborhood: biz.neighborhoods?.[0] || null,
            yelpUrl: `https://www.yelp.com/biz/${biz.alias || biz.businessUrl?.split('/biz/')[1]}`,
            categories: (biz.categories || []).map(c => c.title || c),
            priceRange: biz.priceRange || null,
            source: 'hydration_data',
          });
        }
      }
    } catch (e) { /* skip parse errors */ }
  }

  return businesses;
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

function findExistingMatch(yelpBiz, existingShops) {
  const yelpNorm = normalizeForMatch(yelpBiz.name);
  if (!yelpNorm) return null;

  // Try exact normalized match first
  for (const shop of existingShops) {
    const shopNorm = normalizeForMatch(shop.name);
    if (yelpNorm === shopNorm) return shop;
  }

  // Try substring match (one contains the other)
  for (const shop of existingShops) {
    const shopNorm = normalizeForMatch(shop.name);
    if (shopNorm.length > 3 && yelpNorm.length > 3) {
      if (yelpNorm.includes(shopNorm) || shopNorm.includes(yelpNorm)) return shop;
    }
  }

  // Try phone match
  if (yelpBiz.phone) {
    const yelpPhone = yelpBiz.phone.replace(/\D/g, '').slice(-10);
    for (const shop of existingShops) {
      if (shop.phone) {
        const shopPhone = shop.phone.replace(/\D/g, '').slice(-10);
        if (yelpPhone === shopPhone && yelpPhone.length === 10) return shop;
      }
    }
  }

  // Try address match
  if (yelpBiz.address) {
    const yelpAddr = yelpBiz.address.toLowerCase().replace(/[^a-z0-9]/g, '');
    for (const shop of existingShops) {
      if (shop.address) {
        const shopAddr = shop.address.toLowerCase().replace(/[^a-z0-9]/g, '');
        // Match on street number + first word
        if (yelpAddr.substring(0, 15) === shopAddr.substring(0, 15) && yelpAddr.length > 10) return shop;
      }
    }
  }

  return null;
}

// ── Build shop record from Yelp data ──

function yelpToShopRecord(biz, cityStr) {
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
    name: biz.name,
    city: biz.city || cityName,
    state: biz.state ? (stateMap[biz.state] || biz.state) : (stateMap[stateAbbr] || stateAbbr),
  };

  // From API response
  if (biz.location) {
    record.address = biz.location.display_address?.join(', ') || biz.location.address1;
    record.city = biz.location.city || record.city;
    record.state = stateMap[biz.location.state] || biz.location.state || record.state;
    record.zip = biz.location.zip_code || null;
  }

  // From scraped data
  if (biz.address && !record.address) record.address = biz.address;
  if (biz.zip && !record.zip) record.zip = biz.zip;

  if (biz.phone || biz.display_phone) record.phone = biz.phone || biz.display_phone;
  if (biz.url) record.yelp_url = biz.url;
  if (biz.yelpUrl) record.yelp_url = biz.yelpUrl;
  if (biz.neighborhood) record.neighborhood = biz.neighborhood;

  // Hours from API detail response
  if (biz.hours && biz.hours[0] && biz.hours[0].open) {
    const dayNames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const hours = {};
    for (const slot of biz.hours[0].open) {
      const dayName = dayNames[slot.day];
      const start = slot.start.replace(/(\d{2})(\d{2})/, '$1:$2');
      const end = slot.end.replace(/(\d{2})(\d{2})/, '$1:$2');
      hours[dayName] = `${start} - ${end}`;
    }
    record.hours = hours;
  }

  return record;
}

function buildUpdatePayload(existing, yelpData) {
  const updates = {};

  // Only backfill null/empty fields — never overwrite existing data
  if (!existing.yelp_url && yelpData.yelp_url) updates.yelp_url = yelpData.yelp_url;
  if (!existing.phone && yelpData.phone) updates.phone = yelpData.phone;
  if (!existing.hours && yelpData.hours) updates.hours = yelpData.hours;
  if (!existing.neighborhood && yelpData.neighborhood) updates.neighborhood = yelpData.neighborhood;
  if (!existing.zip && yelpData.zip) updates.zip = yelpData.zip;
  if (!existing.city && yelpData.city) updates.city = yelpData.city;
  if (!existing.address && yelpData.address) updates.address = yelpData.address;

  return updates;
}

// ── Filter: is this actually a record shop? ──

function isLikelyRecordShop(biz) {
  const name = (biz.name || '').toLowerCase();
  const cats = (biz.categories || []).map(c => (c.title || c || '').toLowerCase()).join(' ');
  const allText = `${name} ${cats}`;

  // Positive signals
  const positiveKeywords = ['record', 'vinyl', 'lp', 'music', 'disc', 'wax', 'turntable', 'crate', 'stereo', 'hi-fi', 'hifi', 'audio'];
  const hasPositive = positiveKeywords.some(kw => allText.includes(kw));

  // Category signals from Yelp
  const recordCategories = ['vinyl_records', 'musicvideo', 'music_dvds', 'media', 'used_vintage'];
  const hasRecordCategory = (biz.categories || []).some(c => {
    const alias = (c.alias || c || '').toLowerCase();
    return recordCategories.some(rc => alias.includes(rc));
  });

  // Negative signals (filter out)
  const negativeKeywords = ['karaoke', 'recording studio', 'label', 'production', 'dj service', 'repair'];
  const hasNegative = negativeKeywords.some(kw => allText.includes(kw));

  return (hasPositive || hasRecordCategory) && !hasNegative;
}

// ── Main ──

async function processCity(cityStr, existingShops, progress) {
  console.log(`\n🏙️  ${cityStr}`);
  console.log('─'.repeat(50));

  let yelpResults = [];
  const useApi = (forceApi || (!forceScrape && YELP_API_KEY));

  if (useApi && YELP_API_KEY) {
    // Use Yelp Fusion API — get up to 50 results
    try {
      console.log('  📡 Yelp Fusion API search...');
      const response = await searchYelpApi(cityStr, 0);
      yelpResults = response.businesses || [];
      progress.apiCallsToday++;
      console.log(`  📊 Got ${yelpResults.length} results (${response.total || '?'} total on Yelp)`);

      // If there are more, fetch page 2
      if (response.total > 50 && progress.apiCallsToday < 480) {
        await sleep(1000);
        const page2 = await searchYelpApi(cityStr, 50);
        yelpResults.push(...(page2.businesses || []));
        progress.apiCallsToday++;
        console.log(`  📊 Page 2: +${(page2.businesses || []).length} results`);
      }
    } catch (e) {
      console.log(`  ⚠️  API failed: ${e.message}`);
      console.log('  🔄 Falling back to web scraping...');
      yelpResults = await searchYelpWeb(cityStr);
    }
  } else {
    // Web scraping
    console.log('  🌐 Yelp web scraping...');
    yelpResults = await searchYelpWeb(cityStr);
    console.log(`  📊 Scraped ${yelpResults.length} results`);
  }

  if (yelpResults.length === 0) {
    console.log('  ❌ No results found');
    return { searched: 0, matched: 0, updated: 0, inserted: 0, skipped: 0 };
  }

  // Filter to likely record shops
  const recordShops = yelpResults.filter(isLikelyRecordShop);
  const filtered = yelpResults.length - recordShops.length;
  if (filtered > 0) console.log(`  🔍 Filtered out ${filtered} non-record-shop results`);

  let matched = 0, updated = 0, inserted = 0, skipped = 0;

  for (const biz of recordShops) {
    const yelpData = yelpToShopRecord(biz, cityStr);
    const existing = findExistingMatch(biz, existingShops);

    if (existing) {
      matched++;
      const updates = buildUpdatePayload(existing, yelpData);

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
          const result = await supabaseInsert(yelpData);
          console.log(`  ➕ Inserted: ${yelpData.name} (${yelpData.city}, ${yelpData.state})`);
          // Add to existingShops so we don't double-insert from overlapping searches
          existingShops.push({ ...yelpData, id: result.id || 'new' });
        } catch (e) {
          console.log(`  ⚠️  Insert failed for ${yelpData.name}: ${e.message}`);
        }
      } else {
        console.log(`  ➕ [DRY] Would insert: ${yelpData.name} (${yelpData.city || '?'}, ${yelpData.state || '?'})`);
      }
      inserted++;
    }
  }

  console.log(`  📊 City total: ${recordShops.length} shops — ${matched} matched, ${updated} updated, ${inserted} new, ${skipped} unchanged`);

  return { searched: recordShops.length, matched, updated, inserted, skipped };
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║  🔍 Yelp Record Shop Discovery                         ║');
  console.log('╚══════════════════════════════════════════════════════════╝');

  if (dryRun) console.log('⚠️  DRY RUN — no database writes\n');
  if (YELP_API_KEY) console.log('🔑 Yelp Fusion API key found');
  else console.log('⚠️  No YELP_API_KEY — using web scraping (less reliable)\n');

  // Load all existing shops for matching
  console.log('📡 Loading existing shops from Supabase...');
  const existingShops = await supabaseGet('select=id,name,city,state,phone,address,yelp_url,hours,neighborhood,zip&limit=2000');
  console.log(`📊 Loaded ${existingShops.length} existing shops\n`);

  const progress = loadProgress();

  // Reset API call counter if new day
  const today = new Date().toISOString().split('T')[0];
  if (progress.apiCallDate !== today) {
    progress.apiCallsToday = 0;
    progress.apiCallDate = today;
  }

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

  for (const city of cities) {
    // Check API budget
    if (YELP_API_KEY && progress.apiCallsToday >= 490) {
      console.log('\n🛑 Approaching Yelp API daily limit (500). Stopping.');
      break;
    }

    const result = await processCity(city, existingShops, progress);

    totals.searched += result.searched;
    totals.matched += result.matched;
    totals.updated += result.updated;
    totals.inserted += result.inserted;
    totals.skipped += result.skipped;
    totals.cities++;

    progress.completedCities.push(city);
    progress.stats = totals;
    if (!dryRun) saveProgress(progress);

    // Rate limit between cities
    await sleep(2000);
  }

  // Save full results
  const reportPath = path.join(RESULTS_DIR, `discovery_${today}.json`);
  writeFileSync(reportPath, JSON.stringify({ date: today, totals, progress }, null, 2));

  // Summary
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║  📊 Discovery Summary                                   ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`  Cities searched: ${totals.cities}`);
  console.log(`  Yelp results:    ${totals.searched}`);
  console.log(`  Matched existing: ${totals.matched}`);
  console.log(`  Data backfilled:  ${totals.updated}`);
  console.log(`  New shops added:  ${totals.inserted}`);
  console.log(`  Unchanged:        ${totals.skipped}`);
  if (YELP_API_KEY) console.log(`  API calls used:   ${progress.apiCallsToday}/500`);
  console.log(`\n  Report: ${reportPath}`);
}

main().catch(err => {
  console.error('💀 Fatal error:', err.message);
  process.exit(1);
});
