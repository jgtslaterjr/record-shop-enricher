#!/usr/bin/env node

const http = require('http');
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

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
  try {
    const result = execSync(`curl -s -X PATCH "${SUPABASE_URL}/rest/v1/shops?id=eq.${shopId}" \
      -H "apikey: ${SUPABASE_KEY}" \
      -H "Authorization: Bearer ${SUPABASE_KEY}" \
      -H "Content-Type: application/json" \
      -d '${JSON.stringify(updates)}'`,
      { encoding: 'utf8' }
    );
    return true;
  } catch (error) {
    console.error("Error updating shop:", error.message);
    return false;
  }
}

function fetchShops() {
  // Always fetch all shops, filter client-side
  let url = `${SUPABASE_URL}/rest/v1/shops?select=id,name,city,state,website,phone,address,enrichment_status,date_of_enrichment&order=name&limit=1000`;
  
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

function updateShopStatus(shopId) {
  const now = new Date().toISOString();
  const updateData = {
    enrichment_status: 'enriched',
    date_of_enrichment: now
  };
  
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
  
  // API: Enrich shop
  if (url.pathname === '/api/enrich' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { shopId, shopName, website } = JSON.parse(body);
        
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
        
        const enrichProcess = spawn('node', ['enrich_shop_v2.js', shopName, website], {
          cwd: __dirname
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
      <p>Tier 1: Enhanced Web Intelligence • v 2.0.1</p>
    </div>
    
    <div class="controls">
      <div class="filters">
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
          <label for="edit-state">State</label>
          <input type="text" id="edit-state" />
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
    let shops = [];
    let currentEnrichmentShopId = null;
    let currentEditShop = null;
    
    async function loadShops() {
      try {
        const response = await fetch(\`/api/shops?filter=\${currentFilter}\`);
        shops = await response.json();
        renderShops();
      } catch (error) {
        console.error('Error loading shops:', error);
        document.getElementById('shops').innerHTML = '<div class="loading">Error loading shops</div>';
      }
    }
    
    function renderShops() {
      const container = document.getElementById('shops');
      const enrichedCount = shops.filter(s => s.enrichment_status === 'enriched').length;
      
      document.getElementById('stats').textContent = \`\${shops.length} shops (\${enrichedCount} enriched)\`;
      
      if (shops.length === 0) {
        container.innerHTML = '<div class="loading">No shops found</div>';
        return;
      }
      
      container.innerHTML = shops.map(shop => {
        const isEnriched = shop.enrichment_status === 'enriched';
        const hasWebsite = shop.website && !shop.website.includes('yelp.com');
        const status = isEnriched ? '✓' : '○';
        const cardClass = isEnriched ? 'shop-card enriched' : (hasWebsite ? 'shop-card' : 'shop-card no-website');
        
        return \`
          <div class="\${cardClass}">
            <div class="shop-header">
              <div class="shop-name">\${shop.name}</div>
              <div class="shop-status">\${status}</div>
            </div>
            <div class="shop-info">📍 \${shop.city}, \${shop.state}</div>
            \${shop.website ? \`<a href="\${shop.website}" target="_blank" class="shop-website">\${shop.website}</a>\` : '<div class="shop-info">No website</div>'}
            \${shop.date_of_enrichment ? \`<div class="shop-info" style="font-size: 0.85em; color: #999;">Enriched: \${new Date(shop.date_of_enrichment).toLocaleDateString()}</div>\` : ''}
            <button 
              class="enrich-btn" 
              onclick="enrichShop('\${shop.id}', '\${shop.name.replace(/'/g, "\\'")}', '\${shop.website || ''}')"
              \${!hasWebsite ? 'disabled' : ''}
              id="btn-\${shop.id}"
            >
              \${!hasWebsite ? '⚠️ No Valid URL' : (isEnriched ? '🔄 Re-enrich' : '🚀 Enrich Now')}
            </button>
            <button class="edit-btn" onclick='editShop(\${JSON.stringify(shop)})'>
              ✏️ Edit Details
            </button>
            <button class="delete-btn" onclick="deleteShop('\${shop.id}', '\${shop.name.replace(/'/g, "\\'")}')">
              🗑️ Remove from Database
            </button>
          </div>
        \`;
      }).join('');
    }
    
    async function enrichShop(shopId, shopName, website) {
      currentEnrichmentShopId = shopId;
      const btn = document.getElementById(\`btn-\${shopId}\`);
      const originalText = btn.textContent;
      btn.disabled = true;
      btn.classList.add('enriching');
      btn.textContent = '⏳ Enriching...';
      
      showModal(shopName, '🚀 Starting enrichment...\\n\\n');
      document.getElementById('cancel-btn').style.display = 'block';
      
      try {
        const response = await fetch('/api/enrich', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ shopId, shopName, website })
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
          
          const btn = document.getElementById(\`btn-\${currentEnrichmentShopId}\`);
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
    
    async function deleteShop(shopId, shopName) {
      if (!confirm(\`Are you sure you want to permanently delete "\${shopName}" from the database?\\n\\nThis cannot be undone.\`)) {
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
      currentEditShop = shop;
      document.getElementById('edit-name').value = shop.name || '';
      document.getElementById('edit-website').value = shop.website || '';
      document.getElementById('edit-phone').value = shop.phone || '';
      document.getElementById('edit-address').value = shop.address || '';
      document.getElementById('edit-city').value = shop.city || '';
      document.getElementById('edit-state').value = shop.state || '';
      document.getElementById('edit-modal').classList.add('active');
    }
    
    function closeEditModal() {
      document.getElementById('edit-modal').classList.remove('active');
      currentEditShop = null;
    }
    
    async function saveShopEdit() {
      if (!currentEditShop) return;
      
      const updates = {
        name: document.getElementById('edit-name').value,
        website: document.getElementById('edit-website').value,
        phone: document.getElementById('edit-phone').value,
        address: document.getElementById('edit-address').value,
        city: document.getElementById('edit-city').value,
        state: document.getElementById('edit-state').value
      };
      
      // Remove empty values
      Object.keys(updates).forEach(key => {
        if (!updates[key]) delete updates[key];
      });
      
      try {
        const response = await fetch('/api/update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ shopId: currentEditShop.id, updates })
        });
        
        const result = await response.json();
        
        if (result.success) {
          closeEditModal();
          loadShops(); // Refresh the list
        } else {
          alert('Failed to update shop: ' + (result.error || 'Unknown error'));
        }
      } catch (error) {
        alert('Error updating shop: ' + error.message);
      }
    }
    
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
