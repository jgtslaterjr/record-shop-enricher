#!/usr/bin/env node
/**
 * Discogs Enrichment — official REST API (no more HTML scraping)
 *
 * Resolves a shop's Discogs seller/user profile and pulls marketplace
 * credibility data from api.discogs.com: seller rating (% positive),
 * rating count, inventory size, location, member-since date, homepage.
 * Discogs marketplace ratings are the strongest trust signal we have for
 * a record shop, and they anchor the review_score in summarize_reviews.js.
 *
 * Resolution order:
 *   1. Username from the shop's existing social_discogs URL (trusted)
 *   2. Shop-name variations probed against GET /users/{name} — guessed
 *      hits must be corroborated (location/city, website domain, or exact
 *      normalized name) before being accepted
 *   3. DuckDuckGo search for site:discogs.com profile URLs (same checks)
 *
 * Output: content/{shopId}/discogs/profile.json — the canonical file
 * summarize_reviews.js loadDiscogsData() reads — plus a timestamped audit
 * copy. Updates shops.social_discogs.
 *
 * Auth: set DISCOGS_TOKEN in .env (personal access token from
 * discogs.com/settings/developers) for 60 req/min; without it the API
 * allows 25 req/min and this script paces accordingly.
 *
 * Usage:
 *   node scrape_discogs.js --shop-id "uuid"
 *   node scrape_discogs.js --shop-name "939 Records"
 *   node scrape_discogs.js --all --limit 10
 *   node scrape_discogs.js --all --force   # re-resolve shops that already have URLs
 */

const { supabase, delay, saveJSON, contentDir, getAllShops, updateShop,
  parseArgs, log, ddgSearch } = require('./lib/common');

const DISCOGS_TOKEN = process.env.DISCOGS_TOKEN || null;
const API_BASE = 'https://api.discogs.com';
const USER_AGENT = 'RecordShopEnricher/2.4 +https://github.com/jgtslaterjr/record-shop-enricher';

// Unauthenticated: 25 req/min; with token: 60 req/min
const API_DELAY_MS = DISCOGS_TOKEN ? 1100 : 2500;

// ── Discogs API ────────────────────────────────────────────

async function discogsGet(apiPath, attempt = 0) {
  const headers = { 'User-Agent': USER_AGENT };
  if (DISCOGS_TOKEN) headers['Authorization'] = `Discogs token=${DISCOGS_TOKEN}`;

  const res = await fetch(`${API_BASE}${apiPath}`, { headers });

  if (res.status === 429) {
    if (attempt >= 2) throw new Error('Discogs rate limit persisted after retries');
    const wait = 65000;
    log(`  ⏳ Discogs rate limited — waiting ${wait / 1000}s`);
    await new Promise(r => setTimeout(r, wait));
    return discogsGet(apiPath, attempt + 1);
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Discogs API ${res.status} for ${apiPath}`);
  return res.json();
}

async function fetchDiscogsUser(username) {
  const user = await discogsGet(`/users/${encodeURIComponent(username)}`);
  await new Promise(r => setTimeout(r, API_DELAY_MS));
  return user;
}

// ── Username candidates ────────────────────────────────────

function usernameFromUrl(url) {
  if (!url) return null;
  const m = url.match(/discogs\.com\/(?:user|seller)\/([^/?#]+)/i);
  return m ? decodeURIComponent(m[1]) : null;
}

function nameVariations(name) {
  const variations = [];
  const cleaned = name.replace(/\b(the|llc|inc|co)\b/gi, '').trim();

  for (const base of [...new Set([name, cleaned])]) {
    variations.push(base.replace(/\s+/g, ''));       // NoSpaces
    variations.push(base.replace(/\s+/g, '_'));      // under_scores
    variations.push(base.replace(/\s+/g, '-'));      // hyphen-ated
    variations.push(base.replace(/\s+/g, '.'));      // dot.ted
  }
  const unique = [...new Set(variations.flatMap(v => [v, v.toLowerCase()]))];
  return unique.filter(v => /^[\w.-]{3,30}$/.test(v)).slice(0, 8);
}

// ── Match verification ─────────────────────────────────────

function normalizeForMatch(name) {
  return (name || '')
    .toLowerCase()
    .replace(/[''`]/g, '')
    .replace(/&/g, 'and')
    .replace(/\b(records?|vinyl|music|shop|store|the|llc|inc)\b/g, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

function rootDomain(url) {
  try {
    return new URL(url.startsWith('http') ? url : `https://${url}`).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

/**
 * A guessed username must be corroborated before we attach its ratings to
 * a shop — a wrong profile would poison the review. Returns the signal
 * name or null.
 */
function verifyProfile(shop, user) {
  const userNorm = normalizeForMatch(user.username);
  const nameNorm = normalizeForMatch(shop.name);
  if (userNorm && nameNorm && userNorm === nameNorm) return 'username';

  const loc = (user.location || '').toLowerCase();
  if (loc && shop.city && loc.includes(shop.city.toLowerCase())) return 'location_city';
  if (loc && shop.state && loc.includes(shop.state.toLowerCase())) return 'location_state';

  if (user.home_page && shop.website &&
      rootDomain(user.home_page) && rootDomain(user.home_page) === rootDomain(shop.website)) {
    return 'website_domain';
  }

  const profileText = (user.profile || '').toLowerCase();
  if (profileText && shop.name && profileText.includes(shop.name.toLowerCase())) return 'profile_mentions_name';

  return null;
}

// ── Persistence ────────────────────────────────────────────

function profileRecord(user, verifiedBy) {
  return {
    source: 'discogs_api',
    fetched_at: new Date().toISOString(),
    verified_by: verifiedBy,
    username: user.username,
    uri: user.uri,
    location: user.location || null,
    registered: user.registered || null,
    home_page: user.home_page || null,
    avatar_url: user.avatar_url || null,
    num_for_sale: user.num_for_sale ?? null,
    // Field aliases below match what summarize_reviews.js loadDiscogsData() reads
    seller_rating: user.seller_rating ?? null,           // % positive (e.g. 100.0)
    seller_rating_percent: user.seller_rating ?? null,
    seller_rating_stars: user.seller_rating_stars ?? null,
    num_ratings: user.seller_num_ratings ?? null,
    rating_count: user.seller_num_ratings ?? null,
    buyer_rating: user.buyer_rating ?? null,
    marketplace_suspended: user.marketplace_suspended ?? false,
  };
}

async function persistProfile(shop, user, verifiedBy, results) {
  const record = profileRecord(user, verifiedBy);
  results.profile = record;

  if (shop.id && shop.id !== 'manual') {
    // Canonical file read by summarize_reviews.js
    saveJSON(contentDir(shop.id, 'discogs', 'profile.json'), record);
    // Timestamped audit copy with the full search trail
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    saveJSON(contentDir(shop.id, 'discogs', `discogs_profile_${timestamp}.json`), results);
    log(`  💾 Saved profile.json (rating: ${record.seller_rating ?? '—'}% over ${record.num_ratings ?? 0} sales, ${record.num_for_sale ?? 0} for sale)`);

    await updateShop(shop.id, { social_discogs: user.uri });
    log('  ✓ Updated shop social_discogs');
  } else {
    log(`  ✓ ${user.username}: ${record.seller_rating ?? '—'}% over ${record.num_ratings ?? 0} ratings (not persisted — manual shop)`);
  }
}

// ── Main discovery ─────────────────────────────────────────

async function discoverDiscogs(shop) {
  log(`\n🎵 Discogs API lookup for: ${shop.name}`);

  const results = {
    shopId: shop.id,
    shopName: shop.name,
    searchedAt: new Date().toISOString(),
    usernamesTried: [],
    profile: null,
  };

  // Strategy 1: existing social_discogs URL — trusted source
  const knownUsername = usernameFromUrl(shop.social_discogs);
  if (knownUsername) {
    log(`  Using username from social_discogs: ${knownUsername}`);
    results.usernamesTried.push(knownUsername);
    const user = await fetchDiscogsUser(knownUsername);
    if (user) {
      await persistProfile(shop, user, 'social_discogs_url', results);
      return results;
    }
    log('  ⚠️  social_discogs username no longer exists on Discogs');
  }

  // Strategy 2: probe name variations against the API
  const variations = nameVariations(shop.name);
  log(`  Probing ${variations.length} username variations`);
  for (const variant of variations) {
    if (results.usernamesTried.includes(variant)) continue;
    results.usernamesTried.push(variant);
    const user = await fetchDiscogsUser(variant);
    if (!user) continue;

    const signal = verifyProfile(shop, user);
    if (signal) {
      log(`  ✓ Matched /users/${user.username} (verified by ${signal})`);
      await persistProfile(shop, user, signal, results);
      return results;
    }
    log(`  ✗ /users/${user.username} exists but couldn't be verified as this shop — skipping`);
  }

  // Strategy 3: DuckDuckGo search for profile URLs
  log(`  🔎 Searching DuckDuckGo: site:discogs.com "${shop.name}"`);
  try {
    const { html, blocked } = await ddgSearch(`site:discogs.com "${shop.name}"`);
    if (blocked) {
      log('  ⚠️  DuckDuckGo still rate limited after retries');
    } else {
      const urlPattern = /(?:uddg=|href=")(https?(?::|%3A)(?:\/|%2F){2}(?:www\.)?discogs\.com(?:\/|%2F)(?:user|seller)(?:\/|%2F)[^&"]+)/g;
      const usernames = [];
      let m;
      while ((m = urlPattern.exec(html)) !== null) {
        const u = usernameFromUrl(decodeURIComponent(m[1]));
        if (u && !usernames.includes(u)) usernames.push(u);
      }
      log(`  Found ${usernames.length} candidate profile(s) in search results`);

      for (const username of usernames.slice(0, 4)) {
        if (results.usernamesTried.includes(username)) continue;
        results.usernamesTried.push(username);
        const user = await fetchDiscogsUser(username);
        if (!user) continue;

        const signal = verifyProfile(shop, user);
        if (signal) {
          log(`  ✓ Matched /users/${user.username} via search (verified by ${signal})`);
          await persistProfile(shop, user, signal, results);
          return results;
        }
        log(`  ✗ /users/${user.username} couldn't be verified — skipping`);
      }
    }
  } catch (e) {
    log(`  ⚠️  Search failed: ${e.message}`);
  }

  log(`  ✗ No verified Discogs profile after trying ${results.usernamesTried.length} username(s)`);
  if (shop.id && shop.id !== 'manual') {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    saveJSON(contentDir(shop.id, 'discogs', `discogs_search_${timestamp}.json`), results);
  }
  return results;
}

// ── CLI Entry Point ───────────────────────────────────────

async function main() {
  const args = parseArgs();

  if (!DISCOGS_TOKEN) {
    log('ℹ️  DISCOGS_TOKEN not set — running unauthenticated at 25 req/min (add a token from discogs.com/settings/developers for 60 req/min)');
  }

  if (args.all) {
    const limit = parseInt(args.limit) || 10;
    const shops = await getAllShops(limit);
    log(`\n🎵 Batch Discogs lookup for ${shops.length} shops\n`);

    let found = 0;
    for (let i = 0; i < shops.length; i++) {
      const shop = shops[i];
      log(`\n[${i + 1}/${shops.length}] ${shop.name} (${shop.city}, ${shop.state})`);

      // With --force, or when the canonical profile.json is missing, resolve;
      // otherwise a shop with a URL AND a profile file is done
      const fs = require('fs');
      const hasProfile = fs.existsSync(contentDir(shop.id, 'discogs', 'profile.json'));
      if (shop.social_discogs && hasProfile && !args.force) {
        log('  ⏭ Already resolved (use --force to refresh)');
        continue;
      }

      try {
        const results = await discoverDiscogs(shop);
        if (results.profile) found++;
      } catch (e) {
        log(`  ❌ Error: ${e.message}`);
      }

      if (i < shops.length - 1) await delay(1000, 2000);
    }

    log(`\n✅ Batch complete: ${found}/${shops.length} profiles found`);
    return;
  }

  let shop;

  if (args['shop-id']) {
    const { data, error } = await supabase.from('shops').select('*').eq('id', args['shop-id']).single();
    if (error || !data) {
      log(`❌ Shop not found: ${args['shop-id']}`);
      process.exit(1);
    }
    shop = data;
  } else if (args['shop-name']) {
    shop = {
      id: 'manual',
      name: args['shop-name'],
      city: args.city || '',
      state: args.state || '',
    };
  } else {
    console.log('\nUsage:');
    console.log('  node scrape_discogs.js --shop-id "uuid"');
    console.log('  node scrape_discogs.js --shop-name "939 Records"');
    console.log('  node scrape_discogs.js --all --limit 10');
    console.log('  node scrape_discogs.js --all --force  # refresh shops with existing profiles');
    process.exit(0);
  }

  await discoverDiscogs(shop);
}

if (require.main === module) {
  main().catch(e => {
    console.error('❌ Fatal:', e.message);
    process.exit(1);
  });
}

module.exports = { discoverDiscogs };
