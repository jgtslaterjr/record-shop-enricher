#!/bin/bash
# Record Shop Enricher - Extracts unique features from shop websites
# Usage: ./enrich_shop.sh "Shop Name" "https://shop-url.com"

SHOP_NAME="$1"
SHOP_URL="$2"

if [ -z "$SHOP_NAME" ] || [ -z "$SHOP_URL" ]; then
    echo "Usage: $0 \"Shop Name\" \"https://shop-url.com\""
    exit 1
fi

echo "==================================="
echo "Enriching: $SHOP_NAME"
echo "URL: $SHOP_URL"
echo "==================================="
echo ""

# Fetch website content (will use Clawdbot's web_fetch via a helper script)
echo "Fetching website content..."
CONTENT_FILE="/tmp/shop_content_$$.txt"

# This will be called by the Node.js wrapper
# For now, placeholder - will be replaced by actual fetch
curl -s "$SHOP_URL" > "$CONTENT_FILE" 2>/dev/null || echo "Failed to fetch URL"

if [ ! -s "$CONTENT_FILE" ]; then
    echo "Error: Could not fetch content from $SHOP_URL"
    exit 1
fi

echo "Content fetched. Analyzing with Kimi K2.5..."
echo ""

# Send to Ollama for analysis
PROMPT="Analyze this record shop website and extract a LIST of unique features, specializations, and characteristics.

Shop Name: $SHOP_NAME

Focus on:
- Music format specializations (vinyl, 8-track, cassette, etc.)
- Genre specializations (jazz, classical, punk, hip-hop, etc.)
- Unique amenities (listening room, repair services, turntable sales, etc.)
- Shop vibe/culture (indie, collector-focused, audiophile, etc.)
- Special services (buying collections, appraisals, events, etc.)

Output ONLY a bulleted list of features, one per line, starting with •
Be specific and concise. Only list features that are explicitly mentioned or clearly evident.

Website content:
---
$(head -c 10000 "$CONTENT_FILE")
---"

echo "$PROMPT" | ollama run kimi-k2.5:cloud --nowordwrap

# Cleanup
rm -f "$CONTENT_FILE"

echo ""
echo "==================================="
echo "Analysis complete"
echo "==================================="
