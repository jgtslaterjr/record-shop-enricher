-- Run this in Supabase SQL Editor BEFORE running the new discovery/verification scripts
-- and BEFORE deploying the record-shop-site business_status filter.
-- Dashboard: https://supabase.com/dashboard/project/oytflcaqukxvzmbddrlg/editor

ALTER TABLE shops
  ADD COLUMN IF NOT EXISTS google_place_id text,
  ADD COLUMN IF NOT EXISTS business_status text DEFAULT 'OPERATIONAL',
  ADD COLUMN IF NOT EXISTS business_status_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS tripadvisor_url text,
  ADD COLUMN IF NOT EXISTS discovery_source text,
  ADD COLUMN IF NOT EXISTS rsd_participant boolean;

-- Backfill so the site's .neq('business_status', 'CLOSED_PERMANENTLY') filter
-- never excludes legacy rows via NULL comparison
UPDATE shops SET business_status = 'OPERATIONAL' WHERE business_status IS NULL;

-- place_id is the bulletproof dedup key — enforce uniqueness when present
CREATE UNIQUE INDEX IF NOT EXISTS shops_google_place_id_idx
  ON shops (google_place_id)
  WHERE google_place_id IS NOT NULL;

-- Column meanings:
--   google_place_id            Google Places ID; populated by backfill_place_ids.js,
--                              used by lib/common.js findExistingShop() for dedup
--   business_status            OPERATIONAL | CLOSED_TEMPORARILY | CLOSED_PERMANENTLY
--                              (Google Places vocabulary); maintained by verify_business_status.js
--   business_status_checked_at Last time verify_business_status.js confirmed the status
--   tripadvisor_url            TripAdvisor profile URL; populated by deep_scrape_tripadvisor.js
--   discovery_source           Where a stub shop came from: vinylhub | record_store_day |
--                              foursquare | google_places (existing rows stay NULL)
--   rsd_participant            True if listed in the Record Store Day store directory
