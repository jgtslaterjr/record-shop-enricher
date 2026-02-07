#!/usr/bin/env node
/**
 * Record Shop Enricher V2 - Tier 1: Enhanced Web Intelligence
 * 
 * Features:
 * - Deep multi-page crawling (About, Events, Contact, etc.)
 * - Proper HTML parsing and DOM analysis
 * - Schema.org structured data extraction
 * - Contact information extraction (phone, email, address)
 * - Store hours and location data
 * - Business history and ownership info
 * 
 * Usage: node enrich_shop_v2.js "Shop Name" "https://shop-url.com"
 */

const { spawn } = require('child_process');
const { URL } = require('url');

// Configuration
const MAX_PAGES = 10;           // Maximum pages to crawl per shop
const MAX_DEPTH = 3;            // Maximum link depth from homepage
const FETCH_TIMEOUT = 10000;    // 10 second timeout per page
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36';

const shopName = process.argv[2];
const shopUrl = process.argv[3];

if (!shopName || !shopUrl) {
    console.error('Usage: node enrich_shop_v2.js "Shop Name" "https://shop-url.com"');
    process.exit(1);
}

console.log('╔════════════════════════════════════════════════════════════╗');
console.log(`║ Record Shop Enricher V2 - Tier 1                          ║`);
console.log('╠════════════════════════════════════════════════════════════╣');
console.log(`║ Shop: ${shopName.padEnd(51)}║`);
console.log(`║ URL:  ${shopUrl.padEnd(51)}║`);
console.log('╚════════════════════════════════════════════════════════════╝\n');

// Helper: Fetch webpage with curl
async function fetchPage(url) {
    return new Promise((resolve, reject) => {
        const curl = spawn('curl', [
            '-sL',
            '-A', USER_AGENT,
            '--max-time', '10',
            '--max-redirs', '3',
            url
        ]);
        
        let data = '';
        let error = '';

        curl.stdout.on('data', (chunk) => { data += chunk; });
        curl.stderr.on('data', (chunk) => { error += chunk; });

        curl.on('close', (code) => {
            if (code !== 0 || !data) {
                reject(new Error(`Failed to fetch ${url}: ${error}`));
            } else {
                resolve(data);
            }
        });

        setTimeout(() => {
            curl.kill();
            reject(new Error(`Timeout fetching ${url}`));
        }, FETCH_TIMEOUT);
    });
}

// Helper: Simple HTML parsing without external dependencies
function parseHTML(html) {
    const data = {
        title: '',
        metaDescription: '',
        schemaOrg: [],
        links: [],
        emails: [],
        phones: [],
        text: ''
    };

    // Extract title
    const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/is);
    if (titleMatch) data.title = titleMatch[1].trim().replace(/<[^>]+>/g, '');

    // Extract meta description
    const metaMatch = html.match(/<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i);
    if (metaMatch) data.metaDescription = metaMatch[1];

    // Extract schema.org JSON-LD
    const schemaMatches = html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>(.*?)<\/script>/gis);
    for (const match of schemaMatches) {
        try {
            data.schemaOrg.push(JSON.parse(match[1]));
        } catch (e) {
            // Skip invalid JSON
        }
    }

    // Extract internal links
    const linkMatches = html.matchAll(/<a[^>]+href=["']([^"']+)["']/gi);
    for (const match of linkMatches) {
        data.links.push(match[1]);
    }

    // Extract emails
    const emailMatches = html.matchAll(/([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/gi);
    for (const match of emailMatches) {
        data.emails.push(match[1]);
    }

    // Extract phone numbers (US format primarily)
    const phoneMatches = html.matchAll(/(?:\+?1[-.\s]?)?(?:\([0-9]{3}\)|[0-9]{3})[-.\s]?[0-9]{3}[-.\s]?[0-9]{4}/g);
    for (const match of phoneMatches) {
        data.phones.push(match[0].trim());
    }

    // Extract clean text (remove scripts, styles, tags)
    let cleanText = html
        .replace(/<script[^>]*>.*?<\/script>/gis, ' ')
        .replace(/<style[^>]*>.*?<\/style>/gis, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    
    data.text = cleanText.substring(0, 50000); // Limit to 50KB

    return data;
}

// Helper: Filter and categorize links
function categorizeLinks(baseUrl, links) {
    const base = new URL(baseUrl);
    const categories = {
        about: [],
        contact: [],
        events: [],
        hours: [],
        location: [],
        other: []
    };

    const aboutKeywords = /about|story|history|who-we-are|our-team|mission/i;
    const contactKeywords = /contact|reach-us|get-in-touch/i;
    const eventsKeywords = /events|calendar|shows|performances|concerts/i;
    const hoursKeywords = /hours|visit|location|directions|find-us/i;

    for (const link of links) {
        try {
            const url = new URL(link, baseUrl);
            
            // Only internal links
            if (url.hostname !== base.hostname) continue;
            
            // Ignore non-HTML content
            if (/\.(jpg|jpeg|png|gif|pdf|zip|mp3|mp4)$/i.test(url.pathname)) continue;

            const path = url.pathname.toLowerCase();
            
            if (aboutKeywords.test(path)) {
                categories.about.push(url.href);
            } else if (contactKeywords.test(path)) {
                categories.contact.push(url.href);
            } else if (eventsKeywords.test(path)) {
                categories.events.push(url.href);
            } else if (hoursKeywords.test(path)) {
                categories.hours.push(url.href);
            } else if (path.includes('location') || path.includes('visit')) {
                categories.location.push(url.href);
            } else if (url.pathname !== '/' && url.pathname !== base.pathname) {
                categories.other.push(url.href);
            }
        } catch (e) {
            // Skip invalid URLs
        }
    }

    return categories;
}

// Helper: Deduplicate array
function unique(arr) {
    return [...new Set(arr)];
}

// Main crawling logic
async function crawlShop(startUrl) {
    console.log('📡 Starting deep crawl...\n');
    
    const crawledPages = new Map();
    const pagesToVisit = [];
    
    // Step 1: Fetch homepage
    console.log('🏠 Fetching homepage...');
    try {
        const homeHtml = await fetchPage(startUrl);
        const homeData = parseHTML(homeHtml);
        crawledPages.set(startUrl, homeData);
        console.log(`   ✓ Title: ${homeData.title}`);
        console.log(`   ✓ Found ${homeData.links.length} links`);
        console.log(`   ✓ Schema.org data: ${homeData.schemaOrg.length} blocks\n`);

        // Categorize links
        const linkCategories = categorizeLinks(startUrl, homeData.links);
        
        // Prioritize important pages
        const priorityPages = [
            ...linkCategories.about.slice(0, 2),
            ...linkCategories.contact.slice(0, 1),
            ...linkCategories.events.slice(0, 2),
            ...linkCategories.hours.slice(0, 1),
            ...linkCategories.location.slice(0, 1),
            ...linkCategories.other.slice(0, 3)
        ];

        pagesToVisit.push(...unique(priorityPages));
    } catch (error) {
        console.error(`   ✗ Failed to fetch homepage: ${error.message}\n`);
        return crawledPages;
    }

    // Step 2: Fetch priority pages
    console.log(`🔗 Crawling ${Math.min(pagesToVisit.length, MAX_PAGES - 1)} additional pages...\n`);
    
    let crawled = 1;
    for (const url of pagesToVisit) {
        if (crawled >= MAX_PAGES) break;
        if (crawledPages.has(url)) continue;

        try {
            console.log(`   [${crawled}/${MAX_PAGES}] ${url.substring(0, 60)}...`);
            const html = await fetchPage(url);
            const data = parseHTML(html);
            crawledPages.set(url, data);
            crawled++;
            
            // Small delay to be polite
            await new Promise(resolve => setTimeout(resolve, 500));
        } catch (error) {
            console.log(`   ✗ Failed: ${error.message}`);
        }
    }

    console.log(`\n✅ Crawled ${crawledPages.size} pages successfully\n`);
    return crawledPages;
}

// Extract structured business data from all pages
function extractBusinessData(crawledPages) {
    const businessData = {
        name: shopName,
        url: shopUrl,
        phones: [],
        emails: [],
        addresses: [],
        hours: null,
        schema: [],
        description: '',
        pages: {
            about: [],
            events: [],
            contact: []
        }
    };

    for (const [url, data] of crawledPages) {
        // Aggregate contact info
        businessData.phones.push(...data.phones);
        businessData.emails.push(...data.emails);

        // Aggregate schema.org data
        businessData.schema.push(...data.schemaOrg);

        // Use homepage meta description
        if (url === shopUrl && data.metaDescription) {
            businessData.description = data.metaDescription;
        }

        // Categorize page content
        if (url.includes('about') || url.includes('history') || url.includes('story')) {
            businessData.pages.about.push({ url, text: data.text.substring(0, 3000) });
        }
        if (url.includes('event') || url.includes('calendar')) {
            businessData.pages.events.push({ url, text: data.text.substring(0, 3000) });
        }
        if (url.includes('contact') || url.includes('hours') || url.includes('location')) {
            businessData.pages.contact.push({ url, text: data.text.substring(0, 3000) });
        }
    }

    // Deduplicate
    businessData.phones = unique(businessData.phones).slice(0, 5);
    businessData.emails = unique(businessData.emails).slice(0, 5);

    return businessData;
}

// Analyze with Kimi K2.5
async function analyzeWithKimi(businessData, allText) {
    return new Promise((resolve, reject) => {
        console.log('🤖 Analyzing with Kimi K2.5...\n');

        const schemaInfo = businessData.schema.length > 0 
            ? `\nStructured Data Found:\n${JSON.stringify(businessData.schema, null, 2)}\n`
            : '';

        const contactInfo = `
Contact Information Extracted:
- Phones: ${businessData.phones.join(', ') || 'None found'}
- Emails: ${businessData.emails.join(', ') || 'None found'}
`;

        const prompt = `You are analyzing a record shop's website to extract comprehensive business intelligence.

Shop Name: ${shopName}
Website: ${shopUrl}
${contactInfo}
${schemaInfo}

I've crawled multiple pages from their website. Analyze ALL the content and provide:

## BUSINESS DETAILS
- Full business name and any alternate names
- Physical address (if found)
- Phone number(s) and email(s)
- Store hours (if mentioned)
- Years in business / founding date

## SPECIALIZATIONS & INVENTORY
- Primary formats sold (vinyl, CD, cassette, 8-track, etc.)
- Genre specializations
- New vs used focus
- Collection size indicators
- Rare/collectible focus

## SERVICES & AMENITIES
- Buying/selling/trading policies
- Special services (repair, equipment sales, appraisals)
- In-store features (listening stations, cafe, etc.)
- Events and community activities

## SHOP CULTURE & POSITIONING
- Target audience (collectors, casual, audiophiles)
- Price positioning (budget, mid-range, premium)
- Unique selling points
- Community involvement

## ONLINE PRESENCE
- E-commerce capabilities
- Shipping info
- Social media presence mentioned

Format as a structured report with clear sections. Be specific and cite evidence from the website content.
Only include information that is explicitly stated or clearly evident.

---
WEBSITE CONTENT:
${allText.substring(0, 40000)}
---`;

        const ollama = spawn('ollama', ['run', 'kimi-k2.5:cloud', '--nowordwrap']);
        
        let output = '';
        let errorOutput = '';

        ollama.stdout.on('data', (data) => {
            const chunk = data.toString();
            output += chunk;
            process.stdout.write(chunk);
        });

        ollama.stderr.on('data', (data) => {
            errorOutput += data.toString();
        });

        ollama.stdin.write(prompt);
        ollama.stdin.end();

        ollama.on('close', (code) => {
            console.log('\n');
            if (code !== 0) {
                reject(new Error(`Ollama failed: ${errorOutput}`));
            } else {
                resolve(output);
            }
        });
    });
}

// Main execution
async function main() {
    try {
        // Step 1: Crawl the website
        const crawledPages = await crawlShop(shopUrl);
        
        if (crawledPages.size === 0) {
            console.error('Failed to crawl any pages. Exiting.');
            process.exit(1);
        }

        // Step 2: Extract structured data
        console.log('📊 Extracting structured business data...\n');
        const businessData = extractBusinessData(crawledPages);
        
        // Combine all text for analysis
        let allText = '';
        for (const [url, data] of crawledPages) {
            allText += `\n=== ${url} ===\n${data.text}\n`;
        }

        // Step 3: AI analysis
        const analysis = await analyzeWithKimi(businessData, allText);

        // Step 4: Output summary
        console.log('\n╔════════════════════════════════════════════════════════════╗');
        console.log('║ ENRICHMENT COMPLETE - Tier 1                               ║');
        console.log('╚════════════════════════════════════════════════════════════╝\n');
        
        console.log('📋 EXTRACTED DATA SUMMARY:');
        console.log(`   • Pages crawled: ${crawledPages.size}`);
        console.log(`   • Contact phones: ${businessData.phones.length}`);
        console.log(`   • Contact emails: ${businessData.emails.length}`);
        console.log(`   • Schema.org blocks: ${businessData.schema.length}`);
        console.log(`   • About pages: ${businessData.pages.about.length}`);
        console.log(`   • Event pages: ${businessData.pages.events.length}`);
        console.log(`   • Contact pages: ${businessData.pages.contact.length}`);

    } catch (error) {
        console.error(`\n❌ Error: ${error.message}`);
        process.exit(1);
    }
}

main();
