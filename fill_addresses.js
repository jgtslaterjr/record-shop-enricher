#!/usr/bin/env node
// Fill missing street addresses using Brave Search API
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const BRAVE_KEY = process.env.BRAVE_KEY;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Extract street address from text using regex
function extractAddress(text) {
  if (!text) return null;
  
  // Two patterns: one for long suffixes (unambiguous), one for short (St/Rd/Dr/Ln/Ct/Pl)
  // Short suffixes require period or comma after, or be followed by city/zip context
  const longSuffixes = 'Street|Avenue|Ave|Boulevard|Blvd|Road|Drive|Lane|Court|Place|Parkway|Pkwy|Highway|Hwy|Circle|Cir|Terrace|Ter|Pike|Trail|Trl|Square|Sq|Broadway|Loop';
  const shortSuffixes = 'St|Rd|Dr|Ln|Ct|Pl|Way';
  
  // Pattern 1: Long unambiguous suffixes
  const pat1 = new RegExp(`(\\d{1,5}\\s+(?:[NSEW]\\.?\\s+)?(?:[A-Z][a-zA-Z\\.'-]+\\s+){0,4}(?:${longSuffixes})\\.?)(?:\\s*(?:#|Ste|Suite|Unit|Apt)\\.?\\s*[A-Za-z0-9-]*)?`, 'gi');
  
  // Pattern 2: Short suffixes - must be followed by comma, period, newline, or end
  const pat2 = new RegExp(`(\\d{1,5}\\s+(?:[NSEW]\\.?\\s+)?(?:[A-Z][a-zA-Z\\.'-]+\\s+){0,4}(?:${shortSuffixes})\\.?)(?:\\s*(?:#|Ste|Suite|Unit|Apt)\\.?\\s*[A-Za-z0-9-]*)?(?=[,\\.\\n\\r]|\\s+\\d{5}|\\s*$)`, 'gi');
  
  const matches = [...(text.match(pat1) || []), ...(text.match(pat2) || [])];
  if (matches.length === 0) return null;
  
  // Filter: must be < 60 chars, start with digit, no obviously bad words
  const badWords = /\b(record|vinyl|music|best|items|independently|state-of-the-art|mecca|bargain)\b/i;
  const valid = matches
    .map(m => m.trim().replace(/\s+/g, ' '))
    .filter(m => m.length >= 8 && m.length < 60 && /^\d/.test(m) && !badWords.test(m));
  
  if (valid.length === 0) return null;
  return valid.sort((a, b) => b.length - a.length)[0];
}

// Extract zip code from text
function extractZip(text) {
  if (!text) return null;
  const m = text.match(/\b(\d{5})(?:-\d{4})?\b/);
  return m ? m[1] : null;
}

async function braveLocalSearch(shop) {
  const q = `${shop.name} record store ${shop.city} ${shop.state} address`;
  try {
    const res = await fetch(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=5`,
      {
        headers: { 'Accept': 'application/json', 'X-Subscription-Token': BRAVE_KEY },
        signal: AbortSignal.timeout(10000)
      }
    );
    const data = await res.json();
    
    // Check local results first (POI data from Brave)
    if (data.locations?.results) {
      for (const loc of data.locations.results) {
        if (loc.address?.streetAddress || loc.address?.addressRegion) {
          const addr = loc.address.streetAddress;
          const zip = loc.address.postalCode;
          if (addr && /\d/.test(addr)) {
            return { address: addr, zip: zip || null, source: 'brave-local' };
          }
        }
      }
    }
    
    // Check infobox
    if (data.infobox?.results) {
      for (const info of data.infobox.results) {
        const profiles = info.profiles || {};
        const allText = JSON.stringify(info);
        const addr = extractAddress(allText);
        if (addr) {
          return { address: addr, zip: extractZip(allText), source: 'brave-infobox' };
        }
      }
    }
    
    // Check web results snippets
    const results = data.web?.results || [];
    for (const r of results) {
      const text = `${r.title || ''} ${r.description || ''} ${r.extra_snippets?.join(' ') || ''}`;
      const addr = extractAddress(text);
      if (addr) {
        return { address: addr, zip: extractZip(text), source: 'brave-web' };
      }
    }
    
    return null;
  } catch (e) {
    console.error(`  Brave error: ${e.message}`);
    return null;
  }
}

// Fallback: Nominatim search
async function nominatimSearch(shop) {
  const q = `${shop.name}, ${shop.city}, ${shop.state}`;
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&addressdetails=1&q=${encodeURIComponent(q)}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'RecordShopEnricher/1.0' },
      signal: AbortSignal.timeout(10000)
    });
    const data = await res.json();
    if (data.length === 0) return null;

    const addr = data[0].address || {};
    if (!addr.house_number || !addr.road) return null;

    return {
      address: `${addr.house_number} ${addr.road}`,
      zip: addr.postcode || null,
      lat: parseFloat(data[0].lat),
      lon: parseFloat(data[0].lon),
      source: 'nominatim'
    };
  } catch (e) {
    return null;
  }
}

(async () => {
  const { data: shops, error } = await sb
    .from('shops')
    .select('id, name, city, state, zip, google_maps_url, latitude, longitude')
    .or('address.is.null,address.eq.')
    .order('state')
    .order('city');

  if (error) { console.error('DB error:', error); process.exit(1); }
  console.log(`Found ${shops.length} shops missing addresses\n`);

  let braveHits = 0, nominatimHits = 0, failed = 0;
  const failures = [];
  const bySource = {};

  for (let i = 0; i < shops.length; i++) {
    const shop = shops[i];
    const tag = `[${i + 1}/${shops.length}]`;
    let result = null;

    // Pass 1: Brave Search
    result = await braveLocalSearch(shop);
    await sleep(1100); // Brave rate limit ~1/sec for free tier

    // Pass 2: Nominatim fallback
    if (!result) {
      result = await nominatimSearch(shop);
      await sleep(1100);
    }

    if (result) {
      const update = { address: result.address };
      if (result.zip && !shop.zip) update.zip = result.zip;
      if (result.lat && result.lon) {
        update.latitude = result.lat;
        update.longitude = result.lon;
      }

      const { error: upErr } = await sb.from('shops').update(update).eq('id', shop.id);
      if (upErr) {
        console.log(`${tag} ❌ DB error: ${shop.name} — ${upErr.message}`);
        failed++;
      } else {
        bySource[result.source] = (bySource[result.source] || 0) + 1;
        console.log(`${tag} ✅ ${shop.name} → "${result.address}" [${result.source}]${result.zip ? ' zip:' + result.zip : ''}`);
      }
    } else {
      failed++;
      failures.push(`${shop.name} (${shop.city}, ${shop.state})`);
      console.log(`${tag} ⬜ No address: ${shop.name} (${shop.city}, ${shop.state})`);
    }
  }

  console.log(`\n=== RESULTS ===`);
  console.log(`By source:`, JSON.stringify(bySource));
  console.log(`Not found: ${failed}`);
  console.log(`Total: ${shops.length}`);
  if (failures.length > 0) {
    console.log(`\nFailed (${failures.length}):`);
    failures.forEach(f => console.log(`  - ${f}`));
  }
})();
