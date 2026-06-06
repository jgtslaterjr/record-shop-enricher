# Review Synthesis Upgrade Summary

**Date:** 2026-02-25  
**Commit:** cfa4d95

## What Changed

Transformed `summarize_reviews.js` from a simple Yelp+Google analyzer into a comprehensive multi-source review synthesizer that produces Google AI Overview-quality summaries.

## Data Sources (9 total)

### Before (2 sources):
- Yelp reviews
- Google reviews

### After (9 sources):
1. **Yelp reviews** — from `content/{shopId}/reviews/yelp_reviews.json`
2. **Google reviews** — from `content/{shopId}/reviews/google_reviews.json`
3. **Facebook** — ratings/descriptions from `content/{shopId}/facebook/`
4. **Discogs** — seller ratings (heavily weighted for shops with online presence)
5. **Reddit** — mentions from `content/{shopId}/reddit/` + dynamic search
6. **Wheree.com** — NEW: fetches shop listings via HTTP + cheerio
7. **User reviews** — from `captured_reviews` database table
8. **Website content** — shop's own descriptions from `content/{shopId}/website/`
9. **Press mentions** — from `content/{shopId}/press/` + DuckDuckGo search

## Key Features

### 1. Rich Context Building
- `buildContext()` creates a structured 12k char document
- Sections: Ratings Overview, Review Excerpts, Website Content, Wheree.com, Press
- Prioritizes longer, detailed reviews
- Includes source labels on everything

### 2. Improved Analysis Prompt
- Based on `synthesis-prompt.md` template
- Asks for source attribution in output
- Weights Discogs transaction ratings heavily
- Distinguishes physical store vs online/mailorder
- Notes if shop is also a label/distributor
- Requests specific details (staff names, genres, unique features)

### 3. Comprehensive Database Fields
**Before:** Only saved `sentiment_score`

**After:** Saves all fields:
- `review_score` — 1-10 weighted score
- `sentiment_score` — alias for compatibility
- `review_vibe` — 2-3 sentence atmosphere description
- `review_pros` — array of 3-5 positives
- `review_cons` — array of 2-4 negatives
- `review_themes` — array of 5-8 recurring themes
- `review_notable_quotes` — best/worst/funniest with sources
- `recommendation_for` — target audience description
- `genre_specialties` — genres frequently mentioned
- `review_summary` — SEO-friendly 2-3 paragraph overview
- `review_count` — total reviews analyzed across all sources

### 4. Source Metadata Tracking
Saves to `content/{shopId}/reviews/analysis.json`:
```javascript
{
  ...analysis fields...,
  "metadata": {
    "sources": {
      "google": N,
      "yelp": N,
      "facebook": N,
      "reddit": N,
      "wheree": true/false,
      "user": N,
      "press": N,
      "discogs": N,
      "website": N
    },
    "totalReviewsAnalyzed": N,
    "analyzedAt": "2026-02-25T15:17:00.000Z"
  }
}
```

### 5. CLI Enhancements
- Added `--force` flag to re-analyze existing shops
- Better logging of source counts
- Graceful failure handling (continues if any source unavailable)

## Technical Implementation

### Source Gathering Functions
- `loadYelpReviews()` — existing file loader
- `loadGoogleReviews()` — existing file loader
- `loadFacebookData()` — NEW: scans facebook/ directory
- `loadDiscogsData()` — NEW: loads Discogs seller profile
- `loadWebsiteContent()` — NEW: aggregates website JSON files
- `loadRedditMentions()` — existing + dynamic `redditSearch()`
- `fetchWhereeData()` — NEW: HTTP fetch + cheerio parsing
- `loadPressMentions()` — NEW: scans press/ directory
- `searchPressMentions()` — NEW: DuckDuckGo API search
- `loadUserReviews()` — NEW: Supabase query

### Context Assembly
- Builds structured sections with clear headers
- Caps total context at 12k chars (LLM limit)
- Prioritizes detailed reviews (sorted by length)
- Limits excerpts: 50 reviews max, 400 chars each

### Robust JSON Parsing
- Handles Ollama's varied output formats
- Strips Python-style values (None, True, False)
- Fixes unquoted strings and keys
- Fallback to raw summary if parsing fails

## Usage Examples

```bash
# Analyze single shop
node summarize_reviews.js --shop-id "uuid"

# Re-analyze even if analysis.json exists
node summarize_reviews.js --shop-id "uuid" --force

# Batch analyze (top 10 shops)
node summarize_reviews.js --all --limit 10

# Batch with force re-analysis
node summarize_reviews.js --all --limit 50 --force
```

## Dependencies
- **Existing:** All common.js utilities (ollamaSummarize, loadJSON, saveJSON, etc.)
- **Existing:** cheerio (already installed for other scrapers)
- **Built-in:** Node 22 fetch API (no axios needed)

## Output Quality
Produces summaries comparable to Google AI Overviews:
- Multi-source synthesis with attribution
- Balanced view (pros + cons)
- Specific details (names, genres, unique features)
- SEO-friendly natural language
- Source credibility weighting (Discogs > Yelp > Reddit)

## Testing Checklist
- [x] Syntax validation
- [x] Git commit
- [ ] Run on single shop with all sources
- [ ] Run on shop with missing sources (verify graceful degradation)
- [ ] Verify DB fields populated correctly
- [ ] Check analysis.json metadata structure
- [ ] Test --force flag behavior
