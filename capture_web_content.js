#!/usr/bin/env node

/**
 * WEB CONTENT CAPTURE
 * Deep archival of website content (full pages, text, images, structure)
 * Captures everything from the website, not just metadata
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const OLLAMA_MODEL = 'kimi-k2.5:cloud';
const FETCH_TIMEOUT = 30000;
const MAX_PAGES = 50; // Maximum pages to crawl per site
const MAX_DEPTH = 3; // Maximum crawl depth

function log(message) {
  console.log(`[${new Date().toISOString().substring(11, 19)}] ${message}`);
}

function fetchUrl(url) {
  try {
    const result = execSync(
      `curl -L -s --max-time ${FETCH_TIMEOUT/1000} ` +
      `-H "User-Agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36" ` +
      `-H "Accept: text/html" ` +
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

function normalizeUrl(url, baseUrl) {
  try {
    // Handle relative URLs
    if (url.startsWith('/')) {
      const base = new URL(baseUrl);
      return `${base.protocol}//${base.host}${url}`;
    }
    
    // Handle protocol-relative URLs
    if (url.startsWith('//')) {
      const base = new URL(baseUrl);
      return `${base.protocol}${url}`;
    }
    
    // Handle relative paths
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      return new URL(url, baseUrl).href;
    }
    
    return url;
  } catch (error) {
    return null;
  }
}

function extractLinks(html, baseUrl) {
  const links = new Set();
  const baseDomain = new URL(baseUrl).hostname;
  
  // Match href attributes
  const hrefPattern = /href=["']([^"']+)["']/g;
  let match;
  
  while ((match = hrefPattern.exec(html)) !== null) {
    const url = normalizeUrl(match[1], baseUrl);
    
    if (!url) continue;
    
    try {
      const urlObj = new URL(url);
      
      // Only include same-domain links
      if (urlObj.hostname === baseDomain) {
        // Remove fragments and query params for deduplication
        const cleanUrl = `${urlObj.protocol}//${urlObj.hostname}${urlObj.pathname}`;
        
        // Filter out common non-content URLs
        if (!cleanUrl.match(/\.(jpg|jpeg|png|gif|pdf|zip|css|js|ico|xml|json)$/i) &&
            !cleanUrl.includes('/cart') &&
            !cleanUrl.includes('/checkout') &&
            !cleanUrl.includes('/login') &&
            !cleanUrl.includes('/register')) {
          links.add(cleanUrl);
        }
      }
    } catch (error) {
      // Invalid URL, skip
    }
  }
  
  return Array.from(links);
}

function extractTextContent(html) {
  // Remove script and style tags
  let text = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  text = text.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');
  
  // Remove HTML tags
  text = text.replace(/<[^>]+>/g, ' ');
  
  // Decode HTML entities
  text = text.replace(/&nbsp;/g, ' ');
  text = text.replace(/&amp;/g, '&');
  text = text.replace(/&lt;/g, '<');
  text = text.replace(/&gt;/g, '>');
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#039;/g, "'");
  
  // Clean up whitespace
  text = text.replace(/\s+/g, ' ').trim();
  
  return text;
}

function extractMetadata(html, url) {
  const metadata = {
    url,
    title: null,
    description: null,
    keywords: [],
    og_data: {},
    schema_org: []
  };
  
  // Extract title
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (titleMatch) {
    metadata.title = titleMatch[1].trim();
  }
  
  // Extract meta description
  const descMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i);
  if (descMatch) {
    metadata.description = descMatch[1].trim();
  }
  
  // Extract meta keywords
  const keywordsMatch = html.match(/<meta[^>]*name=["']keywords["'][^>]*content=["']([^"']+)["']/i);
  if (keywordsMatch) {
    metadata.keywords = keywordsMatch[1].split(',').map(k => k.trim());
  }
  
  // Extract Open Graph data
  const ogPattern = /<meta[^>]*property=["']og:([^"']+)["'][^>]*content=["']([^"']+)["']/gi;
  let ogMatch;
  while ((ogMatch = ogPattern.exec(html)) !== null) {
    metadata.og_data[ogMatch[1]] = ogMatch[2];
  }
  
  // Extract Schema.org JSON-LD
  const schemaPattern = /<script[^>]*type=["']application\/ld\+json["'][^>]*>(.*?)<\/script>/gis;
  let schemaMatch;
  while ((schemaMatch = schemaPattern.exec(html)) !== null) {
    try {
      const schema = JSON.parse(schemaMatch[1]);
      metadata.schema_org.push(schema);
    } catch (error) {
      // Invalid JSON, skip
    }
  }
  
  return metadata;
}

function extractStructuredContent(html) {
  const content = {
    headings: [],
    paragraphs: [],
    lists: [],
    links: [],
    images: [],
    events: [],
    contact_info: {}
  };
  
  // Extract headings (h1-h6)
  const headingPattern = /<h([1-6])[^>]*>([^<]+)<\/h\1>/gi;
  let headingMatch;
  while ((headingMatch = headingPattern.exec(html)) !== null) {
    content.headings.push({
      level: parseInt(headingMatch[1]),
      text: headingMatch[2].trim()
    });
  }
  
  // Extract paragraphs with substantial content
  const pPattern = /<p[^>]*>([^<]{20,})<\/p>/gi;
  let pMatch;
  while ((pMatch = pPattern.exec(html)) !== null) {
    const text = pMatch[1].trim();
    if (text.length > 20) {
      content.paragraphs.push(text);
    }
  }
  
  // Extract list items
  const liPattern = /<li[^>]*>([^<]+)<\/li>/gi;
  let liMatch;
  while ((liMatch = liPattern.exec(html)) !== null) {
    content.lists.push(liMatch[1].trim());
  }
  
  // Extract images
  const imgPattern = /<img[^>]*src=["']([^"']+)["'][^>]*alt=["']([^"']*)["']/gi;
  let imgMatch;
  while ((imgMatch = imgPattern.exec(html)) !== null) {
    content.images.push({
      src: imgMatch[1],
      alt: imgMatch[2]
    });
  }
  
  // Extract links with anchor text
  const linkPattern = /<a[^>]*href=["']([^"']+)["'][^>]*>([^<]+)<\/a>/gi;
  let linkMatch;
  while ((linkMatch = linkPattern.exec(html)) !== null) {
    const text = linkMatch[2].trim();
    if (text.length > 0 && text.length < 100) {
      content.links.push({
        url: linkMatch[1],
        text: text
      });
    }
  }
  
  // Extract potential event information
  const datePattern = /\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Mon|Tue|Wed|Thu|Fri|Sat|Sun).*?\d{1,2}(?:st|nd|rd|th)?.*?(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/gi;
  let dateMatch;
  while ((dateMatch = datePattern.exec(html)) !== null) {
    content.events.push(dateMatch[0]);
  }
  
  // Extract phone numbers
  const phonePattern = /\b(?:\+?1[-.\s]?)?\(?([0-9]{3})\)?[-.\s]?([0-9]{3})[-.\s]?([0-9]{4})\b/g;
  const phones = [...html.matchAll(phonePattern)].map(m => m[0]);
  if (phones.length > 0) {
    content.contact_info.phones = [...new Set(phones)];
  }
  
  // Extract email addresses
  const emailPattern = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g;
  const emails = [...html.matchAll(emailPattern)].map(m => m[0]);
  if (emails.length > 0) {
    content.contact_info.emails = [...new Set(emails)];
  }
  
  return content;
}

function crawlWebsite(startUrl, maxPages = MAX_PAGES, maxDepth = MAX_DEPTH) {
  log(`🕷️  Starting website crawl from: ${startUrl}`);
  log(`   Max pages: ${maxPages}, Max depth: ${maxDepth}`);
  
  const visited = new Set();
  const pages = [];
  const queue = [{ url: startUrl, depth: 0 }];
  
  while (queue.length > 0 && pages.length < maxPages) {
    const { url, depth } = queue.shift();
    
    if (visited.has(url) || depth > maxDepth) {
      continue;
    }
    
    visited.add(url);
    log(`  📄 Crawling [${pages.length + 1}/${maxPages}] depth=${depth}: ${url}`);
    
    const html = fetchUrl(url);
    
    if (!html || html.length < 500) {
      log(`    ⚠️  Skipped (no content or too small)`);
      continue;
    }
    
    // Extract page data
    const pageData = {
      url,
      depth,
      crawled_at: new Date().toISOString(),
      size_bytes: html.length,
      html: html,
      text: extractTextContent(html),
      metadata: extractMetadata(html, url),
      content: extractStructuredContent(html)
    };
    
    pages.push(pageData);
    
    log(`    ✓ Captured ${pageData.text.length} chars, ${pageData.content.headings.length} headings`);
    
    // Extract and queue links if not at max depth
    if (depth < maxDepth) {
      const links = extractLinks(html, url);
      log(`    🔗 Found ${links.length} internal links`);
      
      for (const link of links) {
        if (!visited.has(link)) {
          queue.push({ url: link, depth: depth + 1 });
        }
      }
    }
  }
  
  log(`\n✅ Crawl complete: ${pages.length} pages captured`);
  
  return pages;
}

function generateSitemap(pages) {
  const sitemap = {
    total_pages: pages.length,
    pages: []
  };
  
  for (const page of pages) {
    sitemap.pages.push({
      url: page.url,
      title: page.metadata.title,
      depth: page.depth,
      text_length: page.text.length,
      headings_count: page.content.headings.length,
      images_count: page.content.images.length
    });
  }
  
  return sitemap;
}

function analyzeContentWithAI(pages, shopName) {
  log(`\n🤖 Analyzing captured content with AI...`);
  
  // Compile summary for AI
  const summary = {
    total_pages: pages.length,
    total_text_length: pages.reduce((sum, p) => sum + p.text.length, 0),
    all_headings: [],
    all_events: [],
    contact_info: {},
    key_pages: []
  };
  
  for (const page of pages) {
    summary.all_headings.push(...page.content.headings.map(h => h.text));
    summary.all_events.push(...page.content.events);
    
    if (page.content.contact_info.phones) {
      summary.contact_info.phones = page.content.contact_info.phones;
    }
    if (page.content.contact_info.emails) {
      summary.contact_info.emails = page.content.contact_info.emails;
    }
    
    if (page.metadata.title) {
      summary.key_pages.push({
        title: page.metadata.title,
        url: page.url,
        text_sample: page.text.substring(0, 300)
      });
    }
  }
  
  const prompt = `Analyze this record shop's website content and provide insights:

SHOP: ${shopName}

WEBSITE SUMMARY:
- Total pages captured: ${summary.total_pages}
- Total content: ${summary.total_text_length} characters

KEY PAGES:
${summary.key_pages.slice(0, 10).map(p => `- ${p.title} (${p.url})`).join('\n')}

COMMON HEADINGS:
${summary.all_headings.slice(0, 20).join('\n')}

EVENTS/DATES FOUND:
${summary.all_events.slice(0, 10).join('\n')}

CONTACT INFO:
${JSON.stringify(summary.contact_info, null, 2)}

Provide analysis on:

## WEBSITE STRUCTURE
- Navigation and organization
- Key sections and pages
- Content depth

## CONTENT FOCUS
- Main themes and topics
- Services and offerings highlighted
- Community engagement

## EVENTS & ACTIVITIES
- Regular events or programs
- Special offerings
- Community involvement

## TECHNICAL OBSERVATIONS
- Content quality
- Information completeness
- Missing elements

## RECOMMENDATIONS
- Content gaps to fill
- SEO opportunities
- User experience improvements

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

function ensureContentDir(shopId) {
  const contentDir = path.join(__dirname, 'content', shopId, 'web');
  if (!fs.existsSync(contentDir)) {
    fs.mkdirSync(contentDir, { recursive: true });
  }
  return contentDir;
}

async function captureWebContent(shopId, shopName, websiteUrl) {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`🌐 WEB CONTENT CAPTURE`);
  console.log(`📍 Shop: ${shopName} (ID: ${shopId})`);
  console.log(`🔗 URL: ${websiteUrl}`);
  console.log(`${'='.repeat(80)}\n`);
  
  const contentDir = ensureContentDir(shopId);
  const timestamp = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  
  // Crawl the website
  const pages = crawlWebsite(websiteUrl, MAX_PAGES, MAX_DEPTH);
  
  if (pages.length === 0) {
    console.log(`\n❌ No content captured. Website may be inaccessible.\n`);
    return null;
  }
  
  // Generate sitemap
  const sitemap = generateSitemap(pages);
  
  // Save individual pages
  const pagesDir = path.join(contentDir, `pages_${timestamp}`);
  fs.mkdirSync(pagesDir, { recursive: true });
  
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const hash = crypto.createHash('md5').update(page.url).digest('hex').substring(0, 8);
    const filename = `page_${i}_${hash}.json`;
    
    fs.writeFileSync(
      path.join(pagesDir, filename),
      JSON.stringify(page, null, 2)
    );
  }
  
  log(`\n💾 Saved ${pages.length} pages to: ${pagesDir}`);
  
  // AI Analysis
  const analysis = analyzeContentWithAI(pages, shopName);
  
  // Create comprehensive capture summary
  const capture = {
    shop_id: shopId,
    shop_name: shopName,
    website_url: websiteUrl,
    captured_at: new Date().toISOString(),
    crawl_stats: {
      pages_captured: pages.length,
      total_text_chars: pages.reduce((sum, p) => sum + p.text.length, 0),
      total_html_bytes: pages.reduce((sum, p) => sum + p.size_bytes, 0),
      max_depth_reached: Math.max(...pages.map(p => p.depth))
    },
    sitemap: sitemap,
    analysis: analysis,
    pages_directory: pagesDir
  };
  
  // Save capture summary
  const summaryFile = path.join(contentDir, `capture_${timestamp}.json`);
  fs.writeFileSync(summaryFile, JSON.stringify(capture, null, 2));
  
  console.log(`\n${'='.repeat(80)}`);
  console.log(`✅ CAPTURE COMPLETE`);
  console.log(`📂 Content saved to: ${contentDir}`);
  console.log(`📄 Pages captured: ${pages.length}`);
  console.log(`📊 Total text: ${(capture.crawl_stats.total_text_chars / 1000).toFixed(1)}K chars`);
  console.log(`💾 Total size: ${(capture.crawl_stats.total_html_bytes / 1024).toFixed(1)} KB`);
  console.log(`${'='.repeat(80)}\n`);
  
  if (analysis) {
    console.log(`\n📊 AI ANALYSIS\n`);
    console.log(analysis);
    console.log(`\n`);
  }
  
  return capture;
}

// CLI usage
if (require.main === module) {
  const args = process.argv.slice(2);
  
  if (args.length < 3) {
    console.log(`
Usage: ./capture_web_content.js <shop_id> <shop_name> <website_url>

Example:
  ./capture_web_content.js shop_123 "Amoeba Music" "https://www.amoeba.com"
`);
    process.exit(1);
  }
  
  const shopId = args[0];
  const shopName = args[1];
  const websiteUrl = args[2];
  
  captureWebContent(shopId, shopName, websiteUrl);
}

module.exports = { captureWebContent };
