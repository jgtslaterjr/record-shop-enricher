#!/usr/bin/env node
/**
 * Browser-based scraper for Cloudflare-protected sites (Discogs, Yelp, Facebook, etc.)
 * Uses Puppeteer to bypass JS challenges.
 * 
 * Usage: node scrape_with_browser.js <url> [--output <file>] [--selector <css>] [--wait <ms>]
 */
const puppeteer = require('puppeteer');
const fs = require('fs');

async function scrape(url, options = {}) {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  try {
    const page = await browser.newPage();
    
    // Set a realistic user agent
    await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
    
    // Set viewport
    await page.setViewport({ width: 1920, height: 1080 });

    console.error(`Navigating to ${url}...`);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    
    // Wait for Cloudflare challenge if present
    const waitMs = options.wait || 5000;
    await new Promise(r => setTimeout(r, waitMs));
    
    // Check if still on Cloudflare challenge
    const title = await page.title();
    if (title.includes('Just a moment') || title.includes('Attention Required')) {
      console.error('Cloudflare challenge detected, waiting longer...');
      await new Promise(r => setTimeout(r, 10000));
    }
    
    let content;
    if (options.selector) {
      // Extract specific element
      content = await page.$eval(options.selector, el => el.innerText).catch(() => null);
      if (!content) {
        console.error(`Selector "${options.selector}" not found, getting full page`);
        content = await page.evaluate(() => document.body.innerText);
      }
    } else {
      content = await page.evaluate(() => document.body.innerText);
    }
    
    // Also grab structured data
    const structuredData = await page.evaluate(() => {
      const data = {};
      // Meta tags
      document.querySelectorAll('meta[property], meta[name]').forEach(m => {
        const key = m.getAttribute('property') || m.getAttribute('name');
        if (key) data[key] = m.getAttribute('content');
      });
      // JSON-LD
      document.querySelectorAll('script[type="application/ld+json"]').forEach(s => {
        try { data['json-ld'] = JSON.parse(s.textContent); } catch {}
      });
      return data;
    });

    return { content, structuredData, title: await page.title(), url: page.url() };
  } finally {
    await browser.close();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const url = args.find(a => !a.startsWith('--'));
  if (!url) { console.error('Usage: node scrape_with_browser.js <url>'); process.exit(1); }
  
  const outputIdx = args.indexOf('--output');
  const outputFile = outputIdx >= 0 ? args[outputIdx + 1] : null;
  const selectorIdx = args.indexOf('--selector');
  const selector = selectorIdx >= 0 ? args[selectorIdx + 1] : null;
  const waitIdx = args.indexOf('--wait');
  const wait = waitIdx >= 0 ? parseInt(args[waitIdx + 1]) : undefined;
  
  const result = await scrape(url, { selector, wait });
  
  const output = JSON.stringify(result, null, 2);
  if (outputFile) {
    fs.writeFileSync(outputFile, output);
    console.error(`Saved to ${outputFile}`);
  } else {
    console.log(output);
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
