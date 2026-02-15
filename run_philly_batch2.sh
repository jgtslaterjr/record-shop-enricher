#!/bin/bash
cd ~/Projects/record-shop-enricher

LOG="/tmp/philly_results.log"
> "$LOG"

declare -a SHOPS=(
"Angel Record Shop|Philadelphia|Pennsylvania"
"Barnes & Noble Booksellers|Philadelphia|Pennsylvania"
"Beautiful World Syndicate|Philadelphia|Pennsylvania"
"Brackboy Records|Philadelphia|Pennsylvania"
"Centro Musical|Philadelphia|Pennsylvania"
"Common Beat Music|Philadelphia|Pennsylvania"
"Cornerstone Music and Culture|Philadelphia|Pennsylvania"
"Cratediggaz|Philadelphia|Pennsylvania"
"Creep Records|Philadelphia|Pennsylvania"
"Creep Records|Philadelphia|Pennsylvania"
"Digital Underground|Philadelphia|Pennsylvania"
"Disco Latinos Records|Philadelphia|Pennsylvania"
"Discolandia Records|Philadelphia|Pennsylvania"
"F Ye|Philadelphia|Pennsylvania"
"Hideaway Music|Philadelphia|Pennsylvania"
"Impressions Philadelphia|Philadelphia|Pennsylvania"
"Khmer Angkor Gift Shop|Philadelphia|Pennsylvania"
"La Pachanga Enterprises|Philadelphia|Pennsylvania"
"Long In the Tooth|Philadelphia|Pennsylvania"
"Lot 49 Books|Philadelphia|Pennsylvania"
"Milkcrate Cafe|Philadelphia|Pennsylvania"
"Molly's Books and Records|Philadelphia|Pennsylvania"
"Mostly Books|Philadelphia|Pennsylvania"
"Music Box Records|Philadelphia|Pennsylvania"
"Music Hall|Philadelphia|Pennsylvania"
"Nuday Sounds|Philadelphia|Pennsylvania"
"Pat's Music Center|Philadelphia|Pennsylvania"
"Phila Record Exch|Philadelphia|Pennsylvania"
"Philadelphia Record Exchange|Philadelphia|Pennsylvania"
"Pop Culture Vulture|Philadelphia|Pennsylvania"
"Post Records|Philadelphia|Pennsylvania"
"Records Forever|Philadelphia|Pennsylvania"
"Repo Records|Philadelphia|Pennsylvania"
"Rustic Music|Philadelphia|Pennsylvania"
"Sit & Spin Records|Philadelphia|Pennsylvania"
"Softwax Record Pressing|Philadelphia|Pennsylvania"
"Sounds of Lehigh Ave|Philadelphia|Pennsylvania"
"The Book Trader|Philadelphia|Pennsylvania"
"Tomorrow Today|Philadelphia|Pennsylvania"
"Vinyl Altar|Philadelphia|Pennsylvania"
)

TOTAL=${#SHOPS[@]}
SUCCEEDED=0
FAILED=0
START_TIME=$(date +%s)

for i in "${!SHOPS[@]}"; do
  IFS='|' read -r NAME CITY STATE <<< "${SHOPS[$i]}"
  NUM=$((i + 1))
  echo "[$NUM/$TOTAL] $NAME" | tee -a "$LOG"
  
  # Run with timeout, redirect output to temp file
  TMPOUT="/tmp/scrape_shop_$$.log"
  timeout --kill-after=15 180 node master_deep_scrape.js \
    --shop "$NAME" --city "$CITY" --state "$STATE" --skip-google \
    > "$TMPOUT" 2>&1
  EXIT_CODE=$?
  
  # Show summary line from output
  grep "═══ Summary" -A 20 "$TMPOUT" 2>/dev/null | head -10
  
  if [ $EXIT_CODE -eq 0 ]; then
    echo "  -> OK" | tee -a "$LOG"
    SUCCEEDED=$((SUCCEEDED + 1))
  elif [ $EXIT_CODE -eq 124 ] || [ $EXIT_CODE -eq 137 ]; then
    echo "  -> TIMEOUT" | tee -a "$LOG"
    FAILED=$((FAILED + 1))
  else
    echo "  -> FAIL (exit $EXIT_CODE)" | tee -a "$LOG"
    FAILED=$((FAILED + 1))
  fi
  
  # Kill any leftover Playwright browsers
  pkill -9 -f "chrome-headless-shell" 2>/dev/null || true
  rm -f "$TMPOUT"
  
  sleep 10
done

END_TIME=$(date +%s)
ELAPSED=$(( (END_TIME - START_TIME) / 60 ))

echo "" | tee -a "$LOG"
echo "DONE: $SUCCEEDED ok, $FAILED fail, ${ELAPSED}min" | tee -a "$LOG"
