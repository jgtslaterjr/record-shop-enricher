# Social Content Capture

**Deep archival of social media content** - captures actual posts, captions, hashtags, and engagement data.

## Purpose

While `enrich_social.js` provides **metadata** (follower counts, profile exists), `capture_social_content.js` captures **actual content** (posts, videos, captions, hashtags).

## What It Captures

### Instagram
- ✅ Profile (bio, follower count, verification status)
- ✅ Up to 50 recent posts
- ✅ Captions, hashtags, timestamps
- ✅ Likes and comment counts
- ✅ Post types (photo/video/carousel)

### Facebook
- ✅ Profile (name, description)
- ⚠️  Limited post data (Facebook requires login)
- ℹ️  Captures what's publicly visible

### TikTok
- ✅ Profile (bio, follower/like counts)
- ✅ Up to 50 recent videos
- ✅ Video descriptions, hashtags
- ✅ Engagement (likes, comments, shares, views)
- ✅ Music/sound info

### AI Analysis
- 🤖 Content themes and topics
- 📊 Posting patterns
- 💡 Engagement insights
- 🎯 Strategic recommendations

## Storage Structure

```
content/
└── {shop_id}/
    └── social/
        ├── instagram_2026-02-07.json
        ├── facebook_2026-02-07.json
        ├── tiktok_2026-02-07.json
        └── capture_2026-02-07.json (combined summary + analysis)
```

## Usage

### Command Line
```bash
./capture_social_content.js <shop_id> <shop_name> [options]

Options:
  --instagram=username
  --facebook=pageid
  --tiktok=username

Example:
./capture_social_content.js 123 "Amoeba Music" \
  --instagram=amoebamusic \
  --facebook=amoebamusic \
  --tiktok=amoebamusic
```

### Programmatic
```javascript
const { captureSocialContent } = require('./capture_social_content.js');

await captureSocialContent('shop_123', 'Amoeba Music', {
  instagram: 'amoebamusic',
  facebook: 'amoebamusic',
  tiktok: 'amoebamusic'
});
```

## Output Format

### Instagram Post Example
```json
{
  "id": "123456789",
  "shortcode": "AbCdEfG",
  "url": "https://www.instagram.com/p/AbCdEfG/",
  "type": "GraphImage",
  "caption": "New vinyl arrivals! 🎵 #vinyl #recordstore",
  "timestamp": "2026-02-07T15:30:00.000Z",
  "likes": 456,
  "comments": 23,
  "hashtags": ["vinyl", "recordstore"],
  "is_video": false
}
```

### TikTok Video Example
```json
{
  "id": "7234567890123456789",
  "url": "https://www.tiktok.com/@shop/video/7234567890123456789",
  "description": "Rare finds today! #vinyl #tiktokshop",
  "created_at": "2026-02-06T18:20:00.000Z",
  "likes": 12500,
  "comments": 234,
  "shares": 89,
  "plays": 45600,
  "music": {
    "title": "Original Sound",
    "author": "shop"
  },
  "hashtags": ["vinyl", "tiktokshop"]
}
```

## Limitations

### Instagram
- ⚠️  May require login for private accounts
- ⚠️  Instagram frequently changes HTML structure
- ℹ️  Rate limiting may apply

### Facebook
- ⚠️  **Requires authentication** for full post access
- ⚠️  Very limited data from public HTML
- 💡 Consider Facebook Graph API for better results

### TikTok
- ⚠️  May require login for some accounts
- ⚠️  Structure changes frequently
- ℹ️  Rate limiting may apply

## Integration with Enricher UI

To add to the UI, you would:

1. Add button: `<button class="capture-content-btn">📸 Capture Social Content</button>`
2. Call module with shop's social profiles
3. Display progress and results
4. Update database with capture timestamp

## Frequency

**Recommended schedule:**
- **Weekly** for active shops (frequent posters)
- **Monthly** for most shops
- **Quarterly** for inactive shops

## Future Enhancements

- [ ] Support for Twitter/X
- [ ] Support for YouTube
- [ ] Image downloading
- [ ] Sentiment analysis on captions
- [ ] Trend detection over time
- [ ] Content calendar generation
- [ ] Competitor comparison

## Technical Notes

- Uses `curl` for HTTP requests (lightweight)
- Parses embedded JSON from page source
- Falls back to meta tags when JS data unavailable
- Stores timestamped snapshots for historical tracking
- Uses Ollama (Kimi K2.5) for AI analysis

## See Also

- `enrich_social.js` - Quick social profile metadata
- `capture_web_content.js` - Website content capture (to be built)
- `ENRICHMENT_PLAN.md` - Overall enrichment architecture
