#!/usr/bin/env node
/**
 * Deep Instagram Scraper — Profile + recent posts via Playwright stealth
 * 
 * Usage:
 *   node scrape_instagram_deep.js --handle "shadydogrecords"
 *   node scrape_instagram_deep.js --shop-id "uuid"
 *   node scrape_instagram_deep.js --all --limit 10
 */

const { delay, saveJSON, contentDir, getAllShops, updateShop,
  createStealthBrowser, parseArgs, log } = require('./lib/common');

async function scrapeInstagramProfile(page, handle) {
  const cleanHandle = handle.replace(/^@/, '').replace(/^https?:\/\/(www\.)?instagram\.com\//, '').replace(/\/$/, '');
  const url = `https://www.instagram.com/${cleanHandle}/`;
  
  log(`  Scraping Instagram: @${cleanHandle}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await delay(3000, 5000);

  // Check for login wall or 404
  const pageContent = await page.content();
  if (pageContent.includes("Sorry, this page isn't available") || pageContent.includes('Page Not Found')) {
    return { error: 'Profile not found', handle: cleanHandle };
  }

  // Try to extract from meta tags and page content
  const data = await page.evaluate((handle) => {
    const getMeta = (name) => {
      const el = document.querySelector(`meta[property="${name}"], meta[name="${name}"]`);
      return el?.getAttribute('content') || null;
    };

    // Profile data from meta tags
    const description = getMeta('og:description') || getMeta('description') || '';
    
    // Parse follower/following/post counts from description
    // Format: "123 Followers, 45 Following, 67 Posts - See Instagram photos..."
    let followers = null, following = null, postCount = null;
    const countMatch = description.match(/([\d,.]+[KMB]?)\s*Followers.*?([\d,.]+[KMB]?)\s*Following.*?([\d,.]+[KMB]?)\s*Posts/i);
    if (countMatch) {
      const parseCount = (s) => {
        s = s.replace(/,/g, '');
        if (s.endsWith('K')) return Math.round(parseFloat(s) * 1000);
        if (s.endsWith('M')) return Math.round(parseFloat(s) * 1000000);
        if (s.endsWith('B')) return Math.round(parseFloat(s) * 1000000000);
        return parseInt(s);
      };
      followers = parseCount(countMatch[1]);
      following = parseCount(countMatch[2]);
      postCount = parseCount(countMatch[3]);
    }

    // Bio from page elements
    let bio = null;
    const bioEl = document.querySelector('div[class*="-webkit-box"] span, section header section span');
    if (bioEl) bio = bioEl.textContent?.trim();
    
    // Fallback: extract bio from meta description
    if (!bio) {
      const bioMatch = description.match(/Posts.*?-\s*(.*)/);
      if (bioMatch) bio = bioMatch[1].trim();
    }

    // Full name
    const nameEl = document.querySelector('header section span[class*="x1lliihq"], header h2');
    const fullName = nameEl?.textContent?.trim() || getMeta('og:title')?.split('(')[0]?.trim();

    // Profile pic
    const profilePic = getMeta('og:image') || document.querySelector('header img')?.src;

    // Verified
    const verified = !!document.querySelector('[aria-label="Verified"], svg[aria-label="Verified"]');

    // External link
    const extLinkEl = document.querySelector('a[rel="me nofollow noopener noreferrer"]');
    const externalLink = extLinkEl?.href || null;

    // Recent posts (images visible on the grid)
    const posts = [];
    const postEls = document.querySelectorAll('article img, main img[style*="object-fit"]');
    postEls.forEach((img, i) => {
      if (i >= 12) return;
      const src = img.src;
      const alt = img.alt || '';
      if (src && !src.includes('profile_pic') && !src.includes('s150x150')) {
        posts.push({
          imageUrl: src,
          caption: alt,
          index: i
        });
      }
    });

    // Try to get post links for deeper scraping
    const postLinks = [...document.querySelectorAll('a[href*="/p/"]')]
      .map(a => a.href)
      .filter((v, i, a) => a.indexOf(v) === i)
      .slice(0, 12);

    return {
      handle,
      fullName,
      bio,
      followers,
      following,
      postCount,
      verified,
      profilePic,
      externalLink,
      posts,
      postLinks,
      profileUrl: window.location.href,
    };
  }, cleanHandle);

  // Try to get more post details by clicking into posts
  if (data.postLinks && data.postLinks.length > 0) {
    const detailedPosts = [];
    const maxPosts = Math.min(data.postLinks.length, 12);

    for (let i = 0; i < maxPosts; i++) {
      try {
        await page.goto(data.postLinks[i], { waitUntil: 'domcontentloaded', timeout: 15000 });
        await delay(1500, 2500);

        const postData = await page.evaluate(() => {
          const getMeta = (name) => {
            const el = document.querySelector(`meta[property="${name}"]`);
            return el?.getAttribute('content') || null;
          };

          const caption = getMeta('og:title') || getMeta('og:description') || '';
          const imageUrl = getMeta('og:image');

          // Try to get likes/comments from the page
          const likesEl = document.querySelector('a[href*="liked_by"] span, section span[class*="html-span"]');
          let likes = null;
          if (likesEl) {
            const m = likesEl.textContent.match(/([\d,]+)/);
            if (m) likes = parseInt(m[1].replace(/,/g, ''));
          }

          // Extract hashtags from caption
          const hashtags = (caption.match(/#\w+/g) || []);

          // Date
          const timeEl = document.querySelector('time');
          const date = timeEl?.getAttribute('datetime') || timeEl?.textContent?.trim();

          return { caption, imageUrl, likes, hashtags, date, url: window.location.href };
        });

        detailedPosts.push(postData);
      } catch (e) {
        // Skip this post
      }
    }

    if (detailedPosts.length > 0) {
      data.detailedPosts = detailedPosts;
    }
  }

  data.scrapedAt = new Date().toISOString();
  return data;
}

async function run() {
  const args = parseArgs();
  const { browser, context } = await createStealthBrowser();

  try {
    const page = await context.newPage();

    if (args.handle) {
      const data = await scrapeInstagramProfile(page, args.handle);
      if (args['shop-id']) {
        const outPath = contentDir(args['shop-id'], 'social', 'instagram.json');
        saveJSON(outPath, data);
        log(`Saved to ${outPath}`);
      } else {
        console.log(JSON.stringify(data, null, 2));
      }
      return;
    }

    if (args['shop-id']) {
      const { supabase } = require('./lib/common');
      const { data: shop } = await supabase.from('shops').select('*').eq('id', args['shop-id']).single();
      if (!shop) { log('Shop not found'); return; }
      if (!shop.social_instagram) { log('No Instagram handle'); return; }
      
      const data = await scrapeInstagramProfile(page, shop.social_instagram);
      const outPath = contentDir(shop.id, 'social', 'instagram.json');
      saveJSON(outPath, data);
      log(`Saved to ${outPath}`);
      return;
    }

    if (args.all) {
      const limit = parseInt(args.limit) || 10;
      const shops = await getAllShops(limit);
      let processed = 0, skipped = 0;

      for (const shop of shops) {
        if (!shop.social_instagram) {
          skipped++;
          continue;
        }

        try {
          const data = await scrapeInstagramProfile(page, shop.social_instagram);
          
          if (data.error) {
            log(`  ✗ ${shop.name} (@${shop.social_instagram}): ${data.error}`);
            continue;
          }

          const outPath = contentDir(shop.id, 'social', 'instagram.json');
          saveJSON(outPath, data);

          // Update Supabase
          await updateShop(shop.id, {
            social_instagram: data.handle || shop.social_instagram,
          });

          processed++;
          log(`✓ [${processed}] ${shop.name} — ${data.followers || '?'} followers, ${data.postCount || '?'} posts`);
          await delay(3000, 6000);
        } catch (e) {
          log(`✗ ${shop.name}: ${e.message}`);
          await delay(2000, 3000);
        }
      }

      log(`\nDone. Processed ${processed}, skipped ${skipped} (no IG handle).`);
    }

  } finally {
    await browser.close();
  }
}

run().catch(e => { console.error(e); process.exit(1); });
