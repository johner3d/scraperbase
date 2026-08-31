-- Widen v_ebay_listing_latest_price so the live-auction-view predicate
-- (src/curated/ebay/liveAuctionScope.ts) can read buying options and the
-- minimum bid off the latest observation without re-joining the raw table.

DROP VIEW IF EXISTS v_ebay_listing_latest_price;
CREATE VIEW v_ebay_listing_latest_price AS
SELECT o.ebay_listing_id, o.price_value, o.price_currency, o.current_bid_price, o.minimum_bid_price,
  o.bid_count, o.buying_options_json, o.item_end_date, o.observed_at
FROM ebay_listing_price_observations o
WHERE o.ebay_price_observation_id = (
  SELECT o2.ebay_price_observation_id FROM ebay_listing_price_observations o2
  WHERE o2.ebay_listing_id = o.ebay_listing_id
  ORDER BY o2.observed_at DESC, o2.ebay_price_observation_id DESC LIMIT 1
);

PRAGMA optimize;
