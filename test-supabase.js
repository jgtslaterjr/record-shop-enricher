#!/usr/bin/env node

const { execSync } = require('child_process');

const SUPABASE_URL = "https://oytflcaqukxvzmbddrlg.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im95dGZsY2FxdWt4dnptYmRkcmxnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY5NTIwMjQsImV4cCI6MjA4MjUyODAyNH0.YpFZfu2BPxwXxXz5j-xqgu7VdIuTP315eiS3UuLD2wo";

console.log("📚 Fetching first shop to see table structure...\n");

try {
  const result = execSync(`curl -s "${SUPABASE_URL}/rest/v1/shops?limit=1" \
    -H "apikey: ${SUPABASE_KEY}" \
    -H "Authorization: Bearer ${SUPABASE_KEY}"`, 
    { encoding: 'utf8' }
  );
  
  const data = JSON.parse(result);
  
  if (data.length > 0) {
    console.log("✅ Sample shop data:");
    console.log(JSON.stringify(data[0], null, 2));
    console.log("\n📋 Available columns:");
    console.log(Object.keys(data[0]).join(", "));
  } else {
    console.log("❌ No shops found in table");
  }
} catch (error) {
  console.error("❌ Error:", error.message);
}
