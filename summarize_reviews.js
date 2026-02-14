#!/usr/bin/env node
/**
 * AI Review Summarizer — Uses Ollama to analyze Yelp + Google reviews
 * 
 * Usage:
 *   node summarize_reviews.js --shop-id "uuid"
 *   node summarize_reviews.js --all --limit 10
 */

const { saveJSON, loadJSON, contentDir, getAllShops, updateShop,
  ollamaSummarize, parseArgs, log } = require('./lib/common');
const fs = require('fs');
const path = require('path');

async function summarizeShopReviews(shopId, shopName) {
  // Load reviews from both sources
  const yelpPath = contentDir(shopId, 'reviews', 'yelp_reviews.json');
  const googlePath = contentDir(shopId, 'reviews', 'google_reviews.json');

  const yelpData = loadJSON(yelpPath);
  const googleData = loadJSON(googlePath);

  const yelpReviews = yelpData?.reviews || [];
  const googleReviews = googleData?.reviews || [];
  const allReviews = [...yelpReviews, ...googleReviews];

  if (allReviews.length === 0) {
    log(`  No reviews found for ${shopName}`);
    return null;
  }

  log(`  Analyzing ${allReviews.length} reviews (${yelpReviews.length} Yelp, ${googleReviews.length} Google)`);

  // Build review text for the prompt (limit to avoid token overflow)
  const reviewTexts = allReviews
    .filter(r => r.text && r.text.length > 10)
    .sort((a, b) => (b.text?.length || 0) - (a.text?.length || 0))
    .slice(0, 50)
    .map((r, i) => `Review ${i + 1} (${r.stars || '?'}★ - ${r.author || r.reviewer || 'anon'}): ${r.text.slice(0, 500)}`)
    .join('\n\n');

  // Calculate basic stats
  const ratings = allReviews.filter(r => r.stars).map(r => r.stars);
  const avgRating = ratings.length > 0 ? (ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(2) : null;
  const ratingDist = {};
  ratings.forEach(r => { ratingDist[r] = (ratingDist[r] || 0) + 1; });

  const prompt = `You are analyzing customer reviews for "${shopName}", a record shop. Analyze ALL the reviews below and provide a comprehensive summary.

Return your analysis as JSON with EXACTLY these keys:
{
  "sentiment_score": <number 1-10, where 10 is most positive>,
  "key_themes": ["array of 5-8 recurring themes mentioned in reviews"],
  "pros": ["array of 3-5 main positives"],
  "cons": ["array of 2-4 main negatives or areas for improvement"],
  "notable_quotes": {
    "best": "the most glowing review quote",
    "worst": "the most negative review quote",
    "funniest": "the most entertaining/unique review quote"
  },
  "vibe_description": "2-3 sentence description of the shop's atmosphere/vibe based on reviews",
  "genre_specialties": ["genres frequently mentioned (jazz, punk, etc.)"],
  "staff_mentions": "summary of what reviewers say about staff",
  "event_mentions": ["any events, performances, or Record Store Day mentions extracted from reviews"],
  "recommendation_for": "who would love this shop (e.g., 'jazz collectors', 'casual browsers', etc.)"
}

BASIC STATS: ${allReviews.length} total reviews, average rating: ${avgRating}, distribution: ${JSON.stringify(ratingDist)}

REVIEWS:
${reviewTexts.slice(0, 10000)}`;

  try {
    const result = await ollamaSummarize(prompt);
    
    // Try to parse JSON — multiple strategies for dealing with Ollama output
    let analysis = null;
    
    // Strategy 1: extract from ```json ... ``` code fence
    const fenceMatch = result.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
    // Strategy 2: find first { ... } block
    const rawJson = fenceMatch ? fenceMatch[1] : (result.match(/\{[\s\S]*\}/) || [null])[0];
    
    if (rawJson) {
      // Sanitize Python-style values and unquoted strings
      let sanitized = rawJson
        .replace(/:\s*None/g, ': null')
        .replace(/:\s*True/g, ': true')
        .replace(/:\s*False/g, ': false')
        // Fix unquoted string values (common Ollama issue)
        .replace(/:\s*([A-Z][^",\n\r}\]]*[^",\s\n\r}\]])\s*([,}\]])/g, ': "$1"$2');
      
      try {
        analysis = JSON.parse(sanitized);
      } catch (e) {
        // Strategy 3: use a more lenient parse — strip trailing commas, fix quotes
        sanitized = sanitized
          .replace(/,\s*([}\]])/g, '$1')  // trailing commas
          .replace(/([{,]\s*)(\w+)\s*:/g, '$1"$2":');  // unquoted keys
        try {
          analysis = JSON.parse(sanitized);
        } catch (e2) {
          // Strategy 4: just save the raw text as a summary
          log(`    JSON parse failed, saving raw summary`);
          analysis = { raw_summary: result.slice(0, 2000) };
        }
      }
    }
    
    if (analysis) {
      
      // Add metadata
      analysis.metadata = {
        totalReviews: allReviews.length,
        yelpReviews: yelpReviews.length,
        googleReviews: googleReviews.length,
        averageRating: parseFloat(avgRating),
        ratingDistribution: ratingDist,
        analyzedAt: new Date().toISOString(),
      };

      return analysis;
    }

    return { raw_summary: result, metadata: { totalReviews: allReviews.length } };
  } catch (e) {
    log(`    Ollama error: ${e.message}`);
    return { error: e.message };
  }
}

async function run() {
  const args = parseArgs();

  if (args['shop-id']) {
    const { supabase } = require('./lib/common');
    const { data: shop } = await supabase.from('shops').select('*').eq('id', args['shop-id']).single();
    if (!shop) { log('Shop not found'); return; }

    const analysis = await summarizeShopReviews(shop.id, shop.name);
    if (analysis && !analysis.error) {
      const outPath = contentDir(shop.id, 'reviews', 'analysis.json');
      saveJSON(outPath, analysis);
      
      // Update Supabase
      await updateShop(shop.id, {
        sentiment_score: analysis.sentiment_score || null,
      });

      log(`Saved analysis to ${outPath}`);
      console.log(JSON.stringify(analysis, null, 2));
    }
    return;
  }

  if (args.all) {
    const limit = parseInt(args.limit) || 10;
    const shops = await getAllShops(limit);
    let processed = 0, skipped = 0;

    for (const shop of shops) {
      // Check if reviews exist
      const yelpExists = fs.existsSync(contentDir(shop.id, 'reviews', 'yelp_reviews.json'));
      const googleExists = fs.existsSync(contentDir(shop.id, 'reviews', 'google_reviews.json'));

      if (!yelpExists && !googleExists) {
        skipped++;
        continue;
      }

      try {
        log(`\n═══ ${shop.name} ═══`);
        const analysis = await summarizeShopReviews(shop.id, shop.name);
        
        if (analysis && !analysis.error) {
          const outPath = contentDir(shop.id, 'reviews', 'analysis.json');
          saveJSON(outPath, analysis);

          await updateShop(shop.id, {
            sentiment_score: analysis.sentiment_score || null,
          });

          processed++;
          log(`✓ [${processed}] ${shop.name} — sentiment: ${analysis.sentiment_score}/10`);
        }
      } catch (e) {
        log(`✗ ${shop.name}: ${e.message}`);
      }
    }

    log(`\nDone. Analyzed ${processed}, skipped ${skipped} (no reviews).`);
  }
}

run().catch(e => { console.error(e); process.exit(1); });
