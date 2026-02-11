# Content Capture Architecture

**Two-tier system: Enrichment (metadata) + Capture (content archives)**

## Philosophy

### Enrichment = Lightweight Metadata
Fast, frequent, database-stored facts about a shop.

### Capture = Complete Content Archive
Slow, comprehensive, file-stored copies of everything.

## The System

```
┌─────────────────────────────────────────────────────────────┐
│                    RECORD SHOP ENRICHER                      │
└─────────────────────────────────────────────────────────────┘

┌──────────────────────────┐  ┌──────────────────────────────┐
│   TIER 1: ENRICHMENT     │  │   TIER 2: CONTENT CAPTURE    │
│   (Fast & Frequent)      │  │   (Deep & Occasional)        │
└──────────────────────────┘  └──────────────────────────────┘

Website                        Website
├─ enrich_shop_v2.js          ├─ capture_web_content.js
│  • Hours, phone, address    │  • Full HTML of all pages
│  • Schema.org data          │  • Complete text extraction
│  • Quick 3-5 page scan      │  • Up to 50 pages crawled
│  • ~10-30 seconds           │  • ~2-5 minutes
│  • Saves to database        │  • Saves to files
│  • Run: Weekly              │  • Run: Monthly
│                             │
Social Media                   Social Media
├─ enrich_social.js           ├─ capture_social_content.js
│  • Profile exists?          │  • All recent posts (50+)
│  • Follower counts          │  • Full captions, hashtags
│  • Platform discovery       │  • Engagement metrics
│  • ~20-30 seconds           │  • ~1-2 minutes
│  • Saves to database        │  • Saves to files
│  • Run: Weekly              │  • Run: Weekly/Monthly
```

## Storage Architecture

```
/home/john/Projects/record_shop_enricher/

├── Database (Supabase)
│   └── shops table
│       ├── Basic info (name, city, state)
│       ├── Enrichment metadata (hours, phone, website)
│       ├── Social profiles (URLs only)
│       ├── enrichment_status
│       └── date_of_enrichment
│
└── content/
    └── {shop_id}/
        ├── web/
        │   ├── pages_2026-02-07/
        │   │   ├── page_0_abc123.json
        │   │   ├── page_1_def456.json
        │   │   └── ...
        │   └── capture_2026-02-07.json
        │
        └── social/
            ├── instagram_2026-02-07.json
            ├── facebook_2026-02-07.json
            ├── tiktok_2026-02-07.json
            └── capture_2026-02-07.json
```

## Workflow Examples

### Scenario 1: New Shop Discovery
```
1. Find shop on Google Maps → Add to database
2. Run enrich_shop_v2.js → Get basic metadata (30s)
3. Run enrich_social.js → Discover social profiles (30s)
4. Run capture_web_content.js → Archive website (3min)
5. Run capture_social_content.js → Archive posts (2min)

Total: ~6 minutes for complete profile
```

### Scenario 2: Regular Maintenance
```
Weekly:
  - enrich_shop_v2.js (update hours, check for changes)
  - enrich_social.js (update follower counts)
  
Monthly:
  - capture_web_content.js (archive current website state)
  - capture_social_content.js (archive recent posts)
```

### Scenario 3: Research Project
```
Goal: "What are record shops posting about this month?"

1. Run capture_social_content.js on 100 shops
2. Extract all post captions from JSON files
3. Analyze themes, hashtags, trends
4. Generate report
```

## When to Use What

### Use Enrichment When...
- ✅ You need up-to-date contact info
- ✅ You want to check if something changed
- ✅ You need quick metadata for 100+ shops
- ✅ You're updating a live database
- ✅ Speed matters more than depth

### Use Capture When...
- ✅ You want historical archives
- ✅ You need complete content for analysis
- ✅ You're doing research on trends
- ✅ You want to analyze writing/content style
- ✅ You need offline copies
- ✅ Depth matters more than speed

## Technical Differences

| Aspect | Enrichment | Capture |
|--------|------------|---------|
| **HTTP Method** | curl (simple) | curl + crawling |
| **Pages** | 3-5 key pages | Up to 50 pages |
| **Parsing** | Targeted extraction | Full content |
| **Storage** | Database rows | JSON files |
| **Size** | <5KB per shop | 500KB-5MB per shop |
| **Speed** | 10-60 seconds | 2-10 minutes |
| **Frequency** | Daily/Weekly | Weekly/Monthly |
| **Retention** | Latest only | Timestamped archives |
| **Query** | SQL | File system + grep/jq |

## Integration Points

### Enricher UI
Currently only runs enrichment. Could add:

```javascript
// NEW buttons in UI:
<button class="capture-web-btn">🌐 Capture Full Website</button>
<button class="capture-social-btn">📸 Capture Social Posts</button>

// NEW endpoints:
POST /api/capture-web → Run capture_web_content.js
POST /api/capture-social → Run capture_social_content.js

// NEW progress tracking:
- Show pages crawled: "Captured 15/50 pages..."
- Show posts extracted: "Extracted 23 Instagram posts..."
```

### Batch Processing
```bash
#!/bin/bash
# Daily enrichment run
for shop_id in $(get_all_shop_ids); do
  ./enrich_shop_v2.js $shop_id
  ./enrich_social.js $shop_id
done

# Monthly capture run (slower, run overnight)
for shop_id in $(get_all_shop_ids); do
  ./capture_web_content.js $shop_id
  ./capture_social_content.js $shop_id
  sleep 10 # Rate limiting
done
```

## Data Retention

### Enrichment Data
- **Lifetime**: Latest only (overwritten)
- **Reason**: Metadata changes frequently
- **History**: Track in `date_of_enrichment`

### Capture Data
- **Lifetime**: Timestamped archives (keep multiple)
- **Reason**: Historical analysis valuable
- **Retention Policy**: 
  - Keep last 12 months
  - Or keep quarterly snapshots indefinitely
  - Implement cleanup script

## Future Vision

### Phase 1: Current ✅
- Enrichment modules working
- Capture modules built
- Manual execution

### Phase 2: Automation 🚧
- Scheduler (cron/queue)
- UI integration
- Progress tracking
- Error handling

### Phase 3: Analysis 📊
- Trend detection
- Change tracking
- Content search index
- Comparative analysis

### Phase 4: Intelligence 🤖
- Automated insights
- Anomaly detection
- Recommendation engine
- Predictive analytics

## Example Queries

### Find shops that mention "vinyl"
```bash
grep -r "vinyl" content/*/web/pages_*/*.json | jq -r '.shop_name'
```

### Count total Instagram posts captured
```bash
cat content/*/social/instagram_*.json | jq '[.posts | length] | add'
```

### Find shops with events this month
```bash
grep -r "March" content/*/web/capture_*.json | jq -r '.shop_name'
```

### Compare content volume
```bash
for file in content/*/web/capture_*.json; do
  echo "$file: $(jq '.crawl_stats.total_text_chars' $file)"
done | sort -k2 -n
```

## Best Practices

### 1. Run Enrichment First
Always run enrichment before capture to ensure you have URLs.

### 2. Rate Limit Captures
Wait 5-10 seconds between capture runs to be respectful.

### 3. Store Timestamps
Always include timestamps in filenames for easy sorting.

### 4. Validate Before Processing
Check if content exists and is fresh before re-running.

### 5. Monitor Failures
Log failures and retry with exponential backoff.

### 6. Clean Up Old Data
Implement retention policies to manage disk space.

## Cost Considerations

### Storage
- 800 shops × 2MB avg = **1.6GB** (monthly captures)
- 12 months = **~20GB** annually
- Cheap: ~$0.50/month on most cloud storage

### Bandwidth
- 800 shops × 5MB download = **4GB** per capture run
- Monthly capture = **4GB/month**
- Negligible cost

### Compute
- Run on existing server
- Ollama AI analysis: Free (local)
- No API costs

## Conclusion

**Two-tier architecture gives you the best of both worlds:**

1. **Fast enrichment** for up-to-date operational data
2. **Deep capture** for comprehensive archives and analysis

**Use enrichment for real-time needs, capture for research.**
