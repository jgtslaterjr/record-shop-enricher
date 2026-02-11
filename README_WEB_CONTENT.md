# Web Content Capture

**Deep archival of website content** - captures entire websites, all pages, text, structure, and metadata.

## Purpose

While `enrich_shop_v2.js` provides **quick metadata** (hours, contact, Schema.org), `capture_web_content.js` captures **complete website archives** (all pages, full text, images, structure).

## What It Captures

### Per Page
- ✅ Full HTML source
- ✅ Extracted text content (clean)
- ✅ Metadata (title, description, Open Graph, Schema.org)
- ✅ Structured content (headings, paragraphs, lists)
- ✅ All links (internal navigation)
- ✅ All images (URLs and alt text)
- ✅ Contact info (phones, emails)
- ✅ Event information (dates, times)

### Site-Wide
- 🕷️  Multi-page crawling (up to 50 pages, depth 3)
- 📊 Complete sitemap
- 🤖 AI analysis of entire site
- 📈 Crawl statistics

## Storage Structure

```
content/
└── {shop_id}/
    └── web/
        ├── pages_2026-02-07/
        │   ├── page_0_a1b2c3d4.json
        │   ├── page_1_e5f6g7h8.json
        │   └── ...
        └── capture_2026-02-07.json (summary + analysis)
```

## Crawl Strategy

### Starting Point
- Homepage as entry point
- Discovers all internal links

### Scope
- **Same domain only** (no external sites)
- **Max 50 pages** (configurable)
- **Max depth 3** (homepage → section → subsection)

### Filtered Out
- ❌ Media files (.jpg, .pdf, .zip)
- ❌ Cart/checkout pages
- ❌ Login/register pages
- ❌ Duplicate URLs (query params normalized)

### Smart Crawling
- Breadth-first search
- Deduplication
- Respects reasonable size limits

## Usage

### Command Line
```bash
./capture_web_content.js <shop_id> <shop_name> <website_url>

Example:
./capture_web_content.js 123 "Amoeba Music" "https://www.amoeba.com"
```

### Programmatic
```javascript
const { captureWebContent } = require('./capture_web_content.js');

await captureWebContent('shop_123', 'Amoeba Music', 'https://www.amoeba.com');
```

## Output Format

### Page Data Structure
```json
{
  "url": "https://example.com/about",
  "depth": 1,
  "crawled_at": "2026-02-07T17:30:00.000Z",
  "size_bytes": 45678,
  "html": "<!DOCTYPE html>...",
  "text": "Welcome to our shop...",
  "metadata": {
    "title": "About Us - Record Shop",
    "description": "Learn about our history",
    "og_data": {
      "title": "About Us",
      "image": "https://..."
    },
    "schema_org": [...]
  },
  "content": {
    "headings": [
      {"level": 1, "text": "About Us"},
      {"level": 2, "text": "Our History"}
    ],
    "paragraphs": ["We opened in 1995..."],
    "lists": ["Vinyl", "CDs", "Cassettes"],
    "images": [{"src": "...", "alt": "Store front"}],
    "links": [{"url": "...", "text": "Contact"}],
    "events": ["Saturday March 15th", "Live DJ set"],
    "contact_info": {
      "phones": ["(555) 123-4567"],
      "emails": ["info@shop.com"]
    }
  }
}
```

### Capture Summary
```json
{
  "shop_id": "123",
  "shop_name": "Amoeba Music",
  "website_url": "https://www.amoeba.com",
  "captured_at": "2026-02-07T17:30:00.000Z",
  "crawl_stats": {
    "pages_captured": 35,
    "total_text_chars": 125000,
    "total_html_bytes": 2500000,
    "max_depth_reached": 3
  },
  "sitemap": {
    "total_pages": 35,
    "pages": [...]
  },
  "analysis": "AI-generated analysis...",
  "pages_directory": "content/123/web/pages_2026-02-07"
}
```

## AI Analysis

Provides insights on:

### Website Structure
- Navigation organization
- Key sections identified
- Content depth assessment

### Content Focus
- Main themes and topics
- Services highlighted
- Community engagement

### Events & Activities
- Regular events detected
- Special offerings
- Community programs

### Technical Observations
- Content quality
- Information completeness
- Missing elements

### Recommendations
- Content gaps
- SEO opportunities
- UX improvements

## Performance

### Typical Crawl Times
- **Small site** (5-10 pages): ~30 seconds
- **Medium site** (15-30 pages): ~2-3 minutes
- **Large site** (50+ pages, limited to 50): ~4-5 minutes

### Resource Usage
- ~20MB max buffer per page
- Concurrent: 1 page at a time (sequential crawl)
- Storage: ~500KB - 2MB per page (compressed JSON)

## Integration with Enricher UI

To add to the UI:

1. Add button: `<button class="capture-web-btn">🌐 Capture Website</button>`
2. Call module with shop's website URL
3. Display crawl progress (pages captured)
4. Show results and AI analysis
5. Update database with capture timestamp

## Frequency

**Recommended schedule:**
- **Monthly** for most shops (websites change slowly)
- **Weekly** if shop has active blog/events
- **Quarterly** for static sites

## Use Cases

### Content Analysis
- What topics do they cover?
- How deep is their content?
- What pages get the most links?

### Competitive Research
- Compare content depth across shops
- Identify common themes
- Find content gaps

### Historical Tracking
- Track website changes over time
- Monitor new pages/sections
- Detect removed content

### SEO Analysis
- Analyze meta tags
- Check Schema.org implementation
- Review internal linking

### Event Discovery
- Extract all events automatically
- Build event calendar
- Track recurring events

## Limitations

### JavaScript-Heavy Sites
- ⚠️  Uses `curl` (no JavaScript execution)
- ⚠️  SPAs (React/Vue/Angular) may not render
- 💡 Consider Puppeteer for JS-heavy sites

### Paywalls / Login Required
- ⚠️  Only captures publicly accessible content
- ⚠️  Members-only pages not captured

### Rate Limiting
- ℹ️  Sequential crawling (respectful)
- ℹ️  Timeout protection (30s per page)

## Future Enhancements

- [ ] **Puppeteer support** for JavaScript-rendered sites
- [ ] **Screenshot capture** for visual archive
- [ ] **Image downloading** (full media backup)
- [ ] **PDF generation** (readable archive format)
- [ ] **Diff detection** (highlight changes between captures)
- [ ] **Content search** (index all text)
- [ ] **Markdown export** (clean readable format)
- [ ] **Parallel crawling** (faster multi-page captures)

## Comparison: Enrichment vs Capture

| Feature | enrich_shop_v2.js | capture_web_content.js |
|---------|-------------------|------------------------|
| **Purpose** | Quick metadata | Complete archive |
| **Speed** | 10-30 seconds | 2-5 minutes |
| **Pages** | 3-5 key pages | Up to 50 pages |
| **Storage** | Database only | Files + database |
| **Depth** | Surface scan | Deep crawl |
| **Frequency** | Weekly | Monthly |
| **Use case** | Contact info, hours | Content analysis, history |

## Technical Notes

- Uses `curl` for HTTP requests
- Pure Node.js (no external dependencies beyond curl)
- Regex-based HTML parsing (lightweight)
- MD5 hashing for filename deduplication
- URL normalization for link discovery
- Breadth-first crawl algorithm
- Ollama (Kimi K2.5) for AI analysis

## See Also

- `enrich_shop_v2.js` - Quick website metadata
- `capture_social_content.js` - Social media content capture
- `ENRICHMENT_PLAN.md` - Overall enrichment architecture
