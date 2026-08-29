-- Catalogue/pipeline corrections for the staged mobile explorer.

ALTER TABLE runs ADD COLUMN host_name TEXT;
ALTER TABLE runs ADD COLUMN process_id INTEGER;
ALTER TABLE runs ADD COLUMN heartbeat_at TEXT;
ALTER TABLE runs ADD COLUMN stage TEXT;

ALTER TABLE cards ADD COLUMN local_sort_key TEXT NOT NULL DEFAULT '';
ALTER TABLE cards ADD COLUMN detail_status TEXT NOT NULL DEFAULT 'stub'
  CHECK (detail_status IN ('stub', 'hydrated'));

ALTER TABLE variants ADD COLUMN size TEXT;
ALTER TABLE variants ADD COLUMN stamps_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE variants ADD COLUMN identity_status TEXT NOT NULL DEFAULT 'inferred'
  CHECK (identity_status IN ('confirmed', 'inferred', 'review'));

ALTER TABLE psa_population_current ADD COLUMN grade_label TEXT;
ALTER TABLE psa_population_current ADD COLUMN grade_order INTEGER;
ALTER TABLE psa_population_current ADD COLUMN half_grade_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE psa_price_current ADD COLUMN grade_label TEXT;
ALTER TABLE psa_price_current ADD COLUMN grade_order INTEGER;

ALTER TABLE psa_specs ADD COLUMN coverage_cutoff TEXT;
ALTER TABLE psa_specs ADD COLUMN coverage_total_count INTEGER;
ALTER TABLE psa_specs ADD COLUMN coverage_pages_fetched INTEGER;
ALTER TABLE psa_specs ADD COLUMN coverage_complete INTEGER;

ALTER TABLE match_reviews ADD COLUMN issue_key TEXT;

DELETE FROM parser_executions
WHERE execution_id NOT IN (
  SELECT MAX(execution_id)
  FROM parser_executions
  GROUP BY parser_name, parser_version, observation_id
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_parser_execution_once
  ON parser_executions(parser_name, parser_version, observation_id);

CREATE INDEX IF NOT EXISTS idx_cards_natural_sort ON cards(set_id, local_sort_key);
CREATE INDEX IF NOT EXISTS idx_variants_identity
  ON variants(card_id, finish, print_run_marker, micro_variant, size);
CREATE UNIQUE INDEX IF NOT EXISTS idx_assets_one_primary
  ON assets(target_type, target_id, COALESCE(rendition, '')) WHERE is_primary = 1;
CREATE UNIQUE INDEX IF NOT EXISTS idx_psa_sales_fingerprint
  ON psa_sales(sales_spec_pk, sale_fingerprint) WHERE sale_fingerprint IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_match_reviews_issue
  ON match_reviews(issue_key, status);

DROP VIEW IF EXISTS v_card_search;
DROP VIEW IF EXISTS v_variant_search;
DROP VIEW IF EXISTS v_variant_detail;

CREATE VIEW v_card_search AS
SELECT
  c.card_id,
  s.set_id,
  s.language,
  s.source_set_id,
  s.name AS set_name,
  s.series,
  s.release_date,
  c.local_id,
  c.local_sort_key,
  c.detail_status,
  c.number,
  c.name,
  c.category,
  c.rarity,
  c.image_url,
  COUNT(v.variant_id) AS variant_count
FROM cards c
JOIN sets s ON s.set_id = c.set_id
LEFT JOIN variants v ON v.card_id = c.card_id
GROUP BY c.card_id;

-- Deliberately contains no correlated PSA aggregation. The API enriches one
-- result page with one batched query instead of querying PSA once per row.
CREATE VIEW v_variant_search AS
SELECT
  v.variant_id,
  c.card_id,
  s.set_id,
  s.language,
  s.source_set_id,
  s.name AS set_name,
  s.release_date,
  c.local_id,
  c.local_sort_key,
  c.number,
  c.name,
  c.category,
  c.rarity,
  c.image_url,
  v.display_label AS variant_label,
  v.finish,
  v.print_run_marker,
  v.micro_variant,
  v.size,
  v.stamps_json,
  v.identity_status
FROM variants v
JOIN cards c ON c.card_id = v.card_id
JOIN sets s ON s.set_id = c.set_id;

CREATE VIEW v_variant_detail AS
SELECT
  v.variant_id,
  c.card_id,
  c.local_id,
  c.number,
  c.name,
  c.category,
  c.rarity,
  c.attributes_json AS card_attributes_json,
  v.variant_key,
  v.display_label AS variant_label,
  v.finish,
  v.print_run_marker,
  v.micro_variant,
  v.size,
  v.stamps_json,
  v.identity_status,
  v.attributes_json AS variant_attributes_json,
  s.set_id,
  s.language,
  s.source_set_id,
  s.name AS set_name,
  s.series,
  s.release_date,
  (SELECT COUNT(*) FROM source_links sl
    WHERE sl.target_type = 'variant' AND sl.target_id = v.variant_id
      AND sl.match_status IN ('matched', 'manual')) AS matched_source_count,
  (SELECT COUNT(*) FROM assets a
    WHERE a.target_type = 'variant' AND a.target_id = v.variant_id) AS asset_count,
  (SELECT COUNT(*) FROM psa_sales ps
    JOIN psa_specs psp ON psp.psa_spec_pk = ps.sales_spec_pk
    WHERE psp.variant_id = v.variant_id) AS sale_count
FROM variants v
JOIN cards c ON c.card_id = v.card_id
JOIN sets s ON s.set_id = c.set_id;
