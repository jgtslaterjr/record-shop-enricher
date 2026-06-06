#!/usr/bin/env node
/**
 * Multi-Source Review Synthesizer — Produces Google AI Overview-quality summaries
 * 
 * Gathers from: Yelp, Google, Facebook, Discogs, Reddit, Wheree.com, user reviews,
 * website content, and press mentions.
 * 
 * Usage:
 *   node summarize_reviews.js --shop-id "uuid"
 *   node summarize_reviews.js --all --limit 10
 *   node summarize_reviews.js --shop-id "uuid" --force  (re-analyze)
 */

const { saveJSON, loadJSON, contentDir, getAllShops, updateShop, supabase,
  ollamaSummarize, anthropicSummarize, parseArgs, log } = require('./lib/common');
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

// ═══════════════════════════════════════════════════════════════════════════════
// Source Gathering Functions
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Load Yelp reviews from content/{shopId}/reviews/yelp_reviews.json
 */
function loadYelpReviews(shopId) {
  const yelpPath = contentDir(shopId, 'reviews', 'yelp_reviews.json');
  const data = loadJSON(yelpPath);
  return data?.reviews || [];
}

/**
 * Load Google reviews from content/{shopId}/reviews/google_reviews.json
 */
function loadGoogleReviews(shopId) {
  const googlePath = contentDir(shopId, 'reviews', 'google_reviews.json');
  const data = loadJSON(googlePath);
  return {
    reviews: data?.reviews || [],
    rating: data?.rating || null,
    reviewCount: data?.reviewCount || data?.user_ratings_total || 0
  };
}

/**
 * Load Facebook data from content/{shopId}/facebook/
 */
function loadFacebookData(shopId) {
  const fbDir = contentDir(shopId, 'facebook');
  if (!fs.existsSync(fbDir)) return null;
  
  const files = fs.readdirSync(fbDir).filter(f => f.endsWith('.json'));
  if (files.length === 0) return null;
  
  // Load first JSON file found
  const data = loadJSON(path.join(fbDir, files[0]));
  return {
    rating: data?.overall_star_rating || data?.rating || null,
    reviewCount: data?.rating_count || 0,
    description: data?.about || data?.description || null
  };
}

/**
 * Load Discogs data from content/{shopId}/discogs/
 */
function loadDiscogsData(shopId) {
  const discogsPath = contentDir(shopId, 'discogs', 'profile.json');
  const data = loadJSON(discogsPath);
  if (!data) return null;
  
  return {
    rating: data?.seller_rating || data?.rating || null,
    ratingCount: data?.num_ratings || data?.rating_count || 0,
    positivePercent: data?.seller_rating_percent || null,
    profileUrl: data?.uri || data?.url || null
  };
}

/**
 * Load website content from content/{shopId}/website/
 */
function loadWebsiteContent(shopId) {
  const websiteDir = contentDir(shopId, 'website');
  if (!fs.existsSync(websiteDir)) return null;
  
  const content = {};
  const files = fs.readdirSync(websiteDir).filter(f => f.endsWith('.json'));
  
  for (const file of files) {
    const data = loadJSON(path.join(websiteDir, file));
    if (data?.text) {
      const pageName = file.replace('.json', '');
      content[pageName] = data.text.slice(0, 2000); // Cap per page
    }
  }
  
  return Object.keys(content).length > 0 ? content : null;
}

/**
 * Load Reddit mentions from content/{shopId}/reddit/
 */
function loadRedditMentions(shopId) {
  const redditPath = contentDir(shopId, 'reddit', 'mentions.json');
  const data = loadJSON(redditPath);
  return data?.mentions || [];
}

/**
 * Search Reddit dynamically (inline from scrape_reddit.js)
 */
async function redditSearch(query, subreddit = null, limit = 25) {
  const base = subreddit
    ? `https://www.reddit.com/r/${subreddit}/search.json`
    : `https://www.reddit.com/search.json`;
  
  const params = new URLSearchParams({
    q: query,
    limit: limit.toString(),
    sort: 'relevance',
    t: 'all',
    ...(subreddit ? { restrict_sr: 'on' } : {})
  });
  
  try {
    const response = await fetch(`${base}?${params}`, {
      headers: { 'User-Agent': 'RecordShopBot/1.0' }
    });
    
    if (response.status === 429) {
      log('    Reddit rate limit, waiting 2s...');
      await new Promise(r => setTimeout(r, 2000));
      return redditSearch(query, subreddit, limit);
    }
    
    if (!response.ok) return [];
    
    const json = await response.json();
    return json?.data?.children?.map(c => c.data) || [];
  } catch (e) {
    log(`    Reddit search error: ${e.message}`);
    return [];
  }
}

async function gatherRedditMentions(shopId, shopName, city) {
  // Check for existing scrape first
  const existing = loadRedditMentions(shopId);
  if (existing.length > 0) return existing;
  
  // Do a quick search
  const searchQuery = `"${shopName}" ${city || ''} record store`;
  const posts = await redditSearch(searchQuery, null, 15);
  
  return posts.slice(0, 10).map(post => ({
    title: post.title,
    text: post.selftext?.slice(0, 500) || '',
    url: `https://reddit.com${post.permalink}`,
    subreddit: post.subreddit,
    score: post.score,
    created: post.created_utc
  }));
}

/**
 * Fetch Wheree.com listing for a shop
 */
async function fetchWhereeData(shopName, slug) {
  const tryUrls = [
    `https://${slug}.wheree.com/`,
    `https://${shopName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.wheree.com/`
  ];
  
  for (const url of tryUrls) {
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'RecordShopBot/1.0' },
        redirect: 'follow'
      });
      
      if (!response.ok) continue;
      
      const html = await response.text();
      const $ = cheerio.load(html);
      
      // Extract review/description content (adjust selectors as needed)
      const description = $('meta[name="description"]').attr('content') || '';
      const mainText = $('.description, .about, .review-text, main p').text().trim();
      
      if (description || mainText) {
        return {
          url,
          description: description.slice(0, 500),
          text: mainText.slice(0, 1000)
        };
      }
    } catch (e) {
      // Silently continue to next URL
    }
  }
  
  return null;
}

/**
 * Load press mentions from content/{shopId}/press/
 */
function loadPressMentions(shopId) {
  const pressDir = contentDir(shopId, 'press');
  if (!fs.existsSync(pressDir)) return [];
  
  const mentions = [];
  const files = fs.readdirSync(pressDir).filter(f => f.endsWith('.json'));
  
  for (const file of files) {
    const data = loadJSON(path.join(pressDir, file));
    if (data?.text || data?.snippet) {
      mentions.push({
        source: data.source || file.replace('.json', ''),
        text: (data.text || data.snippet).slice(0, 500),
        url: data.url || null
      });
    }
  }
  
  return mentions;
}

/**
 * Fetch review content from known review aggregator sites + the shop's own site
 */
async function searchAndFetchMentions(shopName, city, state, slug, website) {
  const mentions = [];
  const nameSlug = shopName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '');

  // Known review/mention URLs to try for each shop
  const urlsToTry = [
    // Wheree.com (subdomain per shop)
    { url: `https://${nameSlug}.wheree.com/`, source: 'wheree.com' },
    // Loc8NearMe
    { url: `https://www.loc8nearme.com/search/?q=${encodeURIComponent(shopName + ' ' + (city || ''))}`, source: 'loc8nearme.com' },
    // MapQuest
    { url: `https://www.mapquest.com/search/${encodeURIComponent(shopName + ' ' + (city || '') + ' ' + (state || ''))}`, source: 'mapquest.com' },
    // Shop's own website (about page)
    ...(website ? [
      { url: website, source: 'shop website' },
      { url: website.replace(/\/$/, '') + '/about', source: 'shop website (about)' },
      { url: website.replace(/\/$/, '') + '/about-us', source: 'shop website (about)' },
    ] : []),
  ];

  for (const { url, source } of urlsToTry) {
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        signal: AbortSignal.timeout(10000),
        redirect: 'follow',
      });
      if (!response.ok) continue;
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('html')) continue;

      const html = await response.text();
      // Skip Cloudflare/captcha pages
      if (html.includes('Just a moment') && html.includes('Enable JavaScript')) continue;

      const $ = cheerio.load(html);
      $('script, style, nav, footer, header, iframe, noscript').remove();

      const title = $('title').text().trim();

      // Try to extract review-specific content first
      const reviewText = $('[class*="review"], [class*="Review"], .comment, .testimonial, [itemprop="reviewBody"]')
        .map((_, el) => $(el).text().trim()).get().join('\n');

      const bodyText = reviewText || $('main, article, .content, #content, [role="main"]').text().trim()
        || $('body').text().trim();
      const cleanText = bodyText.replace(/\s+/g, ' ').trim();

      if (cleanText.length > 100) {
        mentions.push({
          source,
          title: title.slice(0, 100),
          text: cleanText.slice(0, 2000),
          url,
        });
        log(`    ✓ Fetched ${source} (${cleanText.length} chars)`);
      }

      await new Promise(r => setTimeout(r, 500));
    } catch (e) {
      // Skip failed fetches silently
    }
  }

  return mentions;
}

/**
 * Load user reviews from database (captured_reviews table)
 */
async function loadUserReviews(shopId) {
  try {
    const { data, error } = await supabase
      .from('captured_reviews')
      .select('review_text, captured_at')
      .eq('shop_id', shopId);
    
    if (error) throw error;
    return data || [];
  } catch (e) {
    log(`    Error loading user reviews: ${e.message}`);
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Context Building
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Build comprehensive context document from all sources
 */
async function buildContext(shopId, shopName, city, state, slug) {
  const sources = {
    yelp: 0, google: 0, facebook: 0, reddit: 0, wheree: false,
    user: 0, press: 0, discogs: 0, website: 0
  };
  
  let context = `=== SHOP INFO ===\nName: ${shopName}\nLocation: ${city}, ${state}\n\n`;
  
  // ─────────────────────────────────────────────────────────────────────────────
  // RATINGS OVERVIEW
  // ─────────────────────────────────────────────────────────────────────────────
  context += `=== RATINGS OVERVIEW ===\n`;
  
  const googleData = loadGoogleReviews(shopId);
  if (googleData.rating) {
    context += `Google Maps: ${googleData.rating}★ (${googleData.reviewCount} reviews)\n`;
  }
  
  const yelpReviews = loadYelpReviews(shopId);
  if (yelpReviews.length > 0) {
    const yelpRatings = yelpReviews.filter(r => r.stars).map(r => r.stars);
    const avgYelp = (yelpRatings.reduce((a, b) => a + b, 0) / yelpRatings.length).toFixed(1);
    context += `Yelp: ${avgYelp}★ (${yelpReviews.length} reviews)\n`;
    sources.yelp = yelpReviews.length;
  }
  
  const fbData = loadFacebookData(shopId);
  if (fbData?.rating) {
    context += `Facebook: ${fbData.rating}★ (${fbData.reviewCount} ratings)\n`;
    sources.facebook = fbData.reviewCount;
  }
  
  const discogsData = loadDiscogsData(shopId);
  if (discogsData?.positivePercent) {
    context += `Discogs: ${discogsData.positivePercent}% positive (${discogsData.ratingCount} ratings)\n`;
    sources.discogs = discogsData.ratingCount;
  }
  
  context += '\n';
  
  // ─────────────────────────────────────────────────────────────────────────────
  // REVIEW EXCERPTS
  // ─────────────────────────────────────────────────────────────────────────────
  context += `=== REVIEW EXCERPTS ===\n`;
  
  const allReviewTexts = [];
  
  // Google reviews
  sources.google = googleData.reviews.length;
  for (const review of googleData.reviews.slice(0, 15)) {
    if (review.text && review.text.length > 20) {
      allReviewTexts.push({
        source: 'Google',
        text: review.text.slice(0, 400),
        author: review.author || review.reviewer || 'Anonymous',
        rating: review.stars || review.rating || null
      });
    }
  }
  
  // Yelp reviews
  for (const review of yelpReviews.slice(0, 15)) {
    if (review.text && review.text.length > 20) {
      allReviewTexts.push({
        source: 'Yelp',
        text: review.text.slice(0, 400),
        author: review.author || 'Anonymous',
        rating: review.stars || null
      });
    }
  }
  
  // User reviews
  const userReviews = await loadUserReviews(shopId);
  sources.user = userReviews.length;
  for (const review of userReviews.slice(0, 10)) {
    if (review.review_text && review.review_text.length > 20) {
      allReviewTexts.push({
        source: 'User',
        text: review.review_text.slice(0, 400),
        author: 'Visitor Review',
        rating: null
      });
    }
  }
  
  // Reddit mentions
  const redditMentions = await gatherRedditMentions(shopId, shopName, city);
  sources.reddit = redditMentions.length;
  for (const mention of redditMentions.slice(0, 8)) {
    if (mention.text || mention.title) {
      allReviewTexts.push({
        source: `Reddit r/${mention.subreddit}`,
        text: (mention.text || mention.title).slice(0, 400),
        author: mention.score ? `${mention.score}↑` : '',
        rating: null
      });
    }
  }
  
  // Sort by length (prioritize detailed reviews) and cap at 50 total
  allReviewTexts.sort((a, b) => b.text.length - a.text.length);
  const selectedReviews = allReviewTexts.slice(0, 50);
  
  for (const review of selectedReviews) {
    const ratingStr = review.rating ? ` (${review.rating}★)` : '';
    context += `[${review.source}] "${review.text}" - ${review.author}${ratingStr}\n\n`;
  }
  
  // ─────────────────────────────────────────────────────────────────────────────
  // WEBSITE CONTENT
  // ─────────────────────────────────────────────────────────────────────────────
  const websiteContent = loadWebsiteContent(shopId);
  if (websiteContent) {
    context += `=== WEBSITE CONTENT ===\n`;
    sources.website = Object.keys(websiteContent).length;
    
    for (const [page, text] of Object.entries(websiteContent)) {
      context += `${page}: ${text.slice(0, 800)}\n\n`;
    }
  }
  
  // ─────────────────────────────────────────────────────────────────────────────
  // WHEREE.COM
  // ─────────────────────────────────────────────────────────────────────────────
  const whereeData = await fetchWhereeData(shopName, slug);
  if (whereeData) {
    context += `=== WHEREE.COM ===\n`;
    if (whereeData.description) context += `${whereeData.description}\n`;
    if (whereeData.text) context += `${whereeData.text}\n`;
    context += '\n';
    sources.wheree = true;
  }
  
  // ─────────────────────────────────────────────────────────────────────────────
  // PRESS/NEWS MENTIONS
  // ─────────────────────────────────────────────────────────────────────────────
  const pressMentions = loadPressMentions(shopId);
  // Fetch shop details for website URL
  let shopWebsite = null;
  try {
    const { data: shopData } = await supabase.from('shops').select('website').eq('id', shopId).single();
    shopWebsite = shopData?.website;
  } catch {}
  const webMentions = await searchAndFetchMentions(shopName, city, state, slug, shopWebsite);
  const allPress = [...pressMentions, ...webMentions];
  
  if (allPress.length > 0) {
    context += `=== WEB MENTIONS & REVIEWS ===\n`;
    sources.press = allPress.length;
    
    for (const mention of allPress.slice(0, 8)) {
      if (mention.source) context += `[${mention.source}] `;
      if (mention.title) context += `${mention.title}\n`;
      context += `${mention.text.slice(0, 1000)}\n`;
      if (mention.url) context += `Source: ${mention.url}\n`;
      context += '\n';
    }
  }
  
  // ─────────────────────────────────────────────────────────────────────────────
  // SUPPLEMENTAL SOURCES (manually gathered enrichment data)
  // ─────────────────────────────────────────────────────────────────────────────
  const suppPath = contentDir(shopId, 'reviews', 'supplemental_sources.json');
  const supplemental = loadJSON(suppPath);
  if (supplemental) {
    context += `=== SUPPLEMENTAL DATA (verified from multiple platforms) ===\n`;
    
    if (supplemental.google?.rating) {
      context += `Google Maps: ${supplemental.google.rating}★ from ${supplemental.google.reviewCount} reviews\n`;
      sources.google = Math.max(sources.google, supplemental.google.reviewCount || 0);
    }
    if (supplemental.facebook?.recordStorePage) {
      const fb = supplemental.facebook.recordStorePage;
      context += `Facebook (Record Store): ${fb.rating} (${fb.reviewCount} reviews), Hours: ${fb.hours}, Email: ${fb.email}\n`;
      sources.facebook = Math.max(sources.facebook, fb.reviewCount || 0);
    }
    if (supplemental.facebook?.labelPage) {
      const fbl = supplemental.facebook.labelPage;
      context += `Facebook (Label): ${fbl.likes} likes, ${fbl.talkingAbout} talking about this\n`;
    }
    if (supplemental.yelp?.rating) {
      context += `Yelp: ${supplemental.yelp.rating}★, ${supplemental.yelp.photos} photos\n`;
      if (supplemental.yelp.snippets) {
        for (const s of supplemental.yelp.snippets) context += `  Yelp review: "${s}"\n`;
      }
      sources.yelp = Math.max(sources.yelp, 1);
    }
    if (supplemental.instagram) {
      context += `Instagram: ${supplemental.instagram.followers} followers, ${supplemental.instagram.posts} posts\n`;
    }
    if (supplemental.wheree?.summary) {
      context += `Wheree.com: ${supplemental.wheree.summary}\n`;
      if (supplemental.wheree.reliability) context += `  Reliability: ${supplemental.wheree.reliability}\n`;
      sources.wheree = true;
    }
    if (supplemental.mapquest?.snippets) {
      for (const s of supplemental.mapquest.snippets) context += `MapQuest review: "${s}"\n`;
    }
    if (supplemental.loc8nearme?.snippets) {
      for (const s of supplemental.loc8nearme.snippets) context += `Loc8NearMe review: "${s}"\n`;
    }
    if (supplemental.wikipedia?.summary) {
      context += `Wikipedia: ${supplemental.wikipedia.summary}\n`;
    }
    if (supplemental.press) {
      for (const [key, press] of Object.entries(supplemental.press)) {
        context += `\n[Press: ${press.title || key}]\n`;
        if (press.subtitle) context += `${press.subtitle}\n`;
        if (press.keyFacts) {
          for (const f of press.keyFacts) context += `  • ${f}\n`;
        }
        if (press.keyQuotes) {
          for (const q of press.keyQuotes) context += `  Quote: "${q}"\n`;
        }
        sources.press = (sources.press || 0) + 1;
      }
    }
    context += '\n';
  }

  // Cap total context at ~25,000 chars (richer sources = better synthesis)
  if (context.length > 25000) {
    context = context.slice(0, 25000) + '\n\n[...truncated for length]';
  }
  
  return { context, sources };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Analysis & Prompt
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Generate improved prompt based on synthesis-prompt.md template
 */
function buildPrompt(shopName, city, state, context) {
  return `You are analyzing "${shopName}", a record shop in ${city}, ${state}. Synthesize ALL sources below into a comprehensive review analysis.

${context}

## Instructions

Analyze ALL the above and return JSON with EXACTLY these keys:

{
  "review_score": <number 1-10, 10 = most positive, weighted by source reliability>,
  "review_vibe": "<2-3 sentences describing the shop's atmosphere, personality, and what makes it distinctive>",
  "review_pros": ["<3-5 main positives, specific and sourced>"],
  "review_cons": ["<2-4 negatives or areas for improvement, be honest>"],
  "review_themes": ["<5-8 recurring themes across all sources>"],
  "review_notable_quotes": {
    "best": {"text": "<most glowing quote>", "source": "<Google/Yelp/Facebook/Reddit>"},
    "worst": {"text": "<most critical quote>", "source": "<source>"},
    "funniest": {"text": "<most entertaining quote>", "source": "<source>"}
  },
  "genre_specialties": ["<genres frequently mentioned>"],
  "staff_mentions": "<summary of what reviewers say about staff, name names if mentioned>",
  "recommendation_for": "<who would love this shop, be specific>",
  "review_summary": "<SEO-friendly 2-3 paragraph overview synthesizing everything, similar to a Google AI Overview. Include source attribution like 'According to Yelp reviewers...' or 'Discogs sellers rate them...'>"
}

IMPORTANT:
- Weight Discogs transaction ratings highly for record shops — a 99%+ rating over 1000+ sales is extremely meaningful
- Distinguish between the physical store experience and online/mailorder when both exist
- Note if the shop is also a record label or distributor (common in this industry)
- Include specific details (staff names, genre focuses, unique features) — avoid generic praise
- If sources conflict, note the disagreement rather than averaging
- Source attribution is critical — say WHERE each insight comes from`;
}

/**
 * Parse JSON from Ollama response (handles various formats)
 */
function parseOllamaJSON(response) {
  // Strategy 1: extract from ```json ... ``` code fence
  const fenceMatch = response.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  // Strategy 2: find first { ... } block
  const rawJson = fenceMatch ? fenceMatch[1] : (response.match(/\{[\s\S]*\}/) || [null])[0];
  
  if (!rawJson) return null;
  
  // Sanitize Python-style values and unquoted strings
  let sanitized = rawJson
    .replace(/:\s*None/g, ': null')
    .replace(/:\s*True/g, ': true')
    .replace(/:\s*False/g, ': false')
    .replace(/:\s*([A-Z][^",\n\r}\]]*[^",\s\n\r}\]])\s*([,}\]])/g, ': "$1"$2');
  
  try {
    return JSON.parse(sanitized);
  } catch (e) {
    // Strategy 3: use a more lenient parse — strip trailing commas, fix quotes
    sanitized = sanitized
      .replace(/,\s*([}\]])/g, '$1')  // trailing commas
      .replace(/([{,]\s*)(\w+)\s*:/g, '$1"$2":');  // unquoted keys
    try {
      return JSON.parse(sanitized);
    } catch (e2) {
      return null;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Main Analysis Function
// ═══════════════════════════════════════════════════════════════════════════════

async function summarizeShopReviews(shop, force = false) {
  const { id: shopId, name: shopName, city, state, slug } = shop;
  
  // Check if analysis already exists (unless --force)
  const analysisPath = contentDir(shopId, 'reviews', 'analysis.json');
  if (!force && fs.existsSync(analysisPath)) {
    log(`  Analysis already exists, skipping (use --force to re-analyze)`);
    return loadJSON(analysisPath);
  }
  
  log(`  Gathering sources for ${shopName}...`);
  const { context, sources } = await buildContext(shopId, shopName, city, state, slug);
  
  const totalReviews = sources.yelp + sources.google + sources.user + sources.facebook;
  if (totalReviews === 0 && sources.reddit === 0) {
    log(`  No reviews or mentions found`);
    return null;
  }
  
  log(`  Sources: Google=${sources.google}, Yelp=${sources.yelp}, User=${sources.user}, Reddit=${sources.reddit}, FB=${sources.facebook}, Discogs=${sources.discogs}, Wheree=${sources.wheree}, Press=${sources.press}`);
  
  // Build prompt
  const prompt = buildPrompt(shopName, city, state, context);
  
  // Call Anthropic Sonnet
  try {
    log(`  Analyzing with Claude Sonnet 4.5...`);
    log(`  Context: ${context.length} chars`);
    const result = await anthropicSummarize(prompt);
    
    const analysis = parseOllamaJSON(result);
    
    if (!analysis) {
      log(`  JSON parse failed, saving raw summary`);
      return {
        raw_summary: result.slice(0, 2000),
        metadata: {
          sources,
          totalReviewsAnalyzed: totalReviews,
          analyzedAt: new Date().toISOString()
        }
      };
    }
    
    // Add metadata
    analysis.metadata = {
      sources,
      totalReviewsAnalyzed: totalReviews,
      analyzedAt: new Date().toISOString()
    };
    
    return analysis;
    
  } catch (e) {
    log(`  Ollama error: ${e.message}`);
    return { error: e.message };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Database Update
// ═══════════════════════════════════════════════════════════════════════════════

async function persistAnalysis(shopId, analysis) {
  if (!analysis || analysis.error) return;
  
  const updates = {
    sentiment_score: analysis.review_score || analysis.sentiment_score || null,
    review_vibe: analysis.review_vibe || analysis.vibe_description || null,
    review_pros: analysis.review_pros || analysis.pros || null,
    review_cons: analysis.review_cons || analysis.cons || null,
    review_themes: analysis.review_themes || analysis.key_themes || null,
    review_notable_quotes: analysis.review_notable_quotes || analysis.notable_quotes || null,
    recommendation_for: analysis.recommendation_for || null,
    genre_specialties: analysis.genre_specialties || null,
    review_summary: analysis.review_summary || null,
    review_count: analysis.metadata?.totalReviewsAnalyzed || null,
  };
  
  await updateShop(shopId, updates);
}

// ═══════════════════════════════════════════════════════════════════════════════
// CLI Entry Point
// ═══════════════════════════════════════════════════════════════════════════════

async function run() {
  const args = parseArgs();
  const force = args.force || false;

  if (args['shop-id']) {
    const { data: shop, error } = await supabase
      .from('shops')
      .select('*')
      .eq('id', args['shop-id'])
      .single();
    
    if (error || !shop) {
      log('Shop not found');
      return;
    }

    const analysis = await summarizeShopReviews(shop, force);
    
    if (analysis && !analysis.error) {
      const outPath = contentDir(shop.id, 'reviews', 'analysis.json');
      saveJSON(outPath, analysis);
      
      await persistAnalysis(shop.id, analysis);

      log(`✓ Saved analysis to ${outPath}`);
      console.log(JSON.stringify(analysis, null, 2));
    }
    return;
  }

  if (args.all) {
    const limit = parseInt(args.limit) || 10;
    const shops = await getAllShops(limit);
    let processed = 0, skipped = 0;

    for (const shop of shops) {
      try {
        log(`\n═══ ${shop.name} (${shop.city}, ${shop.state}) ═══`);
        const analysis = await summarizeShopReviews(shop, force);
        
        if (analysis && !analysis.error) {
          const outPath = contentDir(shop.id, 'reviews', 'analysis.json');
          saveJSON(outPath, analysis);

          await persistAnalysis(shop.id, analysis);

          const score = analysis.review_score || analysis.sentiment_score || '?';
          processed++;
          log(`✓ [${processed}] ${shop.name} — score: ${score}/10`);
        } else {
          skipped++;
        }
      } catch (e) {
        log(`✗ ${shop.name}: ${e.message}`);
        skipped++;
      }
    }

    log(`\nDone. Analyzed ${processed}, skipped ${skipped}.`);
  } else {
    log('Usage:');
    log('  node summarize_reviews.js --shop-id "uuid"');
    log('  node summarize_reviews.js --all --limit 10');
    log('  node summarize_reviews.js --shop-id "uuid" --force');
  }
}

run().catch(e => { console.error(e); process.exit(1); });
