/**
 * Data-quality metrics engine for the dashboard.
 *
 * Pure assessment logic — no HTTP. enricher-ui.js serves the report at
 * GET /api/quality; `node lib/quality.js` prints a summary for smoke tests.
 *
 * Tiers (precedence): closed > suspect > needs_enrichment > good.
 *   closed   — permanently closed (hidden on the public site; kept for audit)
 *   suspect  — contradictory or invalid data (would embarrass us if served)
 *   needs    — incomplete or stale; each issue carries a recommended action
 *   good     — complete enough, fresh enough, nothing contradictory
 */

const fs = require('fs');
const path = require('path');
const {
  supabase, scoreShopData, normalizeNameForMatch, STATE_MAP, loadJSON, contentDir,
} = require('./common');

// All tunable thresholds in one place
const CONFIG = {
  staleMonths: 6,         // deep_scrape_at older than this → STALE_SCRAPE
  statusStaleDays: 60,    // business_status_checked_at older than this → STATUS_UNVERIFIED
  lowScore: 8,            // scoreShopData below this → LOW_SCORE
  goodMinScore: 12,       // minimum score for the good tier
  maxScore: 26,           // scoreShopData ceiling: 21 fields + 2 gallery + 1 reviews + 1 rating + 1 formats
  // Issues that are reported but never demote a shop out of `good`
  advisoryCodes: new Set(['NO_PLACE_ID', 'STATUS_UNVERIFIED']),
  topCities: 15,
  // Public site base for "view on site" links (slug pages)
  siteBaseUrl: process.env.SITE_URL || 'https://recordshops.us',
};

/**
 * Fix-priority score (0–100): how urgently a shop needs attention.
 * Suspect data outranks gaps; never-enriched and cheap wins (unsummarized
 * reviews) outrank single missing fields; the completeness gap breaks ties.
 * Closed shops are 0 — they're hidden on the site, nothing to fix.
 */
function priorityScore(tier, issues, score) {
  if (tier === 'closed') return 0;
  let p = 0;
  for (const issue of issues) {
    if (CONFIG.advisoryCodes.has(issue.code)) p += 2;
    else if (issue.severity === 'suspect') p += 25;
    else if (issue.code === 'NEVER_ENRICHED') p += 30;
    else if (issue.code === 'STALE_SCRAPE' || issue.code === 'PARTIAL' || issue.code === 'REVIEWS_UNSUMMARIZED') p += 15;
    else p += 5;
  }
  p += Math.round((1 - score / CONFIG.maxScore) * 20);
  return Math.min(100, p);
}

const NEW_COLUMNS = [
  'google_place_id', 'business_status', 'business_status_checked_at',
  'tripadvisor_url', 'discovery_source', 'rsd_participant',
];

const FIELD_COVERAGE_FIELDS = [
  'website', 'phone', 'address', 'hours', 'hours_text', 'description', 'long_description',
  'social_instagram', 'social_facebook', 'social_tiktok', 'yelp_url', 'discogs_url',
  'google_maps_url', 'google_place_id', 'logo_url', 'image_hero_url', 'neighborhood',
  'owner_name', 'founded_year', 'latitude', 'longitude',
  'review_summary', 'image_gallery', 'tripadvisor_url',
];

const URL_FIELDS = ['website', 'yelp_url', 'google_maps_url', 'tripadvisor_url'];

const FULL_STATE_NAMES = new Set(Object.values(STATE_MAP).map(s => s.toLowerCase()));
const ABBREVS = new Set(Object.keys(STATE_MAP));

function isEmpty(v) {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}

function monthsAgo(iso, now) {
  return (now - new Date(iso).getTime()) / (30.44 * 24 * 60 * 60 * 1000);
}

function daysAgo(iso, now) {
  return (now - new Date(iso).getTime()) / (24 * 60 * 60 * 1000);
}

function validState(state) {
  if (isEmpty(state)) return false;
  const s = state.trim();
  return FULL_STATE_NAMES.has(s.toLowerCase()) || ABBREVS.has(s.toUpperCase());
}

function stateAbbrev(state) {
  if (isEmpty(state)) return null;
  const s = state.trim();
  if (ABBREVS.has(s.toUpperCase())) return s.toUpperCase();
  const hit = Object.entries(STATE_MAP).find(([, full]) => full.toLowerCase() === s.toLowerCase());
  return hit ? hit[0] : null;
}

function dupKey(shop) {
  const norm = normalizeNameForMatch(shop.name || '');
  if (!norm) return null;
  return `${norm}|${(shop.city || '').trim().toLowerCase()}|${(shop.state || '').trim().toLowerCase()}`;
}

// ── Per-shop assessment ────────────────────────────────────

/**
 * ctx: { now, columnsPresent: Set, dupNameKeys: Set, dupSlugs: Set, summaries: Map }
 * Returns { tier, score, maxScore, issues: [{code, severity, message, action}] }
 */
function assessShop(shop, ctx) {
  const { now, columnsPresent, dupNameKeys, dupSlugs, summaries } = ctx;
  const has = col => columnsPresent.has(col);
  const issues = [];
  const add = (code, severity, message, action = null) => issues.push({ code, severity, message, action });

  // ── closed ──
  if (has('business_status') && shop.business_status === 'CLOSED_PERMANENTLY') {
    add('CLOSED_PERMANENT', 'closed', 'Permanently closed (hidden on site)');
  }

  // ── suspect ──
  if (isEmpty(shop.latitude) || isEmpty(shop.longitude)) {
    add('NO_COORDS', 'suspect', 'Missing coordinates — invisible on the map', 'deep_scrape');
  } else if (shop.latitude < 18 || shop.latitude > 72 || shop.longitude < -180 || shop.longitude > -65) {
    add('BAD_COORDS', 'suspect', `Coordinates outside the US (${shop.latitude}, ${shop.longitude})`, 'deep_scrape');
  }

  const key = dupKey(shop);
  if (key && dupNameKeys.has(key)) {
    add('DUP_NAME_CITY', 'suspect', 'Another shop has the same normalized name in this city');
  }
  if (isEmpty(shop.slug)) {
    add('MISSING_SLUG', 'suspect', 'No slug — site cannot route to this shop', 'deep_scrape');
  } else if (dupSlugs.has(shop.slug)) {
    add('DUP_SLUG', 'suspect', 'Slug shared with another shop');
  }

  if (!validState(shop.state)) {
    add('BAD_STATE', 'suspect', `Unrecognized state: "${shop.state ?? ''}"`);
  }
  if (isEmpty(shop.city)) {
    add('NO_CITY', 'suspect', 'Missing city');
  }
  if (shop.enrichment_status === 'failed') {
    add('ENRICH_FAILED', 'suspect', 'Last enrichment failed', 'deep_scrape');
  }
  if (!isEmpty(shop.review_summary) && !(shop.review_count > 0)) {
    add('REVIEW_CONTRADICTION', 'suspect', 'Has a review summary but zero recorded reviews', 'reviews');
  }
  for (const field of URL_FIELDS) {
    if (!has(field) && NEW_COLUMNS.includes(field)) continue;
    if (!isEmpty(shop[field])) {
      try { new URL(shop[field]); } catch { add('BAD_URL', 'suspect', `Unparseable URL in ${field}: ${String(shop[field]).slice(0, 60)}`); }
    }
  }

  // ── needs_enrichment ──
  const score = scoreShopData(shop);

  const neverEnriched = isEmpty(shop.deep_scrape_at) &&
    (isEmpty(shop.enrichment_status) || shop.enrichment_status === 'pending');
  if (neverEnriched) {
    add('NEVER_ENRICHED', 'needs', 'Never been through the enrichment pipeline', 'deep_scrape');
  } else if (!isEmpty(shop.deep_scrape_at) && monthsAgo(shop.deep_scrape_at, now) > CONFIG.staleMonths) {
    add('STALE_SCRAPE', 'needs', `Last deep scrape over ${CONFIG.staleMonths} months ago`, 'deep_scrape');
  }
  if (shop.enrichment_status === 'partial') {
    add('PARTIAL', 'needs', 'Enrichment marked partial', 'deep_scrape');
  }
  if (score < CONFIG.lowScore) {
    add('LOW_SCORE', 'needs', `Data score ${score}/${CONFIG.maxScore}`, 'deep_scrape');
  }
  if (isEmpty(shop.website) && isEmpty(shop.phone)) {
    add('NO_CONTACT', 'needs', 'No website and no phone', 'deep_scrape');
  }
  if (isEmpty(shop.description) && isEmpty(shop.long_description)) {
    add('NO_DESCRIPTION', 'needs', 'No description', 'deep_scrape');
  }
  if (isEmpty(shop.hours) && isEmpty(shop.hours_text)) {
    add('NO_HOURS', 'needs', 'No opening hours', 'deep_scrape');
  }
  if (isEmpty(shop.image_hero_url)) {
    add('NO_HERO', 'needs', 'No hero image', 'deep_scrape');
  }
  if (shop.review_count > 0 && isEmpty(shop.review_summary)) {
    add('REVIEWS_UNSUMMARIZED', 'needs', `${shop.review_count} reviews captured but no summary written`, 'reviews');
  }
  if (has('business_status') && shop.business_status === 'CLOSED_TEMPORARILY') {
    add('CLOSED_TEMP', 'needs', 'Marked temporarily closed — recheck', 'verify_status');
  }

  const summary = summaries.get(shop.id);
  if (summary && summary.scrapers) {
    const failed = Object.entries(summary.scrapers)
      .filter(([, s]) => s && s.status && s.status !== 'success' && s.status !== 'skipped')
      .map(([name]) => name);
    if (failed.length > 0) {
      add('SCRAPER_FAILURES', 'needs', `Pipeline steps failed: ${failed.join(', ')}`, 'deep_scrape');
    }
  }

  // ── advisory (reported, never demotes) ──
  if (has('google_place_id') && isEmpty(shop.google_place_id)) {
    add('NO_PLACE_ID', 'needs', 'No Google place_id (dedup/status checks unavailable)', 'place_id');
  }
  if (has('business_status_checked_at') &&
      (isEmpty(shop.business_status_checked_at) || daysAgo(shop.business_status_checked_at, now) > CONFIG.statusStaleDays)) {
    add('STATUS_UNVERIFIED', 'needs', `Business status not verified in ${CONFIG.statusStaleDays}+ days`, 'verify_status');
  }

  // ── tier resolution ──
  let tier;
  const nonAdvisory = issues.filter(i => !CONFIG.advisoryCodes.has(i.code));
  if (issues.some(i => i.severity === 'closed')) {
    tier = 'closed';
  } else if (nonAdvisory.some(i => i.severity === 'suspect')) {
    tier = 'suspect';
  } else if (nonAdvisory.some(i => i.severity === 'needs')) {
    tier = 'needs_enrichment';
  } else if (score >= CONFIG.goodMinScore) {
    tier = 'good';
  } else {
    tier = 'needs_enrichment';
    add('LOW_SCORE', 'needs', `Data score ${score}/${CONFIG.maxScore} below good threshold (${CONFIG.goodMinScore})`, 'deep_scrape');
  }

  return { tier, score, maxScore: CONFIG.maxScore, issues };
}

// ── Report ─────────────────────────────────────────────────

function latestVinylhubReport() {
  const dir = path.join(__dirname, '..', 'content', '_vinylhub_discovery');
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter(f => f.startsWith('vinylhub_') && f.endsWith('.json')).sort();
  if (files.length === 0) return null;
  return loadJSON(path.join(dir, files[files.length - 1]));
}

async function buildQualityReport() {
  const now = Date.now();

  const { data: shops, error } = await supabase.from('shops').select('*');
  if (error) throw error;

  const columnsPresent = new Set(shops.length > 0 ? Object.keys(shops[0]) : []);
  const missingColumns = NEW_COLUMNS.filter(c => !columnsPresent.has(c));

  // Duplicate passes (O(n))
  const keyCounts = new Map();
  const slugCounts = new Map();
  for (const shop of shops) {
    const key = dupKey(shop);
    if (key) keyCounts.set(key, (keyCounts.get(key) || 0) + 1);
    if (!isEmpty(shop.slug)) slugCounts.set(shop.slug, (slugCounts.get(shop.slug) || 0) + 1);
  }
  const dupNameKeys = new Set([...keyCounts].filter(([, n]) => n > 1).map(([k]) => k));
  const dupSlugs = new Set([...slugCounts].filter(([, n]) => n > 1).map(([k]) => k));

  // Scrape summaries from disk
  const summaries = new Map();
  for (const shop of shops) {
    const p = contentDir(shop.id, 'deep_scrape_summary.json');
    if (fs.existsSync(p)) {
      const s = loadJSON(p);
      if (s) summaries.set(shop.id, s);
    }
  }

  const ctx = { now, columnsPresent, dupNameKeys, dupSlugs, summaries };

  // Assess every shop
  const tiers = { good: 0, needs_enrichment: 0, suspect: 0, closed: 0 };
  const staleness = { neverEnriched: 0, stale: 0, fresh: 0 };
  const reasonCounts = {};
  let scoreSum = 0;
  let deepScraped = 0;

  const shopRows = shops.map(shop => {
    const a = assessShop(shop, ctx);
    tiers[a.tier]++;
    scoreSum += a.score;
    if (!isEmpty(shop.deep_scrape_at)) deepScraped++;

    const reasons = a.issues.map(i => i.code);
    for (const r of reasons) reasonCounts[r] = (reasonCounts[r] || 0) + 1;

    if (reasons.includes('NEVER_ENRICHED')) staleness.neverEnriched++;
    else if (reasons.includes('STALE_SCRAPE')) staleness.stale++;
    else staleness.fresh++;

    const actions = [...new Set(a.issues.map(i => i.action).filter(Boolean))];

    return {
      id: shop.id,
      name: shop.name,
      city: shop.city,
      state: shop.state,
      slug: shop.slug || null,
      tier: a.tier,
      score: a.score,
      maxScore: a.maxScore,
      priority: priorityScore(a.tier, a.issues, a.score),
      reasons,
      issues: a.issues,
      actions,
      deep_scrape_at: shop.deep_scrape_at || null,
      date_of_enrichment: shop.date_of_enrichment || null,
      enrichment_status: shop.enrichment_status || null,
      business_status: columnsPresent.has('business_status') ? shop.business_status : null,
      website: shop.website || null,
      discovery_source: columnsPresent.has('discovery_source') ? shop.discovery_source : null,
    };
  });

  // Coverage: states
  const stateCounts = new Map(Object.keys(STATE_MAP).map(a => [a, 0]));
  let unrecognized = 0;
  const cityCounts = new Map();
  for (const shop of shops) {
    if (columnsPresent.has('business_status') && shop.business_status === 'CLOSED_PERMANENTLY') continue;
    const ab = stateAbbrev(shop.state);
    if (ab) stateCounts.set(ab, stateCounts.get(ab) + 1);
    else unrecognized++;
    if (!isEmpty(shop.city) && ab) {
      const ck = `${shop.city.trim()}|${ab}`;
      cityCounts.set(ck, (cityCounts.get(ck) || 0) + 1);
    }
  }

  const vinylhub = latestVinylhubReport();
  const vhByState = vinylhub?.byState || null;

  const states = [...stateCounts].map(([abbrev, count]) => ({
    abbrev,
    name: STATE_MAP[abbrev],
    count,
    vinylhubCount: vhByState ? (vhByState[abbrev] || 0) : null,
  })).sort((a, b) => b.count - a.count);

  const topCities = [...cityCounts]
    .sort((a, b) => b[1] - a[1])
    .slice(0, CONFIG.topCities)
    .map(([ck, count]) => {
      const [city, state] = ck.split('|');
      return { city, state, count };
    });

  const activeShops = shops.length - tiers.closed;

  // Field coverage histogram
  const fieldCoverage = FIELD_COVERAGE_FIELDS
    .filter(f => columnsPresent.has(f))
    .map(field => {
      const present = shops.filter(s => {
        const v = s[field];
        if (Array.isArray(v)) return v.length > 0;
        return !isEmpty(v);
      }).length;
      return { field, present, pct: Math.round((present / shops.length) * 100) };
    })
    .sort((a, b) => a.pct - b.pct);

  // Duplicate detail list
  const dupMap = new Map();
  for (const shop of shops) {
    const key = dupKey(shop);
    if (key && dupNameKeys.has(key)) {
      if (!dupMap.has(key)) dupMap.set(key, []);
      dupMap.get(key).push({ id: shop.id, name: shop.name, city: shop.city, state: shop.state });
    }
  }
  const duplicates = [...dupMap].map(([key, dupShops]) => ({ key, shops: dupShops }));

  return {
    generatedAt: new Date(now).toISOString(),
    totalShops: shops.length,
    siteBaseUrl: CONFIG.siteBaseUrl,
    missingColumns,
    config: {
      staleMonths: CONFIG.staleMonths,
      statusStaleDays: CONFIG.statusStaleDays,
      lowScore: CONFIG.lowScore,
      goodMinScore: CONFIG.goodMinScore,
      maxScore: CONFIG.maxScore,
    },
    tiers,
    staleness,
    avgScore: Math.round((scoreSum / Math.max(shops.length, 1)) * 10) / 10,
    deepScrapedPct: Math.round((deepScraped / Math.max(shops.length, 1)) * 100),
    reasonCounts,
    coverage: {
      statesCovered: states.filter(s => s.count > 0).length,
      totalStates: Object.keys(STATE_MAP).length,
      unrecognizedStateShops: unrecognized,
      states,
      topCities,
      vinylhub: vinylhub ? {
        usStoreCount: vinylhub.usStoreCount || null,
        dbCount: activeShops,
        pct: vinylhub.usStoreCount ? Math.round((activeShops / vinylhub.usStoreCount) * 100) : null,
        reportTimestamp: vinylhub.timestamp || null,
        hasByState: !!vhByState,
      } : null,
    },
    fieldCoverage,
    duplicates,
    shops: shopRows,
  };
}

module.exports = { assessShop, buildQualityReport, CONFIG };

// ── CLI smoke test ─────────────────────────────────────────

if (require.main === module) {
  buildQualityReport()
    .then(report => {
      const { tiers, staleness, coverage, totalShops } = report;
      console.log(`\nShops: ${totalShops}  (avg score ${report.avgScore}/${report.config.maxScore}, ${report.deepScrapedPct}% deep-scraped)`);
      console.log(`Tiers: good=${tiers.good} needs_enrichment=${tiers.needs_enrichment} suspect=${tiers.suspect} closed=${tiers.closed}  (sum=${Object.values(tiers).reduce((a, b) => a + b, 0)})`);
      console.log(`Staleness: never=${staleness.neverEnriched} stale=${staleness.stale} fresh=${staleness.fresh}`);
      console.log(`States covered: ${coverage.statesCovered}/${coverage.totalStates}  (unrecognized-state shops: ${coverage.unrecognizedStateShops})`);
      if (coverage.vinylhub) console.log(`VinylHub: ${coverage.vinylhub.dbCount}/${coverage.vinylhub.usStoreCount} (${coverage.vinylhub.pct}%)`);
      console.log(`Missing columns: ${report.missingColumns.length ? report.missingColumns.join(', ') : 'none'}`);
      console.log(`Duplicate name+city groups: ${report.duplicates.length}`);
      console.log('\nTop issues:');
      Object.entries(report.reasonCounts).sort((a, b) => b[1] - a[1]).slice(0, 12)
        .forEach(([code, n]) => console.log(`  ${code.padEnd(22)} ${n}`));
      console.log('\nWorst field coverage:');
      report.fieldCoverage.slice(0, 8).forEach(f => console.log(`  ${f.field.padEnd(22)} ${f.pct}%`));
    })
    .catch(err => {
      console.error('💀', err.message);
      process.exit(1);
    });
}
