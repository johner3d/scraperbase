-- eBay PSA-10 listing matching and price-history tables. Additive only --
-- no changes to any existing curated table. See docs/ebay-raw-fetch.md for
-- the matching design (structured localizedAspects/conditionDescriptors as
-- the primary signal, title text as a lower-confidence fallback).

CREATE TABLE IF NOT EXISTS ebay_listings (
  ebay_listing_id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_record_id INTEGER NOT NULL UNIQUE REFERENCES source_records(source_record_id) ON DELETE CASCADE,
  marketplace TEXT NOT NULL,
  item_id TEXT NOT NULL,
  legacy_item_id TEXT,
  item_web_url TEXT,
  title TEXT NOT NULL,
  -- Generic grader/grade columns (not PSA-only) so no migration is needed
  -- later for CGC/BGS/SGC or other grades. v1 ingestion only creates rows
  -- for grader='PSA', grade_value=10.
  grader TEXT,
  grade_label TEXT,
  grade_value REAL,
  cert_number TEXT,
  extracted_card_name TEXT,
  extracted_card_number TEXT,
  extracted_set_name TEXT,
  extracted_language TEXT,
  is_lot INTEGER NOT NULL DEFAULT 0 CHECK (is_lot IN (0, 1)),
  variant_id INTEGER REFERENCES variants(variant_id) ON DELETE SET NULL,
  match_status TEXT NOT NULL CHECK (match_status IN ('matched', 'unmatched', 'ambiguous', 'manual')) DEFAULT 'unmatched',
  match_method TEXT,
  confidence REAL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  latest_observation_id INTEGER REFERENCES observations(observation_id)
);
CREATE INDEX IF NOT EXISTS idx_ebay_listings_variant ON ebay_listings(variant_id, grade_value);
CREATE INDEX IF NOT EXISTS idx_ebay_listings_status ON ebay_listings(match_status);
CREATE INDEX IF NOT EXISTS idx_ebay_listings_item ON ebay_listings(marketplace, item_id);

-- Append-only, unlike psa_price_current: eBay listings genuinely change
-- price/bid state between daily re-scrapes, and the whole point is to keep
-- that history. Note this is observed asking/bid price, not a confirmed sold
-- price -- eBay's Browse API doesn't expose completed-sale prices.
CREATE TABLE IF NOT EXISTS ebay_listing_price_observations (
  ebay_price_observation_id INTEGER PRIMARY KEY AUTOINCREMENT,
  ebay_listing_id INTEGER NOT NULL REFERENCES ebay_listings(ebay_listing_id) ON DELETE CASCADE,
  observation_id INTEGER REFERENCES observations(observation_id),
  observed_at TEXT NOT NULL,
  price_value REAL,
  price_currency TEXT,
  buying_options_json TEXT NOT NULL DEFAULT '[]',
  current_bid_price REAL,
  bid_count INTEGER,
  item_end_date TEXT,
  snapshot_fingerprint TEXT NOT NULL,
  UNIQUE (ebay_listing_id, snapshot_fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_ebay_price_obs_listing ON ebay_listing_price_observations(ebay_listing_id, observed_at DESC);

CREATE VIEW IF NOT EXISTS v_ebay_listing_latest_price AS
SELECT o.ebay_listing_id, o.price_value, o.price_currency, o.current_bid_price, o.bid_count, o.item_end_date, o.observed_at
FROM ebay_listing_price_observations o
WHERE o.ebay_price_observation_id = (
  SELECT o2.ebay_price_observation_id FROM ebay_listing_price_observations o2
  WHERE o2.ebay_listing_id = o.ebay_listing_id
  ORDER BY o2.observed_at DESC, o2.ebay_price_observation_id DESC LIMIT 1
);

-- The concrete "compare eBay to our PSA-10 price/history" query: one row per
-- variant with our own PSA-10 price/population alongside a live rollup of
-- currently-matched, non-lot PSA-10 eBay listings.
CREATE VIEW IF NOT EXISTS v_ebay_psa10_price_comparison AS
SELECT
  v.variant_id,
  c.card_id,
  c.name AS card_name,
  c.number,
  s.set_id,
  s.name AS set_name,
  s.language,
  (SELECT pc.psa_price FROM psa_price_current pc JOIN psa_specs ps ON ps.psa_spec_pk = pc.population_spec_pk
     WHERE ps.variant_id = v.variant_id AND pc.grade_value = 10 ORDER BY pc.observed_at DESC LIMIT 1) AS psa10_price,
  (SELECT pop.population_count FROM psa_population_current pop JOIN psa_specs ps ON ps.psa_spec_pk = pop.population_spec_pk
     WHERE ps.variant_id = v.variant_id AND pop.grade_value = 10 AND pop.qualified = 0 ORDER BY pop.observed_at DESC LIMIT 1) AS psa10_population,
  COUNT(el.ebay_listing_id) AS ebay_psa10_listing_count,
  MIN(lp.price_value) AS ebay_psa10_min_price,
  AVG(lp.price_value) AS ebay_psa10_avg_price,
  MAX(lp.price_value) AS ebay_psa10_max_price,
  MAX(lp.observed_at) AS ebay_psa10_last_observed_at
FROM variants v
JOIN cards c ON c.card_id = v.card_id
JOIN sets s ON s.set_id = c.set_id
LEFT JOIN ebay_listings el ON el.variant_id = v.variant_id AND el.grade_value = 10
  AND el.match_status IN ('matched', 'manual') AND el.is_lot = 0
LEFT JOIN v_ebay_listing_latest_price lp ON lp.ebay_listing_id = el.ebay_listing_id
GROUP BY v.variant_id;
