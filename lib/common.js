/**
 * Common utilities shared across all deep scraping scripts
 */
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const SUPABASE_URL = process.env.SUPABASE_URL;
// Use service key to bypass RLS for inserts/updates
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ SUPABASE_URL or SUPABASE_SERVICE_KEY missing from .env');
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const USER_AGENTS = [
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64; rv:134.0) Gecko/20100101 Firefox/134.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:134.0) Gecko/20100101 Firefox/134.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:134.0) Gecko/20100101 Firefox/134.0',
];

function randomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

async function delay(min = 2000, max = 4000) {
  const ms = Math.floor(Math.random() * (max - min) + min);
  return new Promise(r => setTimeout(r, ms));
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function saveJSON(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function loadJSON(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function contentDir(shopId, ...subPaths) {
  return path.join(__dirname, '..', 'content', shopId, ...subPaths);
}

async function getAllShops(limit) {
  let query = supabase.from('shops').select('*').order('name');
  if (limit) query = query.limit(limit);
  const { data, error } = await query;
  if (error) throw error;
  return data;
}

// Map state abbreviations to full names
const STATE_MAP = {
  'AL':'Alabama','AK':'Alaska','AZ':'Arizona','AR':'Arkansas','CA':'California',
  'CO':'Colorado','CT':'Connecticut','DE':'Delaware','FL':'Florida','GA':'Georgia',
  'HI':'Hawaii','ID':'Idaho','IL':'Illinois','IN':'Indiana','IA':'Iowa','KS':'Kansas',
  'KY':'Kentucky','LA':'Louisiana','ME':'Maine','MD':'Maryland','MA':'Massachusetts',
  'MI':'Michigan','MN':'Minnesota','MS':'Mississippi','MO':'Missouri','MT':'Montana',
  'NE':'Nebraska','NV':'Nevada','NH':'New Hampshire','NJ':'New Jersey','NM':'New Mexico',
  'NY':'New York','NC':'North Carolina','ND':'North Dakota','OH':'Ohio','OK':'Oklahoma',
  'OR':'Oregon','PA':'Pennsylvania','RI':'Rhode Island','SC':'South Carolina',
  'SD':'South Dakota','TN':'Tennessee','TX':'Texas','UT':'Utah','VT':'Vermont',
  'VA':'Virginia','WA':'Washington','WV':'West Virginia','WI':'Wisconsin','WY':'Wyoming',
  'DC':'District of Columbia',
};

async function getShopByName(name, city, state) {
  let query = supabase.from('shops').select('*').ilike('name', `%${name}%`);
  if (city) query = query.ilike('city', `%${city}%`);
  if (state) {
    const fullState = STATE_MAP[state.toUpperCase()] || state;
    query = query.ilike('state', `%${fullState}%`);
  }
  const { data, error } = await query;
  if (error) throw error;
  return data;
}

async function updateShop(id, updates) {
  const { error } = await supabase.from('shops').update(updates).eq('id', id);
  if (error) throw error;
}

async function upsertShop(shopData) {
  // Try to match by name+city first
  const existing = await getShopByName(shopData.name, shopData.city, shopData.state);
  if (existing && existing.length > 0) {
    await updateShop(existing[0].id, shopData);
    return { ...existing[0], ...shopData, isNew: false };
  }
  // Insert new
  const { data, error } = await supabase.from('shops').insert(shopData).select();
  if (error) throw error;
  return { ...data[0], isNew: true };
}

async function createStealthBrowser() {
  const { chromium } = require('playwright-extra');
  const stealth = require('puppeteer-extra-plugin-stealth')();
  chromium.use(stealth);

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--disable-setuid-sandbox',
    ]
  });

  const context = await browser.newContext({
    userAgent: randomUA(),
    viewport: { width: 1366, height: 768 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
  });

  return { browser, context };
}

async function ollamaSummarize(prompt, model = 'llama3.2') {
  const { spawn } = require('child_process');
  return new Promise((resolve, reject) => {
    const proc = spawn('curl', [
      '-s', 'http://localhost:11434/api/generate',
      '-d', JSON.stringify({ model, prompt, stream: false, options: { num_predict: 4096 } })
    ]);
    let out = '';
    proc.stdout.on('data', d => out += d);
    proc.stderr.on('data', d => {});
    proc.on('close', code => {
      try {
        const parsed = JSON.parse(out);
        resolve(parsed.response || '');
      } catch (e) {
        reject(new Error(`Ollama failed: ${out.slice(0, 200)}`));
      }
    });
  });
}

const DEFAULT_CLAUDE_MODEL = 'claude-opus-4-8';

let _anthropicClient = null;
function getAnthropicClient() {
  if (!_anthropicClient) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');
    const Anthropic = require('@anthropic-ai/sdk');
    _anthropicClient = new Anthropic({ maxRetries: 4 });
  }
  return _anthropicClient;
}

/**
 * Call Claude. Second arg accepts an options object:
 *   { model, maxTokens, schema, system }
 * When `schema` (a JSON Schema object) is provided, the API constrains the
 * response to valid JSON matching it (structured outputs) — callers can
 * JSON.parse the return value directly.
 * A bare string second arg is still accepted as a model override.
 */
async function anthropicSummarize(prompt, opts = {}) {
  if (typeof opts === 'string') opts = { model: opts };
  const {
    model = DEFAULT_CLAUDE_MODEL,
    maxTokens = 16000,
    schema = null,
    system = null,
  } = opts;

  const body = {
    model,
    max_tokens: maxTokens,
    thinking: { type: 'adaptive' },
    messages: [{ role: 'user', content: prompt }],
  };
  if (system) body.system = system;
  if (schema) body.output_config = { format: { type: 'json_schema', schema } };

  const msg = await getAnthropicClient().messages.create(body);
  if (msg.stop_reason === 'max_tokens') {
    throw new Error(`Claude response truncated at ${maxTokens} tokens (stop_reason=max_tokens)`);
  }
  if (msg.stop_reason === 'refusal') {
    throw new Error('Claude refused the request (stop_reason=refusal)');
  }
  const text = msg.content.find(b => b.type === 'text');
  return text ? text.text : '';
}

function parseArgs() {
  const args = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        args[key] = argv[++i];
      } else {
        args[key] = true;
      }
    }
  }
  return args;
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

/**
 * Download an image from a URL and upload to Supabase storage
 * Returns the permanent Supabase URL or null on failure
 */
async function downloadAndStoreImage(url, slug, source = 'google') {
  const https = require('https');
  const http = require('http');
  
  return new Promise((resolve) => {
    try {
      const urlObj = new URL(url);
      const client = urlObj.protocol === 'https:' ? https : http;
      
      const req = client.get(url, { timeout: 10000 }, async (res) => {
        if (res.statusCode !== 200) {
          log(`    ⚠️  Failed to download image: HTTP ${res.statusCode}`);
          return resolve(null);
        }

        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', async () => {
          try {
            const buffer = Buffer.concat(chunks);
            const contentType = res.headers['content-type'] || 'image/jpeg';
            
            // Determine extension
            let ext = 'jpg';
            if (contentType.includes('png')) ext = 'png';
            else if (contentType.includes('webp')) ext = 'webp';
            else if (contentType.includes('gif')) ext = 'gif';

            // Upload to Supabase storage
            const timestamp = Date.now();
            const storagePath = `gallery/${slug}/${timestamp}_${source}.${ext}`;
            
            const { data, error } = await supabase.storage
              .from('shop-logos')
              .upload(storagePath, buffer, {
                contentType,
                upsert: false
              });

            if (error) {
              log(`    ⚠️  Storage upload failed: ${error.message}`);
              return resolve(null);
            }

            // Get public URL
            const { data: publicUrlData } = supabase.storage
              .from('shop-logos')
              .getPublicUrl(storagePath);

            log(`    ✓ Uploaded image to storage: ${storagePath}`);
            resolve(publicUrlData.publicUrl);
          } catch (e) {
            log(`    ⚠️  Error processing image: ${e.message}`);
            resolve(null);
          }
        });
      });

      req.on('error', (e) => {
        log(`    ⚠️  Download error: ${e.message}`);
        resolve(null);
      });

      req.on('timeout', () => {
        req.destroy();
        log(`    ⚠️  Timeout downloading image`);
        resolve(null);
      });

    } catch (e) {
      log(`    ⚠️  Invalid URL: ${e.message}`);
      resolve(null);
    }
  });
}

/**
 * Normalize a shop name for fuzzy matching
 * Strips common words, punctuation, and lowercases
 */
function normalizeNameForMatch(name) {
  if (!name) return '';
  return name
    .toLowerCase()
    .replace(/[''`]/g, '')
    .replace(/&/g, 'and')
    .replace(/\b(the|records?|vinyl|music|shop|store|llc|inc|co)\b/g, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

/**
 * Check if two lat/lng coordinates are within ~100m (0.001 degrees)
 */
function coordinatesMatch(lat1, lng1, lat2, lng2) {
  if (!lat1 || !lng1 || !lat2 || !lng2) return false;
  return Math.abs(lat1 - lat2) < 0.001 && Math.abs(lng1 - lng2) < 0.001;
}

/**
 * Find an existing shop that matches the given criteria to prevent duplicates
 * Returns the existing shop if found, null otherwise
 */
async function findExistingShop(name, city, state, googlePlaceId = null, lat = null, lng = null) {
  const normalizedName = normalizeNameForMatch(name);
  
  if (!normalizedName || normalizedName.length < 2) {
    return null; // Name too short to match reliably
  }

  // Get all shops in the same city/state
  let query = supabase
    .from('shops')
    .select('id, name, city, state, latitude, longitude, website, phone, address, yelp_url, social_instagram');
  
  if (city) query = query.ilike('city', city);
  if (state) query = query.ilike('state', state);
  
  const { data: candidates, error } = await query;
  if (error) throw error;
  if (!candidates || candidates.length === 0) return null;

  // Check for matches
  for (const shop of candidates) {
    // 1. Match by google_place_id (column doesn't exist in current schema — kept for forward compatibility)
    if (googlePlaceId && shop.google_place_id && googlePlaceId === shop.google_place_id) {
      return shop;
    }

    // 2. Match by normalized name + same city/state
    const shopNorm = normalizeNameForMatch(shop.name);
    if (shopNorm === normalizedName) {
      return shop;
    }

    // 3. Match by lat/lng proximity (~100m)
    if (coordinatesMatch(lat, lng, shop.latitude, shop.longitude)) {
      return shop;
    }
  }

  return null;
}

/**
 * Score how "rich" a shop data object is (more filled fields = higher score)
 */
function scoreShopData(shop) {
  let score = 0;
  const fields = [
    'website', 'phone', 'address', 'hours', 'hours_text', 'description', 'long_description',
    'social_instagram', 'social_facebook', 'social_tiktok', 'yelp_url', 'discogs_url', 'google_maps_url',
    'google_place_id', 'logo_url', 'image_hero_url', 'neighborhood',
    'owner_name', 'founded_year', 'latitude', 'longitude'
  ];
  
  for (const f of fields) {
    if (shop[f] != null && shop[f] !== '' && shop[f] !== false) score++;
  }
  
  if (shop.image_gallery?.length > 0) score += 2;
  if (shop.review_count > 0) score++;
  if (shop.average_rating > 0) score++;
  if (shop.formats?.length > 0) score++;
  
  return score;
}

/**
 * Merge two shop data objects, preferring non-null values from the better source
 */
function mergeShopData(existing, newData) {
  const merged = { ...existing };
  
  for (const [key, val] of Object.entries(newData)) {
    // Skip id, created_at, updated_at
    if (['id', 'created_at', 'updated_at'].includes(key)) continue;
    
    // If existing value is null/empty and new value isn't, take new
    if (val != null && val !== '' && (existing[key] == null || existing[key] === '')) {
      merged[key] = val;
    }
    
    // For arrays (like image_gallery), merge them
    if (Array.isArray(val) && Array.isArray(existing[key])) {
      merged[key] = [...new Set([...existing[key], ...val])];
    }
  }
  
  return merged;
}

/**
 * Validate and clean shop data before DB write
 * Returns cleaned data object, or throws if critical fields missing
 */
// === slug generation (site convention: name_city_state) ===
// Format: kebab-case within each segment, underscores between segments,
// full lowercase state name — e.g. "hear-we-are_studio-city_california".
// The public site (recordshops.us) looks shops up by this column verbatim,
// so changing a slug changes a live URL.
const STATE_FULL_FROM_ABBREV = {
  al:'alabama',ak:'alaska',az:'arizona',ar:'arkansas',ca:'california',co:'colorado',
  ct:'connecticut',de:'delaware',fl:'florida',ga:'georgia',hi:'hawaii',id:'idaho',
  il:'illinois',in:'indiana',ia:'iowa',ks:'kansas',ky:'kentucky',la:'louisiana',
  me:'maine',md:'maryland',ma:'massachusetts',mi:'michigan',mn:'minnesota',
  ms:'mississippi',mo:'missouri',mt:'montana',ne:'nebraska',nv:'nevada',
  nh:'new hampshire',nj:'new jersey',nm:'new mexico',ny:'new york',
  nc:'north carolina',nd:'north dakota',oh:'ohio',ok:'oklahoma',or:'oregon',
  pa:'pennsylvania',ri:'rhode island',sc:'south carolina',sd:'south dakota',
  tn:'tennessee',tx:'texas',ut:'utah',vt:'vermont',va:'virginia',wa:'washington',
  wv:'west virginia',wi:'wisconsin',wy:'wyoming',dc:'district of columbia',
};
function slugSegment(s) {
  return (s || '')
    .toLowerCase()
    .replace(/['']/g, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
function generateSlug(name, city, state) {
  if (!name) return null;
  const stateRaw = (state || '').trim().toLowerCase();
  const stateFull = STATE_FULL_FROM_ABBREV[stateRaw] || stateRaw;
  const parts = [slugSegment(name), slugSegment(city), slugSegment(stateFull)].filter(Boolean);
  return parts.join('_') || null;
}

// === LLM JSON parser (lifted from summarize_reviews.js Jun 7 2026) ===
// Strips ```json fences, sanitizes Python literals + unquoted barewords, retries with lenient fixes.
function parseFencedJSON(response) {
  if (!response || typeof response !== 'string') return null;
  // Strategy 1: ```json ... ``` fence (greedy match for outermost braces)
  const fenceMatch = response.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  let candidate = fenceMatch ? fenceMatch[1] : response;
  // Strategy 2: take outermost { ... } block (greedy)
  const braceMatch = candidate.match(/\{[\s\S]*\}/);
  const rawJson = braceMatch ? braceMatch[0] : null;
  if (!rawJson) return null;

  // Sanitize Python-style values and unquoted strings
  let sanitized = rawJson
    .replace(/:\s*None/g, ': null')
    .replace(/:\s*True/g, ': true')
    .replace(/:\s*False/g, ': false')
    .replace(/:\s*([A-Z][^",\n\r}\]]*[^",\s\n\r}\]])\s*([,}\]])/g, ': "$1"$2');

  try {
    return JSON.parse(sanitized);
  } catch (e) {
    // Lenient: strip trailing commas, quote unquoted keys
    sanitized = sanitized
      .replace(/,\s*([}\]])/g, '$1')
      .replace(/([{,]\s*)(\w+)\s*:/g, '$1"$2":');
    try {
      return JSON.parse(sanitized);
    } catch (e2) {
      return null;
    }
  }
}

function validateShopData(data) {
  const { normalizeHours } = require('./normalize_hours');
  
  // Critical fields must be non-empty strings
  if (!data.name || typeof data.name !== 'string' || data.name.trim() === '') {
    throw new Error('Shop name is required');
  }
  if (!data.city || typeof data.city !== 'string' || data.city.trim() === '') {
    throw new Error('City is required');
  }
  if (!data.state || typeof data.state !== 'string' || data.state.trim() === '') {
    throw new Error('State is required');
  }
  
  const cleaned = { ...data };
  
  // Normalize hours
  if (cleaned.hours) {
    cleaned.hours = normalizeHours(cleaned.hours);
  }
  
  // Validate URLs
  const urlFields = ['website', 'google_maps_url', 'yelp_url', 'discogs_url', 'logo_url', 'image_hero_url'];
  for (const field of urlFields) {
    if (cleaned[field]) {
      try {
        new URL(cleaned[field]);
      } catch {
        log(`    ⚠️  Invalid URL in ${field}: ${cleaned[field]}`);
        cleaned[field] = null;
      }
    }
  }
  
  // Validate enrichment_status is a valid string
  const validStatuses = ['enriched', 'partial', 'failed', 'pending', null];
  if (cleaned.enrichment_status && !validStatuses.includes(cleaned.enrichment_status)) {
    if (typeof cleaned.enrichment_status !== 'string') {
      log(`    ⚠️  enrichment_status is not a string, setting to null`);
      cleaned.enrichment_status = null;
    } else {
      log(`    ⚠️  Invalid enrichment_status: ${cleaned.enrichment_status}, setting to null`);
      cleaned.enrichment_status = null;
    }
  }
  
  // Strip [object Object] values
  for (const [key, val] of Object.entries(cleaned)) {
    if (val === '[object Object]' || (typeof val === 'object' && val !== null && !Array.isArray(val) && 
        !['hours', 'formats', 'genre_specialties', 'services', 'amenities'].includes(key))) {
      log(`    ⚠️  Removing [object Object] value from ${key}`);
      cleaned[key] = null;
    }
  }
  
  return cleaned;
}

/**
 * Audit image_gallery URLs for a shop, remove dead links
 * Returns number of URLs removed
 */
async function auditShopImages(shopId) {
  const https = require('https');
  const http = require('http');
  
  const { data: shop, error } = await supabase.from('shops').select('image_gallery').eq('id', shopId).single();
  if (error || !shop || !shop.image_gallery || shop.image_gallery.length === 0) {
    return 0;
  }
  
  const gallery = shop.image_gallery;
  const validUrls = [];
  let removed = 0;
  
  log(`  Auditing ${gallery.length} images for shop ${shopId}...`);
  
  for (const url of gallery) {
    try {
      const urlObj = new URL(url);
      const client = urlObj.protocol === 'https:' ? https : http;
      
      const isValid = await new Promise((resolve) => {
        const req = client.request(url, { method: 'HEAD', timeout: 5000 }, (res) => {
          resolve(res.statusCode >= 200 && res.statusCode < 400);
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.end();
      });
      
      if (isValid) {
        validUrls.push(url);
      } else {
        log(`    ✗ Dead link: ${url.substring(0, 60)}...`);
        removed++;
      }
    } catch (e) {
      log(`    ✗ Invalid URL: ${url}`);
      removed++;
    }
  }
  
  if (removed > 0) {
    await supabase.from('shops').update({ image_gallery: validUrls }).eq('id', shopId);
    log(`  Removed ${removed} dead images, ${validUrls.length} remain`);
  } else {
    log(`  All ${validUrls.length} images valid`);
  }
  
  return removed;
}

// Facebook path segments that are site features, not Pages. Kept here so all
// discoverers share one list instead of four divergent copies.
const FACEBOOK_RESERVED = new Set([
  'sharer', 'share', 'dialog', 'login', 'help', 'pages', 'groups', 'events',
  'marketplace', 'watch', 'gaming', 'bookmarks', 'ads', 'privacy', 'policies',
  'settings', 'photo', 'photos', 'media', 'people', 'public', 'hashtag',
  'stories', 'story', 'reel', 'reels', 'notes', 'flx', 'plugins', 'l', 'tr',
  'home', 'search', 'posts', 'video', 'videos', 'live', 'places', 'business',
  'legal', 'terms', 'about', 'recover', 'security', 'permalink',
]);

/**
 * Extract a valid Facebook Page identifier from a URL or bare handle.
 * Returns the page path (usable as facebook.com/<result>), or null for site
 * endpoints (login.php, permalink.php, story.php, sharer, watch, …) that are
 * not real Pages. Two non-vanity formats ARE valid and preserved:
 *   facebook.com/p/<Name-1234567890>      → "p/<Name-1234567890>"
 *   facebook.com/profile.php?id=123456    → "profile.php?id=123456"
 */
function extractFacebookPage(urlOrHandle) {
  if (!urlOrHandle) return null;
  const raw = String(urlOrHandle).trim();

  // Newer /p/<name-with-id> page URLs
  const pMatch = raw.match(/facebook\.com\/(p\/[a-zA-Z0-9.\-_%]+)/i);
  if (pMatch) return pMatch[1].replace(/\/+$/, '');

  // profile.php is valid only when it keeps its numeric id
  const profMatch = raw.match(/facebook\.com\/(profile\.php\?id=\d+)/i);
  if (profMatch) return profMatch[1];

  let handle = raw;
  const m = handle.match(/facebook\.com\/([a-zA-Z0-9.\-_]+)/i);
  if (m) handle = m[1];
  handle = handle.replace(/\/+$/, '');
  if (/\.php$/i.test(handle)) return null;            // login.php, story.php, …
  if (FACEBOOK_RESERVED.has(handle.toLowerCase())) return null;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.\-_]{1,60}$/.test(handle)) return null;
  return handle;
}

/**
 * DuckDuckGo HTML search with exponential backoff on rate limits.
 * DDG returns 429 (or a 202 challenge) when hammered; previously callers
 * just gave up. Retries at ~5s/15s/45s with jitter before reporting blocked.
 * Returns { html, blocked }.
 */
async function ddgSearch(query, opts = {}) {
  const { retries = 3, baseDelayMs = 5000 } = opts;
  const https = require('https');

  const attempt = () => new Promise((resolve, reject) => {
    const postData = `q=${encodeURIComponent(query)}`;
    const req = https.request({
      hostname: 'html.duckduckgo.com',
      path: '/html/',
      method: 'POST',
      headers: {
        'User-Agent': randomUA(),
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
      }
    }, (res) => {
      if (res.statusCode === 429 || res.statusCode === 202) {
        res.resume();
        resolve({ html: '', blocked: true });
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ html: data, blocked: false }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });

  for (let i = 0; i <= retries; i++) {
    const result = await attempt();
    if (!result.blocked) return result;
    if (i < retries) {
      const waitMs = baseDelayMs * Math.pow(3, i) + Math.floor(Math.random() * 2000);
      log(`  ⏳ DuckDuckGo rate limited — retrying in ${Math.round(waitMs / 1000)}s (${i + 1}/${retries})`);
      await new Promise(r => setTimeout(r, waitMs));
    }
  }
  return { html: '', blocked: true };
}

module.exports = {
  supabase, randomUA, delay, ensureDir, saveJSON, loadJSON, contentDir,
  getAllShops, getShopByName, updateShop, upsertShop, createStealthBrowser,
  ollamaSummarize, anthropicSummarize, parseArgs, log, USER_AGENTS,
  normalizeNameForMatch, coordinatesMatch, findExistingShop, scoreShopData, mergeShopData,
  downloadAndStoreImage, validateShopData, auditShopImages, generateSlug, slugSegment, parseFencedJSON,
  ddgSearch, STATE_MAP, extractFacebookPage
};
