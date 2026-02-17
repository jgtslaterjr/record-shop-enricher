#!/usr/bin/env node
/**
 * Pennsylvania-wide record shop discovery via Google Maps.
 * Searches "record store" in PA cities, extracts results, cross-refs with Supabase.
 * 
 * Usage:
 *   node discover_pa_google.js                    # Run all regions
 *   node discover_pa_google.js --dry-run           # Preview only
 *   node discover_pa_google.js --limit 5           # First N cities
 *   node discover_pa_google.js --resume            # Skip completed cities
 */

const { delay, saveJSON, getAllShops, getShopByName, updateShop,
  createStealthBrowser, parseArgs, log, supabase } = require('./lib/common');
const { writeFileSync, readFileSync, existsSync } = require('fs');
const path = require('path');

const PROGRESS_FILE = path.join(__dirname, 'pa_discovery_progress.json');

// ── PA Regions (comprehensive list of all PA places over 5,000 population + culturally significant towns) ──
const PA_SEARCHES = [
  'Abington, PA',
  'Adams Township, PA',
  'Allegheny Township, PA',
  'Aliquippa, PA',
  'Allentown, PA',
  'Altoona, PA',
  'Ambler, PA',
  'Ambridge, PA',
  'Amity Township, PA',
  'Antrim, PA',
  'Archbald, PA',
  'Aston, PA',
  'Baldwin, PA',
  'Beaver Falls, PA',
  'Bedminster, PA',
  'Bellefonte, PA',
  'Bellevue, PA',
  'Benner, PA',
  'Bensalem, PA',
  'Bern, PA',
  'Berwick, PA',
  'Bethel Park, PA',
  'Bethel Township, PA',
  'Bethlehem, PA',
  'Bethlehem Township, PA',
  'Blakely, PA',
  'Bloomsburg, PA',
  'Boyertown, PA',
  'Bradford, PA',
  'Brecknock Township, PA',
  'Brentwood, PA',
  'Brighton, PA',
  'Bristol, PA',
  'Bristol Township, PA',
  'Brookhaven, PA',
  'Buckingham Township, PA',
  'Buffalo Township, PA',
  'Bullskin, PA',
  'Bushkill, PA',
  'Butler, PA',
  'Butler Township, PA',
  'Caln, PA',
  'Camp Hill, PA',
  'Canonsburg, PA',
  'Canton Township, PA',
  'Carbondale, PA',
  'Carlisle, PA',
  'Carnegie, PA',
  'Carroll Township, PA',
  'Castle Shannon, PA',
  'Catasauqua, PA',
  'Cecil, PA',
  'Center Township, PA',
  'Chambersburg, PA',
  'Charlestown, PA',
  'Chartiers, PA',
  'Cheltenham, PA',
  'Chester, PA',
  'Chestnuthill, PA',
  'Chippewa, PA',
  'Clay Township, PA',
  'Clifton Heights, PA',
  'Coal, PA',
  'Coatesville, PA',
  'College, PA',
  'Collier, PA',
  'Collingdale, PA',
  'Columbia, PA',
  'Concord Township, PA',
  'Conemaugh Township, PA',
  'Conewago Township, PA',
  'Connellsville, PA',
  'Conshohocken, PA',
  'Coolbaugh, PA',
  'Cranberry Township, PA',
  'Cumberland Township, PA',
  'Cumru, PA',
  'Dallas Township, PA',
  'Darby, PA',
  'Darby Township, PA',
  'Delaware Township, PA',
  'Derry Township, PA',
  'Dingman, PA',
  'Dormont, PA',
  'Douglass Township, PA',
  'Dover Township, PA',
  'Downingtown, PA',
  'Doylestown, PA',
  'Doylestown Township, PA',
  'DuBois, PA',
  'Dunmore, PA',
  'Earl Township, PA',
  'East Bradford, PA',
  'East Brandywine, PA',
  'East Buffalo, PA',
  'East Cocalico, PA',
  'East Coventry, PA',
  'East Donegal, PA',
  'East Earl, PA',
  'East Fallowfield Township, PA',
  'East Goshen, PA',
  'East Hempfield, PA',
  'East Huntingdon, PA',
  'East Lampeter, PA',
  'East Manchester, PA',
  'East Marlborough, PA',
  'East Norriton, PA',
  'East Nottingham, PA',
  'East Pennsboro, PA',
  'East Pikeland, PA',
  'East Stroudsburg, PA',
  'East Vincent, PA',
  'East Whiteland, PA',
  'Easton, PA',
  'Easttown, PA',
  'Economy, PA',
  'Elizabeth Township, PA',
  'Elizabethtown, PA',
  'Ellwood City, PA',
  'Emmaus, PA',
  'Ephrata, PA',
  'Ephrata Township, PA',
  'Erie, PA',
  'Exeter Township, PA',
  'Fairview Township, PA',
  'Falls Township, PA',
  'Ferguson Township, PA',
  'Findlay, PA',
  'Folcroft, PA',
  'Forks Township, PA',
  'Franconia, PA',
  'Franklin Park, PA',
  'Franklin Township, PA',
  'Frankstown, PA',
  'Gettysburg, PA',
  'Glenolden, PA',
  'Greene Township, PA',
  'Greensburg, PA',
  'Grove City, PA',
  'Guilford, PA',
  'Hamilton Township, PA',
  'Hampden, PA',
  'Hampton, PA',
  'Hanover, PA',
  'Hanover Township, PA',
  'Harborcreek, PA',
  'Harrisburg, PA',
  'Harrison Township, PA',
  'Hatboro, PA',
  'Hatfield Township, PA',
  'Haverford, PA',
  'Hazle, PA',
  'Hazleton, PA',
  'Hempfield Township, PA',
  'Hermitage, PA',
  'Hilltown, PA',
  'Honesdale, PA',
  'Honey Brook Township, PA',
  'Hopewell Township, PA',
  'Horsham, PA',
  'Huntingdon, PA',
  'Indiana, PA',
  'Indiana Township, PA',
  'Jackson Township, PA',
  'Jeannette, PA',
  'Jefferson Hills, PA',
  'Jenkintown, PA',
  'Jim Thorpe, PA',
  'Johnstown, PA',
  'Kennett, PA',
  'Kennett Square, PA',
  'Kennedy, PA',
  'Kingston, PA',
  'Kingston Township, PA',
  'Kutztown, PA',
  'Lancaster, PA',
  'Lancaster Township, PA',
  'Lansdale, PA',
  'Lansdowne, PA',
  'Latrobe, PA',
  'Lawrence Township, PA',
  'Lebanon, PA',
  'Lehigh Township, PA',
  'Lehman Township, PA',
  'Lewisburg, PA',
  'Lewistown, PA',
  'Limerick, PA',
  'Lititz, PA',
  'Lock Haven, PA',
  'Logan Township, PA',
  'London Grove, PA',
  'Lower Allen, PA',
  'Lower Burrell, PA',
  'Lower Gwynedd, PA',
  'Lower Heidelberg, PA',
  'Lower Macungie, PA',
  'Lower Makefield, PA',
  'Lower Merion, PA',
  'Lower Moreland, PA',
  'Lower Nazareth, PA',
  'Lower Paxton, PA',
  'Lower Pottsgrove, PA',
  'Lower Providence, PA',
  'Lower Salford, PA',
  'Lower Saucon, PA',
  'Lower Southampton, PA',
  'Lower Swatara, PA',
  'Lower Windsor, PA',
  'Loyalsock, PA',
  'Maidencreek, PA',
  'Manchester Township, PA',
  'Manheim Township, PA',
  'Manor Township, PA',
  'Marple, PA',
  'Marshall, PA',
  'Maxatawny, PA',
  'McCandless, PA',
  'McKeesport, PA',
  'Meadville, PA',
  'Mechanicsburg, PA',
  'Middle Smithfield, PA',
  'Middlesex Township, PA',
  'Middletown, PA',
  'Middletown Township, PA',
  'Milford Township, PA',
  'Millcreek Township, PA',
  'Millersville, PA',
  'Milton, PA',
  'Monessen, PA',
  'Monroeville, PA',
  'Monroe Township, PA',
  'Montgomery Township, PA',
  'Moon, PA',
  'Moore, PA',
  'Morrisville, PA',
  'Mount Joy, PA',
  'Mount Joy Township, PA',
  'Mount Lebanon, PA',
  'Mount Pleasant Township, PA',
  'Muhlenberg, PA',
  'Munhall, PA',
  'Murrysville, PA',
  'Nanticoke, PA',
  'Narberth, PA',
  'Neshannock, PA',
  'Nether Providence, PA',
  'New Britain Township, PA',
  'New Castle, PA',
  'New Cumberland, PA',
  'New Garden, PA',
  'New Hanover, PA',
  'New Hope, PA',
  'New Kensington, PA',
  'New Sewickley, PA',
  'Newberry, PA',
  'Newtown Township, PA',
  'Norristown, PA',
  'North Codorus, PA',
  'North Cornwall, PA',
  'North Coventry, PA',
  'North Fayette, PA',
  'North Huntingdon, PA',
  'North Lebanon, PA',
  'North Londonderry, PA',
  'North Middleton, PA',
  'North Strabane, PA',
  'North Union Township, PA',
  'North Versailles, PA',
  'North Whitehall, PA',
  'Northampton, PA',
  'Northampton Township, PA',
  'Oakmont, PA',
  "O'Hara, PA",
  'Ohio, PA',
  'Oil City, PA',
  'Old Forge, PA',
  'Palmer, PA',
  'Palmyra, PA',
  'Patton Township, PA',
  'Penn Forest, PA',
  'Penn Hills, PA',
  'Penn Township, PA',
  'Perkasie, PA',
  'Perkiomen, PA',
  'Peters Township, PA',
  'Philadelphia, PA',
  'Phoenixville, PA',
  'Pine Township, PA',
  'Pittsburgh, PA',
  'Pittston, PA',
  'Plains, PA',
  'Pleasant Hills, PA',
  'Plum, PA',
  'Plumstead, PA',
  'Plymouth Township, PA',
  'Pocono, PA',
  'Polk Township, PA',
  'Pottstown, PA',
  'Pottsville, PA',
  'Prospect Park, PA',
  'Providence, PA',
  'Quakertown, PA',
  'Radnor, PA',
  'Rapho, PA',
  'Reading, PA',
  'Red Lion, PA',
  'Richland Township, PA',
  'Ridley, PA',
  'Ridley Park, PA',
  'Robeson, PA',
  'Robinson Township, PA',
  'Ross Township, PA',
  'Rostraver, PA',
  'Salisbury Township, PA',
  'Sandy, PA',
  'Schuylkill Township, PA',
  'Scott Township, PA',
  'Scranton, PA',
  'Shaler, PA',
  'Shamokin, PA',
  'Sharon, PA',
  'Shenango Township, PA',
  'Shrewsbury Township, PA',
  'Silver Spring, PA',
  'Skippack, PA',
  'Slippery Rock Township, PA',
  'Smithfield Township, PA',
  'Solebury, PA',
  'Somerset Township, PA',
  'Souderton, PA',
  'South Abington, PA',
  'South Fayette, PA',
  'South Hanover, PA',
  'South Heidelberg, PA',
  'South Lebanon, PA',
  'South Londonderry, PA',
  'South Middleton, PA',
  'South Park, PA',
  'South Strabane, PA',
  'South Union, PA',
  'South Whitehall, PA',
  'Southampton Township, PA',
  'Spring Garden, PA',
  'Spring Township, PA',
  'Springettsbury, PA',
  'Springfield Township, PA',
  'St. Marys, PA',
  'State College, PA',
  'Stroud, PA',
  'Sunbury, PA',
  'Summit Township, PA',
  'Susquehanna Township, PA',
  'Swarthmore, PA',
  'Swatara Township, PA',
  'Swissvale, PA',
  'Tamaqua, PA',
  'Tobyhanna, PA',
  'Towamencin, PA',
  'Tredyffrin, PA',
  'Tunkhannock Township, PA',
  'Uniontown, PA',
  'Unity, PA',
  'Upper Allen, PA',
  'Upper Chichester, PA',
  'Upper Darby, PA',
  'Upper Dublin, PA',
  'Upper Gwynedd, PA',
  'Upper Hanover, PA',
  'Upper Leacock, PA',
  'Upper Macungie, PA',
  'Upper Makefield, PA',
  'Upper Merion, PA',
  'Upper Milford, PA',
  'Upper Moreland, PA',
  'Upper Nazareth, PA',
  'Upper Providence Township, PA',
  'Upper Saucon, PA',
  'Upper Southampton, PA',
  'Upper St. Clair, PA',
  'Upper Uwchlan, PA',
  'Uwchlan, PA',
  'Valley Township, PA',
  'Warminster, PA',
  'Warren, PA',
  'Warrington Township, PA',
  'Warwick Township, PA',
  'Washington, PA',
  'Washington Township, PA',
  'Waynesboro, PA',
  'West Bradford, PA',
  'West Brandywine, PA',
  'West Caln, PA',
  'West Chester, PA',
  'West Cocalico, PA',
  'West Deer, PA',
  'West Donegal, PA',
  'West Earl, PA',
  'West Goshen, PA',
  'West Hanover, PA',
  'West Hempfield, PA',
  'West Lampeter, PA',
  'West Manchester, PA',
  'West Manheim, PA',
  'West Mifflin, PA',
  'West Norriton, PA',
  'West Vincent, PA',
  'West Whiteland, PA',
  'Westtown, PA',
  'Whitehall, PA',
  'Whitehall Township, PA',
  'Whitemarsh, PA',
  'Whitpain, PA',
  'Wilkes-Barre, PA',
  'Wilkinsburg, PA',
  'Williams Township, PA',
  'Williamsport, PA',
  'Willistown, PA',
  'Wilson, PA',
  'Windsor Township, PA',
  'Worcester, PA',
  'Wyomissing, PA',
  'Yeadon, PA',
  'York, PA',
  'York Township, PA',
];

function loadProgress() {
  try {
    if (existsSync(PROGRESS_FILE)) return JSON.parse(readFileSync(PROGRESS_FILE, 'utf8'));
  } catch (e) {}
  return { completed: [], discovered: [], stats: { new: 0, existing: 0, skipped: 0 } };
}

function saveProgressFile(progress) {
  writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

function normalizeForMatch(name) {
  return name
    .toLowerCase()
    .replace(/[''`]/g, '')
    .replace(/&/g, 'and')
    .replace(/\b(records?|vinyl|music|shop|store|the|llc|inc)\b/g, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

function findMatch(name, city, existingShops) {
  const norm = normalizeForMatch(name);
  if (!norm || norm.length < 2) return null;
  
  for (const shop of existingShops) {
    const shopNorm = normalizeForMatch(shop.name);
    // Exact match
    if (norm === shopNorm) return shop;
    // Substring (both ways)
    if (norm.length > 4 && shopNorm.length > 4) {
      if (norm.includes(shopNorm) || shopNorm.includes(norm)) return shop;
    }
  }
  return null;
}

// Scrape Google Maps search results list (not individual places)
async function searchGoogleMaps(page, location) {
  const query = encodeURIComponent(`record stores in ${location}`);
  const url = `https://www.google.com/maps/search/${query}`;
  
  log(`\n🔍 Searching: record stores in ${location}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await delay(4000, 6000);

  // Scroll the results panel to load more
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => {
      const feed = document.querySelector('div[role="feed"]');
      if (feed) feed.scrollBy(0, 2000);
      // Alternative selector
      const panel = document.querySelector('.m6QErb[role="main"]');
      if (panel) panel.scrollBy(0, 2000);
    });
    await delay(1500, 2500);
  }

  // Also try "vinyl record store" search
  // (skip for now — one query per city should catch most)

  // Extract all results from the feed
  const results = await page.evaluate(() => {
    const items = [];
    
    // Method 1: Feed items with links
    const links = document.querySelectorAll('a[href*="/maps/place/"]');
    const seen = new Set();
    
    for (const link of links) {
      const href = link.getAttribute('href') || '';
      // Extract name from aria-label or inner text
      const label = link.getAttribute('aria-label') || '';
      if (!label || seen.has(label)) continue;
      seen.add(label);
      
      // Try to get the parent card for more info
      const card = link.closest('[jsaction]') || link.parentElement;
      
      // Rating
      let rating = null;
      const ratingEl = card?.querySelector('span[role="img"]');
      if (ratingEl) {
        const m = ratingEl.getAttribute('aria-label')?.match(/([\d.]+)/);
        if (m) rating = parseFloat(m[1]);
      }
      
      // Review count
      let reviewCount = null;
      const spans = card?.querySelectorAll('span') || [];
      for (const s of spans) {
        const m = s.textContent.match(/\(([\d,]+)\)/);
        if (m) { reviewCount = parseInt(m[1].replace(/,/g, '')); break; }
      }
      
      // Address text (usually in a div after the name/rating)
      let address = null;
      const addressDivs = card?.querySelectorAll('div[class*="fontBody"]') || [];
      for (const d of addressDivs) {
        const text = d.textContent.trim();
        if (text.match(/\d+\s+\w+\s+(St|Ave|Rd|Blvd|Dr|Ln|Ct|Way|Pike|Hwy)/i)) {
          address = text;
          break;
        }
      }

      // Category text
      let category = null;
      for (const d of addressDivs) {
        const text = d.textContent.trim().toLowerCase();
        if (text.includes('record') || text.includes('music') || text.includes('vinyl') || text.includes('store')) {
          category = d.textContent.trim();
          break;
        }
      }
      
      items.push({
        name: label,
        googleMapsUrl: href.startsWith('http') ? href : `https://www.google.com${href}`,
        rating,
        reviewCount,
        address,
        category,
      });
    }
    
    return items;
  });

  log(`   Found ${results.length} results`);
  return results;
}

// Filter out non-record-shops
function isLikelyRecordShop(result) {
  const name = (result.name || '').toLowerCase();
  const cat = (result.category || '').toLowerCase();
  const all = `${name} ${cat}`;
  
  const positive = ['record', 'vinyl', 'disc', 'music', 'wax', 'lp', 'turntable', 'hi-fi', 'hifi', 'audio', 'stereo', 'cd'];
  const negative = ['karaoke', 'recording studio', 'label', 'production', 'dj service', 'repair shop',
    'medical', 'dental', 'law', 'attorney', 'real estate', 'auto', 'car wash', 'nail', 'hair salon',
    'restaurant', 'bar & grill', 'pizza', 'tattoo', 'pawn'];
  
  const hasPositive = positive.some(kw => all.includes(kw));
  const hasNegative = negative.some(kw => all.includes(kw));
  
  return hasPositive && !hasNegative;
}

// Extract city/state from address or location string
function parseCityState(address, searchLocation) {
  const [searchCity, searchState] = searchLocation.split(', ');
  
  if (address) {
    // Try to find city, PA pattern
    const m = address.match(/,\s*([^,]+),\s*PA/i);
    if (m) return { city: m[1].trim(), state: 'Pennsylvania' };
  }
  
  return { city: searchCity, state: 'Pennsylvania' };
}

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[''`]/g, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

async function main() {
  const args = parseArgs();
  const dryRun = args['dry-run'];
  const limit = args.limit ? parseInt(args.limit) : null;
  const resume = args.resume;
  
  const progress = loadProgress();
  
  let cities = PA_SEARCHES;
  if (resume) {
    cities = cities.filter(c => !progress.completed.includes(c));
    log(`Resuming — ${cities.length} cities remaining`);
  }
  if (limit) cities = cities.slice(0, limit);
  
  log('╔══════════════════════════════════════════════════════╗');
  log('║  🗺️  Pennsylvania Record Shop Discovery (Google)     ║');
  log('╚══════════════════════════════════════════════════════╝');
  log(`   ${cities.length} locations to search`);
  if (dryRun) log('   ⚠️  DRY RUN — no database writes');
  
  // Load existing shops
  const { data: existingShops } = await supabase
    .from('shops')
    .select('id,name,city,state,phone,address,google_maps_url')
    .limit(2000);
  
  log(`   ${existingShops.length} existing shops in database\n`);
  
  const { browser, context } = await createStealthBrowser();
  
  try {
    const page = await context.newPage();
    let totalNew = 0, totalExisting = 0, totalFiltered = 0;
    
    for (let i = 0; i < cities.length; i++) {
      const location = cities[i];
      
      try {
        const results = await searchGoogleMaps(page, location);
        
        const recordShops = results.filter(isLikelyRecordShop);
        const filtered = results.length - recordShops.length;
        if (filtered > 0) log(`   Filtered out ${filtered} non-record-shop results`);
        totalFiltered += filtered;
        
        for (const shop of recordShops) {
          const match = findMatch(shop.name, location, existingShops);
          const { city, state } = parseCityState(shop.address, location);
          
          if (match) {
            totalExisting++;
            // Backfill google_maps_url if missing
            if (!match.google_maps_url && shop.googleMapsUrl && !dryRun) {
              await supabase.from('shops').update({ google_maps_url: shop.googleMapsUrl }).eq('id', match.id);
              log(`   ✏️  ${shop.name} — added Google Maps URL`);
            } else {
              log(`   ✓  ${shop.name} — already in DB`);
            }
          } else {
            totalNew++;
            const newShop = {
              name: shop.name,
              city,
              state,
              slug: slugify(shop.name),
              address: shop.address || null,
              google_maps_url: shop.googleMapsUrl || null,
              average_rating: shop.rating || null,
              review_count: shop.reviewCount || null,
            };
            
            if (!dryRun) {
              try {
                const { data: inserted, error } = await supabase.from('shops').insert(newShop).select().single();
                if (error) {
                  if (error.code === '23505') {
                    log(`   ⚠️  ${shop.name} — slug conflict, skipping`);
                    continue;
                  }
                  throw error;
                }
                existingShops.push({ ...newShop, id: inserted.id });
                log(`   ➕ NEW: ${shop.name} (${city})`);
                progress.discovered.push({ name: shop.name, city, rating: shop.rating });
              } catch (e) {
                log(`   ⚠️  Insert failed: ${shop.name} — ${e.message}`);
              }
            } else {
              log(`   ➕ [DRY] Would insert: ${shop.name} (${city})`);
            }
          }
        }
        
        progress.completed.push(location);
        if (!dryRun) saveProgressFile(progress);
        
        // Rate limit
        await delay(3000, 5000);
        
      } catch (e) {
        log(`   ⚠️  Failed on ${location}: ${e.message}`);
        await delay(2000, 3000);
      }
    }
    
    log('\n╔══════════════════════════════════════════════════════╗');
    log('║  📊 PA Discovery Summary                             ║');
    log('╚══════════════════════════════════════════════════════╝');
    log(`   Locations searched: ${cities.length}`);
    log(`   New shops found:    ${totalNew}`);
    log(`   Already in DB:      ${totalExisting}`);
    log(`   Non-shops filtered: ${totalFiltered}`);
    
    progress.stats = { new: totalNew, existing: totalExisting, filtered: totalFiltered };
    if (!dryRun) saveProgressFile(progress);
    
  } finally {
    await browser.close();
  }
}

main().catch(e => { console.error('💀', e.message); process.exit(1); });
