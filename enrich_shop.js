#!/usr/bin/env node
/**
 * Record Shop Enricher
 * Extracts unique features from record shop websites using Kimi K2.5
 * 
 * Usage: node enrich_shop.js "Shop Name" "https://shop-url.com"
 */

const { spawn } = require('child_process');
const fs = require('fs');

const shopName = process.argv[2];
const shopUrl = process.argv[3];

if (!shopName || !shopUrl) {
    console.error('Usage: node enrich_shop.js "Shop Name" "https://shop-url.com"');
    process.exit(1);
}

console.log('===================================');
console.log(`Enriching: ${shopName}`);
console.log(`URL: ${shopUrl}`);
console.log('===================================\n');

// Function to call Clawdbot's web_fetch (will need to use exec through bash)
async function fetchWebsite(url) {
    return new Promise((resolve, reject) => {
        console.log('Fetching website content...');
        
        // Use curl as fallback for now
        const curl = spawn('curl', ['-sL', '-A', 'Mozilla/5.0', url]);
        let data = '';
        let error = '';

        curl.stdout.on('data', (chunk) => {
            data += chunk;
        });

        curl.stderr.on('data', (chunk) => {
            error += chunk;
        });

        curl.on('close', (code) => {
            if (code !== 0 || !data) {
                reject(new Error(`Failed to fetch: ${error}`));
            } else {
                resolve(data);
            }
        });
    });
}

async function analyzeWithKimi(content) {
    return new Promise((resolve, reject) => {
        console.log('Analyzing with Kimi K2.5...\n');

        const prompt = `Analyze this record shop website and extract a LIST of unique features, specializations, and characteristics.

Shop Name: ${shopName}

Focus on:
- Music format specializations (vinyl, 8-track, cassette, reel-to-reel, etc.)
- Genre specializations (jazz, classical, punk, hip-hop, soul, metal, etc.)
- Unique amenities (listening room, repair services, turntable sales, cafe, etc.)
- Shop vibe/culture (indie, collector-focused, audiophile, community hub, etc.)
- Special services (buying collections, appraisals, events, DJ equipment, etc.)
- Rare/unique features (used gear, vintage equipment, autographed items, etc.)

Output ONLY a bulleted list of features, one per line, starting with •
Be specific and concise. Only list features that are explicitly mentioned or clearly evident.
If you can't find much information, say so.

Website content:
---
${content.substring(0, 10000)}
---`;

        const ollama = spawn('ollama', ['run', 'kimi-k2.5:cloud', '--nowordwrap']);
        
        let output = '';
        let errorOutput = '';

        ollama.stdout.on('data', (data) => {
            const chunk = data.toString();
            output += chunk;
            process.stdout.write(chunk);
        });

        ollama.stderr.on('data', (data) => {
            errorOutput += data.toString();
        });

        ollama.stdin.write(prompt);
        ollama.stdin.end();

        ollama.on('close', (code) => {
            console.log('\n');
            console.log('===================================');
            console.log('Analysis complete');
            console.log('===================================');
            
            if (code !== 0) {
                reject(new Error(`Ollama failed: ${errorOutput}`));
            } else {
                resolve(output);
            }
        });
    });
}

async function main() {
    try {
        const content = await fetchWebsite(shopUrl);
        await analyzeWithKimi(content);
    } catch (error) {
        console.error(`\nError: ${error.message}`);
        process.exit(1);
    }
}

main();
