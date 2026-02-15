#!/bin/bash
cd ~/Projects/record-shop-enricher

SUCCEEDED=0
FAILED=0
FAILED_SHOPS=""
START_TIME=$(date +%s)

run_scrape() {
  local name="$1"
  local city="$2"
  local state="$3"
  echo "=== Scraping: $name | $city | $state ==="
  if timeout 300 node master_deep_scrape.js --shop "$name" --city "$city" --state "$state" 2>&1; then
    SUCCEEDED=$((SUCCEEDED + 1))
    echo "=== SUCCESS: $name ==="
  else
    FAILED=$((FAILED + 1))
    FAILED_SHOPS="$FAILED_SHOPS\n  - $name ($city)"
    echo "=== FAILED: $name ==="
  fi
  echo "--- Waiting 10s before next shop ---"
  sleep 10
}

run_scrape "Angel Record Shop" "Philadelphia" "Pennsylvania"
run_scrape "Barnes & Noble Booksellers" "Philadelphia" "Pennsylvania"
run_scrape "Beautiful World Syndicate" "Philadelphia" "Pennsylvania"
run_scrape "Brackboy Records" "Philadelphia" "Pennsylvania"
run_scrape "Camp 101 Records" "Upper Darby" "Pennsylvania"
run_scrape "Centro Musical" "Philadelphia" "Pennsylvania"
run_scrape "Common Beat Music" "Philadelphia" "Pennsylvania"
run_scrape "Cornerstone Music and Culture" "Philadelphia" "Pennsylvania"
run_scrape "Cratediggaz" "Philadelphia" "Pennsylvania"
run_scrape "Creep Records" "Philadelphia" "Pennsylvania"
run_scrape "Creep Records" "Philadelphia" "Pennsylvania"
run_scrape "Digital Underground" "Philadelphia" "Pennsylvania"
run_scrape "Disco Latinos Records" "Philadelphia" "Pennsylvania"
run_scrape "Discolandia Records" "Philadelphia" "Pennsylvania"
run_scrape "F Ye" "Philadelphia" "Pennsylvania"
run_scrape "Hideaway Music" "Philadelphia" "Pennsylvania"
run_scrape "Impressions Philadelphia" "Philadelphia" "Pennsylvania"
run_scrape "Khmer Angkor Gift Shop" "Philadelphia" "Pennsylvania"
run_scrape "La Pachanga Enterprises" "Philadelphia" "Pennsylvania"
run_scrape "Long In the Tooth" "Philadelphia" "Pennsylvania"
run_scrape "Lot 49 Books" "Philadelphia" "Pennsylvania"
run_scrape "Milkcrate Cafe" "Philadelphia" "Pennsylvania"
run_scrape "Molly's Books and Records" "Philadelphia" "Pennsylvania"
run_scrape "Mostly Books" "Philadelphia" "Pennsylvania"
run_scrape "Music Box Records" "Philadelphia" "Pennsylvania"
run_scrape "Music Hall" "Philadelphia" "Pennsylvania"
run_scrape "Nuday Sounds" "Philadelphia" "Pennsylvania"
run_scrape "Pat's Music Center" "Philadelphia" "Pennsylvania"
run_scrape "Phila Record Exch" "Philadelphia" "Pennsylvania"
run_scrape "Philadelphia Record Exchange" "Philadelphia" "Pennsylvania"
run_scrape "Pop Culture Vulture" "Philadelphia" "Pennsylvania"
run_scrape "Post Records" "Philadelphia" "Pennsylvania"
run_scrape "R & B Records" "Upper Darby" "Pennsylvania"
run_scrape "Records Forever" "Philadelphia" "Pennsylvania"
run_scrape "Repo Records" "Philadelphia" "Pennsylvania"
run_scrape "Rock N Roll Knife Fight" "Lansdowne" "Pennsylvania"
run_scrape "Rustic Music" "Philadelphia" "Pennsylvania"
run_scrape "Sit & Spin Records" "Philadelphia" "Pennsylvania"
run_scrape "Softwax Record Pressing" "Philadelphia" "Pennsylvania"
run_scrape "Sounds of Lehigh Ave" "Philadelphia" "Pennsylvania"
run_scrape "The Book Trader" "Philadelphia" "Pennsylvania"
run_scrape "Tomorrow Today" "Philadelphia" "Pennsylvania"
run_scrape "Val Shively R&B Records" "Upper Darby" "Pennsylvania"
run_scrape "Vinyl Altar" "Philadelphia" "Pennsylvania"
run_scrape "Vinyl Revival" "Lansdowne" "Pennsylvania"

END_TIME=$(date +%s)
ELAPSED=$(( (END_TIME - START_TIME) / 60 ))

echo ""
echo "========================================="
echo "PA DEEP SCRAPE COMPLETE"
echo "========================================="
echo "Succeeded: $SUCCEEDED"
echo "Failed: $FAILED"
if [ $FAILED -gt 0 ]; then
  echo -e "Failed shops:$FAILED_SHOPS"
fi
echo "Total time: ${ELAPSED} minutes"
echo "========================================="
