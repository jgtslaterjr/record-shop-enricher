#!/usr/bin/env node

/**
 * Facebook mobile scraper - sometimes more accessible than desktop
 */

const { execSync } = require('child_process');

function fetchFacebookMobile(pageId) {
  const url = `https://m.facebook.com/${pageId}`;
  
  try {
    const html = execSync(
      `curl -L -s --max-time 20 ` +
      `-H "User-Agent: Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15" ` +
      `-H "Accept: text/html,application/xhtml+xml" ` +
      `-H "Accept-Language: en-US,en;q=0.9" ` +
      `-H "Accept-Encoding: gzip, deflate" ` +
      `"${url}"`,
      { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }
    );
    
    // Extract basic info
    const pageName = html.match(/<title>([^<]+)<\/title>/)?.[1];
    const about = html.match(/<div[^>]*id="About"[^>]*>[\s\S]*?<div[^>]*>(.*?)<\/div>/)?.[1];
    
    // Try to extract posts
    const postMatches = [...html.matchAll(/<div[^>]*data-ft[^>]*>([\s\S]*?)<\/div>/g)];
    
    const posts = postMatches.map(match => {
      const text = match[1]
        .replace(/<script[\s\S]*?<\/script>/g, '')
        .replace(/<style[\s\S]*?<\/style>/g, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      
      return text.length > 20 ? text : null;
    }).filter(Boolean).slice(0, 10);
    
    return {
      platform: 'facebook',
      url,
      page_id: pageId,
      page_name: pageName,
      about: about,
      posts: posts,
      captured_at: new Date().toISOString()
    };
    
  } catch (error) {
    console.error(`Failed to fetch mobile Facebook: ${error.message}`);
    return null;
  }
}

// Test
if (require.main === module) {
  const pageId = process.argv[2] || 'rpmunderground';
  const result = fetchFacebookMobile(pageId);
  console.log(JSON.stringify(result, null, 2));
}

module.exports = { fetchFacebookMobile };
