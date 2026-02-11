#!/usr/bin/env node

const http = require('http');
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { enrichSocial } = require('./enrich_social.js');

const SUPABASE_URL = "https://oytflcaqukxvzmbddrlg.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im95dGZsY2FxdWt4dnptYmRkcmxnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY5NTIwMjQsImV4cCI6MjA4MjUyODAyNH0.YpFZfu2BPxwXxXz5j-xqgu7VdIuTP315eiS3UuLD2wo";
const PORT = 3456;

// Active enrichment processes
const activeEnrichments = new Map();

function deleteShop(shopId) {
  try {
    execSync(`curl -s -X DELETE "${SUPABASE_URL}/rest/v1/shops?id=eq.${shopId}" \
      -H "apikey: ${SUPABASE_KEY}" \
      -H "Authorization: Bearer ${SUPABASE_KEY}"`,
      { encoding: 'utf8' }
    );
    return true;
  } catch (error) {
    console.error("Error deleting shop:", error.message);
    return false;
  }
}

function updateShop(shopId, updates) {
  console.log('Updating shop:', shopId, 'with data:', JSON.stringify(updates, null, 2));
  
  // Check if we're trying to update the name
  if ('name' in updates) {
    console.log('Name update detected:', updates.name);
  }
  
  try {
    // Write JSON to temp file to avoid shell escaping issues
    const tempFile = `/tmp/shop-update-${shopId}.json`;
    fs.writeFileSync(tempFile, JSON.stringify(updates));
    
    const result = execSync(`curl -s -X PATCH "${SUPABASE_URL}/rest/v1/shops?id=eq.${shopId}" \
      -H "apikey: ${SUPABASE_KEY}" \
      -H "Authorization: Bearer ${SUPABASE_KEY}" \
      -H "Content-Type: application/json" \
      -H "Prefer: return=representation" \
      -d @${tempFile}`,
      { encoding: 'utf8' }
    );
    
    // Clean up temp file
    try { fs.unlinkSync(tempFile); } catch (e) {}
    
    console.log('Supabase update response:', result);
    
    // Check if response is an error
    if (!result || result.trim() === '') {
      console.error('Empty response from Supabase');
      return false;
    }
    
    const parsed = JSON.parse(result);
    
    // Check for error response
    if (parsed.code || parsed.error || parsed.message) {
      console.error('Supabase update error:', parsed);
      return false;
    }
    
    // Check if array with data was returned
    if (Array.isArray(parsed) && parsed.length > 0) {
      console.log('Update successful, returned:', parsed[0]);
      return true;
    }
    
    console.log('Update completed');
    return true;
  } catch (error) {
    console.error("Error updating shop:", error.message, error.stack);
    return false;
  }
}

function fetchShops() {
  // Always fetch all shops, filter client-side
  let url = `${SUPABASE_URL}/rest/v1/shops?select=id,name,city,state,neighborhood,website,phone,address,social_instagram,social_facebook,social_tiktok,enrichment_status,date_of_enrichment&order=name&limit=1000`;
  
  console.log(`Fetching all shops from database`);
  
  try {
    const result = execSync(`curl -s "${url}" \
      -H "apikey: ${SUPABASE_KEY}" \
      -H "Authorization: Bearer ${SUPABASE_KEY}" \
      -H "Prefer: return=representation"`, 
      { encoding: 'utf8' }
    );
    
    const parsed = JSON.parse(result);
    
    // Check if it's an error response
    if (parsed.message || parsed.error || parsed.code) {
      console.error("Supabase error:", parsed);
      return [];
    }
    
    console.log(`Fetched ${parsed.length} shops`);
    return parsed;
  } catch (error) {
    console.error("Error fetching shops:", error.message);
    return [];
  }
}

function updateShopStatus(shopId, socialData = null) {
  const now = new Date().toISOString();
  const updateData = {
    enrichment_status: 'enriched',
    date_of_enrichment: now
  };
  
  // Add social media data if provided
  if (socialData) {
    if (socialData.social_profiles?.instagram) {
      updateData.social_instagram = socialData.social_profiles.instagram.url;
    }
    if (socialData.social_profiles?.facebook) {
      updateData.social_facebook = socialData.social_profiles.facebook.url;
    }
    if (socialData.social_profiles?.tiktok) {
      updateData.social_tiktok = socialData.social_profiles.tiktok.url;
    }
  }
  
  try {
    execSync(`curl -s -X PATCH "${SUPABASE_URL}/rest/v1/shops?id=eq.${shopId}" \
      -H "apikey: ${SUPABASE_KEY}" \
      -H "Authorization: Bearer ${SUPABASE_KEY}" \
      -H "Content-Type: application/json" \
      -d '${JSON.stringify(updateData)}'`,
      { encoding: 'utf8' }
    );
    return true;
  } catch (error) {
    console.error("Error updating shop:", error.message);
    return false;
  }
}

function enrichShop(shopId, shopName, website) {
  return new Promise((resolve, reject) => {
    if (!website || website.includes('yelp.com')) {
      reject(new Error('No valid website URL (Yelp URLs cannot be crawled)'));
      return;
    }
    
    const process = spawn('node', ['enrich_shop_v2.js', shopName, website], {
      cwd: __dirname
    });
    
    let output = '';
    let errorOutput = '';
    
    process.stdout.on('data', (data) => {
      output += data.toString();
    });
    
    process.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });
    
    process.on('close', (code) => {
      if (code === 0) {
        updateShopStatus(shopId);
        resolve(output);
      } else {
        reject(new Error(errorOutput || 'Enrichment failed'));
      }
    });
    
    activeEnrichments.set(shopId, { process, output: '', startTime: Date.now() });
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }
  
  // API: Get shops
  if (url.pathname === '/api/shops') {
    const filter = url.searchParams.get('filter') || 'all';
    let shops = fetchShops();
    
    // Filter client-side based on enrichment_status
    if (filter === 'enriched') {
      shops = shops.filter(s => s.enrichment_status === 'enriched');
    } else if (filter === 'unenriched') {
      shops = shops.filter(s => !s.enrichment_status || s.enrichment_status !== 'enriched');
    }
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(shops));
    return;
  }
  
  // API: Cancel enrichment
  if (url.pathname === '/api/cancel' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { shopId } = JSON.parse(body);
        const enrichment = activeEnrichments.get(shopId);
        
        if (enrichment && enrichment.process) {
          enrichment.process.kill('SIGTERM');
          activeEnrichments.delete(shopId);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'No active enrichment found' }));
        }
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: error.message }));
      }
    });
    return;
  }
  
  // API: Delete shop
  if (url.pathname === '/api/delete' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { shopId } = JSON.parse(body);
        const success = deleteShop(shopId);
        res.writeHead(success ? 200 : 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: error.message }));
      }
    });
    return;
  }
  
  // API: Update shop
  if (url.pathname === '/api/update' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { shopId, updates } = JSON.parse(body);
        const success = updateShop(shopId, updates);
        res.writeHead(success ? 200 : 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: error.message }));
      }
    });
    return;
  }
  
  // API: Enrich social media
  if (url.pathname === '/api/enrich-social' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { shopId, shopName, website, socialInstagram, socialFacebook, socialTiktok, neighborhood, city, state } = JSON.parse(body);
        
        // Set up SSE-like streaming
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive'
        });
        
        // Capture console output
        const originalLog = console.log;
        const outputBuffer = [];
        
        console.log = (...args) => {
          const text = args.join(' ') + '\n';
          outputBuffer.push(text);
          res.write(`data: ${JSON.stringify({ type: 'output', text })}\n\n`);
          originalLog(...args);
        };
        
        // Send location context header
        let locationInfo = '';
        if (neighborhood) {
          locationInfo = `🎯 Location Context: ${neighborhood}, ${city}, ${state}\n`;
        } else if (city) {
          locationInfo = `🎯 Location Context: ${city}, ${state}\n`;
        }
        if (locationInfo) {
          locationInfo += `\n⚠️  NOTE: Social media accounts may be:\n`;
          locationInfo += `   • Shared across all locations (e.g., @amoebamusic for all stores)\n`;
          locationInfo += `   • Location-specific (e.g., @amoebaberkeley)\n`;
          locationInfo += `\nThe enrichment will attempt to identify which type.\n\n`;
          res.write(`data: ${JSON.stringify({ type: 'output', text: locationInfo })}\n\n`);
        }
        
        try {
          const existingSocial = {
            instagram: socialInstagram || null,
            facebook: socialFacebook || null,
            tiktok: socialTiktok || null
          };
          
          const locationContext = {
            neighborhood: neighborhood || null,
            city: city || null,
            state: state || null
          };
          
          const socialData = await enrichSocial(shopName, existingSocial, website, locationContext);
          
          // Restore console.log
          console.log = originalLog;
          
          // Update database with social data
          updateShopStatus(shopId, socialData);
          
          res.write(`data: ${JSON.stringify({ type: 'complete', success: true })}\n\n`);
          res.end();
        } catch (error) {
          console.log = originalLog;
          res.write(`data: ${JSON.stringify({ type: 'complete', success: false, error: error.message })}\n\n`);
          res.end();
        }
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: error.message }));
      }
    });
    return;
  }
  
  // API: Enrich shop (web)
  if (url.pathname === '/api/enrich' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { shopId, shopName, website, neighborhood, city, state, address } = JSON.parse(body);
        
        if (!website || website.includes('yelp.com')) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'No valid website URL (Yelp URLs cannot be crawled)' }));
          return;
        }
        
        // Set up SSE-like streaming
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive'
        });
        
        // Add location context to environment
        const locationEnv = {
          ...process.env,
          LOCATION_NEIGHBORHOOD: neighborhood || '',
          LOCATION_CITY: city || '',
          LOCATION_STATE: state || '',
          LOCATION_ADDRESS: address || ''
        };
        
        // Send location context header
        let locationInfo = '';
        if (neighborhood) {
          locationInfo = `🎯 Location Context: ${neighborhood}, ${city}, ${state}\n`;
        } else if (city) {
          locationInfo = `🎯 Location Context: ${city}, ${state}\n`;
        }
        if (address) {
          locationInfo += `📍 Address: ${address}\n`;
        }
        if (locationInfo) {
          locationInfo += `⚠️  Multi-location shop detected. Extracting data for THIS location only.\n\n`;
          res.write(`data: ${JSON.stringify({ type: 'output', text: locationInfo })}\n\n`);
        }
        
        const enrichProcess = spawn('node', ['enrich_shop_v2.js', shopName, website], {
          cwd: __dirname,
          env: locationEnv
        });
        
        // Track active process
        activeEnrichments.set(shopId, { process: enrichProcess, startTime: Date.now() });
        
        let allOutput = '';
        
        enrichProcess.stdout.on('data', (data) => {
          const text = data.toString();
          allOutput += text;
          res.write(`data: ${JSON.stringify({ type: 'output', text })}\n\n`);
        });
        
        enrichProcess.stderr.on('data', (data) => {
          const text = data.toString();
          allOutput += text;
          res.write(`data: ${JSON.stringify({ type: 'output', text })}\n\n`);
        });
        
        enrichProcess.on('close', (code) => {
          activeEnrichments.delete(shopId);
          
          if (code === 0) {
            updateShopStatus(shopId);
            res.write(`data: ${JSON.stringify({ type: 'complete', success: true })}\n\n`);
          } else if (code === null || code === 143 || code === 15) {
            // SIGTERM or killed
            res.write(`data: ${JSON.stringify({ type: 'complete', success: false, error: 'Cancelled by user' })}\n\n`);
          } else {
            res.write(`data: ${JSON.stringify({ type: 'complete', success: false, error: 'Enrichment failed' })}\n\n`);
          }
          res.end();
        });
        
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: error.message }));
      }
    });
    return;
  }
  
  // Serve HTML UI
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Record Shop Enricher</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='0.9em' font-size='90'>🪙</text></svg>">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      padding: 20px;
    }
    .container {
      max-width: 1400px;
      margin: 0 auto;
    }
    .header {
      text-align: center;
      color: white;
      margin-bottom: 30px;
    }
    .header h1 {
      font-size: 2.5em;
      margin-bottom: 10px;
    }
    .header p {
      font-size: 1.1em;
      opacity: 0.9;
    }
    .controls {
      background: white;
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 20px;
      box-shadow: 0 4px 6px rgba(0,0,0,0.1);
    }
    .filters {
      display: flex;
      gap: 10px;
      align-items: center;
      flex-wrap: wrap;
    }
    .search-box {
      flex: 1;
      min-width: 250px;
      max-width: 400px;
    }
    .search-box input {
      width: 100%;
      padding: 10px 15px;
      border: 2px solid #ddd;
      border-radius: 8px;
      font-size: 1em;
      transition: border-color 0.2s;
    }
    .search-box input:focus {
      outline: none;
      border-color: #667eea;
    }
    .search-box input::placeholder {
      color: #999;
    }
    .filter-btn {
      padding: 10px 20px;
      border: 2px solid #667eea;
      background: white;
      border-radius: 8px;
      cursor: pointer;
      font-size: 1em;
      transition: all 0.2s;
    }
    .filter-btn:hover {
      background: #f0f0f0;
    }
    .filter-btn.active {
      background: #667eea;
      color: white;
    }
    .stats {
      margin-left: auto;
      font-size: 1.1em;
      color: #666;
    }
    .shop-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(350px, 1fr));
      gap: 20px;
    }
    .shop-card {
      background: white;
      border-radius: 12px;
      padding: 20px;
      box-shadow: 0 4px 6px rgba(0,0,0,0.1);
      transition: transform 0.2s, box-shadow 0.2s;
    }
    .shop-card:hover {
      transform: translateY(-4px);
      box-shadow: 0 8px 12px rgba(0,0,0,0.15);
    }
    .shop-header {
      display: flex;
      justify-content: space-between;
      align-items: start;
      margin-bottom: 12px;
    }
    .shop-name {
      font-size: 1.2em;
      font-weight: bold;
      color: #333;
      flex: 1;
      line-height: 1.3;
    }
    .shop-status {
      font-size: 1.5em;
      margin-left: 10px;
    }
    .shop-info {
      color: #666;
      margin-bottom: 8px;
      font-size: 0.95em;
    }
    .shop-website {
      color: #667eea;
      text-decoration: none;
      font-size: 0.9em;
      display: block;
      margin-bottom: 12px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .shop-website:hover {
      text-decoration: underline;
    }
    .enrich-btn {
      width: 100%;
      padding: 12px;
      border: none;
      border-radius: 8px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      font-size: 1em;
      font-weight: bold;
      cursor: pointer;
      transition: opacity 0.2s;
    }
    .enrich-social-btn {
      width: 100%;
      padding: 12px;
      margin-top: 8px;
      border: none;
      border-radius: 8px;
      background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
      color: white;
      font-size: 1em;
      font-weight: bold;
      cursor: pointer;
      transition: opacity 0.2s;
    }
    .enrich-btn:hover:not(:disabled) {
      opacity: 0.9;
    }
    .enrich-btn:disabled {
      background: #ccc;
      cursor: not-allowed;
    }
    .enrich-btn.enriching {
      background: #f59e0b;
      animation: pulse 2s infinite;
    }
    .delete-btn {
      width: 100%;
      padding: 10px;
      margin-top: 8px;
      border: 2px solid #ef4444;
      border-radius: 8px;
      background: white;
      color: #ef4444;
      font-size: 0.9em;
      font-weight: bold;
      cursor: pointer;
      transition: all 0.2s;
    }
    .delete-btn:hover {
      background: #ef4444;
      color: white;
    }
    .modal-actions {
      display: flex;
      gap: 10px;
      margin-top: 15px;
    }
    .modal-btn {
      padding: 10px 20px;
      border: none;
      border-radius: 8px;
      font-size: 1em;
      font-weight: bold;
      cursor: pointer;
      transition: opacity 0.2s;
    }
    .modal-btn:hover {
      opacity: 0.9;
    }
    .cancel-btn {
      background: #ef4444;
      color: white;
    }
    .close-modal-btn {
      background: #667eea;
      color: white;
    }
    .edit-btn {
      width: 100%;
      padding: 10px;
      margin-top: 8px;
      border: 2px solid #667eea;
      border-radius: 8px;
      background: white;
      color: #667eea;
      font-size: 0.9em;
      font-weight: bold;
      cursor: pointer;
      transition: all 0.2s;
    }
    .edit-btn:hover {
      background: #667eea;
      color: white;
    }
    .form-group {
      margin-bottom: 15px;
    }
    .form-group label {
      display: block;
      margin-bottom: 5px;
      font-weight: bold;
      color: #333;
    }
    .form-group input {
      width: 100%;
      padding: 10px;
      border: 2px solid #ddd;
      border-radius: 8px;
      font-size: 1em;
    }
    .form-group input:focus {
      outline: none;
      border-color: #667eea;
    }
    .save-btn {
      background: #10b981;
      color: white;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.7; }
    }
    .enriched {
      border: 2px solid #10b981;
    }
    .no-website {
      opacity: 0.6;
    }
    .loading {
      text-align: center;
      color: white;
      font-size: 1.5em;
      padding: 60px;
    }
    .modal {
      display: none;
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0,0,0,0.7);
      z-index: 1000;
      align-items: center;
      justify-content: center;
    }
    .modal.active {
      display: flex;
    }
    .modal-content {
      background: white;
      border-radius: 12px;
      padding: 30px;
      max-width: 90%;
      width: 800px;
      max-height: 80vh;
      display: flex;
      flex-direction: column;
      box-shadow: 0 10px 25px rgba(0,0,0,0.3);
    }
    .modal-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 20px;
      padding-bottom: 15px;
      border-bottom: 2px solid #eee;
    }
    .modal-header h2 {
      color: #333;
    }
    .close-btn {
      background: none;
      border: none;
      font-size: 2em;
      cursor: pointer;
      color: #666;
      line-height: 1;
    }
    .close-btn:hover {
      color: #333;
    }
    .output {
      font-family: 'Courier New', monospace;
      white-space: pre-wrap;
      background: #f5f5f5;
      padding: 20px;
      border-radius: 8px;
      font-size: 0.9em;
      line-height: 1.5;
      flex: 1;
      overflow-y: auto;
      min-height: 200px;
      max-height: 60vh;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🎵 Record Shop Enricher</h1>
      <p>Tier 1: Web Intelligence • Tier 2: Social Media • v 2.3.8</p>
    </div>
    
    <div class="controls">
      <div class="filters">
        <div class="search-box">
          <input type="text" id="search" placeholder="🔍 Search shops by name, city, or neighborhood..." />
        </div>
        <button class="filter-btn active" data-filter="all">All Shops</button>
        <button class="filter-btn" data-filter="unenriched">Unenriched</button>
        <button class="filter-btn" data-filter="enriched">Enriched</button>
        <div class="stats" id="stats"></div>
      </div>
    </div>
    
    <div id="shops" class="shop-grid">
      <div class="loading">Loading shops...</div>
    </div>
  </div>
  
  <div id="modal" class="modal">
    <div class="modal-content">
      <div class="modal-header">
        <h2 id="modal-title">Enrichment Progress</h2>
        <button class="close-btn" onclick="closeModal()">&times;</button>
      </div>
      <div id="modal-body" class="output"></div>
      <div class="modal-actions" id="modal-actions">
        <button class="modal-btn cancel-btn" id="cancel-btn" onclick="cancelEnrichment()">⏹️ Stop Enrichment</button>
        <button class="modal-btn close-modal-btn" onclick="closeModal()">Close</button>
      </div>
    </div>
  </div>
  
  <div id="edit-modal" class="modal">
    <div class="modal-content">
      <div class="modal-header">
        <h2>✏️ Edit Shop Details</h2>
        <button class="close-btn" onclick="closeEditModal()">&times;</button>
      </div>
      <div style="padding: 10px 0;">
        <div class="form-group">
          <label for="edit-name">Shop Name</label>
          <input type="text" id="edit-name" />
        </div>
        <div class="form-group">
          <label for="edit-website">Website URL</label>
          <input type="url" id="edit-website" placeholder="https://example.com" />
        </div>
        <div class="form-group">
          <label for="edit-phone">Phone</label>
          <input type="tel" id="edit-phone" />
        </div>
        <div class="form-group">
          <label for="edit-address">Address</label>
          <input type="text" id="edit-address" />
        </div>
        <div class="form-group">
          <label for="edit-city">City</label>
          <input type="text" id="edit-city" />
        </div>
        <div class="form-group">
          <label for="edit-neighborhood">Neighborhood</label>
          <input type="text" id="edit-neighborhood" placeholder="e.g., Hollywood, Berkeley" />
        </div>
        <div class="form-group">
          <label for="edit-state">State</label>
          <input type="text" id="edit-state" />
        </div>
        <hr style="margin: 20px 0; border: none; border-top: 2px solid #eee;">
        <h3 style="margin-bottom: 15px; color: #667eea;">Social Media</h3>
        <div class="form-group">
          <label for="edit-instagram">Instagram Username</label>
          <input type="text" id="edit-instagram" placeholder="username (without @)" />
        </div>
        <div class="form-group">
          <label for="edit-facebook">Facebook Page ID</label>
          <input type="text" id="edit-facebook" placeholder="pagename or page-id" />
        </div>
        <div class="form-group">
          <label for="edit-tiktok">TikTok Username</label>
          <input type="text" id="edit-tiktok" placeholder="username (without @)" />
        </div>
      </div>
      <div class="modal-actions">
        <button class="modal-btn save-btn" onclick="saveShopEdit()">💾 Save Changes</button>
        <button class="modal-btn close-modal-btn" onclick="closeEditModal()">Cancel</button>
      </div>
    </div>
  </div>
  
  <script>
    let currentFilter = 'all';
    let searchQuery = '';
    let shops = [];
    let currentEnrichmentShopId = null;
    let currentEditShop = null;
    
    async function loadShops() {
      try {
        console.log('Loading shops with filter:', currentFilter);
        const response = await fetch('/api/shops?filter=' + currentFilter);
        shops = await response.json();
        console.log('Loaded ' + shops.length + ' shops');
        renderShops();
      } catch (error) {
        console.error('Error loading shops:', error);
        document.getElementById('shops').innerHTML = '<div class="loading">Error loading shops</div>';
      }
    }
    
    function escapeHtml(text) {
      if (!text) return '';
      return text.toString().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
    }
    
    function renderShops() {
      const container = document.getElementById('shops');
      
      // Apply search filter
      let filteredShops = shops;
      if (searchQuery) {
        const query = searchQuery.toLowerCase();
        filteredShops = shops.filter(shop => {
          const name = (shop.name || '').toLowerCase();
          const city = (shop.city || '').toLowerCase();
          const state = (shop.state || '').toLowerCase();
          const neighborhood = (shop.neighborhood || '').toLowerCase();
          
          return name.includes(query) || 
                 city.includes(query) || 
                 state.includes(query) || 
                 neighborhood.includes(query);
        });
      }
      
      const enrichedCount = filteredShops.filter(s => s.enrichment_status === 'enriched').length;
      const totalEnriched = shops.filter(s => s.enrichment_status === 'enriched').length;
      
      if (searchQuery) {
        document.getElementById('stats').textContent = filteredShops.length + ' of ' + shops.length + ' shops (' + enrichedCount + ' enriched)';
      } else {
        document.getElementById('stats').textContent = shops.length + ' shops (' + totalEnriched + ' enriched)';
      }
      
      if (filteredShops.length === 0) {
        container.innerHTML = '<div class="loading">No shops found</div>';
        return;
      }
      
      // Store all shop data globally
      window.shopData = window.shopData || {};
      filteredShops.forEach(shop => {
        window.shopData[shop.id] = shop;
      });
      
      container.innerHTML = filteredShops.map((shop, index) => {
        const isEnriched = shop.enrichment_status === 'enriched';
        const hasWebsite = shop.website && !shop.website.includes('yelp.com');
        const status = isEnriched ? '✓' : '○';
        const cardClass = isEnriched ? 'shop-card enriched' : (hasWebsite ? 'shop-card' : 'shop-card no-website');
        
        const websiteLink = shop.website 
          ? '<a href="' + escapeHtml(shop.website) + '" target="_blank" class="shop-website">' + escapeHtml(shop.website) + '</a>'
          : '<div class="shop-info">No website</div>';
          
        const enrichedDate = shop.date_of_enrichment 
          ? '<div class="shop-info" style="font-size: 0.85em; color: #999;">Enriched: ' + new Date(shop.date_of_enrichment).toLocaleDateString() + '</div>'
          : '';
          
        const locationText = shop.neighborhood 
          ? escapeHtml(shop.neighborhood) + ', ' + escapeHtml(shop.city) + ', ' + escapeHtml(shop.state)
          : escapeHtml(shop.city) + ', ' + escapeHtml(shop.state);
        
        return '<div class="' + cardClass + '">' +
          '<div class="shop-header">' +
            '<div class="shop-name">' + escapeHtml(shop.name) + '</div>' +
            '<div class="shop-status">' + status + '</div>' +
          '</div>' +
          '<div class="shop-info">📍 ' + locationText + '</div>' +
          websiteLink +
          enrichedDate +
          '<button class="enrich-btn" data-shop-id="' + escapeHtml(shop.id) + '" ' +
            (hasWebsite ? '' : 'disabled ') +
            'id="btn-' + shop.id + '">' +
            (!hasWebsite ? '⚠️ No Valid URL' : (isEnriched ? '🔄 Re-enrich Web' : '🚀 Enrich Now')) +
          '</button>' +
          '<button class="enrich-social-btn" data-shop-id="' + escapeHtml(shop.id) + '" id="btn-social-' + shop.id + '">' +
            '📱 Enrich Social' +
          '</button>' +
          '<button class="edit-btn" data-shop-id="' + escapeHtml(shop.id) + '">' +
            '✏️ Edit Details' +
          '</button>' +
          '<button class="delete-btn" data-shop-id="' + escapeHtml(shop.id) + '">' +
            '🗑️ Remove from Database' +
          '</button>' +
        '</div>';
      }).join('');
      
      // Attach event listeners using event delegation
      container.querySelectorAll('.enrich-btn').forEach(btn => {
        btn.addEventListener('click', function() {
          const shopId = this.getAttribute('data-shop-id');
          enrichShop(window.shopData[shopId]);
        });
      });
      
      container.querySelectorAll('.enrich-social-btn').forEach(btn => {
        btn.addEventListener('click', function() {
          const shopId = this.getAttribute('data-shop-id');
          enrichSocial(window.shopData[shopId]);
        });
      });
      
      container.querySelectorAll('.edit-btn').forEach(btn => {
        btn.addEventListener('click', function() {
          const shopId = this.getAttribute('data-shop-id');
          editShop(window.shopData[shopId]);
        });
      });
      
      container.querySelectorAll('.delete-btn').forEach(btn => {
        btn.addEventListener('click', function() {
          const shopId = this.getAttribute('data-shop-id');
          deleteShopById(shopId);
        });
      });
    }
    
    async function enrichSocial(shop) {
      const shopId = shop.id;
      const shopName = shop.name;
      
      currentEnrichmentShopId = shopId;
      const btn = document.getElementById('btn-social-' + shopId);
      btn.disabled = true;
      btn.classList.add('enriching');
      btn.textContent = '⏳ Enriching Social...';
      
      const locationDisplay = shop.neighborhood 
        ? shop.neighborhood + ', ' + shop.city + ', ' + shop.state
        : shop.city + ', ' + shop.state;
      
      showModal(shopName + ' - ' + locationDisplay + ' - Social', '📱 Starting social media enrichment...\\n\\n');
      document.getElementById('cancel-btn').style.display = 'none'; // Can't cancel social enrichment (runs as function)
      
      try {
        const response = await fetch('/api/enrich-social', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            shopId, 
            shopName, 
            website: shop.website,
            socialInstagram: shop.social_instagram,
            socialFacebook: shop.social_facebook,
            socialTiktok: shop.social_tiktok,
            neighborhood: shop.neighborhood,
            city: shop.city,
            state: shop.state
          })
        });
        
        if (!response.ok) {
          throw new Error('Social enrichment failed');
        }
        
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          
          const chunk = decoder.decode(value);
          const lines = chunk.split('\\n');
          
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = JSON.parse(line.substring(6));
              
              if (data.type === 'output') {
                document.getElementById('modal-body').textContent += data.text;
                const modalBody = document.getElementById('modal-body');
                modalBody.scrollTop = modalBody.scrollHeight;
              } else if (data.type === 'complete') {
                if (data.success) {
                  document.getElementById('modal-body').textContent += '\\n\\n✅ Social enrichment complete! Database updated.\\n\\n[Click Close to continue]';
                  btn.classList.remove('enriching');
                  btn.textContent = '✓ Social Done';
                  setTimeout(() => loadShops(), 1000);
                } else {
                  document.getElementById('modal-body').textContent += '\\n\\n❌ Error: ' + (data.error || 'Unknown error');
                  btn.disabled = false;
                  btn.classList.remove('enriching');
                  btn.textContent = '🔄 Retry Social';
                }
              }
            }
          }
        }
      } catch (error) {
        document.getElementById('modal-body').textContent += '\\n\\n❌ Error: ' + error.message;
        btn.disabled = false;
        btn.classList.remove('enriching');
        btn.textContent = '🔄 Retry Social';
      }
    }
    
    async function enrichShop(shop) {
      const shopId = shop.id;
      const shopName = shop.name;
      const website = shop.website;
      
      currentEnrichmentShopId = shopId;
      const btn = document.getElementById('btn-' + shopId);
      const originalText = btn.textContent;
      btn.disabled = true;
      btn.classList.add('enriching');
      btn.textContent = '⏳ Enriching Web...';
      
      const locationDisplay = shop.neighborhood 
        ? shop.neighborhood + ', ' + shop.city + ', ' + shop.state
        : shop.city + ', ' + shop.state;
      
      showModal(shopName + ' - ' + locationDisplay, '🚀 Starting web enrichment...\\n\\n');
      document.getElementById('cancel-btn').style.display = 'block';
      
      try {
        const response = await fetch('/api/enrich', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            shopId, 
            shopName, 
            website,
            neighborhood: shop.neighborhood,
            city: shop.city,
            state: shop.state,
            address: shop.address
          })
        });
        
        if (!response.ok) {
          const error = await response.json();
          throw new Error(error.error || 'Enrichment failed');
        }
        
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          
          const chunk = decoder.decode(value);
          const lines = chunk.split('\\n');
          
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = JSON.parse(line.substring(6));
              
              if (data.type === 'output') {
                document.getElementById('modal-body').textContent += data.text;
                // Auto-scroll to bottom
                const modalBody = document.getElementById('modal-body');
                modalBody.scrollTop = modalBody.scrollHeight;
              } else if (data.type === 'complete') {
                document.getElementById('cancel-btn').style.display = 'none';
                currentEnrichmentShopId = null;
                
                if (data.success) {
                  document.getElementById('modal-body').textContent += '\\n\\n✅ Enrichment complete! Database updated.\\n\\n[Click Close to continue]';
                  btn.classList.remove('enriching');
                  btn.textContent = '✓ Enriched';
                  setTimeout(() => loadShops(), 1000);
                } else {
                  document.getElementById('modal-body').textContent += '\\n\\n❌ Error: ' + (data.error || 'Unknown error');
                  btn.disabled = false;
                  btn.classList.remove('enriching');
                  btn.textContent = '🔄 Retry';
                }
              }
            }
          }
        }
      } catch (error) {
        document.getElementById('modal-body').textContent += '\\n\\n❌ Error: ' + error.message;
        btn.disabled = false;
        btn.classList.remove('enriching');
        btn.textContent = '🔄 Retry';
      }
    }
    
    async function cancelEnrichment() {
      if (!currentEnrichmentShopId) return;
      
      if (!confirm('Stop the current enrichment process?')) return;
      
      try {
        const response = await fetch('/api/cancel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ shopId: currentEnrichmentShopId })
        });
        
        const result = await response.json();
        
        if (result.success) {
          document.getElementById('modal-body').textContent += '\\n\\n⏹️ Enrichment cancelled by user.';
          document.getElementById('cancel-btn').style.display = 'none';
          
          const btn = document.getElementById('btn-' + currentEnrichmentShopId);
          if (btn) {
            btn.disabled = false;
            btn.classList.remove('enriching');
            btn.textContent = '🔄 Retry';
          }
          
          currentEnrichmentShopId = null;
        }
      } catch (error) {
        console.error('Cancel error:', error);
      }
    }
    
    function deleteShopById(shopId) {
      const shop = window.shopData[shopId];
      if (!shop) {
        alert('Shop data not found');
        return;
      }
      deleteShop(shopId, shop.name);
    }
    
    async function deleteShop(shopId, shopName) {
      if (!confirm("Are you sure you want to permanently delete " + JSON.stringify(shopName) + " from the database?\\n\\nThis cannot be undone.")) {
        return;
      }
      
      try {
        const response = await fetch('/api/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ shopId })
        });
        
        const result = await response.json();
        
        if (result.success) {
          loadShops(); // Refresh the list
        } else {
          alert('Failed to delete shop: ' + (result.error || 'Unknown error'));
        }
      } catch (error) {
        alert('Error deleting shop: ' + error.message);
      }
    }
    
    function showModal(title, content) {
      document.getElementById('modal-title').textContent = title;
      document.getElementById('modal-body').textContent = content;
      document.getElementById('modal').classList.add('active');
      document.getElementById('cancel-btn').style.display = 'none';
    }
    
    function closeModal() {
      document.getElementById('modal').classList.remove('active');
      currentEnrichmentShopId = null;
    }
    
    function editShop(shop) {
      console.log('Opening edit for shop:', shop);
      
      currentEditShop = shop;
      document.getElementById('edit-name').value = shop.name || '';
      document.getElementById('edit-website').value = shop.website || '';
      document.getElementById('edit-phone').value = shop.phone || '';
      document.getElementById('edit-address').value = shop.address || '';
      document.getElementById('edit-city').value = shop.city || '';
      document.getElementById('edit-neighborhood').value = shop.neighborhood || '';
      document.getElementById('edit-state').value = shop.state || '';
      
      // Extract username from social URLs - show just the username for easier editing
      const extractUsername = (url, platform) => {
        if (!url) {
          console.log('No ' + platform + ' URL');
          return '';
        }
        console.log('Extracting ' + platform + ' from:', url);
        
        // Remove trailing slashes
        url = url.replace(/\\/+$/, '');
        
        let pattern;
        if (platform === 'instagram') {
          // Match instagram.com/username or instagr.am/username
          pattern = /(?:instagram\\.com|instagr\\.am)\\/([a-zA-Z0-9._]+)(?:\\/|$)/;
        } else if (platform === 'facebook') {
          // Match facebook.com/username
          pattern = /facebook\\.com\\/([a-zA-Z0-9._-]+)(?:\\/|$)/;
        } else if (platform === 'tiktok') {
          // Match tiktok.com/@username
          pattern = /tiktok\\.com\\/@([a-zA-Z0-9._]+)(?:\\/|$)/;
        }
        
        const match = url.match(pattern);
        const result = match ? match[1] : url;
        console.log('Extracted ' + platform + ':', result);
        return result;
      };
      
      console.log('Social URLs from database:');
      console.log('  instagram:', shop.social_instagram);
      console.log('  facebook:', shop.social_facebook);
      console.log('  tiktok:', shop.social_tiktok);
      
      document.getElementById('edit-instagram').value = extractUsername(shop.social_instagram, 'instagram');
      document.getElementById('edit-facebook').value = extractUsername(shop.social_facebook, 'facebook');
      document.getElementById('edit-tiktok').value = extractUsername(shop.social_tiktok, 'tiktok');
      
      document.getElementById('edit-modal').classList.add('active');
    }
    
    function closeEditModal() {
      document.getElementById('edit-modal').classList.remove('active');
      currentEditShop = null;
    }
    
    async function saveShopEdit() {
      if (!currentEditShop) return;
      
      const instagram = document.getElementById('edit-instagram').value.trim();
      const facebook = document.getElementById('edit-facebook').value.trim();
      const tiktok = document.getElementById('edit-tiktok').value.trim();
      
      const updates = {};
      
      // Only include fields that have values (or explicitly null to clear)
      const name = document.getElementById('edit-name').value.trim();
      const website = document.getElementById('edit-website').value.trim();
      const phone = document.getElementById('edit-phone').value.trim();
      const address = document.getElementById('edit-address').value.trim();
      const city = document.getElementById('edit-city').value.trim();
      const neighborhood = document.getElementById('edit-neighborhood').value.trim();
      const state = document.getElementById('edit-state').value.trim();
      
      // Debug logging for name field
      console.log('Current shop name:', currentEditShop.name);
      console.log('New name value from input:', name);
      console.log('Name input element:', document.getElementById('edit-name'));
      
      // Always include name if it's different from current value
      if (name !== (currentEditShop.name || '')) {
        updates.name = name;
      }
      if (website) updates.website = website;
      if (phone) updates.phone = phone;
      if (address) updates.address = address;
      if (city) updates.city = city;
      if (neighborhood) updates.neighborhood = neighborhood;
      if (state) updates.state = state;
      
      // Handle social media - normalize to URL format
      // If user enters full URL, use it. If username, construct URL.
      const normalizeSocialUrl = (input, platform) => {
        if (!input) return null;
        
        // If it's already a full URL, just clean it up
        if (input.startsWith('http://') || input.startsWith('https://')) {
          return input.replace(/\\/+$/, ''); // Remove trailing slashes
        }
        
        // Otherwise, treat as username and construct URL
        const username = input.replace(/^@/, '');
        
        if (platform === 'instagram') {
          return 'https://instagram.com/' + username;
        } else if (platform === 'facebook') {
          return 'https://facebook.com/' + username;
        } else if (platform === 'tiktok') {
          return 'https://tiktok.com/@' + username;
        }
        
        return null;
      };
      
      updates.social_instagram = normalizeSocialUrl(instagram, 'instagram');
      updates.social_facebook = normalizeSocialUrl(facebook, 'facebook');
      updates.social_tiktok = normalizeSocialUrl(tiktok, 'tiktok');
      
      console.log('Saving shop updates for ID:', currentEditShop.id);
      console.log('Updates:', updates);
      
      try {
        const response = await fetch('/api/update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ shopId: currentEditShop.id, updates })
        });
        
        const result = await response.json();
        console.log('Server response:', result);
        
        if (result.success) {
          console.log('Update successful, reloading shops...');
          closeEditModal();
          
          // Wait a moment for DB to propagate
          await new Promise(resolve => setTimeout(resolve, 500));
          await loadShops(); // Refresh the list
          
          console.log('Shops reloaded');
          alert('✅ Shop details updated successfully!');
        } else {
          console.error('Update failed:', result);
          alert('❌ Failed to update shop: ' + (result.error || 'Unknown error'));
        }
      } catch (error) {
        console.error('Update error:', error);
        alert('❌ Error updating shop: ' + error.message);
      }
    }
    
    // Search input
    document.getElementById('search').addEventListener('input', (e) => {
      searchQuery = e.target.value.trim();
      renderShops();
    });
    
    // Filter buttons
    document.querySelectorAll('.filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentFilter = btn.dataset.filter;
        loadShops();
      });
    });
    
    // Initial load
    loadShops();
    
    // Close modal on outside click
    document.getElementById('modal').addEventListener('click', (e) => {
      if (e.target.id === 'modal') closeModal();
    });
    
    document.getElementById('edit-modal').addEventListener('click', (e) => {
      if (e.target.id === 'edit-modal') closeEditModal();
    });
  </script>
</body>
</html>
    `);
    return;
  }
  
  // 404
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

server.listen(PORT, () => {
  console.log(`\n🎵 Record Shop Enricher UI`);
  console.log(`\n🌐 Open in browser: http://localhost:${PORT}`);
  console.log(`\n⌨️  Press Ctrl+C to stop\n`);
});
