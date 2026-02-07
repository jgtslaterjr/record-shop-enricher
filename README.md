# Record Shop Enricher

Extracts unique features, specializations, and characteristics from record shop websites using AI analysis (Kimi K2.5).

## Usage

```bash
# Using Node.js script (recommended)
node enrich_shop.js "Shop Name" "https://shop-website.com"

# Or using bash script
./enrich_shop.sh "Shop Name" "https://shop-website.com"
```

## Examples

```bash
# Analyze Waterloo Records
node enrich_shop.js "Waterloo Records" "http://www.waterloorecords.com/"

# Analyze Amoeba Music
node enrich_shop.js "Amoeba Music" "https://www.amoeba.com/"
```

## What It Extracts

The tool looks for:
- **Format specializations**: vinyl, 8-track, cassette, reel-to-reel, CD
- **Genre specializations**: jazz, classical, punk, hip-hop, soul, metal, indie, etc.
- **Amenities**: listening rooms, repair services, turntable sales, cafes
- **Services**: buying collections, appraisals, events, DJ equipment
- **Unique features**: vintage equipment, autographed items, rare imports
- **Shop vibe**: collector-focused, audiophile, community hub, indie

## Output

Returns a bulleted list of features found on the website:
```
• Specializes in new and used vinyl records
• Hosts in-store performances and signings
• Buys used vinyl collections
• Large selection of local Austin artists
• Turntable and audio equipment sales
```

## Requirements

- Node.js
- Ollama with kimi-k2.5:cloud model
- curl (for fetching websites)

## Notes

- Analyzes first 10KB of website content
- Only reports features explicitly mentioned on the site
- Uses Kimi K2.5 AI model for intelligent extraction
