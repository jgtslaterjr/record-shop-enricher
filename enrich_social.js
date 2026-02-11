#!/usr/bin/env node

/**
 * Tier 2: Social Media Intelligence Enricher
 * Extracts Instagram, Facebook, TikTok metrics and engagement data
 */

const { execSync } = require('child_process');

const OLLAMA_MODEL = 'kimi-k2.5:cloud';
const FETCH_TIMEOUT = 15000;

// Social media URL patterns
const SOCIAL_PATTERNS = {
  instagram: /(?:instagram\.com|instagr\.am)\/([a-zA-Z0-9._]+)/,
  facebook: /facebook\.com\/([a-zA-Z0-9._]+)/,
  tiktok: /tiktok\.com\/@([a-zA-Z0-9._]+)/
};

function log(message) {
  console.log(`[${new Date().toISOString().substring(11, 19)}] ${message}`);
}

function fetchUrl(url) {
  try {
    const result = execSync(
      `curl -L -s --max-time ${FETCH_TIMEOUT/1000} ` +
      `-H "User-Agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36" ` +
      `-H "Accept: text/html,application/json" ` +
      `-H "Accept-Language: en-US,en;q=0.9" ` +
      `"${url}"`,
      { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
    );
    return result;
  } catch (error) {
    log(`  ⚠️  Failed to fetch ${url}: ${error.message}`);
    return null;
  }
}

function extractInstagramData(username, html) {
  log(`  📸 Analyzing Instagram @${username}...`);
  
  if (!html) return null;
  
  const data = {
    username,
    url: `https://instagram.com/${username}`,
    exists: false
  };
  
  // Look for shared data JSON (Instagram embeds profile data in script tags)
  const sharedDataMatch = html.match(/window\._sharedData\s*=\s*({.*?});/);
  const additionalDataMatch = html.match(/window\.__additionalDataLoaded\([^,]+,\s*({.*?})\);/);
  
  try {
    if (sharedDataMatch) {
      const json = JSON.parse(sharedDataMatch[1]);
      const profile = json?.entry_data?.ProfilePage?.[0]?.graphql?.user;
      
      if (profile) {
        data.exists = true;
        data.full_name = profile.full_name;
        data.bio = profile.biography;
        data.followers = profile.edge_followed_by?.count;
        data.following = profile.edge_follow?.count;
        data.posts = profile.edge_owner_to_timeline_media?.count;
        data.is_verified = profile.is_verified;
        data.is_business = profile.is_business_account;
        data.category = profile.category_name;
        data.website = profile.external_url;
      }
    } else if (additionalDataMatch) {
      const json = JSON.parse(additionalDataMatch[1]);
      const profile = json?.graphql?.user;
      
      if (profile) {
        data.exists = true;
        data.full_name = profile.full_name;
        data.bio = profile.biography;
        data.followers = profile.edge_followed_by?.count;
        data.following = profile.edge_follow?.count;
        data.posts = profile.edge_owner_to_timeline_media?.count;
        data.is_verified = profile.is_verified;
        data.is_business = profile.is_business_account;
        data.category = profile.category_name;
        data.website = profile.external_url;
      }
    }
    
    // Fallback: try to extract from meta tags
    if (!data.exists) {
      const descMatch = html.match(/<meta property="og:description" content="([^"]+)"/);
      if (descMatch) {
        const desc = descMatch[1];
        const followersMatch = desc.match(/(\d+(?:,\d+)*)\s+Followers/);
        const followingMatch = desc.match(/(\d+(?:,\d+)*)\s+Following/);
        const postsMatch = desc.match(/(\d+(?:,\d+)*)\s+Posts/);
        
        if (followersMatch || followingMatch || postsMatch) {
          data.exists = true;
          data.followers = followersMatch ? parseInt(followersMatch[1].replace(/,/g, '')) : null;
          data.following = followingMatch ? parseInt(followingMatch[1].replace(/,/g, '')) : null;
          data.posts = postsMatch ? parseInt(postsMatch[1].replace(/,/g, '')) : null;
        }
      }
    }
  } catch (error) {
    log(`  ⚠️  Error parsing Instagram data: ${error.message}`);
  }
  
  if (data.exists) {
    log(`  ✓ Found: ${data.followers?.toLocaleString() || '?'} followers, ${data.posts || '?'} posts`);
  } else {
    log(`  ✗ Profile not found or private`);
  }
  
  return data;
}

function extractFacebookData(pageId, html) {
  log(`  📘 Analyzing Facebook /${pageId}...`);
  
  if (!html) return null;
  
  const data = {
    page_id: pageId,
    url: `https://facebook.com/${pageId}`,
    exists: false
  };
  
  try {
    // Facebook embeds data in JSON-LD and meta tags
    const titleMatch = html.match(/<title>([^<]+)<\/title>/);
    if (titleMatch) {
      data.name = titleMatch[1].replace(' | Facebook', '').trim();
    }
    
    const descMatch = html.match(/<meta property="og:description" content="([^"]+)"/);
    if (descMatch) {
      data.description = descMatch[1];
    }
    
    // Look for like/follower counts in page text
    const likesMatch = html.match(/(\d+(?:,\d+)*(?:\.\d+)?[KM]?)\s+(?:people\s+)?like[ds]?\s+this/i);
    const followersMatch = html.match(/(\d+(?:,\d+)*(?:\.\d+)?[KM]?)\s+followers/i);
    const checkInsMatch = html.match(/(\d+(?:,\d+)*)\s+(?:were\s+here|check-ins)/i);
    
    if (likesMatch) {
      data.likes = parseCount(likesMatch[1]);
      data.exists = true;
    }
    if (followersMatch) {
      data.followers = parseCount(followersMatch[1]);
      data.exists = true;
    }
    if (checkInsMatch) {
      data.check_ins = parseInt(checkInsMatch[1].replace(/,/g, ''));
      data.exists = true;
    }
    
    // Look for rating
    const ratingMatch = html.match(/(\d+\.\d+)\s+star/i);
    if (ratingMatch) {
      data.rating = parseFloat(ratingMatch[1]);
      data.exists = true;
    }
    
    // Check if it exists at all
    if (!data.exists && html.includes('content="Facebook"') && !html.includes('Page Not Found')) {
      data.exists = true;
    }
  } catch (error) {
    log(`  ⚠️  Error parsing Facebook data: ${error.message}`);
  }
  
  if (data.exists) {
    const metrics = [];
    if (data.likes) metrics.push(`${data.likes.toLocaleString()} likes`);
    if (data.followers) metrics.push(`${data.followers.toLocaleString()} followers`);
    if (data.rating) metrics.push(`${data.rating}⭐`);
    log(`  ✓ Found: ${metrics.join(', ') || 'Page exists'}`);
  } else {
    log(`  ✗ Page not found`);
  }
  
  return data;
}

function extractTikTokData(username, html) {
  log(`  🎵 Analyzing TikTok @${username}...`);
  
  if (!html) return null;
  
  const data = {
    username,
    url: `https://tiktok.com/@${username}`,
    exists: false
  };
  
  try {
    // TikTok embeds user data in script tags
    const scriptMatch = html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application\/json">({.*?})<\/script>/);
    
    if (scriptMatch) {
      const json = JSON.parse(scriptMatch[1]);
      const user = json?.__DEFAULT_SCOPE__?.["webapp.user-detail"]?.userInfo?.user;
      const stats = json?.__DEFAULT_SCOPE__?.["webapp.user-detail"]?.userInfo?.stats;
      
      if (user) {
        data.exists = true;
        data.display_name = user.nickname;
        data.bio = user.signature;
        data.verified = user.verified;
        
        if (stats) {
          data.followers = stats.followerCount;
          data.following = stats.followingCount;
          data.likes = stats.heartCount;
          data.videos = stats.videoCount;
        }
      }
    }
    
    // Fallback: meta tags
    if (!data.exists) {
      const descMatch = html.match(/<meta name="description" content="([^"]+)"/);
      if (descMatch) {
        const desc = descMatch[1];
        const followersMatch = desc.match(/(\d+(?:\.\d+)?[KM]?)\s+Followers/);
        const likesMatch = desc.match(/(\d+(?:\.\d+)?[KM]?)\s+Likes/);
        
        if (followersMatch || likesMatch) {
          data.exists = true;
          data.followers = followersMatch ? parseCount(followersMatch[1]) : null;
          data.likes = likesMatch ? parseCount(likesMatch[1]) : null;
        }
      }
    }
  } catch (error) {
    log(`  ⚠️  Error parsing TikTok data: ${error.message}`);
  }
  
  if (data.exists) {
    log(`  ✓ Found: ${data.followers?.toLocaleString() || '?'} followers, ${data.videos || '?'} videos`);
  } else {
    log(`  ✗ Profile not found`);
  }
  
  return data;
}

function parseCount(str) {
  // Parse strings like "12.5K" or "1.2M" into numbers
  str = str.replace(/,/g, '');
  const num = parseFloat(str);
  if (str.includes('K')) return Math.round(num * 1000);
  if (str.includes('M')) return Math.round(num * 1000000);
  return Math.round(num);
}

function searchWebForSocial(shopName, city, platform) {
  // Use web search to find social profiles
  const query = `${platform} ${shopName}${city ? ' ' + city : ''}`;
  
  try {
    const result = execSync(
      `curl -s "https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}" ` +
      `-H "User-Agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36"`,
      { encoding: 'utf8', maxBuffer: 5 * 1024 * 1024, timeout: 10000 }
    );
    
    // Extract URLs from search results
    const pattern = platform === 'instagram' 
      ? /https?:\/\/(?:www\.)?instagram\.com\/([a-zA-Z0-9._]+)/g
      : platform === 'facebook'
      ? /https?:\/\/(?:www\.)?facebook\.com\/([a-zA-Z0-9._]+)/g
      : /https?:\/\/(?:www\.)?tiktok\.com\/@([a-zA-Z0-9._]+)/g;
    
    const matches = [...result.matchAll(pattern)];
    
    // Return first match that's not a generic page
    for (const match of matches) {
      const username = match[1];
      // Filter out generic pages
      if (!['login', 'signup', 'about', 'help', 'privacy', 'terms'].includes(username.toLowerCase())) {
        return username;
      }
    }
    
    return null;
  } catch (error) {
    return null;
  }
}

function searchForSocialProfiles(shopName, websiteHtml, city = null) {
  log(`🔍 Searching for social profiles...`);
  
  const profiles = {
    instagram: null,
    facebook: null,
    tiktok: null
  };
  
  // Step 1: Try to find in website HTML
  if (websiteHtml) {
    log(`  📄 Scanning website HTML...`);
    const urlMatches = websiteHtml.matchAll(/https?:\/\/[^\s"'<>]+/g);
    
    for (const match of urlMatches) {
      const url = match[0];
      
      // Check Instagram
      const igMatch = url.match(SOCIAL_PATTERNS.instagram);
      if (igMatch && !profiles.instagram) {
        profiles.instagram = igMatch[1].replace(/\/$/, '');
        log(`    ✓ Found Instagram in HTML: @${profiles.instagram}`);
      }
      
      // Check Facebook
      const fbMatch = url.match(SOCIAL_PATTERNS.facebook);
      if (fbMatch && !profiles.facebook) {
        profiles.facebook = fbMatch[1].replace(/\/$/, '');
        log(`    ✓ Found Facebook in HTML: /${profiles.facebook}`);
      }
      
      // Check TikTok
      const ttMatch = url.match(SOCIAL_PATTERNS.tiktok);
      if (ttMatch && !profiles.tiktok) {
        profiles.tiktok = ttMatch[1].replace(/\/$/, '');
        log(`    ✓ Found TikTok in HTML: @${profiles.tiktok}`);
      }
    }
  }
  
  // Step 2: Web search fallback for missing profiles
  const searchNeeded = [];
  if (!profiles.instagram) searchNeeded.push('Instagram');
  if (!profiles.facebook) searchNeeded.push('Facebook');
  if (!profiles.tiktok) searchNeeded.push('TikTok');
  
  if (searchNeeded.length > 0) {
    log(`  🌐 Web searching for: ${searchNeeded.join(', ')}...`);
    
    if (!profiles.instagram) {
      const ig = searchWebForSocial(shopName, city, 'instagram');
      if (ig) {
        profiles.instagram = ig;
        log(`    ✓ Found Instagram via search: @${ig}`);
      }
    }
    
    if (!profiles.facebook) {
      const fb = searchWebForSocial(shopName, city, 'facebook');
      if (fb) {
        profiles.facebook = fb;
        log(`    ✓ Found Facebook via search: /${fb}`);
      }
    }
    
    if (!profiles.tiktok) {
      const tt = searchWebForSocial(shopName, city, 'tiktok');
      if (tt) {
        profiles.tiktok = tt;
        log(`    ✓ Found TikTok via search: @${tt}`);
      }
    }
  }
  
  const foundCount = [profiles.instagram, profiles.facebook, profiles.tiktok].filter(Boolean).length;
  if (foundCount === 0) {
    log(`  ✗ No social profiles found`);
  }
  
  return profiles;
}

function analyzeWithAI(shopName, socialData) {
  log(`🤖 Analyzing social media presence with AI...`);
  
  const prompt = `Analyze this record shop's social media presence and provide insights.

Shop: ${shopName}

Social Media Data:
${JSON.stringify(socialData, null, 2)}

Provide a comprehensive analysis covering:

## SOCIAL MEDIA PRESENCE
- Overall social media strategy and effectiveness
- Platform priorities (which platforms they focus on)
- Audience size and engagement levels
- Verification and business account status

## COMMUNITY ENGAGEMENT
- Follower-to-engagement ratios
- Content posting frequency (estimated from metrics)
- Audience reach and growth indicators
- Community building efforts

## BRAND POSITIONING
- Consistency across platforms
- Bio/description messaging
- Professional vs casual approach
- Visual identity (if apparent from data)

## RECOMMENDATIONS
- Which platforms to strengthen
- Content strategy suggestions
- Engagement improvement opportunities
- Missing platform opportunities

Keep it concise but insightful. Focus on actionable observations.`;

  try {
    const result = execSync(
      `curl -s http://localhost:11434/api/generate -d '${JSON.stringify({
        model: OLLAMA_MODEL,
        prompt: prompt,
        stream: false
      }).replace(/'/g, "'\\''")}'`,
      { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 }
    );
    
    const jsonResponse = JSON.parse(result);
    return jsonResponse.response;
  } catch (error) {
    log(`  ⚠️  AI analysis failed: ${error.message}`);
    return null;
  }
}

async function enrichSocial(shopName, existingSocialUrls = {}, websiteUrl = null, locationContext = {}) {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`🎵 TIER 2: SOCIAL MEDIA INTELLIGENCE`);
  console.log(`📍 Shop: ${shopName}`);
  console.log(`${'='.repeat(80)}\n`);
  
  const results = {
    shop_name: shopName,
    timestamp: new Date().toISOString(),
    social_profiles: {},
    metrics: {},
    analysis: null
  };
  
  // Step 1: Determine social profiles to check
  let profiles = { ...existingSocialUrls };
  
  // Get city for search context
  const city = locationContext.city || null;
  
  // If we have a website, scan it for social links
  if (websiteUrl) {
    log(`📡 Fetching website to discover social profiles...`);
    const websiteHtml = fetchUrl(websiteUrl);
    const discovered = searchForSocialProfiles(shopName, websiteHtml, city);
    
    profiles.instagram = profiles.instagram || discovered.instagram;
    profiles.facebook = profiles.facebook || discovered.facebook;
    profiles.tiktok = profiles.tiktok || discovered.tiktok;
  } else {
    // No website - go straight to web search
    log(`🌐 No website provided, using web search...`);
    const discovered = searchForSocialProfiles(shopName, null, city);
    
    profiles.instagram = profiles.instagram || discovered.instagram;
    profiles.facebook = profiles.facebook || discovered.facebook;
    profiles.tiktok = profiles.tiktok || discovered.tiktok;
  }
  
  // Step 2: Fetch social media data
  console.log(`\n📱 Fetching social media profiles...\n`);
  
  if (profiles.instagram) {
    const html = fetchUrl(`https://www.instagram.com/${profiles.instagram}/`);
    const data = extractInstagramData(profiles.instagram, html);
    if (data) results.social_profiles.instagram = data;
  }
  
  if (profiles.facebook) {
    const html = fetchUrl(`https://www.facebook.com/${profiles.facebook}`);
    const data = extractFacebookData(profiles.facebook, html);
    if (data) results.social_profiles.facebook = data;
  }
  
  if (profiles.tiktok) {
    const html = fetchUrl(`https://www.tiktok.com/@${profiles.tiktok}`);
    const data = extractTikTokData(profiles.tiktok, html);
    if (data) results.social_profiles.tiktok = data;
  }
  
  // Step 3: Calculate aggregate metrics
  console.log(`\n📊 Calculating metrics...\n`);
  
  const ig = results.social_profiles.instagram;
  const fb = results.social_profiles.facebook;
  const tt = results.social_profiles.tiktok;
  
  results.metrics = {
    total_followers: (ig?.followers || 0) + (fb?.followers || 0) + (tt?.followers || 0),
    total_posts: (ig?.posts || 0) + (tt?.videos || 0),
    platforms_active: Object.values(results.social_profiles).filter(p => p.exists).length,
    verified_count: [ig?.is_verified, fb?.verified, tt?.verified].filter(Boolean).length,
    engagement_score: calculateEngagementScore(results.social_profiles)
  };
  
  log(`  Total followers: ${results.metrics.total_followers.toLocaleString()}`);
  log(`  Active platforms: ${results.metrics.platforms_active}`);
  log(`  Engagement score: ${results.metrics.engagement_score}/10`);
  
  // Step 4: AI Analysis
  if (results.metrics.platforms_active > 0) {
    console.log(`\n`);
    const analysis = analyzeWithAI(shopName, results);
    if (analysis) {
      results.analysis = analysis;
    }
  }
  
  // Step 5: Output
  console.log(`\n${'='.repeat(80)}`);
  console.log(`📋 SOCIAL MEDIA INTELLIGENCE REPORT`);
  console.log(`${'='.repeat(80)}\n`);
  
  if (results.metrics.platforms_active === 0) {
    console.log(`❌ No social media profiles found for ${shopName}\n`);
    console.log(`Searched: Instagram, Facebook, TikTok`);
    if (websiteUrl) {
      console.log(`Website scanned: ${websiteUrl}`);
    }
  } else {
    console.log(results.analysis || 'Social media profiles found but analysis unavailable.');
  }
  
  console.log(`\n${'='.repeat(80)}\n`);
  
  return results;
}

function calculateEngagementScore(profiles) {
  // Simple engagement score 0-10 based on follower counts and activity
  let score = 0;
  
  const ig = profiles.instagram;
  const fb = profiles.facebook;
  const tt = profiles.tiktok;
  
  // Points for having active profiles
  if (ig?.exists) score += 2;
  if (fb?.exists) score += 1.5;
  if (tt?.exists) score += 1.5;
  
  // Points for follower counts
  const totalFollowers = (ig?.followers || 0) + (fb?.followers || 0) + (tt?.followers || 0);
  if (totalFollowers > 10000) score += 3;
  else if (totalFollowers > 5000) score += 2;
  else if (totalFollowers > 1000) score += 1;
  else if (totalFollowers > 500) score += 0.5;
  
  // Points for content activity
  if (ig?.posts > 100) score += 1;
  if (tt?.videos > 50) score += 1;
  
  // Bonus for verification
  if (ig?.is_verified || tt?.verified) score += 1;
  
  return Math.min(Math.round(score * 10) / 10, 10);
}

// CLI
if (require.main === module) {
  const args = process.argv.slice(2);
  
  if (args.length < 1) {
    console.log(`
Usage: ./enrich_social.js "Shop Name" [website_url] [instagram] [facebook] [tiktok] [city] [state] [neighborhood]

Examples:
  # With website (auto-discovers social + web search fallback)
  ./enrich_social.js "Amoeba Music" "https://www.amoeba.com" "" "" "" "Berkeley" "CA"
  
  # No website - pure web search
  ./enrich_social.js "Local Record Shop" "" "" "" "" "Portland" "OR"
  
  # With known social handles
  ./enrich_social.js "Rough Trade" "" "roughtrade" "roughtradeshops" "roughtrade" "Brooklyn" "NY"
  
  # Minimal (shop name only - will web search)
  ./enrich_social.js "Record Paradise"

Note: City helps narrow web search results for better accuracy.
`);
    process.exit(1);
  }
  
  const shopName = args[0];
  const websiteUrl = args[1] || null;
  const existingSocial = {
    instagram: args[2] || null,
    facebook: args[3] || null,
    tiktok: args[4] || null
  };
  const locationContext = {
    city: args[5] || null,
    state: args[6] || null,
    neighborhood: args[7] || null
  };
  
  enrichSocial(shopName, existingSocial, websiteUrl, locationContext);
}

module.exports = { enrichSocial };
