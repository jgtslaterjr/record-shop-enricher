/**
 * Common utilities shared across all deep scraping scripts
 */
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://oytflcaqukxvzmbddrlg.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im95dGZsY2FxdWt4dnptYmRkcmxnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY5NTIwMjQsImV4cCI6MjA4MjUyODAyNH0.YpFZfu2BPxwXxXz5j-xqgu7VdIuTP315eiS3UuLD2wo';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const USER_AGENTS = [
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64; rv:134.0) Gecko/20100101 Firefox/134.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:134.0) Gecko/20100101 Firefox/134.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:134.0) Gecko/20100101 Firefox/134.0',
];

function randomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

async function delay(min = 2000, max = 4000) {
  const ms = Math.floor(Math.random() * (max - min) + min);
  return new Promise(r => setTimeout(r, ms));
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function saveJSON(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function loadJSON(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function contentDir(shopId, ...subPaths) {
  return path.join(__dirname, '..', 'content', shopId, ...subPaths);
}

async function getAllShops(limit) {
  let query = supabase.from('shops').select('*').order('name');
  if (limit) query = query.limit(limit);
  const { data, error } = await query;
  if (error) throw error;
  return data;
}

// Map state abbreviations to full names
const STATE_MAP = {
  'AL':'Alabama','AK':'Alaska','AZ':'Arizona','AR':'Arkansas','CA':'California',
  'CO':'Colorado','CT':'Connecticut','DE':'Delaware','FL':'Florida','GA':'Georgia',
  'HI':'Hawaii','ID':'Idaho','IL':'Illinois','IN':'Indiana','IA':'Iowa','KS':'Kansas',
  'KY':'Kentucky','LA':'Louisiana','ME':'Maine','MD':'Maryland','MA':'Massachusetts',
  'MI':'Michigan','MN':'Minnesota','MS':'Mississippi','MO':'Missouri','MT':'Montana',
  'NE':'Nebraska','NV':'Nevada','NH':'New Hampshire','NJ':'New Jersey','NM':'New Mexico',
  'NY':'New York','NC':'North Carolina','ND':'North Dakota','OH':'Ohio','OK':'Oklahoma',
  'OR':'Oregon','PA':'Pennsylvania','RI':'Rhode Island','SC':'South Carolina',
  'SD':'South Dakota','TN':'Tennessee','TX':'Texas','UT':'Utah','VT':'Vermont',
  'VA':'Virginia','WA':'Washington','WV':'West Virginia','WI':'Wisconsin','WY':'Wyoming',
  'DC':'District of Columbia',
};

async function getShopByName(name, city, state) {
  let query = supabase.from('shops').select('*').ilike('name', `%${name}%`);
  if (city) query = query.ilike('city', `%${city}%`);
  if (state) {
    const fullState = STATE_MAP[state.toUpperCase()] || state;
    query = query.ilike('state', `%${fullState}%`);
  }
  const { data, error } = await query;
  if (error) throw error;
  return data;
}

async function updateShop(id, updates) {
  const { error } = await supabase.from('shops').update(updates).eq('id', id);
  if (error) throw error;
}

async function upsertShop(shopData) {
  // Try to match by name+city first
  const existing = await getShopByName(shopData.name, shopData.city, shopData.state);
  if (existing && existing.length > 0) {
    await updateShop(existing[0].id, shopData);
    return { ...existing[0], ...shopData, isNew: false };
  }
  // Insert new
  const { data, error } = await supabase.from('shops').insert(shopData).select();
  if (error) throw error;
  return { ...data[0], isNew: true };
}

async function createStealthBrowser() {
  const { chromium } = require('playwright-extra');
  const stealth = require('puppeteer-extra-plugin-stealth')();
  chromium.use(stealth);

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--disable-setuid-sandbox',
    ]
  });

  const context = await browser.newContext({
    userAgent: randomUA(),
    viewport: { width: 1366, height: 768 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
  });

  return { browser, context };
}

async function ollamaSummarize(prompt, model = 'llama3.2') {
  const { spawn } = require('child_process');
  return new Promise((resolve, reject) => {
    const proc = spawn('curl', [
      '-s', 'http://localhost:11434/api/generate',
      '-d', JSON.stringify({ model, prompt, stream: false })
    ]);
    let out = '';
    proc.stdout.on('data', d => out += d);
    proc.stderr.on('data', d => {});
    proc.on('close', code => {
      try {
        const parsed = JSON.parse(out);
        resolve(parsed.response || '');
      } catch (e) {
        reject(new Error(`Ollama failed: ${out.slice(0, 200)}`));
      }
    });
  });
}

function parseArgs() {
  const args = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        args[key] = argv[++i];
      } else {
        args[key] = true;
      }
    }
  }
  return args;
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

module.exports = {
  supabase, randomUA, delay, ensureDir, saveJSON, loadJSON, contentDir,
  getAllShops, getShopByName, updateShop, upsertShop, createStealthBrowser,
  ollamaSummarize, parseArgs, log, USER_AGENTS
};
