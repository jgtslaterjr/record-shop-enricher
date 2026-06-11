#!/usr/bin/env node
/**
 * Migrate non-conforming shop slugs to the site convention (format A):
 *   <name-kebab>_<city-kebab>_<full-state-kebab>
 *   e.g. hear-we-are_studio-city_california
 *
 * Conforming slugs are left untouched (they are live, indexed URLs).
 * Usage:
 *   node migrate_slugs.js            # dry run — prints the plan
 *   node migrate_slugs.js --apply    # backs up, fixes states, updates slugs
 *
 * Outputs:
 *   slug-migration-backup-<ts>.json  — full prior rows of every changed shop
 *   slug-redirects.json              — { oldSlug: newSlug } for site-side redirects
 */
require('dotenv').config();
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');
const { generateSlug, slugSegment } = require('./lib/common');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// Shops with an empty state column; inferred from city/address (Pittsburgh-metro
// and Chicago-metro imports).
const STATE_FIXES = {
  '8d505f19-7648-4184-96b9-f92121f07f1c': 'Pennsylvania', // Attic Record Store Inc, Millvale
  '99499b47-5017-4119-9284-514dbe5c61ac': 'Pennsylvania', // Amazing Books & Records, Pittsburgh
  '509b5ae8-7271-40ac-96d4-ffdacb440c39': 'Pennsylvania', // C D Warehouse, Pittsburgh
  '43237181-988a-4d85-8f87-957b68f7fba5': 'Illinois',     // Algonquin Records, Des Plaines
  '92832ddc-0632-41b0-8199-f9f0ce5232ec': 'Illinois',     // Animal Records, Evanston
  '15db0671-314e-4185-936c-5ecbe59bfa81': 'Illinois',     // B-Side Records, Lemont
};

const SEGMENT_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function isConforming(slug, state) {
  if (!slug || !state) return false;
  const segs = slug.split('_');
  if (segs.length < 2 || segs.length > 3) return false;
  if (!segs.every(s => SEGMENT_RE.test(s))) return false;
  return segs[segs.length - 1] === slugSegment(state);
}

async function main() {
  const apply = process.argv.includes('--apply');

  const { data: shops, error } = await supabase
    .from('shops')
    .select('id, name, slug, city, state')
    .order('name')
    .limit(2000);
  if (error) throw new Error('Fetch failed: ' + error.message);
  console.log(`Fetched ${shops.length} shops`);

  const finalSlugs = new Set();
  const changes = [];

  // Pass 1: conforming slugs are fixed points — reserve them first.
  for (const s of shops) {
    const state = STATE_FIXES[s.id] || s.state;
    if (isConforming(s.slug, state)) finalSlugs.add(s.slug);
  }

  // Pass 2: compute new slugs for the rest.
  for (const s of shops) {
    const state = STATE_FIXES[s.id] || s.state;
    if (isConforming(s.slug, state)) continue;
    let newSlug = generateSlug(s.name, s.city, state);
    if (!newSlug) {
      console.error(`!! Cannot build slug for ${s.id} (${s.name}) — skipping`);
      continue;
    }
    if (finalSlugs.has(newSlug)) newSlug = `${newSlug}-${s.id.split('-')[0]}`;
    finalSlugs.add(newSlug);
    changes.push({
      id: s.id, name: s.name, city: s.city, state,
      stateFixed: Boolean(STATE_FIXES[s.id]),
      oldSlug: s.slug, newSlug,
    });
  }

  console.log(`\n${changes.length} shops need new slugs (${shops.length - changes.length} already conform)\n`);
  for (const c of changes) {
    console.log(`  ${c.oldSlug}  ->  ${c.newSlug}${c.stateFixed ? `   [state -> ${c.state}]` : ''}`);
  }

  const redirects = Object.fromEntries(
    changes.filter(c => c.oldSlug && c.oldSlug !== c.newSlug).map(c => [c.oldSlug, c.newSlug])
  );
  fs.writeFileSync('slug-redirects.json', JSON.stringify(redirects, null, 2));
  console.log(`\nWrote slug-redirects.json (${Object.keys(redirects).length} entries)`);

  if (!apply) {
    console.log('\nDry run — re-run with --apply to write to the database.');
    return;
  }

  // Backup full rows of every shop we are about to change.
  const ids = changes.map(c => c.id);
  const { data: backup, error: bErr } = await supabase.from('shops').select('*').in('id', ids);
  if (bErr) throw new Error('Backup fetch failed: ' + bErr.message);
  if (backup.length !== ids.length) throw new Error(`Backup verification failed: ${backup.length}/${ids.length}`);
  const backupFile = `slug-migration-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  fs.writeFileSync(backupFile, JSON.stringify(backup, null, 2));
  console.log(`Backup saved: ${backupFile}`);

  let ok = 0, failed = 0;
  for (const c of changes) {
    const payload = { slug: c.newSlug };
    if (c.stateFixed) payload.state = c.state;
    const { error: uErr } = await supabase.from('shops').update(payload).eq('id', c.id);
    if (uErr) {
      failed++;
      console.error(`  FAILED ${c.name}: ${uErr.message}`);
    } else {
      ok++;
    }
  }
  console.log(`\nDone: ${ok} updated, ${failed} failed.`);
  if (failed > 0) process.exitCode = 1;
}

main().catch(e => { console.error(e); process.exit(1); });
