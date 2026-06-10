#!/usr/bin/env node
/**
 * Founded-Year Enrichment via the Wayback Machine
 *
 * "Serving collectors since 1987" is exactly the kind of credential the
 * review prompt leads with — but founded_year is null for most shops.
 * This script fills it conservatively:
 *
 *   1. Scan already-scraped website content (content/{shopId}/website/)
 *      for "est./established/since/founded YYYY" phrasing
 *   2. Query the Wayback Machine CDX API for the site's earliest snapshot
 *      and scan THAT page too — old homepages often state a founding year
 *      that has since been redesigned away
 *   3. With --llm, ambiguous snippets are adjudicated by Claude with a
 *      strict "null unless explicit" schema
 *
 * The earliest-snapshot year itself is NEVER written as founded_year (a
 * 2004 first crawl doesn't mean founded 2004) — it's saved as evidence in
 * content/{shopId}/wayback/founded.json. founded_year is only written
 * when a year is explicitly claimed, is plausible (1900..now), and the
 * column is currently null.
 *
 * Usage:
 *   node enrich_founded_year_wayback.js --all --limit 25
 *   node enrich_founded_year_wayback.js --shop-id "uuid"
 *   node enrich_founded_year_wayback.js --all --limit 25 --llm   # Claude adjudication
 *   node enrich_founded_year_wayback.js --dry-run --all
 */

const fs = require('fs');
const path = require('path');
const { supabase, updateShop, parseArgs, log, saveJSON, loadJSON, contentDir,
  anthropicSummarize } = require('./lib/common');

const CDX_URL = 'https://web.archive.org/cdx/search/cdx';
const USER_AGENT = 'RecordShopEnricher/2.4 (+https://github.com/jgtslaterjr/record-shop-enricher)';
const CURRENT_YEAR = new Date().getFullYear();

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Year extraction ────────────────────────────────────────

const FOUNDED_PATTERNS = [
  /\b(?:est(?:ablished)?\.?|founded|opened|serving[^.]{0,40}since|in business since|since)\s*(?:in\s*)?((?:19|20)\d{2})\b/gi,
  /\b((?:19|20)\d{2})\s*(?:—|-|–)?\s*(?:est\.?|established)\b/gi,
];

function extractFoundedYear(text) {
  if (!text) return null;
  const hits = [];
  for (const pattern of FOUNDED_PATTERNS) {
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(text)) !== null) {
      const year = parseInt(m[1]);
      if (year >= 1900 && year <= CURRENT_YEAR) {
        const start = Math.max(0, m.index - 80);
        hits.push({ year, snippet: text.slice(start, m.index + m[0].length + 40).replace(/\s+/g, ' ').trim() });
      }
    }
  }
  if (hits.length === 0) return null;
  // Multiple claims → take the earliest (rebrands restate later dates)
  hits.sort((a, b) => a.year - b.year);
  return hits[0];
}

function gatherLocalWebsiteText(shopId) {
  const websiteDir = contentDir(shopId, 'website');
  if (!fs.existsSync(websiteDir)) return '';
  let text = '';
  for (const file of fs.readdirSync(websiteDir).filter(f => f.endsWith('.json'))) {
    const data = loadJSON(path.join(websiteDir, file));
    if (data?.text) text += `\n${data.text}`;
  }
  return text;
}

// ── Wayback Machine ────────────────────────────────────────

async function earliestSnapshot(websiteUrl) {
  let domain;
  try {
    domain = new URL(websiteUrl).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
  const params = new URLSearchParams({
    url: domain,
    output: 'json',
    filter: 'statuscode:200',
    collapse: 'timestamp:6', // one per month
    limit: '3',
  });
  const res = await fetch(`${CDX_URL}?${params}`, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`CDX API ${res.status}`);
  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length < 2) return null;
  // rows[0] is the header; rows[1] the earliest capture
  const [, ts, original] = rows[1];
  return { timestamp: ts, year: parseInt(ts.slice(0, 4)), url: `https://web.archive.org/web/${ts}/${original}` };
}

async function fetchArchivedText(snapshotUrl) {
  const res = await fetch(snapshotUrl, { headers: { 'User-Agent': USER_AGENT }, redirect: 'follow' });
  if (!res.ok) return '';
  const html = await res.text();
  // Strip tags/scripts crudely — we only need prose for the year regex
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, 50000);
}

// ── Claude adjudication (opt-in) ───────────────────────────

const LLM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['founded_year', 'evidence'],
  properties: {
    founded_year: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
    evidence: { anyOf: [{ type: 'string' }, { type: 'null' }] },
  },
};

async function adjudicateWithClaude(shopName, snippets) {
  const prompt = `These text snippets are from the website (current and archived) of the record shop "${shopName}".
Determine the year the shop was FOUNDED, only if a snippet explicitly states it (e.g. "est. 1987", "serving Austin since 1992").
Do NOT infer from copyright years, review dates, or the age of the website itself. If no snippet makes an explicit founding claim, return null.

Snippets:
${snippets.map((s, i) => `${i + 1}. ${s}`).join('\n')}`;

  const result = await anthropicSummarize(prompt, { schema: LLM_SCHEMA, maxTokens: 2000 });
  const parsed = JSON.parse(result);
  if (parsed.founded_year && (parsed.founded_year < 1900 || parsed.founded_year > CURRENT_YEAR)) return { founded_year: null, evidence: null };
  return parsed;
}

// ── Per-shop flow ──────────────────────────────────────────

async function enrichShop(shop, { dryRun, useLLM }) {
  log(`\n📼 ${shop.name} (${shop.city}, ${shop.state})`);

  const evidence = {
    shopId: shop.id,
    website: shop.website,
    checkedAt: new Date().toISOString(),
    localMatch: null,
    waybackSnapshot: null,
    waybackMatch: null,
    llm: null,
    decided: null,
  };

  // 1. Local website content already on disk
  const localText = gatherLocalWebsiteText(shop.id);
  evidence.localMatch = extractFoundedYear(localText);
  if (evidence.localMatch) {
    log(`  ✓ Website content claims ${evidence.localMatch.year}: "${evidence.localMatch.snippet.slice(0, 100)}..."`);
  }

  // 2. Wayback earliest snapshot
  let archivedText = '';
  if (shop.website) {
    try {
      evidence.waybackSnapshot = await earliestSnapshot(shop.website);
      if (evidence.waybackSnapshot) {
        log(`  🕰  Earliest archive: ${evidence.waybackSnapshot.year}`);
        archivedText = await fetchArchivedText(evidence.waybackSnapshot.url);
        evidence.waybackMatch = extractFoundedYear(archivedText);
        if (evidence.waybackMatch) {
          log(`  ✓ Archived page claims ${evidence.waybackMatch.year}: "${evidence.waybackMatch.snippet.slice(0, 100)}..."`);
        }
      } else {
        log('  ✗ No archive snapshots found');
      }
    } catch (e) {
      log(`  ⚠️  Wayback error: ${e.message}`);
    }
  } else {
    log('  ✗ No website on record — local content only');
  }

  // 3. Decide
  let decided = null;
  const regexHits = [evidence.localMatch, evidence.waybackMatch].filter(Boolean);
  if (regexHits.length > 0) {
    decided = Math.min(...regexHits.map(h => h.year));
  } else if (useLLM) {
    // Regex found nothing explicit — let Claude look at year-adjacent snippets
    const candidates = [];
    for (const text of [localText, archivedText]) {
      if (!text) continue;
      const re = /(?:19|20)\d{2}/g;
      let m;
      while ((m = re.exec(text)) !== null && candidates.length < 12) {
        const start = Math.max(0, m.index - 120);
        candidates.push(text.slice(start, m.index + 120).replace(/\s+/g, ' ').trim());
      }
    }
    if (candidates.length > 0) {
      try {
        evidence.llm = await adjudicateWithClaude(shop.name, candidates);
        if (evidence.llm.founded_year) {
          decided = evidence.llm.founded_year;
          log(`  ✓ Claude: ${decided} ("${(evidence.llm.evidence || '').slice(0, 100)}")`);
        }
      } catch (e) {
        log(`  ⚠️  Claude adjudication failed: ${e.message}`);
      }
    }
  }

  // Sanity check: a founding year after the earliest crawl + slack is fine,
  // but a year BEFORE 1900 or in the future was filtered already
  evidence.decided = decided;
  saveJSON(contentDir(shop.id, 'wayback', 'founded.json'), evidence);

  if (!decided) {
    log('  ✗ No explicit founding year found');
    return false;
  }

  if (dryRun) {
    log(`  ✓ [DRY] Would set founded_year = ${decided}`);
  } else {
    await updateShop(shop.id, { founded_year: decided });
    log(`  ✓ Set founded_year = ${decided}`);
  }
  return true;
}

// ── CLI ────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();
  const dryRun = !!args['dry-run'];
  const useLLM = !!args.llm;

  if (dryRun) log('⚠️  DRY RUN — no database writes');

  let shops;
  if (args['shop-id']) {
    const { data, error } = await supabase.from('shops').select('id, name, city, state, website, founded_year').eq('id', args['shop-id']).single();
    if (error || !data) {
      log(`❌ Shop not found: ${args['shop-id']}`);
      process.exit(1);
    }
    shops = [data];
  } else if (args.all) {
    let query = supabase
      .from('shops')
      .select('id, name, city, state, website, founded_year')
      .is('founded_year', null)
      .not('website', 'is', null)
      .order('name');
    if (args.limit) query = query.limit(parseInt(args.limit));
    const { data, error } = await query;
    if (error) throw error;
    shops = data;
  } else {
    console.log('\nUsage:');
    console.log('  node enrich_founded_year_wayback.js --all --limit 25');
    console.log('  node enrich_founded_year_wayback.js --shop-id "uuid"');
    console.log('  node enrich_founded_year_wayback.js --all --llm    # Claude adjudication of ambiguous text');
    process.exit(0);
  }

  log(`📡 ${shops.length} shops to check`);

  let found = 0;
  for (let i = 0; i < shops.length; i++) {
    if (shops[i].founded_year && !args.force) {
      log(`⏭ ${shops[i].name}: founded_year already set`);
      continue;
    }
    try {
      if (await enrichShop(shops[i], { dryRun, useLLM })) found++;
    } catch (e) {
      log(`  ❌ Error: ${e.message}`);
    }
    // Be polite to the Wayback Machine
    if (i < shops.length - 1) await sleep(1500);
  }

  log(`\n📊 founded_year resolved for ${found}/${shops.length} shops`);
}

main().catch(err => {
  console.error('💀 Fatal error:', err.message);
  process.exit(1);
});
