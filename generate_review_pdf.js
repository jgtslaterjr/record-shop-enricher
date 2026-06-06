#!/usr/bin/env node
/**
 * Generate a styled PDF from a shop's review analysis JSON.
 * Uses built-in Node to create HTML, then we rely on the browser PDF endpoint.
 * 
 * Usage: node generate_review_pdf.js --shop-id "uuid"
 */

const fs = require('fs');
const path = require('path');
const { contentDir, loadJSON, parseArgs, supabase } = require('./lib/common');

function escapeHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function generateHtml(analysis, shopName, city, state) {
  const score = analysis.review_score || 'N/A';
  const scoreColor = score >= 8 ? '#22c55e' : score >= 6 ? '#eab308' : '#ef4444';
  
  const prosHtml = (analysis.review_pros || []).map(p => `<li>${escapeHtml(p)}</li>`).join('\n');
  const consHtml = (analysis.review_cons || []).map(c => `<li>${escapeHtml(c)}</li>`).join('\n');
  const themesHtml = (analysis.review_themes || []).map(t => `<span class="tag">${escapeHtml(t)}</span>`).join(' ');
  const genresHtml = (analysis.genre_specialties || []).map(g => `<span class="genre">${escapeHtml(g)}</span>`).join(' ');
  
  const quotes = analysis.review_notable_quotes || {};
  const summary = (analysis.review_summary || '').replace(/\n/g, '</p><p>');
  const vibe = analysis.review_vibe || '';
  const staff = analysis.staff_mentions || '';
  const recFor = analysis.recommendation_for || '';
  
  const sources = analysis.metadata?.sources || {};
  const analyzedAt = analysis.metadata?.analyzedAt ? new Date(analysis.metadata.analyzedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : 'Unknown';
  
  const sourceList = Object.entries(sources)
    .filter(([k,v]) => v && v !== false && v !== 0)
    .map(([k,v]) => `${k}: ${v}`)
    .join(', ') || 'Limited sources available';

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  @page { margin: 0.75in; size: letter; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Georgia', 'Times New Roman', serif; color: #1a1a1a; line-height: 1.6; font-size: 11pt; }
  .header { border-bottom: 3px solid #1a1a1a; padding-bottom: 16px; margin-bottom: 24px; }
  .header h1 { font-size: 28pt; font-weight: 700; letter-spacing: -0.5px; margin-bottom: 4px; }
  .header .location { font-size: 14pt; color: #555; font-style: italic; }
  .score-badge { float: right; background: ${scoreColor}; color: white; font-size: 24pt; font-weight: 700; width: 70px; height: 70px; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin-top: 4px; font-family: 'Helvetica Neue', Arial, sans-serif; }
  .section { margin-bottom: 20px; }
  .section h2 { font-size: 14pt; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; color: #333; border-bottom: 1px solid #ddd; padding-bottom: 4px; margin-bottom: 10px; font-family: 'Helvetica Neue', Arial, sans-serif; }
  .vibe { font-size: 12pt; font-style: italic; color: #444; background: #f8f8f8; padding: 14px 18px; border-left: 4px solid #333; margin-bottom: 20px; }
  p { margin-bottom: 10px; }
  ul { margin-left: 20px; margin-bottom: 10px; }
  li { margin-bottom: 6px; }
  .pros li::marker { color: #22c55e; }
  .cons li::marker { color: #ef4444; }
  .tag { display: inline-block; background: #e8e8e8; padding: 2px 10px; border-radius: 12px; font-size: 9pt; margin: 2px; font-family: 'Helvetica Neue', Arial, sans-serif; }
  .genre { display: inline-block; background: #1a1a1a; color: white; padding: 2px 10px; border-radius: 12px; font-size: 9pt; margin: 2px; font-family: 'Helvetica Neue', Arial, sans-serif; }
  .quote { background: #fafafa; padding: 12px 16px; border-left: 3px solid #888; margin-bottom: 10px; }
  .quote .text { font-style: italic; font-size: 11pt; }
  .quote .source { font-size: 9pt; color: #777; margin-top: 4px; font-family: 'Helvetica Neue', Arial, sans-serif; }
  .footer { margin-top: 30px; padding-top: 12px; border-top: 1px solid #ddd; font-size: 8pt; color: #999; font-family: 'Helvetica Neue', Arial, sans-serif; }
</style>
</head>
<body>

<div class="header">
  <div class="score-badge">${score}</div>
  <h1>${escapeHtml(shopName)}</h1>
  <div class="location">${escapeHtml(city)}, ${escapeHtml(state)}</div>
</div>

<div class="vibe">${escapeHtml(vibe)}</div>

<div class="section">
  <h2>Review Summary</h2>
  <p>${summary}</p>
</div>

<div class="section">
  <h2>Genre Specialties</h2>
  ${genresHtml}
</div>

<div class="section pros">
  <h2>Strengths</h2>
  <ul>${prosHtml}</ul>
</div>

<div class="section cons">
  <h2>Areas for Improvement</h2>
  <ul>${consHtml}</ul>
</div>

<div class="section">
  <h2>Notable Quotes</h2>
  ${quotes.best ? `<div class="quote"><div class="text">"${escapeHtml(quotes.best.text)}"</div><div class="source">— ${escapeHtml(quotes.best.source)}</div></div>` : ''}
  ${quotes.funniest && quotes.funniest.text !== 'N/A' ? `<div class="quote"><div class="text">"${escapeHtml(quotes.funniest.text)}"</div><div class="source">— ${escapeHtml(quotes.funniest.source)}</div></div>` : ''}
</div>

<div class="section">
  <h2>Key Themes</h2>
  ${themesHtml}
</div>

<div class="section">
  <h2>Staff & Ownership</h2>
  <p>${escapeHtml(staff)}</p>
</div>

<div class="section">
  <h2>Recommended For</h2>
  <p>${escapeHtml(recFor)}</p>
</div>

<div class="footer">
  <p>Aggregate Review Analysis — Generated ${analyzedAt} | Sources: ${escapeHtml(sourceList)}</p>
  <p>Multi-source synthesis powered by Claude Sonnet 4.6 • Data from Reddit, loc8nearme.com, shop website</p>
</div>

</body>
</html>`;
}

async function main() {
  const args = parseArgs();
  const shopId = args['shop-id'];
  if (!shopId) { console.error('Usage: node generate_review_pdf.js --shop-id "uuid"'); process.exit(1); }

  const analysisPath = contentDir(shopId, 'reviews', 'analysis.json');
  const analysis = loadJSON(analysisPath);
  if (!analysis) { console.error('No analysis found. Run summarize_reviews.js first.'); process.exit(1); }

  // Get shop info from supabase
  const { data: shop } = await supabase.from('shops').select('name, city, state, slug').eq('id', shopId).single();
  if (!shop) { console.error('Shop not found'); process.exit(1); }

  const html = generateHtml(analysis, shop.name, shop.city, shop.state);
  
  const outDir = contentDir(shopId, 'reviews');
  const htmlPath = path.join(outDir, 'review_report.html');
  const pdfPath = path.join(outDir, `${shop.slug || 'review'}_aggregate_review.pdf`);
  
  fs.writeFileSync(htmlPath, html);
  console.log(`HTML written to ${htmlPath}`);
  console.log(`PDF path: ${pdfPath}`);
  console.log(`HTML_PATH=${htmlPath}`);
  console.log(`PDF_PATH=${pdfPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
