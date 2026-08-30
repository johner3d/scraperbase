-- Native PSA set discovery/mapping. Additive only -- no changes to any
-- existing curated table. Replaces the old dependency on a hand-copied
-- snapshot from the sibling `clean_rewrite` project: scraperbase now
-- discovers PSA "headings" (population-report sets) itself by crawling
-- PSA's own /pop/tcg-cards category tree, and owns the mapping from a PSA
-- heading to a tcgdex `sets` row. See src/sources/psa/collectors/popDiscovery.ts
-- and src/curated/psaSetMatch.ts.

-- One row per PSA population-report "heading" (e.g. headingID 81226 =
-- "Pokemon Promo Black Star"). A heading can legitimately map to the same
-- tcgdex set as other headings (PSA sometimes splits what tcgdex treats as
-- one release into several headings, or vice versa via the `Variety` field
-- inside GetSetItems rows) -- so this is many-to-one by design, not unique
-- on source_set_id.
CREATE TABLE IF NOT EXISTS psa_set_map (
  psa_set_map_id INTEGER PRIMARY KEY AUTOINCREMENT,
  psa_heading_id INTEGER NOT NULL UNIQUE,
  psa_heading_name TEXT NOT NULL,
  psa_heading_slug TEXT,
  psa_heading_year TEXT,
  source_set_id TEXT,
  language TEXT NOT NULL DEFAULT 'en',
  match_status TEXT NOT NULL CHECK (match_status IN ('matched', 'unmatched', 'ambiguous', 'manual')) DEFAULT 'unmatched',
  match_method TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_psa_set_map_status ON psa_set_map(match_status);
CREATE INDEX IF NOT EXISTS idx_psa_set_map_source_set ON psa_set_map(source_set_id);
