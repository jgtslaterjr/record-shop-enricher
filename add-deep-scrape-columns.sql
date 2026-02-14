-- Run this in Supabase SQL Editor to add deep scrape columns
-- Dashboard: https://supabase.com/dashboard/project/oytflcaqukxvzmbddrlg/editor

ALTER TABLE shops 
  ADD COLUMN IF NOT EXISTS review_summary text,
  ADD COLUMN IF NOT EXISTS review_pros jsonb,
  ADD COLUMN IF NOT EXISTS review_cons jsonb,
  ADD COLUMN IF NOT EXISTS review_themes jsonb,
  ADD COLUMN IF NOT EXISTS review_vibe text,
  ADD COLUMN IF NOT EXISTS review_notable_quotes jsonb,
  ADD COLUMN IF NOT EXISTS genre_specialties jsonb,
  ADD COLUMN IF NOT EXISTS recommendation_for text,
  ADD COLUMN IF NOT EXISTS owner_name text,
  ADD COLUMN IF NOT EXISTS founded_year integer,
  ADD COLUMN IF NOT EXISTS formats_detailed jsonb,
  ADD COLUMN IF NOT EXISTS services jsonb,
  ADD COLUMN IF NOT EXISTS amenities jsonb,
  ADD COLUMN IF NOT EXISTS collection_size text,
  ADD COLUMN IF NOT EXISTS deep_scrape_at timestamptz,
  ADD COLUMN IF NOT EXISTS events_feed_url text,
  ADD COLUMN IF NOT EXISTS social_tumblr text;

-- After running this, the deep scrape data can be written to Shady Dog's record
