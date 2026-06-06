#!/usr/bin/env node
const puppeteer = require('puppeteer');
const path = require('path');

async function main() {
  const htmlPath = process.argv[2];
  const pdfPath = process.argv[3];
  if (!htmlPath || !pdfPath) { console.error('Usage: node html_to_pdf.js <html> <pdf>'); process.exit(1); }
  
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.goto('file://' + path.resolve(htmlPath), { waitUntil: 'networkidle0' });
  await page.pdf({ path: pdfPath, format: 'Letter', printBackground: true, margin: { top: '0.75in', bottom: '0.75in', left: '0.75in', right: '0.75in' } });
  await browser.close();
  console.log(`PDF saved: ${pdfPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
