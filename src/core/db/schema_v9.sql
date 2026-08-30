-- Live-auction dashboard support. Curated listing fields are deliberately
-- denormalized from the raw eBay item payload so the read-only web process
-- never has to open hundreds of object-store files for one page.
ALTER TABLE ebay_listings ADD COLUMN subtitle TEXT;
ALTER TABLE ebay_listings ADD COLUMN primary_image_url TEXT;
ALTER TABLE ebay_listings ADD COLUMN condition_label TEXT;
ALTER TABLE ebay_listings ADD COLUMN seller_username TEXT;
ALTER TABLE ebay_listings ADD COLUMN seller_feedback_score INTEGER;
ALTER TABLE ebay_listings ADD COLUMN seller_feedback_percent REAL;
ALTER TABLE ebay_listings ADD COLUMN item_location_country TEXT;
ALTER TABLE ebay_listings ADD COLUMN item_location_text TEXT;
ALTER TABLE ebay_listings ADD COLUMN shipping_cost_value REAL;
ALTER TABLE ebay_listings ADD COLUMN shipping_cost_currency TEXT;
ALTER TABLE ebay_listings ADD COLUMN shipping_service TEXT;
ALTER TABLE ebay_listings ADD COLUMN returns_accepted INTEGER CHECK (returns_accepted IN (0, 1));

ALTER TABLE ebay_listing_price_observations ADD COLUMN minimum_bid_price REAL;

CREATE TABLE IF NOT EXISTS exchange_rates (
  exchange_rate_id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  rate_date TEXT NOT NULL,
  base_currency TEXT NOT NULL,
  quote_currency TEXT NOT NULL,
  rate REAL NOT NULL CHECK (rate > 0),
  observed_at TEXT NOT NULL,
  observation_id INTEGER REFERENCES observations(observation_id),
  UNIQUE (source, rate_date, base_currency, quote_currency)
);
CREATE INDEX IF NOT EXISTS idx_exchange_rates_pair_date
  ON exchange_rates(base_currency, quote_currency, rate_date DESC);

CREATE INDEX IF NOT EXISTS idx_ebay_live_dashboard
  ON ebay_listings(match_tier, flagged, is_lot, grade_value, variant_id);
CREATE INDEX IF NOT EXISTS idx_ebay_price_end_bid
  ON ebay_listing_price_observations(item_end_date, bid_count, ebay_listing_id);
