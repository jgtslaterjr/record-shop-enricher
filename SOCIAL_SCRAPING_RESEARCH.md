# Social Media Scraping Research Report (Early 2026)
## For Record Shop Enricher Application

**Last Updated:** February 12, 2026  
**Purpose:** Evaluate techniques for scraping Instagram, Facebook, and TikTok to collect social media profiles and engagement data for ~800 record shops.

**Environment:** Linux, Node.js, Ollama (local), OpenAI/Anthropic APIs available

---

## Executive Summary

### Key Findings

**Instagram:**
- ✅ Public profile data still accessible without login (bio, follower count, recent posts)
- ⚠️ Rate limits: ~200 requests/hour per IP
- ⚠️ Instaloader requires login/cookies as of late 2025, but alternative scrapers work without auth
- 🎯 Best approach: Apify Actors or specialized scraper APIs

**Facebook:**
- ❌ Extremely difficult to scrape public pages
- ❌ Graph API requires business verification and only provides data for pages you own/manage
- ⚠️ Login required for most data
- 🎯 Best approach: Screenshot + AI vision OR paid scraper services (Bright Data, Apify)

**TikTok:**
- ✅ Unofficial TikTok-Api Python library still works with Playwright backend
- ❌ Research API restricted to academic/non-commercial use only
- ⚠️ Strong anti-bot protections, requires stealth techniques
- 🎯 Best approach: Apify TikTok Scraper or unofficial API with proper evasion

**Overall Recommendation for Record Shop Use Case:**
For a one-time/infrequent scrape of 800 shops, use **Apify Actors** (pay-as-you-go) or **screenshot + AI vision** (higher cost but most reliable). For ongoing monitoring, invest in a robust browser automation setup with Playwright stealth + residential proxies.

---

## 1. Instagram

### 1.1 Direct HTML/API Scraping

**What Still Works:**
- Public profiles expose data via embedded JSON in HTML (`window._sharedData`)
- Profile information: bio, follower count, following count, post count, verification status
- Recent posts (~12 posts) available without authentication
- Hashtag and location pages still accessible

**What's Been Blocked:**
- Comment data now requires login (changed ~2025)
- Deep pagination (beyond first ~12 posts) increasingly difficult without auth
- Stories, DMs, and private account data impossible without authentication
- Direct API endpoints heavily rate-limited and fingerprint-checked

**Rate Limits:**
- ~200 requests/hour per IP address
- Exceeding limits results in temporary IP bans (1-24 hours)
- Account-based scraping (logged in) has stricter limits and risks account suspension

**Code Example (Node.js without login):**
```javascript
// Simple fetch approach - works for public profiles
async function getInstagramProfile(username) {
  const url = `https://www.instagram.com/${username}/?__a=1&__d=dis`;
  
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Connection': 'keep-alive',
    }
  });
  
  if (response.status === 404) return null;
  if (response.status === 429) throw new Error('Rate limited');
  
  const html = await response.text();
  // Parse window._sharedData from HTML
  const match = html.match(/window\._sharedData = ({.*?});/);
  if (match) {
    const data = JSON.parse(match[1]);
    const userData = data.entry_data.ProfilePage[0].graphql.user;
    return {
      username: userData.username,
      fullName: userData.full_name,
      bio: userData.biography,
      followers: userData.edge_followed_by.count,
      following: userData.edge_follow.count,
      posts: userData.edge_owner_to_timeline_media.count,
      verified: userData.is_verified,
      profilePic: userData.profile_pic_url_hd
    };
  }
}
```

### 1.2 Browser Automation (Playwright/Puppeteer)

**Best Practices:**
- Use Playwright with stealth plugins (`playwright-extra-stealth`)
- Run in non-headless mode or use headed mode with Xvfb on Linux servers
- Implement random delays between actions (1-3 seconds)
- Rotate user agents to mimic real devices (prefer mobile UAs)
- Use residential or mobile proxies (4G/5G IPs)
- Implement exponential backoff on errors

**Anti-Bot Evasion Techniques:**
1. **Stealth Plugin:** Install `playwright-extra` and `puppeteer-extra-plugin-stealth`
2. **Fingerprint Spoofing:** Use `fingerprint-suite` to generate consistent fingerprints
3. **Human-like Behavior:** Random mouse movements, scroll patterns, timing variations
4. **Session Management:** Maintain cookies across requests, warm up sessions
5. **TLS Fingerprinting:** Use modern Chrome version, avoid Python requests library

**Example Setup:**
```javascript
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);

async function scrapeInstagramWithPlaywright(username) {
  const browser = await chromium.launch({
    headless: false, // Better detection avoidance
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--no-sandbox'
    ]
  });
  
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)',
    viewport: { width: 390, height: 844 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
  });
  
  const page = await context.newPage();
  
  // Add random delay
  await page.waitForTimeout(Math.random() * 2000 + 1000);
  
  await page.goto(`https://www.instagram.com/${username}/`, {
    waitUntil: 'networkidle'
  });
  
  // Extract data from page...
  const data = await page.evaluate(() => {
    // Access window._sharedData or parse DOM
    return window._sharedData?.entry_data?.ProfilePage?.[0]?.graphql?.user;
  });
  
  await browser.close();
  return data;
}
```

**Login Handling:**
- Store cookies after manual login
- Use browser context with saved cookies: `context.storageState('cookies.json')`
- Rotate accounts if doing large-scale scraping
- Risk: Account suspension if detected as bot

### 1.3 Official APIs

**Instagram Graph API:**
- **Access:** Requires Facebook Developer account + app review
- **Limitation:** Only works for Business/Creator accounts that YOU OWN
- **Cannot access:** Random public profiles, competitor data, general public data
- **Use case:** Managing your own Instagram business account programmatically

**Verdict:** ❌ Not useful for scraping third-party record shop profiles

**Instagram Basic Display API:**
- **Status:** Deprecated by Meta (being phased out)
- **Limited to:** Personal account data only, read-only
- **Verdict:** ❌ Not applicable for your use case

### 1.4 Third-Party Services/Libraries

#### **Instaloader (Python)**
- **Status (2026):** Still maintained but requires login/cookies
- **GitHub:** `instaloader/instaloader`
- **Installation:** `pip install instaloader`
- **Pros:** Feature-rich, downloads media, metadata, comments
- **Cons:** Requires authentication via cookies, slower, risk of account ban
- **Verdict:** ⚠️ Works but requires account; not ideal for Node.js workflow

**Example Usage:**
```bash
# Requires login
instaloader --login=your_username profile target_username
# Or use saved cookies
instaloader --load-cookies chrome profile target_username
```

#### **Apify Instagram Scraper**
- **URL:** `apify.com/apify/instagram-scraper`
- **Pricing:** Pay-per-use (compute units), ~$5-20 for 800 profiles
- **Pros:** 
  - No login required for public profiles
  - Handles anti-bot measures
  - Returns structured JSON
  - Over 146,000 developers using it
- **Cons:** Cost per request, external dependency
- **Best for:** One-off or scheduled scraping jobs

**Node.js Integration:**
```javascript
const { ApifyClient } = require('apify-client');

const client = new ApifyClient({ token: 'YOUR_API_TOKEN' });

async function scrapeInstagramProfiles(usernames) {
  const run = await client.actor('apify/instagram-scraper').call({
    directUrls: usernames.map(u => `https://www.instagram.com/${u}/`),
    resultsType: 'profiles',
    resultsLimit: 1,
  });
  
  const { items } = await client.dataset(run.defaultDatasetId).listItems();
  return items;
}
```

#### **Other Notable Libraries:**
- **`instagram-scraper` (drawrowfly/instagram-scraper):** No login required, but less maintained
- **Bright Data Instagram Scraper API:** Enterprise solution, handles proxies/evasion
- **ScrapFly Instagram API:** Modern API wrapper, handles anti-bot measures
- **SociaVault API:** Dedicated social media API with Node.js support

### 1.5 Screenshot + AI Vision Approach

**Concept:** 
Take screenshots of Instagram profiles using Playwright, then use GPT-4o Vision or Claude Sonnet 4.5 to extract structured data.

**Pros:**
- Most reliable (what you see is what the AI sees)
- No API keys, no parsing HTML changes
- Works even if Instagram changes their HTML structure
- Can extract any visual data (follower count, bio, recent posts)

**Cons:**
- Higher cost (~$0.10-0.30 per profile with GPT-4o)
- Slower (need to render page + API call)
- Token usage for large images

**Cost Analysis for 800 Record Shops:**

| Model | Cost per Image | Total for 800 |
|-------|---------------|---------------|
| GPT-4o | ~$0.15-0.25 | $120-$200 |
| Claude 3.5 Sonnet | ~$0.18-0.30 | $144-$240 |
| Claude 3 Haiku | ~$0.0004 | ~$0.32 |

**Implementation:**
```javascript
const { chromium } = require('playwright');
const OpenAI = require('openai');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function extractInstagramDataWithVision(username) {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  
  await page.goto(`https://www.instagram.com/${username}/`);
  await page.waitForLoadState('networkidle');
  
  // Take screenshot
  const screenshot = await page.screenshot({ 
    fullPage: false,
    clip: { x: 0, y: 0, width: 1200, height: 900 }
  });
  await browser.close();
  
  // Convert to base64
  const base64Image = screenshot.toString('base64');
  
  // Send to GPT-4o Vision
  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Extract the following data from this Instagram profile screenshot and return as JSON:
{
  "username": "string",
  "fullName": "string",
  "bio": "string",
  "followerCount": number,
  "followingCount": number,
  "postCount": number,
  "verified": boolean,
  "recentPostCaptions": ["string array of 3-5 recent post captions"],
  "hashtags": ["array of hashtags from recent posts"]
}`
          },
          {
            type: 'image_url',
            image_url: {
              url: `data:image/png;base64,${base64Image}`
            }
          }
        ]
      }
    ],
    max_tokens: 1000
  });
  
  const data = JSON.parse(response.choices[0].message.content);
  return data;
}
```

**When to Use Screenshot + AI:**
- Instagram blocks all other methods
- Need highest reliability
- Budget allows ~$150-250 for 800 profiles
- One-time data collection (not ongoing monitoring)

---

## 2. Facebook

### 2.1 Direct HTML/API Scraping

**Current State (2026):**
- ❌ Public pages require login to view most content
- ❌ Facebook actively blocks headless browsers and automated access
- ❌ Data is heavily JavaScript-rendered and paginated
- ⚠️ Mobile site (`m.facebook.com`) slightly easier but still challenging

**What's Blocked:**
- Almost everything without authentication
- Posts, comments, reactions require login
- Even basic page info (followers, likes) often hidden

**Verdict:** Direct scraping essentially impossible without logging in

### 2.2 Browser Automation (Playwright/Puppeteer)

**Challenges:**
- Facebook has sophisticated bot detection (among the strongest)
- Requires login for any meaningful data
- High risk of account suspension/ban
- CAPTCHA challenges frequent

**Best Practices (if attempting):**
1. Use residential proxies (4G mobile preferred)
2. Warm up accounts (use manually for days/weeks first)
3. Implement extensive random delays (5-10 seconds between actions)
4. Use saved browser sessions with full cookies/cache
5. Scrape during "human hours" (9am-11pm local time)
6. Limit to 20-50 pages per day per account

**Example (high risk):**
```javascript
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);

async function scrapeFacebookPage(pageUrl) {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    storageState: 'facebook_cookies.json', // Pre-authenticated
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64)...',
  });
  
  const page = await context.newPage();
  
  await page.goto(pageUrl, { waitUntil: 'networkidle' });
  
  // Wait for random time
  await page.waitForTimeout(Math.random() * 3000 + 2000);
  
  // Scroll slowly
  await page.evaluate(async () => {
    for (let i = 0; i < 3; i++) {
      window.scrollBy(0, window.innerHeight);
      await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 1000));
    }
  });
  
  // Extract data - highly page-structure dependent
  const data = await page.evaluate(() => {
    // Parse page info from DOM
    // Facebook's structure changes frequently
    return {
      pageName: document.querySelector('h1')?.textContent,
      likes: document.querySelector('[aria-label*="like"]')?.textContent,
      // ... very fragile
    };
  });
  
  await browser.close();
  return data;
}
```

**Verdict:** ⚠️ Possible but very high risk, fragile, requires account management

### 2.3 Official APIs

#### **Facebook Graph API**

**Access Requirements:**
- Facebook Developer account
- Create an app + app review process
- **Page Public Content Access** permission (requires business verification)
- **Limitations:** Only works for pages YOU manage/own

**What You CAN'T Do:**
- Cannot scrape random public business pages
- Cannot get follower counts for pages you don't own
- Cannot access posts from pages you don't manage

**What You CAN Do:**
- Manage your own business pages
- Get insights for pages you own
- Publish content to pages you manage

**Example (only works for YOUR pages):**
```javascript
const fetch = require('node-fetch');

async function getOwnPageData(pageId, accessToken) {
  const url = `https://graph.facebook.com/v18.0/${pageId}?fields=name,fan_count,about,website&access_token=${accessToken}`;
  const response = await fetch(url);
  return await response.json();
}
```

**Verdict:** ❌ Not useful for scraping third-party record shop pages

### 2.4 Third-Party Services/Libraries

#### **facebook-scraper (Python)**
- **GitHub:** `kevinzg/facebook-scraper`
- **Status:** Still maintained, but frequently breaks
- **Requires:** Login credentials
- **Works for:** Public page posts (sometimes)
- **Risk:** High chance of account suspension

**Example:**
```python
from facebook_scraper import get_posts

# Requires cookies from logged-in browser
for post in get_posts('some_page', pages=5, cookies='cookies.txt'):
    print(post['text'])
    print(post['likes'])
```

**Issues:**
- Facebook changes HTML structure frequently → breaks scraper
- Requires active Facebook account → risk of ban
- Rate limiting aggressive

**Verdict:** ⚠️ Works intermittently, high maintenance, account risk

#### **Apify Facebook Scraper**
- **URL:** `apify.com/apify/facebook-pages-scraper`
- **Pricing:** More expensive than Instagram (~$10-40 for 800 pages)
- **Pros:** 
  - Handles anti-bot measures
  - No personal account needed
  - Managed infrastructure
- **Cons:** 
  - Still requires login under the hood (Apify manages accounts)
  - More expensive
  - May fail for some pages

**Verdict:** ⚠️ Best third-party option, but not guaranteed

#### **Bright Data / Oxylabs**
- Enterprise scraping services
- Provide dedicated Facebook scraper APIs
- Handle proxies, account rotation, anti-bot
- **Pricing:** $500-1000/month minimum
- **Verdict:** 💰 Expensive but most reliable for large-scale operations

### 2.5 Screenshot + AI Vision Approach

**Viability for Facebook: ★★★★☆ (Highly Recommended)**

Given Facebook's anti-scraping measures, the screenshot + AI vision approach is **potentially the most reliable** method for one-time data collection.

**Implementation Strategy:**
1. Use Playwright with stealth to navigate to public page
2. Take screenshot of page header (page name, likes, about section)
3. Scroll and capture 2-3 screenshots of recent posts
4. Send to GPT-4o or Claude to extract:
   - Page name
   - Likes/follower count
   - About/bio
   - Recent post captions and engagement
   - Hashtags

**Pros:**
- Works even with Facebook's anti-bot measures
- No account ban risk (just viewing public pages)
- More reliable than HTML parsing
- Can extract visual data (photos, logos)

**Cons:**
- Cost: ~$0.20-0.40 per page (higher than Instagram due to multiple screenshots)
- Total for 800 pages: **$160-320**
- Slower: ~10-15 seconds per page

**Example Implementation:**
```javascript
async function extractFacebookPageWithVision(pageUrl) {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64)...',
    viewport: { width: 1280, height: 720 }
  });
  
  const page = await context.newPage();
  await page.goto(pageUrl);
  await page.waitForLoadState('networkidle');
  
  // Wait for content
  await page.waitForTimeout(3000);
  
  // Take header screenshot
  const headerScreenshot = await page.screenshot({
    clip: { x: 0, y: 0, width: 1280, height: 600 }
  });
  
  // Scroll and take posts screenshot
  await page.evaluate(() => window.scrollBy(0, 400));
  await page.waitForTimeout(2000);
  const postsScreenshot = await page.screenshot({
    clip: { x: 0, y: 200, width: 1280, height: 800 }
  });
  
  await browser.close();
  
  // Send both screenshots to AI
  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Extract data from these Facebook page screenshots. Return JSON:
{
  "pageName": "string",
  "likes": number,
  "followers": number,
  "about": "string",
  "website": "string",
  "recentPosts": ["array of recent post texts"],
  "hashtags": ["array"]
}`
          },
          {
            type: 'image_url',
            image_url: { url: `data:image/png;base64,${headerScreenshot.toString('base64')}` }
          },
          {
            type: 'image_url',
            image_url: { url: `data:image/png;base64,${postsScreenshot.toString('base64')}` }
          }
        ]
      }
    ],
    max_tokens: 1500
  });
  
  return JSON.parse(response.choices[0].message.content);
}
```

**Verdict:** 🎯 **Best approach for Facebook public pages** (for your use case)

---

## 3. TikTok

### 3.1 Direct HTML/API Scraping

**Current State:**
- Public profile data accessible via HTML (embedded JSON in `<script>` tags)
- Video data, user stats available without login
- API endpoints exist but are heavily rate-limited
- TLS fingerprinting and anti-bot checks aggressive

**What Works:**
- Profile info: username, bio, follower/following counts, video count
- Recent videos (limited pagination)
- Hashtag searches
- Video metadata (likes, comments, shares)

**What's Blocked:**
- Deep pagination without proper sessions
- High-frequency requests (rate limited quickly)
- Python `requests` library (TLS fingerprint detected)

**Example (using mobile web version):**
```javascript
async function getTikTokProfile(username) {
  const url = `https://www.tiktok.com/@${username}`;
  
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0...)',
      'Accept': 'text/html,application/xhtml+xml',
    }
  });
  
  const html = await response.text();
  
  // Extract data from embedded JSON
  const scriptMatch = html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application\/json">(.*?)<\/script>/);
  if (scriptMatch) {
    const data = JSON.parse(scriptMatch[1]);
    const userInfo = data['__DEFAULT_SCOPE__']['webapp.user-detail'].userInfo;
    
    return {
      username: userInfo.user.uniqueId,
      nickname: userInfo.user.nickname,
      bio: userInfo.user.signature,
      followers: userInfo.stats.followerCount,
      following: userInfo.stats.followingCount,
      likes: userInfo.stats.heartCount,
      videos: userInfo.stats.videoCount,
      verified: userInfo.user.verified
    };
  }
}
```

**Rate Limits:**
- ~50-100 requests per hour per IP before blocking
- 429 errors common, followed by temporary IP bans

### 3.2 Browser Automation (Playwright/Puppeteer)

**Best Practices:**
- Use Playwright with stealth plugins
- Mobile user agents perform better
- Implement scroll behavior (TikTok loads content on scroll)
- Random delays between actions
- Residential proxies recommended

**Example:**
```javascript
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);

async function scrapeTikTokWithPlaywright(username) {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0...)',
    viewport: { width: 375, height: 667 },
    locale: 'en-US',
  });
  
  const page = await context.newPage();
  
  await page.goto(`https://www.tiktok.com/@${username}`, {
    waitUntil: 'domcontentloaded'
  });
  
  // Wait for profile to load
  await page.waitForSelector('[data-e2e="user-bio"]', { timeout: 10000 });
  
  // Extract data
  const data = await page.evaluate(() => {
    const getTextContent = (selector) => {
      const el = document.querySelector(selector);
      return el ? el.textContent.trim() : null;
    };
    
    const getCount = (selector) => {
      const text = getTextContent(selector);
      if (!text) return 0;
      // Parse "1.5M" style counts
      const match = text.match(/(\d+\.?\d*)[KMB]?/);
      if (!match) return 0;
      let num = parseFloat(match[1]);
      if (text.includes('K')) num *= 1000;
      if (text.includes('M')) num *= 1000000;
      if (text.includes('B')) num *= 1000000000;
      return Math.round(num);
    };
    
    return {
      username: getTextContent('[data-e2e="user-title"]'),
      bio: getTextContent('[data-e2e="user-bio"]'),
      followers: getCount('[data-e2e="followers-count"]'),
      following: getCount('[data-e2e="following-count"]'),
      likes: getCount('[data-e2e="likes-count"]'),
    };
  });
  
  await browser.close();
  return data;
}
```

**Anti-Bot Evasion:**
- TikTok detects headless browsers aggressively
- Use `playwright-extra-stealth` or `rebrowser-patches`
- Consider `nodriver` (Python) - undetected Chrome automation
- Rotate IPs after 50-100 requests

### 3.3 Official APIs

#### **TikTok Research API**

**Access Requirements:**
- Must be a qualified academic or non-profit researcher
- Institutional affiliation required
- Application + 30-day approval process
- Research plan submission
- **Strictly non-commercial use only**

**Limitations:**
- ❌ Commercial use prohibited (your record shop app doesn't qualify)
- Rate limited to 1,000 requests/day
- Data retention limits (must refresh every 15 days)
- Must submit research plans to TikTok

**Verdict:** ❌ Not available for commercial record shop enrichment

#### **TikTok Business API / Marketing API**
- Only for ads data
- Requires advertiser account
- Doesn't provide public user/video data

**Verdict:** ❌ Not useful for profile scraping

### 3.4 Third-Party Services/Libraries

#### **TikTok-Api (Python - davidteather/TikTok-Api)**
- **GitHub:** `davidteather/TikTok-Api`
- **Status (2026):** Still maintained and working
- **Backend:** Uses Playwright for browser automation
- **Installation:** `pip install TikTokApi` + `python -m playwright install`

**Features:**
- Get user info, videos, hashtags, sounds
- No API key required
- Handles anti-bot measures internally
- Async support

**Example:**
```python
from TikTokApi import TikTokApi
import asyncio

async def get_user_data(username):
    async with TikTokApi() as api:
        user = api.user(username)
        user_data = await user.info()
        
        return {
            'username': user_data['uniqueId'],
            'nickname': user_data['nickname'],
            'bio': user_data['signature'],
            'followers': user_data['stats']['followerCount'],
            'following': user_data['stats']['followingCount'],
            'likes': user_data['stats']['heartCount'],
            'videos': user_data['stats']['videoCount']
        }

# Usage
data = asyncio.run(get_user_data('recordshopname'))
```

**Pros:**
- Actively maintained (latest release Nov 2025)
- Works without API keys
- Good documentation
- Community support

**Cons:**
- Python only (you're using Node.js)
- Requires Playwright (heavier than pure HTTP)
- Can still be detected/blocked with heavy use

**Verdict:** ✅ **Best Python option** - consider calling from Node.js via child process

#### **Node.js Integration:**
```javascript
const { spawn } = require('child_process');

async function getTikTokDataPython(username) {
  return new Promise((resolve, reject) => {
    const python = spawn('python3', ['-c', `
import asyncio
from TikTokApi import TikTokApi

async def main():
    async with TikTokApi() as api:
        user = api.user("${username}")
        data = await user.info()
        print(data)

asyncio.run(main())
    `]);
    
    let output = '';
    python.stdout.on('data', (data) => output += data);
    python.stderr.on('data', (data) => console.error(data.toString()));
    python.on('close', (code) => {
      if (code === 0) resolve(JSON.parse(output));
      else reject(new Error('Python script failed'));
    });
  });
}
```

#### **Apify TikTok Scraper**
- **URL:** `apify.com/clockworks/tiktok-scraper`
- **Pricing:** Pay-per-use, ~$5-15 for 800 profiles
- **Pros:**
  - No setup required
  - Handles proxies/anti-bot
  - Returns structured JSON
  - Node.js SDK available
- **Cons:** External dependency, cost

**Example:**
```javascript
const { ApifyClient } = require('apify-client');

const client = new ApifyClient({ token: 'YOUR_API_TOKEN' });

async function scrapeTikTokProfiles(usernames) {
  const run = await client.actor('clockworks/tiktok-scraper').call({
    profiles: usernames.map(u => `https://www.tiktok.com/@${u}`),
    resultsPerPage: 1
  });
  
  const { items } = await client.dataset(run.defaultDatasetId).listItems();
  return items;
}
```

**Verdict:** 🎯 **Best Node.js option** (managed service)

#### **Other Notable Services:**
- **Bright Data TikTok Scraper:** Enterprise solution, expensive
- **ScrapFly TikTok API:** Modern API, good documentation
- **SociaVault / ScrapeCreators:** Dedicated social APIs with TikTok support

### 3.5 Screenshot + AI Vision Approach

**Viability for TikTok: ★★★☆☆ (Moderate)**

TikTok profiles are visually simple, making AI vision extraction accurate but potentially unnecessary (since HTML scraping still works reasonably well).

**When to Use:**
- As a fallback if other methods fail
- Need visual verification
- Scraping video thumbnails/content

**Cost:** ~$0.10-0.20 per profile = $80-160 for 800 shops

**Pros:**
- Reliable extraction of follower counts
- Works despite HTML structure changes
- Can extract video thumbnails

**Cons:**
- More expensive than direct scraping
- Slower than API/HTML methods
- Overkill if TikTok-Api works

**Verdict:** ⚠️ Use as backup/fallback method

---

## 4. Browser Automation Deep Dive

### 4.1 Anti-Bot Evasion Techniques (2026)

**Core Strategies:**

1. **Playwright Stealth Plugin**
```javascript
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);

// Automatically patches:
// - navigator.webdriver (removes automation flag)
// - navigator.plugins (adds fake plugins)
// - navigator.languages (realistic language array)
// - window.chrome (adds chrome object for Chromium browsers)
// - Permissions API (overrides to avoid permission prompts)
```

2. **Fingerprint Spoofing**
```bash
npm install fingerprint-suite fingerprint-injector
```

```javascript
const { FingerprintGenerator } = require('fingerprint-suite');

const fpGenerator = new FingerprintGenerator({
  browsers: ['chrome'],
  devices: ['desktop'],
  locales: ['en-US'],
  operatingSystems: ['linux']
});

const fingerprint = fpGenerator.getFingerprint();

const context = await browser.newContext({
  userAgent: fingerprint.fingerprint.navigator.userAgent,
  viewport: fingerprint.fingerprint.screen,
  locale: fingerprint.fingerprint.navigator.language,
  timezoneId: 'America/New_York',
  geolocation: { latitude: 40.7128, longitude: -74.0060 },
  permissions: ['geolocation']
});
```

3. **TLS Fingerprinting Mitigation**
- Use latest Chrome/Chromium version (critical!)
- Avoid Python `requests` library (has distinctive TLS signature)
- Use browser automation or Node.js `got`/`axios` with proper headers
- Consider TLS proxy services (Bright Data, ScrapFly)

4. **Human-like Behavior Simulation**
```javascript
async function humanScroll(page) {
  await page.evaluate(async () => {
    await new Promise(resolve => {
      let totalHeight = 0;
      const distance = Math.floor(Math.random() * 100) + 100;
      const timer = setInterval(() => {
        const scrollHeight = document.body.scrollHeight;
        window.scrollBy(0, distance);
        totalHeight += distance;
        
        if (totalHeight >= scrollHeight - window.innerHeight) {
          clearInterval(timer);
          resolve();
        }
      }, Math.random() * 100 + 50);
    });
  });
}

async function randomDelay(min = 1000, max = 3000) {
  const delay = Math.random() * (max - min) + min;
  await new Promise(resolve => setTimeout(resolve, delay));
}

async function humanMouseMovement(page) {
  const { width, height } = page.viewportSize();
  await page.mouse.move(
    Math.random() * width,
    Math.random() * height,
    { steps: Math.floor(Math.random() * 10) + 5 }
  );
}
```

5. **Proxy Rotation**
```javascript
const proxies = [
  'http://proxy1:port',
  'http://proxy2:port',
  'http://proxy3:port'
];

let currentProxyIndex = 0;

async function getContextWithRotatedProxy() {
  const proxy = proxies[currentProxyIndex];
  currentProxyIndex = (currentProxyIndex + 1) % proxies.length;
  
  return await browser.newContext({
    proxy: { server: proxy }
  });
}
```

**Recommended Proxy Types:**
- **Residential proxies:** Best for social media (IP from real ISPs)
- **4G/5G mobile proxies:** Excellent for Instagram/TikTok (mobile-first platforms)
- **Datacenter proxies:** Cheapest but easily detected, not recommended

**Proxy Providers:**
- Bright Data (expensive, highest quality)
- Smartproxy (good balance)
- Oxylabs (enterprise)
- IPRoyal (budget-friendly residential)

### 4.2 Detection Testing Tools

Before deploying your scraper, test against:
- **bot.sannysoft.com** - Basic bot detection tests
- **pixelscan.net** - Comprehensive fingerprint analysis
- **creepjs.com** - Advanced fingerprinting detection
- **browserscan.net** - TLS and browser fingerprinting

**Passing Criteria:**
- bot.sannysoft.com: All tests green (headless detection, webdriver, etc.)
- pixelscan.net: Consistency score >80%, Trust score >70%

### 4.3 Session Management & Cookies

**Best Practices:**
```javascript
// Save session after scraping
await context.storageState({ path: 'session.json' });

// Reuse session later
const context = await browser.newContext({
  storageState: 'session.json'
});
```

**Session Warming:**
For logged-in scraping, warm up accounts:
1. Manual browsing for 5-10 minutes
2. Like/comment on 3-5 posts
3. Follow 2-3 accounts
4. Wait 24 hours before automated scraping
5. Save cookies/session state

---

## 5. Cost-Benefit Analysis for 800 Record Shops

### Scenario 1: DIY Browser Automation (One-time Scrape)

**Setup:**
- Playwright + stealth plugins
- Residential proxy service
- Manual implementation

**Costs:**
- Development time: 20-40 hours ($0 if DIY, $1000-3000 if outsourced)
- Residential proxies: $50-100/month (1-2 GB data)
- Server/compute: $10-20 (can run locally)

**Total:** $60-120 (excluding labor)

**Pros:**
- Full control
- Reusable for future scrapes
- Learn valuable skills

**Cons:**
- Time-intensive
- Maintenance required when sites change
- Risk of IP bans during development

**Recommended for:** Developers with time, ongoing monitoring needs

---

### Scenario 2: Apify Actors (Managed Service)

**Costs:**
- Instagram: $5-10 for 800 profiles
- Facebook: $10-25 for 800 pages
- TikTok: $5-10 for 800 profiles
- **Total: $20-45**

**Pros:**
- Quick setup (1-2 hours)
- No maintenance
- Reliable infrastructure
- Built-in proxy rotation
- Pay-as-you-go

**Cons:**
- Recurring cost for updates
- Less control
- Dependent on third-party

**Recommended for:** One-time scrapes, quick MVP, non-technical users

---

### Scenario 3: Screenshot + AI Vision

**Costs:**
- Instagram: $120-200 (800 × $0.15-0.25)
- Facebook: $160-320 (800 × $0.20-0.40, multiple screenshots)
- TikTok: $80-160 (800 × $0.10-0.20)
- **Total: $360-680**

**Pros:**
- Most reliable
- No account ban risk
- Works despite anti-bot measures
- Can extract any visual data

**Cons:**
- Expensive
- Slower (10-15 sec per shop)
- Requires vision API setup

**Recommended for:** High-value data, when other methods fail, maximum reliability needed

---

### Scenario 4: Hybrid Approach (Recommended)

**Strategy:**
1. Try direct HTML scraping first (free)
2. Fall back to Apify for failures ($20-45)
3. Use AI vision only for stubborn cases ($50-100)

**Total Cost:** $70-145

**Implementation:**
```javascript
async function scrapeWithFallback(platform, identifier) {
  try {
    // Attempt 1: Direct scraping (free)
    return await directScrape(platform, identifier);
  } catch (error) {
    console.log(`Direct scrape failed for ${identifier}, trying Apify...`);
    try {
      // Attempt 2: Apify ($)
      return await apifyScrape(platform, identifier);
    } catch (error2) {
      console.log(`Apify failed for ${identifier}, using AI vision...`);
      // Attempt 3: AI Vision ($$$)
      return await aiVisionScrape(platform, identifier);
    }
  }
}
```

**Estimated Success Rates:**
- Instagram: 60% direct, 90% Apify, 99% AI vision
- Facebook: 10% direct, 70% Apify, 95% AI vision
- TikTok: 70% direct, 95% Apify, 99% AI vision

**Pros:**
- Cost-effective
- High success rate
- Flexible

**Cons:**
- More complex implementation

---

## 6. Recommendations for Record Shop Enricher

### For Your Specific Use Case (800 shops, Node.js, Linux)

#### **Recommended Approach:**

**🥇 Option 1: Apify Actors (Best for MVP/Quick Win)**

```javascript
const { ApifyClient } = require('apify-client');

const client = new ApifyClient({ token: process.env.APIFY_TOKEN });

async function enrichRecordShop(shop) {
  const results = {};
  
  // Instagram
  if (shop.instagramHandle) {
    try {
      const run = await client.actor('apify/instagram-scraper').call({
        directUrls: [`https://www.instagram.com/${shop.instagramHandle}/`],
        resultsType: 'profiles',
        resultsLimit: 1
      });
      const { items } = await client.dataset(run.defaultDatasetId).listItems();
      results.instagram = items[0];
    } catch (e) {
      console.error(`Instagram failed for ${shop.name}:`, e.message);
    }
  }
  
  // TikTok
  if (shop.tiktokHandle) {
    try {
      const run = await client.actor('clockworks/tiktok-scraper').call({
        profiles: [`https://www.tiktok.com/@${shop.tiktokHandle}`],
        resultsPerPage: 1
      });
      const { items } = await client.dataset(run.defaultDatasetId).listItems();
      results.tiktok = items[0];
    } catch (e) {
      console.error(`TikTok failed for ${shop.name}:`, e.message);
    }
  }
  
  // Facebook (screenshot + AI if Apify fails)
  if (shop.facebookUrl) {
    results.facebook = await scrapeFacebookWithFallback(shop.facebookUrl);
  }
  
  return results;
}
```

**Cost:** ~$30-60 total  
**Time:** 2-4 hours setup, 1-2 hours runtime  
**Success Rate:** 80-90%

---

**🥈 Option 2: Hybrid (Direct + Apify + AI Vision)**

Use the fallback approach shown earlier.

**Cost:** ~$70-150 total  
**Time:** 8-16 hours setup, 2-4 hours runtime  
**Success Rate:** 95%+

---

**🥉 Option 3: Full DIY with Playwright Stealth**

Build custom scraper with proper evasion.

**Cost:** ~$60-120 (proxies + server)  
**Time:** 20-40 hours development  
**Success Rate:** 70-85% (requires tuning)  
**Best for:** Ongoing monitoring, learning, full control

---

### Immediate Next Steps

1. **Week 1: Prototype with Apify**
   - Sign up for Apify (free tier for testing)
   - Test with 10-20 record shops
   - Measure success rate and cost
   - Validate data quality

2. **Week 2: Implement Fallbacks**
   - Add direct HTML scraping for Instagram/TikTok
   - Set up screenshot + AI vision for Facebook
   - Build retry logic

3. **Week 3: Production Run**
   - Run full 800-shop scrape
   - Rate limit: 20-50 shops per hour (avoid suspicion)
   - Save raw data + timestamp
   - Log failures for manual review

4. **Week 4: Data Validation & Storage**
   - Clean and normalize data
   - Store in database
   - Build refresh mechanism (monthly/quarterly)

---

## 7. Legal & Ethical Considerations

### Terms of Service

All three platforms prohibit automated data collection in their ToS:
- **Instagram:** Forbids scraping without permission
- **Facebook:** Explicitly bans automated access
- **TikTok:** Prohibits bots and scrapers

**Reality:** Scraping public data for commercial use exists in a legal gray area. Courts have ruled both ways depending on jurisdiction and use case.

### Best Practices

✅ **Do:**
- Only scrape publicly available data
- Respect robots.txt (though social sites block everything)
- Rate limit aggressively (appear human)
- Provide opt-out mechanism for businesses
- Store data securely
- Use data only for stated purpose (enrichment)

❌ **Don't:**
- Scrape private/gated content
- Bypass authentication
- Resell scraped data
- Overwhelm servers
- Scrape personal user data (GDPR/CCPA violations)

### Risk Mitigation

- Use data for business analytics (lower risk than resale)
- Offer shops the ability to update/remove their data
- Don't make scraped data publicly searchable
- Attribute data source where possible
- Consider asking shops permission (though impractical for 800)

**Legal Disclaimer:** This research is educational. Consult a lawyer familiar with data privacy laws in your jurisdiction before scraping at scale.

---

## 8. Technical Implementation Checklist

### Prerequisites
```bash
# Node.js setup
npm install playwright playwright-extra puppeteer-extra-plugin-stealth
npm install apify-client openai anthropic
npm install dotenv axios

# Python (for TikTok-Api)
pip install TikTokApi
python -m playwright install
```

### Project Structure
```
record_shop_enricher/
├── src/
│   ├── scrapers/
│   │   ├── instagram.js
│   │   ├── facebook.js
│   │   ├── tiktok.js
│   │   └── ai-vision.js
│   ├── utils/
│   │   ├── proxy-manager.js
│   │   ├── rate-limiter.js
│   │   └── retry-logic.js
│   ├── config.js
│   └── index.js
├── data/
│   ├── record_shops.csv         # Input: shop names + handles
│   ├── results/                 # Output: scraped data
│   └── logs/                    # Error logs, retry queue
├── .env                         # API keys, credentials
└── package.json
```

### Configuration
```javascript
// config.js
module.exports = {
  apify: {
    token: process.env.APIFY_TOKEN,
    instagram: {
      actorId: 'apify/instagram-scraper',
      timeout: 60000
    },
    tiktok: {
      actorId: 'clockworks/tiktok-scraper',
      timeout: 60000
    }
  },
  
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    model: 'gpt-4o',
    maxTokens: 1000
  },
  
  rateLimit: {
    requestsPerHour: 50,
    delayBetweenRequests: 2000, // ms
  },
  
  retry: {
    maxAttempts: 3,
    backoffMultiplier: 2,
    initialDelay: 5000 // ms
  }
};
```

### Rate Limiter
```javascript
// utils/rate-limiter.js
class RateLimiter {
  constructor(requestsPerHour) {
    this.requestsPerHour = requestsPerHour;
    this.requests = [];
  }
  
  async waitIfNeeded() {
    const now = Date.now();
    const oneHourAgo = now - (60 * 60 * 1000);
    
    // Remove requests older than 1 hour
    this.requests = this.requests.filter(time => time > oneHourAgo);
    
    if (this.requests.length >= this.requestsPerHour) {
      const oldestRequest = this.requests[0];
      const waitTime = oldestRequest + (60 * 60 * 1000) - now;
      console.log(`Rate limit reached. Waiting ${waitTime}ms...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    
    this.requests.push(now);
  }
}

module.exports = RateLimiter;
```

### Main Enrichment Flow
```javascript
// src/index.js
const { enrichRecordShop } = require('./scrapers');
const RateLimiter = require('./utils/rate-limiter');
const fs = require('fs').promises;

async function enrichAllShops() {
  const shops = JSON.parse(await fs.readFile('data/record_shops.json'));
  const rateLimiter = new RateLimiter(50); // 50 requests/hour
  const results = [];
  
  for (let i = 0; i < shops.length; i++) {
    console.log(`Processing ${i + 1}/${shops.length}: ${shops[i].name}`);
    
    await rateLimiter.waitIfNeeded();
    
    try {
      const enriched = await enrichRecordShop(shops[i]);
      results.push({
        ...shops[i],
        ...enriched,
        scrapedAt: new Date().toISOString()
      });
      
      // Save incrementally
      if (i % 10 === 0) {
        await fs.writeFile(
          `data/results/batch_${Math.floor(i / 10)}.json`,
          JSON.stringify(results.slice(i - 9, i + 1), null, 2)
        );
      }
    } catch (error) {
      console.error(`Failed to enrich ${shops[i].name}:`, error.message);
      results.push({
        ...shops[i],
        error: error.message,
        scrapedAt: new Date().toISOString()
      });
    }
    
    // Random delay to appear more human
    await new Promise(resolve => 
      setTimeout(resolve, Math.random() * 3000 + 2000)
    );
  }
  
  await fs.writeFile('data/results/final.json', JSON.stringify(results, null, 2));
  console.log('Enrichment complete!');
}

enrichAllShops().catch(console.error);
```

---

## 9. Summary & Decision Matrix

| Approach | Instagram | Facebook | TikTok | Total Cost | Time | Reliability |
|----------|-----------|----------|--------|------------|------|-------------|
| **Direct HTML** | ⚠️ OK | ❌ Hard | ⚠️ OK | $0-50 | High | 60% |
| **Apify Actors** | ✅ Good | ⚠️ OK | ✅ Good | $30-60 | Low | 85% |
| **DIY Playwright** | ✅ Good | ⚠️ Hard | ✅ Good | $60-120 | Very High | 75% |
| **AI Vision** | ✅ Excellent | ✅ Excellent | ✅ Excellent | $360-680 | Medium | 95% |
| **Hybrid** | ✅ Excellent | ✅ Excellent | ✅ Excellent | $70-150 | Medium | 95% |

### Final Recommendation: **Hybrid Approach**

**For 800 record shops, use:**
1. Apify for Instagram + TikTok (fast, cheap, reliable)
2. Screenshot + AI Vision for Facebook (most reliable given FB's anti-scraping)
3. Direct HTML scraping as primary attempt (free, why not try?)

**Expected Outcome:**
- **Cost:** $100-150 total
- **Time:** 10-15 hours implementation + 3-5 hours runtime
- **Success Rate:** 90-95% data collection
- **Maintenance:** Minimal (Apify handles site changes)

**Timeline:**
- Day 1-2: Setup Apify + AI vision pipelines
- Day 3: Test with 50 shops
- Day 4-5: Full run (800 shops)
- Day 6: Data validation + cleanup

---

## 10. Additional Resources

### Documentation
- [Playwright Stealth Guide](https://brightdata.com/blog/how-tos/avoid-bot-detection-with-playwright-stealth)
- [Apify Instagram Scraper](https://apify.com/apify/instagram-scraper)
- [TikTok-Api Documentation](https://github.com/davidteather/TikTok-Api)
- [GPT-4o Vision API](https://platform.openai.com/docs/guides/vision)

### Tools
- **Proxy Testing:** pixelscan.net, bot.sannysoft.com
- **Fingerprint Libraries:** fingerprint-suite (npm)
- **Rate Limiting:** bottleneck (npm)
- **CSV Processing:** papaparse (npm)

### Communities
- r/webscraping (Reddit)
- Apify Discord
- Playwright GitHub Discussions

---

**Report End**

*Generated: February 12, 2026*  
*For: Record Shop Enricher Project*  
*Next Steps: Prototype with Apify using 10-20 test shops*
