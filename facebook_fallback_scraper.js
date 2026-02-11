#!/usr/bin/env node

/**
 * Facebook scraper with fallback strategies
 * Tries multiple approaches to get content
 */

const { execSync } = require('child_process');

// Check for Graph API token in environment
const FB_ACCESS_TOKEN = process.env.FACEBOOK_ACCESS_TOKEN;

function log(msg) {
  console.log(`[FB] ${msg}`);
}

/**
 * Strategy 1: Facebook Graph API (most reliable)
 */
function tryGraphAPI(pageId) {
  if (!FB_ACCESS_TOKEN) {
    log('⏭️  No Facebook access token (set FACEBOOK_ACCESS_TOKEN env var)');
    return null;
  }
  
  log('Trying Graph API...');
  
  try {
    const fields = 'name,about,description,category,emails,phone,website,fan_count,link';
    const url = `https://graph.facebook.com/v18.0/${pageId}?fields=${fields}&access_token=${FB_ACCESS_TOKEN}`;
    
    const result = execSync(`curl -s "${url}"`, { encoding: 'utf8', timeout: 10000 });
    const data = JSON.parse(result);
    
    if (data.error) {
      log(`  ❌ API error: ${data.error.message}`);
      return null;
    }
    
    log('  ✅ Graph API success');
    return {
      method: 'graph_api',
      ...data
    };
  } catch (error) {
    log(`  ❌ Graph API failed: ${error.message}`);
    return null;
  }
}

/**
 * Strategy 2: Mobile Facebook (sometimes accessible)
 */
function tryMobileScrape(pageId) {
  log('Trying mobile scrape...');
  
  try {
    const url = `https://m.facebook.com/${pageId}`;
    const html = execSync(
      `curl -L -s --max-time 15 ` +
      `-H "User-Agent: Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X)" ` +
      `-H "Accept-Language: en-US,en;q=0.9" ` +
      `"${url}"`,
      { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
    );
    
    // Check if we got redirected to login
    if (html.includes('login') && html.includes('password')) {
      log('  ❌ Redirected to login page');
      return null;
    }
    
    // Extract what we can
    const titleMatch = html.match(/<title>([^<]+)<\/title>/);
    const name = titleMatch ? titleMatch[1].replace(' | Facebook', '').trim() : null;
    
    if (!name) {
      log('  ❌ Could not extract page name');
      return null;
    }
    
    // Try to find about section
    const aboutMatch = html.match(/<div[^>]*>About<\/div>[\s\S]{0,500}<div[^>]*>([^<]{20,})<\/div>/);
    const about = aboutMatch ? aboutMatch[1].trim() : null;
    
    log(`  ✅ Mobile scrape success (limited data)`);
    return {
      method: 'mobile_scrape',
      name,
      about,
      url
    };
  } catch (error) {
    log(`  ❌ Mobile scrape failed: ${error.message}`);
    return null;
  }
}

/**
 * Strategy 3: Public Graph API (no token, very limited)
 */
function tryPublicAPI(pageId) {
  log('Trying public API...');
  
  try {
    const url = `https://graph.facebook.com/v18.0/${pageId}?fields=name,about,category`;
    const result = execSync(`curl -s "${url}"`, { encoding: 'utf8', timeout: 10000 });
    const data = JSON.parse(result);
    
    if (data.error) {
      log(`  ❌ API error: ${data.error.message}`);
      return null;
    }
    
    if (data.name) {
      log('  ✅ Public API success (very limited data)');
      return {
        method: 'public_api',
        ...data
      };
    }
    
    return null;
  } catch (error) {
    log(`  ❌ Public API failed: ${error.message}`);
    return null;
  }
}

/**
 * Main function: tries all strategies in order
 */
function captureFacebookPage(pageId) {
  log(`\n${'='.repeat(60)}`);
  log(`Capturing Facebook page: ${pageId}`);
  log('='.repeat(60));
  
  // Try strategies in order of reliability
  let result = tryGraphAPI(pageId);
  if (result) return result;
  
  result = tryPublicAPI(pageId);
  if (result) return result;
  
  result = tryMobileScrape(pageId);
  if (result) return result;
  
  log('\n❌ All strategies failed');
  log('\nSolutions:');
  log('1. Set FACEBOOK_ACCESS_TOKEN env var (see facebook_graph_api.md)');
  log('2. Use browser automation (openclaw browser tool)');
  log('3. Some pages may require login to view');
  
  return {
    error: 'all_strategies_failed',
    message: 'Could not access page. See logs for details.',
    page_id: pageId
  };
}

// CLI usage
if (require.main === module) {
  const pageId = process.argv[2] || 'rpmunderground';
  const result = captureFacebookPage(pageId);
  console.log('\n' + '='.repeat(60));
  console.log('RESULT:');
  console.log('='.repeat(60));
  console.log(JSON.stringify(result, null, 2));
}

module.exports = { captureFacebookPage };
