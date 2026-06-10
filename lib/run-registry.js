/**
 * Whitelist of enrichment actions the dashboard may spawn.
 * /api/run validates against this — never spawns arbitrary scripts.
 *
 * perShop: true  → spawned once per shop id with args(shopId)
 * perShop: false → spawned once per batch with args()
 */
module.exports = {
  deep_scrape: {
    label: 'Deep scrape',
    script: 'master_deep_scrape.js',
    perShop: true,
    args: id => ['--shop-id', id],
    estMinutes: 3,
  },
  reviews: {
    label: 'Regenerate review',
    script: 'summarize_reviews.js',
    perShop: true,
    args: id => ['--shop-id', id, '--force'],
    estMinutes: 1,
  },
  place_id: {
    label: 'Resolve place ID',
    script: 'backfill_place_ids.js',
    perShop: true,
    args: id => ['--shop-id', id],
    estMinutes: 0.2,
  },
  verify_status: {
    label: 'Verify business status (all stale)',
    script: 'verify_business_status.js',
    perShop: false,
    args: () => ['--stale-days', '60'],
    estMinutes: 5,
  },
};
