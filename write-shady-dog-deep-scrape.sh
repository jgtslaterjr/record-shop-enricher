#!/bin/bash
# Write Shady Dog deep scrape results to Supabase
# Run this AFTER adding the columns via SQL

SUPABASE_URL="https://oytflcaqukxvzmbddrlg.supabase.co"
SUPABASE_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im95dGZsY2FxdWt4dnptYmRkcmxnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY5NTIwMjQsImV4cCI6MjA4MjUyODAyNH0.YpFZfu2BPxwXxXz5j-xqgu7VdIuTP315eiS3UuLD2wo"
SHOP_ID="efcb6547-a85b-4ef9-91c0-c16930232f34"

curl -X PATCH "${SUPABASE_URL}/rest/v1/shops?id=eq.${SHOP_ID}" \
  -H "apikey: ${SUPABASE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_KEY}" \
  -H "Content-Type: application/json" \
  -H "Prefer: return=representation" \
  -d '{
    "review_summary": "Shady Dog Record & Disc Exchange has a unique, laid-back vibe that'\''s both nostalgic and inviting. The cramped store layout can feel overwhelming at first, but the friendly staff and vast selection of records and CDs make it worth exploring. While some areas may be smoky or disorganized, the shop'\''s character is undeniable.",
    "review_pros": ["Friendly and knowledgeable staff", "Great selection of records and CDs", "Affordable prices", "Unique shopping experience (dumpy, cramped) for some", "Personalized service from the owner Dave"],
    "review_cons": ["Smoky atmosphere in some areas", "Cramped store layout", "Not all inventory is organized", "Some staff members may be unfriendly or distracted", "Remodeling can disrupt the shopping experience"],
    "review_themes": ["Knowledgeable staff", "Unique shopping experience (dumpy, cramped)", "Great selection of records and CDs", "Affordable prices", "Local business with a personal touch"],
    "review_vibe": "Shady Dog Record & Disc Exchange has a unique, laid-back vibe that'\''s both nostalgic and inviting. The cramped store layout can feel overwhelming at first, but the friendly staff and vast selection of records and CDs make it worth exploring. While some areas may be smoky or disorganized, the shop'\''s character is undeniable.",
    "review_notable_quotes": {
      "best": "Memory heaven. My daughter and I spent almost 2 hours in the store yesterday looking at and buying records and cds.",
      "worst": null,
      "funniest": "Everybody says the store is dumpy, but if you grew up in the 70s, the sight (and the vintage smell)"
    },
    "genre_specialties": ["Jazz", "Classical", "Classic rock"],
    "recommendation_for": "Collectors of a certain vintage, jazz enthusiasts, casual browsers, and anyone looking for a unique shopping experience.",
    "owner_name": "Dave",
    "deep_scrape_at": "'$(date -Iseconds)'"
  }'

echo ""
echo "✓ Deep scrape data written to Shady Dog record"
