#!/usr/bin/env node
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

// Simple markdown to HTML converter (no external deps)
function mdToHtml(md) {
  let html = md;
  // Code blocks
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>');
  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Headers
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Italic
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  // Horizontal rules
  html = html.replace(/^---$/gm, '<hr>');
  // Unordered lists
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');
  // Ordered lists
  html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
  // Paragraphs
  html = html.replace(/^(?!<[hulop]|<\/|<pre|<code|<hr|<li|<strong)(.+)$/gm, '<p>$1</p>');
  // Clean up double newlines
  html = html.replace(/\n{2,}/g, '\n');
  return html;
}

async function main() {
  const md = fs.readFileSync(path.join(__dirname, 'ENRICHMENT_PIPELINE.md'), 'utf-8');
  const body = mdToHtml(md);
  
  const fullHtml = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  @page { margin: 1in 0.8in; }
  body { font-family: 'Segoe UI', Helvetica, Arial, sans-serif; font-size: 11pt; line-height: 1.6; color: #1a1a1a; max-width: 100%; }
  h1 { font-size: 22pt; color: #111; border-bottom: 3px solid #333; padding-bottom: 8px; margin-top: 0; }
  h2 { font-size: 15pt; color: #222; border-bottom: 1px solid #ccc; padding-bottom: 4px; margin-top: 28px; page-break-after: avoid; }
  h3 { font-size: 12pt; color: #333; margin-top: 18px; }
  p { margin: 6px 0; }
  ul { margin: 6px 0; padding-left: 24px; }
  li { margin: 3px 0; }
  code { background: #f4f4f4; padding: 1px 4px; border-radius: 3px; font-size: 10pt; }
  pre { background: #f4f4f4; padding: 12px; border-radius: 4px; font-size: 9pt; overflow-x: auto; white-space: pre; }
  pre code { background: none; padding: 0; }
  hr { border: none; border-top: 1px solid #ddd; margin: 20px 0; }
  strong { color: #111; }
</style>
</head><body>${body}</body></html>`;

  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setContent(fullHtml, { waitUntil: 'networkidle0' });
  
  const outPath = path.join(__dirname, 'Enrichment_Pipeline.pdf');
  await page.pdf({
    path: outPath,
    format: 'Letter',
    printBackground: true,
    margin: { top: '0.8in', bottom: '0.8in', left: '0.8in', right: '0.8in' },
  });
  
  await browser.close();
  console.log(`PDF saved: ${outPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
