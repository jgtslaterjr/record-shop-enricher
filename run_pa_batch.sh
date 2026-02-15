#!/bin/bash
# Batch PA deep scrape with aggressive timeouts
cd ~/Projects/record-shop-enricher

LOG="/tmp/pa_scrape_results.log"
echo "PA Deep Scrape Started: $(date)" > "$LOG"

SHOPS=(
"Angel Record Shop|Philadelphia|Pennsylvania"
"Barnes & Noble Booksellers|Philadelphia|Pennsylvania"
"Beautiful World Syndicate|Philadelphia|Pennsylvania"
"Brackboy Records|Philadelphia|Pennsylvania"
"Camp 101 Records|Upper Darby|Pennsylvania"
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
"R & B Records|Upper Darby|Pennsylvania"
"Records Forever|Philadelphia|Pennsylvania"
"Repo Records|Philadelphia|Pennsylvania"
"Rock N Roll Knife Fight|Lansdowne|Pennsylvania"
"Rustic Music|Philadelphia|Pennsylvania"
"Sit & Spin Records|Philadelphia|Pennsylvania"
"Softwax Record Pressing|Philadelphia|Pennsylvania"
"Sounds of Lehigh Ave|Philadelphia|Pennsylvania"
"The Book Trader|Philadelphia|Pennsylvania"
"Tomorrow Today|Philadelphia|Pennsylvania"
"Val Shively R&B Records|Upper Darby|Pennsylvania"
"Vinyl Altar|Philadelphia|Pennsylvania"
"Vinyl Revival|Lansdowne|Pennsylvania"
)

TOTAL=${#SHOPS[@]}
SUCCEEDED=0
FAILED=0
FAILED_LIST=""
START_TIME=$(date +%s)

for i in "${!SHOPS[@]}"; do
  IFS='|' read -r NAME CITY STATE <<< "${SHOPS[$i]}"
  NUM=$((i + 1))
  echo ""
  echo "============================================================"
  echo "[$NUM/$TOTAL] $NAME ($CITY, $STATE)"
  echo "============================================================"
  
  # Use timeout with SIGKILL after 4 min, and --kill-after for stubborn processes
  if timeout --kill-after=10 240 node master_deep_scrape.js --shop "$NAME" --city "$CITY" --state "$STATE" --skip-google 2>&1; then
    echo "✅ [$NUM/$TOTAL] SUCCESS: $NAME"
    echo "✅ $NAME ($CITY)" >> "$LOG"
    SUCCEEDED=$((SUCCEEDED + 1))
  else
    EXIT_CODE=$?
    if [ $EXIT_CODE -eq 124 ]; then
      echo "❌ [$NUM/$TOTAL] TIMEOUT: $NAME"
      echo "❌ $NAME ($CITY) - TIMEOUT" >> "$LOG"
    else
      echo "❌ [$NUM/$TOTAL] FAILED: $NAME (exit $EXIT_CODE)"
      echo "❌ $NAME ($CITY) - exit $EXIT_CODE" >> "$LOG"
    fi
    FAILED=$((FAILED + 1))
    FAILED_LIST="$FAILED_LIST  - $NAME ($CITY)\n"
    # Kill any leftover chrome/node processes from this scrape
    pkill -f "master_deep_scrape.js --shop" 2>/dev/null || true
    sleep 2
  fi
  
  # Delay between shops
  if [ $NUM -lt $TOTAL ]; then
    sleep 10
  fi
done

END_TIME=$(date +%s)
ELAPSED=$(( (END_TIME - START_TIME) / 60 ))

echo ""
echo "========================================="
echo "PA DEEP SCRAPE COMPLETE"
echo "========================================="
echo "Succeeded: $SUCCEEDED"
echo "Failed: $FAILED"
if [ $FAILED -gt 0 ]; then
  echo -e "Failed shops:\n$FAILED_LIST"
fi
echo "Total time: ${ELAPSED} minutes"
echo "========================================="

# Also append summary to results log
echo "" >> "$LOG"
echo "SUMMARY: $SUCCEEDED succeeded, $FAILED failed, ${ELAPSED} min" >> "$LOG"
