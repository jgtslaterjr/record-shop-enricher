#!/bin/bash
# PA deep scrape - skip google (hangs), use process.exit fix
cd ~/Projects/record-shop-enricher

RESULT_LOG="/tmp/pa_results.txt"
> "$RESULT_LOG"

START=$(date +%s)

# Read shops from inline list
while IFS='|' read -r NAME CITY STATE; do
  [ -z "$NAME" ] && continue
  echo ""
  echo "================================================================"
  echo "$(date '+%H:%M:%S') SCRAPING: $NAME ($CITY)"
  echo "================================================================"
  
  timeout --kill-after=15 180 node master_deep_scrape.js \
    --shop "$NAME" --city "$CITY" --state "$STATE" --skip-google 2>&1
  
  RC=$?
  if [ $RC -eq 0 ]; then
    echo "OK|$NAME|$CITY" >> "$RESULT_LOG"
    echo ">>> SUCCESS: $NAME"
  elif [ $RC -eq 124 ] || [ $RC -eq 137 ]; then
    echo "TIMEOUT|$NAME|$CITY" >> "$RESULT_LOG"
    echo ">>> TIMEOUT: $NAME"
  else
    echo "FAIL|$NAME|$CITY|$RC" >> "$RESULT_LOG"
    echo ">>> FAILED ($RC): $NAME"
  fi
  
  # Kill any leftover processes
  pkill -f "chrome-headless-shell" 2>/dev/null
  sleep 10
  
done << 'SHOPLIST'
Angel Record Shop|Philadelphia|Pennsylvania
Barnes & Noble Booksellers|Philadelphia|Pennsylvania
Beautiful World Syndicate|Philadelphia|Pennsylvania
Brackboy Records|Philadelphia|Pennsylvania
Camp 101 Records|Upper Darby|Pennsylvania
Centro Musical|Philadelphia|Pennsylvania
Common Beat Music|Philadelphia|Pennsylvania
Cornerstone Music and Culture|Philadelphia|Pennsylvania
Cratediggaz|Philadelphia|Pennsylvania
Creep Records|Philadelphia|Pennsylvania
Creep Records|Philadelphia|Pennsylvania
Digital Underground|Philadelphia|Pennsylvania
Disco Latinos Records|Philadelphia|Pennsylvania
Discolandia Records|Philadelphia|Pennsylvania
F Ye|Philadelphia|Pennsylvania
Hideaway Music|Philadelphia|Pennsylvania
Impressions Philadelphia|Philadelphia|Pennsylvania
Khmer Angkor Gift Shop|Philadelphia|Pennsylvania
La Pachanga Enterprises|Philadelphia|Pennsylvania
Long In the Tooth|Philadelphia|Pennsylvania
Lot 49 Books|Philadelphia|Pennsylvania
Milkcrate Cafe|Philadelphia|Pennsylvania
Molly's Books and Records|Philadelphia|Pennsylvania
Mostly Books|Philadelphia|Pennsylvania
Music Box Records|Philadelphia|Pennsylvania
Music Hall|Philadelphia|Pennsylvania
Nuday Sounds|Philadelphia|Pennsylvania
Pat's Music Center|Philadelphia|Pennsylvania
Phila Record Exch|Philadelphia|Pennsylvania
Philadelphia Record Exchange|Philadelphia|Pennsylvania
Pop Culture Vulture|Philadelphia|Pennsylvania
Post Records|Philadelphia|Pennsylvania
R & B Records|Upper Darby|Pennsylvania
Records Forever|Philadelphia|Pennsylvania
Repo Records|Philadelphia|Pennsylvania
Rock N Roll Knife Fight|Lansdowne|Pennsylvania
Rustic Music|Philadelphia|Pennsylvania
Sit & Spin Records|Philadelphia|Pennsylvania
Softwax Record Pressing|Philadelphia|Pennsylvania
Sounds of Lehigh Ave|Philadelphia|Pennsylvania
The Book Trader|Philadelphia|Pennsylvania
Tomorrow Today|Philadelphia|Pennsylvania
Val Shively R&B Records|Upper Darby|Pennsylvania
Vinyl Altar|Philadelphia|Pennsylvania
Vinyl Revival|Lansdowne|Pennsylvania
SHOPLIST

END=$(date +%s)
ELAPSED=$(( (END - START) / 60 ))

echo ""
echo "================================================================"
echo "COMPLETE - $(date)"
echo "================================================================"
OK=$(grep -c "^OK|" "$RESULT_LOG")
FAIL=$(grep -c "^FAIL\|^TIMEOUT" "$RESULT_LOG")
echo "Succeeded: $OK"
echo "Failed: $FAIL"
grep "^FAIL\|^TIMEOUT" "$RESULT_LOG" | while IFS='|' read -r STATUS NAME CITY REST; do
  echo "  - $NAME ($CITY): $STATUS $REST"
done
echo "Total time: ${ELAPSED} minutes"
echo ""
cat "$RESULT_LOG"
