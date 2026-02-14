#!/usr/bin/env node
/**
 * Reddit Mention Scraper for Record Shops
 * 
 * Usage:
 *   node scrape_reddit.js --shop "Shady Dog" --city "Berwyn" --state "PA"
 *   node scrape_reddit.js --slug "shop_slug_here"
 *   node scrape_reddit.js --all --limit 10
 *   node scrape_reddit.js --discover --city "Philadelphia"
 */

const { supabase, delay, saveJSON, loadJSON, contentDir, ensureDir,
  getAllShops, getShopByName, updateShop, parseArgs, log } = require('./lib/common');
const path = require('path');

const VINYL_SUBS = ['vinyl', 'vinylcollecting', 'crate_digging', 'VinylDeals', 'VinylCollectors'];
const UA = 'RecordShopEnricher/1.0 (by /u/recordshopenricher)';

async function redditSearch(query, subreddit = null, limit = 25) {
  const base = subreddit
    ? `https://www.reddit.com/r/${subreddit}/search.json`
    : `https://www.reddit.com/search.json`;
  
  const params = new URLSearchParams({
    q: query,
    sort: 'relevance',
    limit: String(limit),
    ...(subreddit ? { restrict_sr: 'on' } : {})
  });

  const url = `${base}?${params}`;
  
  try {
    const resp = await fetch(url, { headers: { 'User-Agent': UA } });
    if (resp.status === 429) {
      log('    Rate limited, waiting 10s...');
      await delay(10000, 12000);
      return redditSearch(query, subreddit, limit);
    }
    if (!resp.ok) {
      log(`    Reddit API error: ${resp.status}`);
      return [];
    }
    const data = await resp.json();
    return data?.data?.children?.map(c => c.data) || [];
  } catch (e) {
    log(`    Reddit fetch error: ${e.message}`);
    return [];
  }
}

function extractImages(post) {
  const images = [];
  // Direct image URL
  if (post.url && /\.(jpg|jpeg|png|gif|webp)(\?.*)?$/i.test(post.url)) {
    images.push(post.url);
  }
  // Preview images
  if (post.preview?.images) {
    for (const img of post.preview.images) {
      if (img.source?.url) images.push(img.source.url.replace(/&amp;/g, '&'));
    }
  }
  // Gallery
  if (post.is_gallery && post.media_metadata) {
    for (const meta of Object.values(post.media_metadata)) {
      if (meta.s?.u) images.push(meta.s.u.replace(/&amp;/g, '&'));
    }
  }
  return images;
}

function extractQuotes(post) {
  const text = post.selftext || '';
  const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 20 && s.trim().length < 300);
  // Look for sentences that sound like recommendations
  return sentences.filter(s =>
    /recommend|love|amazing|incredible|best|favorite|great selection|worth|must.visit|hidden gem|go.to/i.test(s)
  ).map(s => s.trim());
}

async function scrapeRedditForShop(shop) {
  log(`\n${'='.repeat(60)}`);
  log(`Reddit scrape: ${shop.name} (${shop.city}, ${shop.state})`);
  log(`${'='.repeat(60)}`);

  const searchQuery = `"${shop.name}" ${shop.city}`;
  const allMentions = [];
  const seenIds = new Set();

  // Global search
  log(`  Searching globally: ${searchQuery}`);
  const globalPosts = await redditSearch(searchQuery);
  await delay(1500, 2500);

  // Subreddit-specific searches
  for (const sub of VINYL_SUBS) {
    log(`  Searching r/${sub}...`);
    const posts = await redditSearch(searchQuery, sub);
    globalPosts.push(...posts);
    await delay(1500, 2500);
  }

  // Also try without quotes for broader results
  const broadQuery = `${shop.name} ${shop.city}`;
  log(`  Broad search: ${broadQuery}`);
  const broadPosts = await redditSearch(broadQuery);
  globalPosts.push(...broadPosts);
  await delay(1500, 2500);

  // Also search city-specific subreddit
  const citySub = shop.city?.toLowerCase().replace(/\s+/g, '');
  if (citySub) {
    log(`  Searching r/${citySub}...`);
    const cityPosts = await redditSearch(shop.name, citySub);
    globalPosts.push(...cityPosts);
    await delay(1500, 2500);
  }

  // Process all posts
  for (const post of globalPosts) {
    if (seenIds.has(post.id)) continue;
    seenIds.add(post.id);

    const images = extractImages(post);
    const quotes = extractQuotes(post);

    allMentions.push({
      id: post.id,
      title: post.title,
      body: post.selftext?.slice(0, 2000) || '',
      score: post.score,
      date: new Date(post.created_utc * 1000).toISOString(),
      subreddit: post.subreddit,
      url: `https://reddit.com${post.permalink}`,
      author: post.author,
      imageUrls: images,
      quotes,
      numComments: post.num_comments
    });
  }

  // Sort by score
  allMentions.sort((a, b) => b.score - a.score);

  log(`\nFound ${allMentions.length} unique mentions`);
  log(`  Total images: ${allMentions.reduce((s, m) => s + m.imageUrls.length, 0)}`);
  log(`  Total quotes: ${allMentions.reduce((s, m) => s + m.quotes.length, 0)}`);

  // Save to file
  const outDir = contentDir(shop.id, 'reddit');
  ensureDir(outDir);
  saveJSON(path.join(outDir, 'mentions.json'), {
    shop: { id: shop.id, name: shop.name, slug: shop.slug },
    scrapedAt: new Date().toISOString(),
    totalMentions: allMentions.length,
    mentions: allMentions
  });
  log(`  Saved to content/${shop.id}/reddit/mentions.json`);

  // Extract notable quotes for DB update
  const notableQuotes = [];
  for (const mention of allMentions) {
    for (const quote of mention.quotes) {
      notableQuotes.push({
        text: quote,
        source: `Reddit r/${mention.subreddit}`,
        url: mention.url,
        score: mention.score,
        date: mention.date,
        author: mention.author
      });
    }
  }

  if (notableQuotes.length > 0) {
    // Keep top 10 by score
    notableQuotes.sort((a, b) => b.score - a.score);
    const topQuotes = notableQuotes.slice(0, 10);
    
    const existing = shop.review_notable_quotes || [];
    const existingTexts = new Set(existing.map(q => typeof q === 'string' ? q : q.text));
    const newQuotes = topQuotes.filter(q => !existingTexts.has(q.text));
    
    if (newQuotes.length > 0) {
      const updated = [...existing, ...newQuotes];
      await updateShop(shop.id, { review_notable_quotes: updated });
      log(`  Updated review_notable_quotes: +${newQuotes.length} quotes`);
    }
  }

  // Print top mentions
  if (allMentions.length > 0) {
    log('\nTop mentions:');
    for (const m of allMentions.slice(0, 5)) {
      log(`  [${m.score}↑] r/${m.subreddit}: ${m.title.slice(0, 80)}`);
      if (m.quotes.length > 0) log(`    Quote: "${m.quotes[0].slice(0, 100)}"`);
    }
  }

  return allMentions;
}

// ─── Discovery Mode ─────────────────────────────────────────────────────────

async function discoverShops(city, state) {
  log(`\nDiscovering record shops in ${city}${state ? ', ' + state : ''}...`);
  
  const queries = [
    `best record shops in ${city}`,
    `vinyl record store ${city}`,
    `record store ${city} ${state || ''}`,
    `best place to buy vinyl ${city}`
  ];

  const allMentions = [];
  const seenIds = new Set();

  for (const query of queries) {
    log(`  Searching: ${query}`);
    
    // Global search
    const posts = await redditSearch(query);
    await delay(1500, 2500);
    
    // Vinyl subreddits
    for (const sub of VINYL_SUBS.slice(0, 3)) {
      const subPosts = await redditSearch(query, sub);
      posts.push(...subPosts);
      await delay(1500, 2500);
    }

    for (const post of posts) {
      if (seenIds.has(post.id)) continue;
      seenIds.add(post.id);
      allMentions.push({
        id: post.id,
        title: post.title,
        body: post.selftext?.slice(0, 3000) || '',
        score: post.score,
        date: new Date(post.created_utc * 1000).toISOString(),
        subreddit: post.subreddit,
        url: `https://reddit.com${post.permalink}`,
        numComments: post.num_comments,
        query
      });
    }
  }

  allMentions.sort((a, b) => b.score - a.score);

  // Save discovery results
  const outDir = path.join(__dirname, 'content', 'discovery');
  ensureDir(outDir);
  const slug = city.toLowerCase().replace(/\s+/g, '_');
  saveJSON(path.join(outDir, `reddit_${slug}.json`), {
    city,
    state,
    scrapedAt: new Date().toISOString(),
    totalMentions: allMentions.length,
    mentions: allMentions
  });

  log(`\nFound ${allMentions.length} posts about record shops in ${city}`);
  log(`Saved to content/discovery/reddit_${slug}.json`);

  // Print top results
  for (const m of allMentions.slice(0, 10)) {
    log(`  [${m.score}↑] r/${m.subreddit}: ${m.title.slice(0, 80)}`);
  }
}

// ─── CLI Entry Point ────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();

  if (args.discover) {
    if (!args.city) { log('--discover requires --city'); process.exit(1); }
    await discoverShops(args.city, args.state);
    return;
  }

  let shops = [];

  if (args.slug) {
    const { data, error } = await supabase.from('shops').select('*').eq('slug', args.slug).single();
    if (error || !data) { log(`Shop not found: ${args.slug}`); process.exit(1); }
    shops = [data];
  } else if (args.shop) {
    shops = await getShopByName(args.shop, args.city, args.state);
    if (shops.length === 0) { log(`Shop not found: ${args.shop}`); process.exit(1); }
    if (shops.length > 1) {
      log(`Multiple shops found, using first:`);
      shops.forEach(s => log(`  - ${s.name} (${s.city}, ${s.state})`));
      shops = [shops[0]];
    }
  } else if (args.all) {
    shops = await getAllShops(parseInt(args.limit) || undefined);
  } else if (args['shop-id']) {
    const { data, error } = await supabase.from('shops').select('*').eq('id', args['shop-id']).single();
    if (error || !data) { log(`Shop not found: ${args['shop-id']}`); process.exit(1); }
    shops = [data];
  } else {
    console.log('Usage:');
    console.log('  node scrape_reddit.js --shop "Shady Dog" --city "Berwyn" --state "PA"');
    console.log('  node scrape_reddit.js --slug "shop_slug_here"');
    console.log('  node scrape_reddit.js --all --limit 10');
    console.log('  node scrape_reddit.js --discover --city "Philadelphia"');
    process.exit(0);
  }

  log(`Processing ${shops.length} shop(s)...`);
  for (const shop of shops) {
    await scrapeRedditForShop(shop);
  }
  log('\nAll done!');
}

main().catch(e => { console.error(e); process.exit(1); });
