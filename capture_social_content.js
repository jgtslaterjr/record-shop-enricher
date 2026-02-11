#!/usr/bin/env node

/**
 * SOCIAL CONTENT CAPTURE
 * Deep archival of social media content (posts, captions, engagement)
 * Captures everything posted, not just metadata
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const OLLAMA_MODEL = 'kimi-k2.5:cloud';
const FETCH_TIMEOUT = 20000;
const MAX_POSTS_PER_PLATFORM = 50; // Capture up to 50 recent posts

// Social media URL patterns
const SOCIAL_PATTERNS = {
  instagram: /(?:instagram\.com|instagr\.am)\/([a-zA-Z0-9._]+)/,
  facebook: /facebook\.com\/([a-zA-Z0-9._-]+)/,
  tiktok: /tiktok\.com\/@([a-zA-Z0-9._]+)/
};

function log(message) {
  console.log(`[${new Date().toISOString().substring(11, 19)}] ${message}`);
}

function fetchUrl(url, includeHeaders = false) {
  try {
    const headerFlag = includeHeaders ? '-i' : '';
    const result = execSync(
      `curl -L -s ${headerFlag} --max-time ${FETCH_TIMEOUT/1000} ` +
      `-H "User-Agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36" ` +
      `-H "Accept: text/html,application/json" ` +
      `-H "Accept-Language: en-US,en;q=0.9" ` +
      `"${url}"`,
      { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }
    );
    return result;
  } catch (error) {
    log(`  ⚠️  Failed to fetch ${url}: ${error.message}`);
    return null;
  }
}

function ensureContentDir(shopId) {
  const contentDir = path.join(__dirname, 'content', shopId, 'social');
  if (!fs.existsSync(contentDir)) {
    fs.mkdirSync(contentDir, { recursive: true });
  }
  return contentDir;
}

function captureInstagramContent(username) {
  log(`  📸 Capturing Instagram content for @${username}...`);
  
  const url = `https://www.instagram.com/${username}/`;
  const html = fetchUrl(url);
  
  if (!html) {
    log(`    ❌ Failed to fetch Instagram page`);
    return null;
  }
  
  const content = {
    platform: 'instagram',
    username,
    url,
    captured_at: new Date().toISOString(),
    profile: {},
    posts: []
  };
  
  // Extract profile data
  const sharedDataMatch = html.match(/window\._sharedData\s*=\s*({.*?});/);
  const additionalDataMatch = html.match(/window\.__additionalDataLoaded\([^,]+,\s*({.*?})\);/);
  
  try {
    let profile = null;
    
    if (sharedDataMatch) {
      const json = JSON.parse(sharedDataMatch[1]);
      profile = json?.entry_data?.ProfilePage?.[0]?.graphql?.user;
    } else if (additionalDataMatch) {
      const json = JSON.parse(additionalDataMatch[1]);
      profile = json?.graphql?.user;
    }
    
    if (profile) {
      content.profile = {
        full_name: profile.full_name,
        bio: profile.biography,
        followers: profile.edge_followed_by?.count,
        following: profile.edge_follow?.count,
        posts_count: profile.edge_owner_to_timeline_media?.count,
        is_verified: profile.is_verified,
        is_business: profile.is_business_account,
        category: profile.category_name,
        external_url: profile.external_url
      };
      
      // Extract posts
      const posts = profile.edge_owner_to_timeline_media?.edges || [];
      
      for (const edge of posts.slice(0, MAX_POSTS_PER_PLATFORM)) {
        const node = edge.node;
        
        const post = {
          id: node.id,
          shortcode: node.shortcode,
          url: `https://www.instagram.com/p/${node.shortcode}/`,
          type: node.__typename, // GraphImage, GraphVideo, GraphSidecar
          caption: node.edge_media_to_caption?.edges?.[0]?.node?.text || '',
          timestamp: new Date(node.taken_at_timestamp * 1000).toISOString(),
          likes: node.edge_liked_by?.count,
          comments: node.edge_media_to_comment?.count,
          is_video: node.is_video,
          video_views: node.video_view_count
        };
        
        // Extract hashtags from caption
        if (post.caption) {
          const hashtags = [...post.caption.matchAll(/#(\w+)/g)].map(m => m[1]);
          post.hashtags = hashtags;
        }
        
        content.posts.push(post);
      }
      
      log(`    ✓ Captured ${content.posts.length} posts`);
    }
  } catch (error) {
    log(`    ⚠️  Error parsing Instagram data: ${error.message}`);
  }
  
  // Fallback: try meta tags
  if (content.posts.length === 0) {
    log(`    📄 Attempting fallback extraction from meta tags...`);
    const ogTitle = html.match(/<meta property="og:title" content="([^"]+)"/)?.[1];
    const ogDesc = html.match(/<meta property="og:description" content="([^"]+)"/)?.[1];
    
    if (ogTitle || ogDesc) {
      content.profile.title = ogTitle;
      content.profile.description = ogDesc;
      log(`    ℹ️  Limited data available (Instagram may require login)`);
    }
  }
  
  return content;
}

function captureFacebookContent(pageId) {
  log(`  👍 Capturing Facebook content for /${pageId}...`);
  
  const url = `https://www.facebook.com/${pageId}`;
  const html = fetchUrl(url);
  
  if (!html) {
    log(`    ❌ Failed to fetch Facebook page`);
    return null;
  }
  
  const content = {
    platform: 'facebook',
    page_id: pageId,
    url,
    captured_at: new Date().toISOString(),
    profile: {},
    posts: []
  };
  
  // Facebook is heavily JavaScript-rendered, so we get limited data from HTML
  // Extract what we can from meta tags and page source
  
  try {
    // Profile info from meta tags
    const ogTitle = html.match(/<meta property="og:title" content="([^"]+)"/)?.[1];
    const ogDesc = html.match(/<meta property="og:description" content="([^"]+)"/)?.[1];
    const ogImage = html.match(/<meta property="og:image" content="([^"]+)"/)?.[1];
    
    content.profile = {
      name: ogTitle,
      description: ogDesc,
      image: ogImage
    };
    
    // Try to extract visible text posts (limited without JavaScript execution)
    // Look for common Facebook post patterns in the HTML
    const textBlocks = [...html.matchAll(/<div[^>]*>([^<]{50,500})<\/div>/g)];
    const potentialPosts = textBlocks
      .map(m => m[1].trim())
      .filter(text => {
        // Filter out navigation, ads, and boilerplate
        return text.length > 30 && 
               !text.includes('cookie') &&
               !text.includes('privacy') &&
               !text.match(/^\d+ (likes|comments|shares)/);
      })
      .slice(0, 10);
    
    for (let i = 0; i < potentialPosts.length; i++) {
      content.posts.push({
        text: potentialPosts[i],
        source: 'html_extraction',
        note: 'Limited data - Facebook requires login for full content'
      });
    }
    
    log(`    ℹ️  Captured basic profile data (${content.posts.length} potential text snippets)`);
    log(`    ⚠️  Note: Facebook requires authentication for full post access`);
    
  } catch (error) {
    log(`    ⚠️  Error parsing Facebook data: ${error.message}`);
  }
  
  return content;
}

function captureTikTokContent(username) {
  log(`  🎵 Capturing TikTok content for @${username}...`);
  
  const url = `https://www.tiktok.com/@${username}`;
  const html = fetchUrl(url);
  
  if (!html) {
    log(`    ❌ Failed to fetch TikTok page`);
    return null;
  }
  
  const content = {
    platform: 'tiktok',
    username,
    url,
    captured_at: new Date().toISOString(),
    profile: {},
    posts: []
  };
  
  try {
    // TikTok embeds data in <script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">
    const dataMatch = html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>(.*?)<\/script>/s);
    
    if (dataMatch) {
      const jsonData = JSON.parse(dataMatch[1]);
      const userDetail = jsonData?.__DEFAULT_SCOPE__?.['webapp.user-detail'];
      
      if (userDetail?.userInfo) {
        const user = userDetail.userInfo.user;
        const stats = userDetail.userInfo.stats;
        
        content.profile = {
          username: user.uniqueId,
          nickname: user.nickname,
          bio: user.signature,
          verified: user.verified,
          followers: stats.followerCount,
          following: stats.followingCount,
          likes: stats.heartCount,
          videos: stats.videoCount
        };
        
        // Extract video posts
        const videos = userDetail.itemList || [];
        
        for (const video of videos.slice(0, MAX_POSTS_PER_PLATFORM)) {
          const post = {
            id: video.id,
            url: `https://www.tiktok.com/@${username}/video/${video.id}`,
            description: video.desc,
            created_at: new Date(video.createTime * 1000).toISOString(),
            duration: video.video?.duration,
            likes: video.stats?.diggCount,
            comments: video.stats?.commentCount,
            shares: video.stats?.shareCount,
            plays: video.stats?.playCount,
            music: {
              title: video.music?.title,
              author: video.music?.authorName
            },
            hashtags: video.textExtra?.filter(t => t.hashtagName).map(t => t.hashtagName) || []
          };
          
          content.posts.push(post);
        }
        
        log(`    ✓ Captured ${content.posts.length} videos`);
      }
    }
  } catch (error) {
    log(`    ⚠️  Error parsing TikTok data: ${error.message}`);
  }
  
  // Fallback
  if (content.posts.length === 0) {
    log(`    ℹ️  Limited data available (TikTok may require login or changed structure)`);
  }
  
  return content;
}

function analyzeContentWithAI(allContent) {
  log(`\n🤖 Analyzing captured content with AI...`);
  
  const summary = {
    total_posts: 0,
    platforms: []
  };
  
  for (const [platform, data] of Object.entries(allContent)) {
    if (data) {
      summary.total_posts += data.posts?.length || 0;
      summary.platforms.push({
        platform,
        posts_count: data.posts?.length || 0,
        username: data.username || data.page_id
      });
    }
  }
  
  // Compile all post text for analysis
  const allPostText = [];
  
  if (allContent.instagram?.posts) {
    allPostText.push(...allContent.instagram.posts.map(p => p.caption).filter(Boolean));
  }
  if (allContent.facebook?.posts) {
    allPostText.push(...allContent.facebook.posts.map(p => p.text).filter(Boolean));
  }
  if (allContent.tiktok?.posts) {
    allPostText.push(...allContent.tiktok.posts.map(p => p.description).filter(Boolean));
  }
  
  const prompt = `Analyze this record shop's social media content and provide insights:

CONTENT CAPTURED:
${JSON.stringify(summary, null, 2)}

SAMPLE POST TEXT (first 10):
${allPostText.slice(0, 10).map((text, i) => `${i+1}. ${text.substring(0, 200)}`).join('\n\n')}

Provide analysis on:

## CONTENT THEMES
- What topics do they post about most?
- Music genres featured
- Events and promotions
- Community engagement style

## POSTING PATTERNS
- Frequency across platforms
- Content type preferences (text, images, videos)
- Hashtag strategy

## ENGAGEMENT INDICATORS
- What content seems to resonate?
- Best performing post types

## RECOMMENDATIONS
- Content gaps or opportunities
- Platform-specific strategies
- Engagement improvement ideas

Keep it concise and actionable.`;
  
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

async function captureSocialContent(shopId, shopName, socialProfiles = {}) {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`📱 SOCIAL CONTENT CAPTURE`);
  console.log(`📍 Shop: ${shopName} (ID: ${shopId})`);
  console.log(`${'='.repeat(80)}\n`);
  
  const contentDir = ensureContentDir(shopId);
  const timestamp = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  
  const capture = {
    shop_id: shopId,
    shop_name: shopName,
    captured_at: new Date().toISOString(),
    instagram: null,
    facebook: null,
    tiktok: null,
    analysis: null
  };
  
  // Capture Instagram
  if (socialProfiles.instagram) {
    capture.instagram = captureInstagramContent(socialProfiles.instagram);
    if (capture.instagram) {
      const filename = path.join(contentDir, `instagram_${timestamp}.json`);
      fs.writeFileSync(filename, JSON.stringify(capture.instagram, null, 2));
      log(`  💾 Saved to: ${filename}\n`);
    }
  } else {
    log(`  ⏭️  No Instagram profile provided\n`);
  }
  
  // Capture Facebook
  if (socialProfiles.facebook) {
    capture.facebook = captureFacebookContent(socialProfiles.facebook);
    if (capture.facebook) {
      const filename = path.join(contentDir, `facebook_${timestamp}.json`);
      fs.writeFileSync(filename, JSON.stringify(capture.facebook, null, 2));
      log(`  💾 Saved to: ${filename}\n`);
    }
  } else {
    log(`  ⏭️  No Facebook profile provided\n`);
  }
  
  // Capture TikTok
  if (socialProfiles.tiktok) {
    capture.tiktok = captureTikTokContent(socialProfiles.tiktok);
    if (capture.tiktok) {
      const filename = path.join(contentDir, `tiktok_${timestamp}.json`);
      fs.writeFileSync(filename, JSON.stringify(capture.tiktok, null, 2));
      log(`  💾 Saved to: ${filename}\n`);
    }
  } else {
    log(`  ⏭️  No TikTok profile provided\n`);
  }
  
  // AI Analysis
  capture.analysis = analyzeContentWithAI({
    instagram: capture.instagram,
    facebook: capture.facebook,
    tiktok: capture.tiktok
  });
  
  // Save complete capture
  const summaryFile = path.join(contentDir, `capture_${timestamp}.json`);
  fs.writeFileSync(summaryFile, JSON.stringify(capture, null, 2));
  
  console.log(`\n${'='.repeat(80)}`);
  console.log(`✅ CAPTURE COMPLETE`);
  console.log(`📂 Content saved to: ${contentDir}`);
  console.log(`📊 Total posts captured: ${
    (capture.instagram?.posts?.length || 0) +
    (capture.facebook?.posts?.length || 0) +
    (capture.tiktok?.posts?.length || 0)
  }`);
  console.log(`${'='.repeat(80)}\n`);
  
  if (capture.analysis) {
    console.log(`\n📊 AI ANALYSIS\n`);
    console.log(capture.analysis);
    console.log(`\n`);
  }
  
  return capture;
}

// CLI usage
if (require.main === module) {
  const args = process.argv.slice(2);
  
  if (args.length < 2) {
    console.log(`
Usage: ./capture_social_content.js <shop_id> <shop_name> [--instagram=username] [--facebook=pageid] [--tiktok=username]

Example:
  ./capture_social_content.js shop_123 "Amoeba Music" --instagram=amoebamusic --facebook=amoebamusic --tiktok=amoebamusic
`);
    process.exit(1);
  }
  
  const shopId = args[0];
  const shopName = args[1];
  
  const socialProfiles = {};
  
  for (const arg of args.slice(2)) {
    if (arg.startsWith('--instagram=')) {
      socialProfiles.instagram = arg.split('=')[1];
    } else if (arg.startsWith('--facebook=')) {
      socialProfiles.facebook = arg.split('=')[1];
    } else if (arg.startsWith('--tiktok=')) {
      socialProfiles.tiktok = arg.split('=')[1];
    }
  }
  
  captureSocialContent(shopId, shopName, socialProfiles);
}

module.exports = { captureSocialContent };
