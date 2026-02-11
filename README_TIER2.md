# Tier 2: Social Media Intelligence

Deep social media analytics for record shops - Instagram, Facebook, and TikTok metrics.

## 🆕 Tier 2 Features

### Platform Coverage
- **Instagram**: Followers, posts, bio, verification, business account status, engagement
- **Facebook**: Likes, followers, ratings, check-ins, reviews
- **TikTok**: Followers, videos, likes, verification

### Smart Discovery
- **HTML scanning**: Scans shop website HTML for social media links (primary method)
- **Web search fallback**: Searches "instagram [shop name] [city]" if not found in HTML
- **Manual input**: Accepts Instagram/Facebook/TikTok usernames directly
- **URL extraction**: Works with full URLs or just usernames
- **City context**: Uses location to improve search accuracy (e.g., "Amoeba Music Berkeley")

### Engagement Analytics
- **Aggregate metrics**: Total followers across all platforms
- **Engagement score**: 0-10 rating based on followers, posts, and verification
- **Platform comparison**: Which platforms the shop prioritizes
- **Activity indicators**: Post frequency and content volume

### AI Analysis
- Social media strategy assessment
- Platform priority recommendations
- Community engagement insights
- Brand positioning analysis
- Content strategy suggestions

## Usage

### Standalone CLI

```bash
# Make executable
chmod +x enrich_social.js

# With website (auto-discovers social links)
./enrich_social.js "Shop Name" "https://shop-website.com"

# With direct social handles
./enrich_social.js "Shop Name" "" "instagram_username" "facebook_page" "tiktok_username"

# Mix and match
./enrich_social.js "Amoeba Music" "https://amoeba.com" "amoebamusic"
```

### From Browser UI

1. Open enricher UI: `./enricher-ui.js`
2. Navigate to http://localhost:3456
3. Click **"📱 Enrich Social"** on any shop card
4. Watch real-time progress
5. Results automatically saved to database

### Database Integration

The enricher updates these Supabase fields:
- `social_instagram` - Instagram profile URL
- `social_facebook` - Facebook page URL
- `social_tiktok` - TikTok profile URL

## Output Format

### Console Progress
```
================================================================================
🎵 TIER 2: SOCIAL MEDIA INTELLIGENCE
📍 Shop: Amoeba Music
================================================================================

🔍 Searching for social profiles...
  ✓ Found Instagram: @amoebamusic
  ✓ Found Facebook: /amoebamusic

📱 Fetching social media profiles...

  📸 Analyzing Instagram @amoebamusic...
  ✓ Found: 125,432 followers, 1,847 posts

  📘 Analyzing Facebook /amoebamusic...
  ✓ Found: 98,234 likes, 4.8⭐

📊 Calculating metrics...
  Total followers: 223,666
  Active platforms: 2
  Engagement score: 8.5/10

🤖 Analyzing social media presence with AI...

================================================================================
📋 SOCIAL MEDIA INTELLIGENCE REPORT
================================================================================

## SOCIAL MEDIA PRESENCE
Strong presence on Instagram and Facebook with excellent engagement...

[Full AI analysis]

================================================================================
```

## What It Extracts

### Instagram
- ✅ Username and display name
- ✅ Follower count
- ✅ Following count
- ✅ Post count
- ✅ Bio/description
- ✅ Website link
- ✅ Verification status
- ✅ Business account status
- ✅ Category

### Facebook
- ✅ Page name and ID
- ✅ Likes count
- ✅ Follower count
- ✅ Rating (stars)
- ✅ Check-ins count
- ✅ Description
- ✅ Page existence

### TikTok
- ✅ Username and display name
- ✅ Follower count
- ✅ Following count
- ✅ Video count
- ✅ Total likes
- ✅ Bio/signature
- ✅ Verification status

### Aggregate Metrics
- ✅ Total followers (all platforms)
- ✅ Total posts/videos
- ✅ Active platform count
- ✅ Verification count
- ✅ Engagement score (0-10)

### AI Insights
- ✅ Social media strategy analysis
- ✅ Platform priorities
- ✅ Engagement effectiveness
- ✅ Brand positioning
- ✅ Content recommendations
- ✅ Growth opportunities

## Configuration

Edit these constants in `enrich_social.js`:

```javascript
const OLLAMA_MODEL = 'kimi-k2.5:cloud';  // AI model for analysis
const FETCH_TIMEOUT = 15000;             // Timeout per request (ms)
```

## Requirements

- **Node.js** (v14+)
- **curl** (for HTTP requests)
- **Ollama** with `kimi-k2.5:cloud` model
- Stable internet connection

## Performance

- **Speed**: ~20-30 seconds per shop (3 platforms)
- **Success rate**: ~80% (depends on privacy settings)
- **Rate limiting**: Respects platform policies
- **Graceful fallback**: Works even if some platforms fail

## Limitations

### Instagram
- Private accounts: No data accessible
- Rate limiting: May fail if too many requests
- Login wall: Some profiles require authentication

### Facebook
- Privacy settings: Public pages work best
- Business pages: More data available than personal profiles
- Regional blocks: Some pages geo-restricted

### TikTok
- Rate limiting: Aggressive anti-scraping
- JavaScript rendering: Some data may be incomplete
- Regional content: Availability varies by location

## Tips

1. **Add social handles manually** - Use the edit popup to pre-fill Instagram/Facebook/TikTok usernames for best results
2. **Run after Tier 1** - Website enrichment often discovers social links automatically
3. **Check privacy** - Public profiles yield much better data
4. **Batch carefully** - Don't enrich too many shops rapidly (rate limiting)

## Integration with Tier 1

Tier 1 (web intelligence) and Tier 2 (social media) complement each other:

- **Tier 1 discovers social links** → Tier 2 enriches them
- **Tier 1 gets website data** → Tier 2 gets community data
- **Together**: 70-90 data points per shop

Run both for complete enrichment!

## Troubleshooting

**"Profile not found or private"**:
- Check username spelling
- Profile may be private or deleted
- Try visiting the URL manually to verify

**"Failed to fetch"**:
- Rate limiting (wait a few minutes)
- Network issues
- Platform temporarily blocked scraping

**"AI analysis failed"**:
- Ollama not running (`ollama serve`)
- Model not installed (`ollama pull kimi-k2.5:cloud`)
- Model name mismatch

## Next: Tier 3

Future enhancements planned:
- **Reviews analysis** (Yelp, Google, Facebook reviews)
- **Sentiment scoring**
- **Competitor comparison**
- **Historical trends**

## License

MIT
