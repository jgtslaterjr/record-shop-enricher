#!/bin/bash
# Batch deep scrape for Philadelphia shops
# Logs to /tmp/philly_batch.log, saves progress after each shop
cd /home/john/Projects/record-shop-enricher
LOG=/tmp/philly_batch.log
PROGRESS=/tmp/philly_progress.txt

echo "=== Philadelphia Batch Scrape Started $(date) ===" >> $LOG
touch $PROGRESS

# Get list of Philly shops not yet scraped
node -e "
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
(async () => {
  const { data } = await sb.from('shops').select('name,city,state').eq('state','Pennsylvania').eq('city','Philadelphia').is('deep_scrape_at', null).order('name');
  data.forEach(s => console.log(s.name));
})();
" 2>/dev/null | while IFS= read -r SHOP; do
  # Skip if already done this run
  if grep -qF "$SHOP" $PROGRESS 2>/dev/null; then
    echo "SKIP (already done): $SHOP" >> $LOG
    continue
  fi

  echo "$(date +%H:%M:%S) START: $SHOP" >> $LOG
  
  timeout 180 node master_deep_scrape.js --shop "$SHOP" --city "Philadelphia" --state "Pennsylvania" --skip-discovery >> $LOG 2>&1
  EXIT=$?
  
  if [ $EXIT -eq 0 ]; then
    echo "$(date +%H:%M:%S) ✅ DONE: $SHOP" >> $LOG
    echo "$SHOP" >> $PROGRESS
  elif [ $EXIT -eq 124 ]; then
    echo "$(date +%H:%M:%S) ⏰ TIMEOUT: $SHOP" >> $LOG
    echo "$SHOP (timeout)" >> $PROGRESS
  else
    echo "$(date +%H:%M:%S) ❌ FAILED ($EXIT): $SHOP" >> $LOG
    echo "$SHOP (failed)" >> $PROGRESS
  fi
  
  # Brief pause between shops
  sleep 5
done

echo "=== Philadelphia Batch Scrape Complete $(date) ===" >> $LOG
echo "--- Results ---" >> $LOG
echo "Succeeded: $(grep -c '✅' $LOG)" >> $LOG
echo "Failed: $(grep -c '❌' $LOG)" >> $LOG
echo "Timeout: $(grep -c '⏰' $LOG)" >> $LOG
