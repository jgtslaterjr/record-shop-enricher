# New Data Sources & Verification Stack (June 2026)

Nine additions to the enrichment stack: four discovery sources, place_id-based
dedup, monthly closure verification (with site-side hiding), the Discogs REST
API, TripAdvisor review scraping, Wayback founded-year enrichment, and
DuckDuckGo rate-limit resilience.

---

## ⚠️ One-time setup (in this order)

1. **Run the migration** — paste `add-enrichment-source-columns.sql` into the
   Supabase SQL Editor. Adds `google_place_id`, `business_status`,
   `business_status_checked_at`, `tripadvisor_url`, `discovery_source`,
   `rsd_participant`. Everything below (and the site filter) depends on it.

2. **Add keys to `.env`:**
   ```
   DISCOGS_TOKEN=...        # discogs.com/settings/developers → personal access token
                            # optional but recommended: 60 req/min vs 25 unauthenticated
   FOURSQUARE_API_KEY=...   # foursquare.com/developers — legacy fsq3 or new service key both work
   ```
   Already present and reused: `GOOGLE_API_KEY`, `APIFY_API_TOKEN`, `ANTHROPIC_API_KEY`, `BRAVE_KEY`.

3. **Approve the Apify TripAdvisor actor** (one click, one time):
   the first `deep_scrape_tripadvisor.js` run prints an approval URL like
   `https://console.apify.com/actors/...` — open it and approve. TripAdvisor
   blocks even the stealth browser, so the Apify fallback does the real work.

4. **Deploy record-shop-site** — all 11 public shop queries now filter
   `.neq('business_status', 'CLOSED_PERMANENTLY')`. Deploy **after** the
   migration (the column must exist) and rebuild so the homepage/sitemap
   (build-time queries) pick it up.

---

## Discovery (run occasionally, e.g. quarterly)

| Script | Source | What it found in dry-run |
|---|---|---|
| `node discover_vinylhub.js` | Discogs record-store directory (single 4MB fetch, no key) | **735 new US shops**, 252 matches backfilled |
| `node discover_rsd.js` | Record Store Day participating stores, per state (slow on purpose: AWS WAF) | OK alone: 10 new / 16; sets `rsd_participant` |
| `node discover_foursquare.js` | Foursquare Places, top-60 cities (needs key) | untested until key arrives |
| `node discover_from_google_places.js` | existing Google discoverer | unchanged |

All three new discoverers: `--dry-run`, `--state XX` / `--city "X, ST"`,
`--limit N`, `--resume`. New shops are inserted as **stubs**
(`discovery_source` set) — enrich them on demand:
`node master_deep_scrape.js --shop-id <id>`.

## Dedup & closure verification

```
node backfill_place_ids.js            # once after migration (~$15), then after each discovery wave
node verify_business_status.js        # monthly (~$15/month) — flags closures
```

- Backfill resolves each shop to a `google_place_id` via Find Place, but only
  saves when the candidate is corroborated by name, coordinates, or street
  address; the rest land in `content/_place_id_backfill/` for manual review.
- The unique index on `google_place_id` makes future discovery dedup
  bulletproof (`lib/common.js findExistingShop()` already checks it).
- The status sweep writes `business_status` + timestamp; `CLOSED_PERMANENTLY`
  rows vanish from the site (listings, search, sitemap, detail page → 404)
  while staying in the DB. Stale place_ids (Google NOT_FOUND) are cleared for
  re-backfill. Report: `content/_business_status/`.

## Per-shop enrichment (now part of master_deep_scrape)

- **TripAdvisor** (`deep_scrape_tripadvisor.js`, new pipeline step before
  discogs): resolves the page from `tripadvisor_url` → discovery JSONs → DDG,
  scrapes rating/count/excerpts (stealth browser, Apify fallback), writes
  `content/{id}/reviews/tripadvisor_reviews.json`. summarize_reviews.js now
  folds TripAdvisor into the ratings overview and excerpts.
- **Discogs** (`scrape_discogs.js`, rewritten): official REST API instead of
  HTML scraping. Pulls seller rating %, rating count, inventory size,
  location, member-since. Guessed usernames must be corroborated
  (location/website/exact name) before being attached. Writes the canonical
  `content/{id}/discogs/profile.json` — **fixing a real bug**: the old script
  only wrote timestamped files, so Discogs ratings never actually reached the
  review prompt.
- **Founded year** (`enrich_founded_year_wayback.js`, standalone): scans
  current + earliest-archived website text for "est./since YYYY"
  (`--llm` adds Claude adjudication). Never infers from crawl dates. Verified
  hit on first dry-run: 2nd Avenue Records → "Since 1982" from a 2011 snapshot.

## Reliability

`lib/common.js ddgSearch()` — shared DuckDuckGo search with ~5s/15s/45s
exponential backoff on 429/202, used by `discover_links.js`,
`scrape_discogs.js`, and `deep_scrape_tripadvisor.js`.

## Suggested cadence

| When | What |
|---|---|
| Once now | migration → keys → `backfill_place_ids.js` → deploy site |
| Monthly | `verify_business_status.js` (then rebuild site so homepage/sitemap update) |
| Quarterly | discovery wave: vinylhub → rsd → foursquare → google, then `backfill_place_ids.js` for the new stubs |
| Per new shop | `master_deep_scrape.js --shop-id <id>` |
