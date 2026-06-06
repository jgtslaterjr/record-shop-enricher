#!/usr/bin/env node
/**
 * Extract Fields — Post-scrape field extraction from all scraped content
 * 
 * Reads scraped content from content/{shopId}/ and fills empty DB fields.
 * Only fills NULL fields — never overwrites existing data.
 * 
 * Extracts:
 * - phone: from website scrape phoneMatches
 * - owner_name: from about pages with "owned by", "founder", etc.
 * - description: from meta description or homepage tagline
 * 
 * Usage:
 *   node extract_fields.js --shop-id "uuid"
 *   node extract_fields.js --all
 *   node extract_fields.js --all --limit 50
 */

const { supabase, loadJSON, contentDir, getAllShops, updateShop,
  parseArgs, log } = require('./lib/common');
const fs = require('fs');
const path = require('path');

// ── Field Extraction Functions ────────────────────────────

function extractPhone(pages) {
  if (!pages || !Array.isArray(pages)) return null;
  
  // Collect all phone numbers from all pages
  const allPhones = [];
  for (const page of pages) {
    if (page.phones && Array.isArray(page.phones)) {
      allPhones.push(...page.phones);
    }
  }
  
  if (allPhones.length === 0) return null;
  
  // Clean and validate phone numbers
  const cleanPhones = allPhones
    .map(p => p.replace(/\D/g, '')) // Remove non-digits
    .filter(p => p.length === 10 || p.length === 11) // Valid US phone
    .map(p => {
      // Format as (XXX) XXX-XXXX
      if (p.length === 11 && p.startsWith('1')) p = p.slice(1);
      if (p.length === 10) {
        return `(${p.slice(0, 3)}) ${p.slice(3, 6)}-${p.slice(6)}`;
      }
      return null;
    })
    .filter(Boolean);
  
  return cleanPhones.length > 0 ? cleanPhones[0] : null;
}

function extractOwnerName(pages) {
  if (!pages || !Array.isArray(pages)) return null;
  
  // Focus on about and staff pages
  const relevantPages = pages.filter(p => 
    p.pageType === 'about' || p.pageType === 'staff' || p.pageType === 'homepage'
  );
  
  for (const page of relevantPages) {
    if (!page.text) continue;
    
    const text = page.text;
    
    // Pattern 1: "owned by NAME" or "owner: NAME"
    const ownedByMatch = text.match(/owned\s+by\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/i);
    if (ownedByMatch) return ownedByMatch[1].trim();
    
    const ownerMatch = text.match(/owner:\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/i);
    if (ownerMatch) return ownerMatch[1].trim();
    
    // Pattern 2: "founded by NAME" or "founder: NAME"
    const foundedByMatch = text.match(/founded\s+by\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/i);
    if (foundedByMatch) return foundedByMatch[1].trim();
    
    const founderMatch = text.match(/founder:\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/i);
    if (founderMatch) return founderMatch[1].trim();
    
    // Pattern 3: "proprietor: NAME" or "proprietor NAME"
    const proprietorMatch = text.match(/proprietor:\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/i);
    if (proprietorMatch) return proprietorMatch[1].trim();
    
    // Pattern 4: Look for "owner" or "founder" near a person's name
    const ownerContextMatch = text.match(/([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)[\s,]*(?:is\s+the\s+)?(?:owner|founder|proprietor)/i);
    if (ownerContextMatch) return ownerContextMatch[1].trim();
    
    // Pattern 5: Check structured data for founder
    if (page.structuredData && Array.isArray(page.structuredData)) {
      for (const sd of page.structuredData) {
        if (sd['@type'] === 'LocalBusiness' || sd['@type'] === 'Store') {
          if (sd.founder && typeof sd.founder === 'string') {
            return sd.founder;
          }
          if (sd.founder && sd.founder.name) {
            return sd.founder.name;
          }
        }
      }
    }
  }
  
  return null;
}

function extractDescription(pages) {
  if (!pages || !Array.isArray(pages)) return null;
  
  // Try to find homepage
  const homepage = pages.find(p => p.pageType === 'homepage');
  
  if (homepage) {
    // Check for meta description in structured data
    if (homepage.structuredData && Array.isArray(homepage.structuredData)) {
      for (const sd of homepage.structuredData) {
        if (sd.description && typeof sd.description === 'string' && sd.description.length > 20) {
          return sd.description.slice(0, 500);
        }
      }
    }
    
    // Use h1 as tagline if short enough
    if (homepage.h1 && homepage.h1.length < 200 && homepage.h1.length > 10) {
      return homepage.h1;
    }
    
    // Use first sentence or two from homepage text
    if (homepage.text) {
      const sentences = homepage.text.match(/[^.!?]+[.!?]+/g);
      if (sentences && sentences.length > 0) {
        const desc = sentences.slice(0, 2).join(' ').trim();
        if (desc.length > 20 && desc.length < 500) {
          return desc;
        }
      }
    }
  }
  
  // Fallback: look for about page
  const aboutPage = pages.find(p => p.pageType === 'about');
  if (aboutPage && aboutPage.text) {
    const sentences = aboutPage.text.match(/[^.!?]+[.!?]+/g);
    if (sentences && sentences.length > 0) {
      const desc = sentences.slice(0, 2).join(' ').trim();
      if (desc.length > 20 && desc.length < 500) {
        return desc;
      }
    }
  }
  
  return null;
}

// ── Main Extraction Function ──────────────────────────────

async function extractFieldsForShop(shop) {
  log(`\n📊 Extracting fields for: ${shop.name} (${shop.city}, ${shop.state})`);
  
  const updates = {};
  const extracted = {};
  
  // Load website scrape data
  const websiteDir = contentDir(shop.id, 'web');
  let pages = null;
  
  if (fs.existsSync(websiteDir)) {
    // Find the most recent crawl directory
    const crawls = fs.readdirSync(websiteDir)
      .filter(f => f.startsWith('crawl_'))
      .sort()
      .reverse();
    
    if (crawls.length > 0) {
      const latestCrawl = path.join(websiteDir, crawls[0]);
      const pagesFile = path.join(latestCrawl, 'pages.json');
      
      if (fs.existsSync(pagesFile)) {
        pages = loadJSON(pagesFile);
        log(`  Found ${pages?.length || 0} pages from website crawl`);
      }
    }
  }
  
  // Extract phone
  if (!shop.phone || shop.phone === '') {
    const phone = extractPhone(pages);
    if (phone) {
      updates.phone = phone;
      extracted.phone = phone;
      log(`  📞 Extracted phone: ${phone}`);
    }
  }
  
  // Extract owner name
  if (!shop.owner_name || shop.owner_name === '') {
    const ownerName = extractOwnerName(pages);
    if (ownerName) {
      updates.owner_name = ownerName;
      extracted.owner_name = ownerName;
      log(`  👤 Extracted owner: ${ownerName}`);
    }
  }
  
  // Extract description
  if (!shop.description || shop.description === '') {
    const description = extractDescription(pages);
    if (description) {
      updates.description = description;
      extracted.description = description;
      log(`  📝 Extracted description: ${description.slice(0, 100)}...`);
    }
  }
  
  // Apply updates to database
  if (Object.keys(updates).length > 0) {
    log(`  💾 Updating ${Object.keys(updates).length} field(s) in database...`);
    await updateShop(shop.id, updates);
    log(`  ✓ Database updated`);
  } else {
    log(`  ℹ  No empty fields to fill`);
  }
  
  return { extracted, updates };
}

// ── CLI Entry Point ───────────────────────────────────────

async function main() {
  const args = parseArgs();
  
  if (args.all) {
    const limit = args.limit ? parseInt(args.limit) : null;
    const shops = await getAllShops(limit);
    log(`\n📊 Batch field extraction for ${shops.length} shops\n`);
    
    let updated = 0;
    let fieldsExtracted = 0;
    
    for (let i = 0; i < shops.length; i++) {
      const shop = shops[i];
      log(`\n[${i + 1}/${shops.length}] ${shop.name}`);
      
      try {
        const result = await extractFieldsForShop(shop);
        if (Object.keys(result.updates).length > 0) {
          updated++;
          fieldsExtracted += Object.keys(result.updates).length;
        }
      } catch (e) {
        log(`  ❌ Error: ${e.message}`);
      }
    }
    
    log(`\n✅ Batch complete: ${updated}/${shops.length} shops updated, ${fieldsExtracted} fields extracted`);
    return;
  }
  
  if (args['shop-id']) {
    const { data, error } = await supabase.from('shops').select('*').eq('id', args['shop-id']).single();
    if (error || !data) {
      log(`❌ Shop not found: ${args['shop-id']}`);
      process.exit(1);
    }
    
    await extractFieldsForShop(data);
    return;
  }
  
  console.log('\nUsage:');
  console.log('  node extract_fields.js --shop-id "uuid"');
  console.log('  node extract_fields.js --all');
  console.log('  node extract_fields.js --all --limit 50');
  process.exit(0);
}

if (require.main === module) {
  main().catch(e => {
    console.error('❌ Fatal:', e.message);
    process.exit(1);
  });
}

module.exports = { extractFieldsForShop };
