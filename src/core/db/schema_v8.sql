-- eBay listing -> card/variant matching v2.
--
-- v1 resolved a listing by card number alone and only accepted a match when
-- exactly one variant survived, which linked 57 of 4,650 PSA-10 listings. The
-- new matcher (src/curated/ebay/) gathers every available signal, resolves the
-- SET first, generates candidates from several independent blockers and scores
-- them, so these columns record what it decided and why.
--
-- Additive only. `match_status` keeps its original four-value domain so the
-- existing views, API and FK from ebay_listing_price_observations stay valid;
-- the wider outcome vocabulary (out-of-scope listings, lots, confidence tiers)
-- lives in `match_tier` instead of forcing a table rebuild.

-- The card the listing was resolved to. Populated even when `variant_id` is
-- NULL: eBay listings almost never state finish/print run, so a confident
-- card-level answer plus an honest "which variant is unproven" is far more
-- useful than refusing to match at all.
ALTER TABLE ebay_listings ADD COLUMN card_id INTEGER REFERENCES cards(card_id) ON DELETE SET NULL;

-- exact       -- deterministic bridge (PSA cert), effectively certain
-- strong      -- score and margin both above the auto-accept thresholds
-- card-level  -- one card, several candidate variants, finish unproven
-- flagged     -- accepted but worth a human glance; NOT in the review queue
-- review      -- queued for manual matching
-- lot         -- multi-card listing, cannot map to one variant
-- out-of-scope-- not a Pokemon single (other TCGs, sealed product)
ALTER TABLE ebay_listings ADD COLUMN match_tier TEXT;
ALTER TABLE ebay_listings ADD COLUMN flagged INTEGER NOT NULL DEFAULT 0 CHECK (flagged IN (0, 1));

-- Winning score and the runner-up it beat. The margin between them is what
-- separates "one obvious answer" from "two equally plausible ones", so both
-- are kept for threshold tuning and for the review UI.
ALTER TABLE ebay_listings ADD COLUMN score REAL;
ALTER TABLE ebay_listings ADD COLUMN runner_up_score REAL;

-- proven | card-level | none -- how far the variant answer is actually backed
-- by finish/edition evidence in the listing.
ALTER TABLE ebay_listings ADD COLUMN variant_confidence TEXT;

-- The extracted ListingEvidence plus the winning score breakdown, so a review
-- can be judged without re-reading the raw payload, and so a regression in
-- extraction is visible in the database rather than only at runtime.
ALTER TABLE ebay_listings ADD COLUMN signals_json TEXT NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_ebay_listings_card ON ebay_listings(card_id);
CREATE INDEX IF NOT EXISTS idx_ebay_listings_tier ON ebay_listings(match_tier);

-- Free-text set name (as written by an eBay seller, or auto-translated by
-- eBay itself) -> tcgdex set. Two origins:
--   curated -- seeded from data/aliases/ebay-sets.json, hand-checked
--   learned -- recorded when a human resolves a review, so every sibling
--              listing with the same set text matches on the next run
-- alias_text is already normalizePart()-ed by the writer.
CREATE TABLE IF NOT EXISTS ebay_set_aliases (
  ebay_set_alias_id INTEGER PRIMARY KEY AUTOINCREMENT,
  alias_text TEXT NOT NULL,
  language TEXT,
  source_set_id TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('curated', 'learned')),
  created_at TEXT NOT NULL,
  UNIQUE (alias_text, language, source_set_id)
);
CREATE INDEX IF NOT EXISTS idx_ebay_set_aliases_text ON ebay_set_aliases(alias_text);

-- Blocking indexes for candidate generation. Card numbers are looked up
-- across the whole 56k-card catalogue on every listing, in both the
-- printed-number and the tcgdex local-id form.
CREATE INDEX IF NOT EXISTS idx_cards_number ON cards(number);
CREATE INDEX IF NOT EXISTS idx_cards_local_id ON cards(local_id);
