#!/usr/bin/env node

/**
 * Facebook content capture using OpenClaw browser automation
 * Handles JavaScript-rendered content
 */

const { execSync } = require('child_process');

async function captureFacebookWithBrowser(pageUrl) {
  console.log(`📱 Capturing Facebook page: ${pageUrl}`);
  
  try {
    // Use OpenClaw browser tool via exec
    const result = execSync(
      `curl -s http://localhost:18790/browser/action ` +
      `-H "Authorization: Bearer 4b688a06f3d55909fd4f7f632f363e1fad2b392e3160e2a8" ` +
      `-H "Content-Type: application/json" ` +
      `-d '${JSON.stringify({
        action: "navigate",
        targetUrl: pageUrl,
        profile: "openclaw"
      })}'`,
      { encoding: 'utf8' }
    );
    
    console.log('Navigation result:', result);
    
    // Wait for page load
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Take a snapshot
    const snapshotCmd = `curl -s http://localhost:18790/browser/action ` +
      `-H "Authorization: Bearer 4b688a06f3d55909fd4f7f632f363e1fad2b392e3160e2a8" ` +
      `-H "Content-Type: application/json" ` +
      `-d '${JSON.stringify({
        action: "snapshot",
        profile: "openclaw",
        refs: "aria"
      })}'`;
    
    const snapshot = JSON.parse(execSync(snapshotCmd, { encoding: 'utf8' }));
    
    return {
      url: pageUrl,
      title: snapshot.title,
      content: snapshot.text,
      timestamp: new Date().toISOString()
    };
    
  } catch (error) {
    console.error('Browser capture failed:', error.message);
    return null;
  }
}

// Test
if (require.main === module) {
  const url = process.argv[2] || 'https://www.facebook.com/rpmunderground/';
  captureFacebookWithBrowser(url).then(result => {
    console.log('\n✅ Captured:', result);
  });
}

module.exports = { captureFacebookWithBrowser };
