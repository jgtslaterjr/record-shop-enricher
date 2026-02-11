#!/bin/bash

cd /home/john/Projects/record_shop_enricher

echo "Testing Tier 2: Social Media Intelligence"
echo ""

# Make executable
chmod +x enrich_social.js

# Test with a known shop (Amoeba Music has strong social presence)
./enrich_social.js "Amoeba Music" "https://www.amoeba.com"
