# Enrichment Improvements — Feb 25, 2026

Based on manual review of 939 Records, which had poor enrichment despite being a well-established shop. Our enricher missed: website, phone, owner name, tagline, Facebook page, and Discogs profile.

## Problem Analysis

### What we missed for 939 Records:
- **Website**: midnitememoriesradio.com — non-obvious domain, wouldn't match "939 Records"
- **Owner**: Joe Parknavy — on the About page
- **Phone**: 412-860-4096 — on the website
- **Tagline**: "Pittsburgh's first online record store"
- **Facebook**: facebook.com/p/939-Records-61566799180474/
- **Discogs**: discogs.com/user/939Records — 5 stars, 2171 ratings (huge quality signal)

### Root causes:
1. **Discogs is completely ignored** — vinylhub.discogs.com is in SKIP_DOMAINS, and we never search discogs.com/user/ or discogs.com/seller/
2. **Discovery misses non-obvious websites** — DuckDuckGo search may not surface midnitememoriesradio.com for "939 Records"
3. **Website scraper extracts phones/emails but doesn't persist them** to the shop DB record
4. **No owner name extraction** from About pages
5. **Facebook pages discovered but not scraped** for structured data (address, phone, about text)

## Improvements to Implement

### 1. Discogs Integration (NEW SCRAPER: `scrape_discogs.js`)
- Search discogs.com for the shop name
- Check both `/user/{name}` and `/seller/{name}` endpoints
- Extract: seller rating, total ratings, marketplace activity, location
- Save `social_discogs` URL to DB (may need new column or use description)
- **Priority: HIGH** — Discogs ratings are the #1 quality signal for record shops

### 2. Enhanced Link Discovery (`discover_links.js`)
- **Remove** `vinylhub.discogs.com` from SKIP_DOMAINS
- **Add** Discogs user/seller URL categorization:
  ```
  if (lower.includes('discogs.com/user/') || lower.includes('discogs.com/seller/'))
    return { category: 'discogs', url }
  ```
- Add a secondary search query: `"{shop name}" discogs` to find Discogs profiles
- Add a secondary search query: `"{shop name}" {city} record store` (broader discovery)

### 3. Website → DB Field Extraction (`scrape_shop_website.js`)
After crawling, extract and persist:
- **Phone**: Already extracted as `phoneMatches` — write the first valid one to `shops.phone` if null
- **Owner name**: Look for patterns on /about, /staff pages:
  - "owned by {name}", "owner: {name}", "founded by {name}"
  - Staff page with "owner" or "proprietor" title
  - LD+JSON `founder` or `employee` with role
- **Tagline/description**: First meaningful `<meta name="description">` or homepage h1/h2 → write to `description` if null
- **Email**: Extract and store (consider adding `email` column or putting in description)

### 4. Facebook Scraping Enhancement (`capture_facebook_browser.js` / `facebook_mobile_scraper.js`)
When we find a Facebook page:
- Extract the "About" section → phone, address, hours, description
- Cross-reference address with our DB (update if ours is less specific)
- Extract owner name if listed

### 5. Master Orchestrator Update (`master_deep_scrape.js`)
Add Discogs scraper to the pipeline:
```javascript
{
  name: 'discogs',
  skip: args['skip-discogs'],
  run: async () => {
    await runScript('scrape_discogs.js', ['--shop-id', shop.id]);
  }
}
```

### 6. Post-Scrape Field Extraction (NEW: `extract_fields.js`)
Run after all scrapers complete. Reads the scraped content files and fills empty DB fields:
- Reads `content/{shopId}/website/*.json` for phone, owner, description
- Reads `content/{shopId}/facebook/*.json` for phone, address, owner
- Reads `content/{shopId}/discogs/*.json` for ratings, activity level
- Only fills fields that are currently NULL (never overwrites human-provided data)
- Add as final step in master_deep_scrape.js pipeline

## DB Schema Changes Needed
- Consider adding: `social_discogs` TEXT, `discogs_rating` NUMERIC, `discogs_ratings_count` INTEGER
- Or store Discogs data in existing fields (description, long_description)

## Implementation Order
1. Fix discover_links.js (Discogs categorization, remove from skip list) — quick win
2. Create scrape_discogs.js — new scraper
3. Create extract_fields.js — post-scrape field filler
4. Update master_deep_scrape.js — add new steps
5. Enhance Facebook scraping — lower priority, harder due to auth
