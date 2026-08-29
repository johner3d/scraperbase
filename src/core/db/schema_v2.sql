-- Curated catalogue and application-facing facts.
-- Raw acquisition tables remain in schema.sql and are intentionally not
-- replaced by these tables.

CREATE TABLE IF NOT EXISTS source_records (
  source_record_id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  namespace TEXT NOT NULL,
  source_key TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  language TEXT,
  latest_observation_id INTEGER REFERENCES observations(observation_id),
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  parser_name TEXT,
  parser_version TEXT,
  UNIQUE (source, namespace, source_key)
);
CREATE INDEX IF NOT EXISTS idx_source_records_entity
  ON source_records(source, entity_type, language);

CREATE TABLE IF NOT EXISTS sets (
  set_id INTEGER PRIMARY KEY AUTOINCREMENT,
  language TEXT NOT NULL,
  source_set_id TEXT NOT NULL,
  name TEXT NOT NULL,
  series TEXT,
  release_date TEXT,
  total_cards INTEGER,
  official_cards INTEGER,
  logo_url TEXT,
  symbol_url TEXT,
  source_record_id INTEGER REFERENCES source_records(source_record_id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (language, source_set_id)
);
CREATE INDEX IF NOT EXISTS idx_sets_language_name ON sets(language, name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS cards (
  card_id INTEGER PRIMARY KEY AUTOINCREMENT,
  set_id INTEGER NOT NULL REFERENCES sets(set_id) ON DELETE CASCADE,
  local_id TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT,
  rarity TEXT,
  number TEXT,
  image_url TEXT,
  attributes_json TEXT NOT NULL DEFAULT '{}',
  source_record_id INTEGER REFERENCES source_records(source_record_id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (set_id, local_id)
);
CREATE INDEX IF NOT EXISTS idx_cards_set_local ON cards(set_id, local_id);
CREATE INDEX IF NOT EXISTS idx_cards_name ON cards(name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS variants (
  variant_id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id INTEGER NOT NULL REFERENCES cards(card_id) ON DELETE CASCADE,
  variant_key TEXT NOT NULL,
  finish TEXT,
  print_run_marker TEXT,
  micro_variant TEXT,
  display_label TEXT NOT NULL,
  attributes_json TEXT NOT NULL DEFAULT '{}',
  source_record_id INTEGER REFERENCES source_records(source_record_id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (card_id, variant_key)
);
CREATE INDEX IF NOT EXISTS idx_variants_card ON variants(card_id);
CREATE INDEX IF NOT EXISTS idx_variants_filters ON variants(finish, print_run_marker, micro_variant);

CREATE TABLE IF NOT EXISTS source_links (
  source_link_id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_record_id INTEGER NOT NULL REFERENCES source_records(source_record_id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('set', 'card', 'variant', 'psa_spec')),
  target_id INTEGER NOT NULL,
  match_status TEXT NOT NULL CHECK (match_status IN ('matched', 'unmatched', 'ambiguous', 'manual')),
  confidence REAL,
  match_method TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE (source_record_id, target_type, target_id)
);
CREATE INDEX IF NOT EXISTS idx_source_links_target ON source_links(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_source_links_status ON source_links(match_status);

CREATE TABLE IF NOT EXISTS match_reviews (
  match_review_id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_record_id INTEGER NOT NULL REFERENCES source_records(source_record_id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('set', 'card', 'variant')),
  candidate_target_id INTEGER,
  reason TEXT NOT NULL,
  candidates_json TEXT,
  status TEXT NOT NULL CHECK (status IN ('open', 'resolved', 'dismissed')) DEFAULT 'open',
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  UNIQUE (source_record_id, target_type, status)
);
CREATE INDEX IF NOT EXISTS idx_match_reviews_open ON match_reviews(status, target_type);

CREATE TABLE IF NOT EXISTS match_overrides (
  match_override_id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_record_id INTEGER NOT NULL REFERENCES source_records(source_record_id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('card', 'variant')),
  target_id INTEGER NOT NULL,
  note TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  UNIQUE (source_record_id, target_type)
);
CREATE INDEX IF NOT EXISTS idx_match_overrides_active ON match_overrides(source_record_id, active);

CREATE TABLE IF NOT EXISTS assets (
  asset_id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_record_id INTEGER REFERENCES source_records(source_record_id),
  target_type TEXT NOT NULL CHECK (target_type IN ('set', 'card', 'variant')),
  target_id INTEGER NOT NULL,
  object_hash TEXT REFERENCES raw_objects(hash),
  url TEXT NOT NULL,
  rendition TEXT,
  media_type TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (target_type, target_id, url, rendition)
);
CREATE INDEX IF NOT EXISTS idx_assets_target ON assets(target_type, target_id, is_primary);

CREATE TABLE IF NOT EXISTS psa_specs (
  psa_spec_pk INTEGER PRIMARY KEY AUTOINCREMENT,
  namespace TEXT NOT NULL CHECK (namespace IN ('population', 'sales')),
  spec_id TEXT NOT NULL,
  source_record_id INTEGER REFERENCES source_records(source_record_id),
  variant_id INTEGER REFERENCES variants(variant_id) ON DELETE SET NULL,
  release TEXT,
  source_card_id TEXT,
  finish TEXT,
  print_run_marker TEXT,
  micro_variant TEXT,
  source_url TEXT,
  match_status TEXT NOT NULL CHECK (match_status IN ('matched', 'unmatched', 'ambiguous', 'manual')) DEFAULT 'unmatched',
  match_method TEXT,
  fetched_at TEXT,
  UNIQUE (namespace, spec_id)
);
CREATE INDEX IF NOT EXISTS idx_psa_specs_variant ON psa_specs(variant_id, namespace);
CREATE INDEX IF NOT EXISTS idx_psa_specs_source_card ON psa_specs(release, source_card_id, finish, print_run_marker, micro_variant);

CREATE TABLE IF NOT EXISTS psa_spec_pairs (
  population_spec_pk INTEGER PRIMARY KEY REFERENCES psa_specs(psa_spec_pk) ON DELETE CASCADE,
  sales_spec_pk INTEGER NOT NULL UNIQUE REFERENCES psa_specs(psa_spec_pk) ON DELETE CASCADE,
  link_method TEXT NOT NULL,
  confidence REAL NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS psa_population_current (
  population_row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  population_spec_pk INTEGER NOT NULL REFERENCES psa_specs(psa_spec_pk) ON DELETE CASCADE,
  grade_key TEXT NOT NULL,
  grade_value REAL,
  qualified INTEGER NOT NULL CHECK (qualified IN (0, 1)),
  population_count INTEGER NOT NULL,
  total_population INTEGER,
  half_grade_total INTEGER,
  qualified_total INTEGER,
  observed_at TEXT NOT NULL,
  observation_id INTEGER REFERENCES observations(observation_id),
  UNIQUE (population_spec_pk, grade_key, qualified)
);
CREATE INDEX IF NOT EXISTS idx_psa_population_grade ON psa_population_current(population_spec_pk, grade_value, qualified);

CREATE TABLE IF NOT EXISTS psa_price_current (
  price_row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  population_spec_pk INTEGER NOT NULL REFERENCES psa_specs(psa_spec_pk) ON DELETE CASCADE,
  grade_key TEXT NOT NULL,
  grade_value REAL,
  most_recent_price REAL,
  average_price REAL,
  psa_price REAL,
  observed_at TEXT NOT NULL,
  observation_id INTEGER REFERENCES observations(observation_id),
  UNIQUE (population_spec_pk, grade_key)
);

CREATE TABLE IF NOT EXISTS psa_census_current (
  census_row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  population_spec_pk INTEGER NOT NULL REFERENCES psa_specs(psa_spec_pk) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  grade_label TEXT NOT NULL,
  grade_value REAL,
  population_count INTEGER,
  pedigree TEXT,
  observed_at TEXT NOT NULL,
  observation_id INTEGER REFERENCES observations(observation_id),
  UNIQUE (population_spec_pk, position)
);

CREATE TABLE IF NOT EXISTS psa_sales (
  sale_row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  sales_spec_pk INTEGER NOT NULL REFERENCES psa_specs(psa_spec_pk) ON DELETE CASCADE,
  sale_item_id TEXT NOT NULL,
  cert_number TEXT,
  auction_house TEXT,
  sale_date TEXT,
  sale_type TEXT,
  sale_price REAL,
  currency TEXT NOT NULL DEFAULT 'USD',
  grade_value REAL,
  lot_number TEXT,
  listing_url TEXT,
  image_url TEXT,
  thumbnail_url TEXT,
  qualifier_code TEXT,
  dna_grade_value REAL,
  grading_company TEXT,
  sale_fingerprint TEXT,
  observed_at TEXT NOT NULL,
  observation_id INTEGER REFERENCES observations(observation_id),
  UNIQUE (sales_spec_pk, sale_item_id)
);
CREATE INDEX IF NOT EXISTS idx_psa_sales_date ON psa_sales(sales_spec_pk, sale_date DESC);
CREATE INDEX IF NOT EXISTS idx_psa_sales_price ON psa_sales(sale_price);

CREATE VIEW IF NOT EXISTS v_card_search AS
SELECT
  c.card_id,
  s.set_id,
  s.language,
  s.source_set_id,
  s.name AS set_name,
  s.series,
  s.release_date,
  c.local_id,
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

CREATE VIEW IF NOT EXISTS v_variant_search AS
SELECT
  v.variant_id,
  c.card_id,
  s.set_id,
  s.language,
  s.source_set_id,
  s.name AS set_name,
  c.local_id,
  c.number,
  c.name,
  v.display_label AS variant_label,
  v.finish,
  v.print_run_marker,
  v.micro_variant,
  COALESCE((SELECT MAX(p.total_population) FROM psa_population_current p JOIN psa_specs ps ON ps.psa_spec_pk = p.population_spec_pk WHERE ps.variant_id = v.variant_id), 0) AS psa_population_total,
  COALESCE((SELECT SUM(p.population_count) FROM psa_population_current p JOIN psa_specs ps ON ps.psa_spec_pk = p.population_spec_pk WHERE ps.variant_id = v.variant_id AND p.grade_value = 10), 0) AS psa10_population,
  (SELECT pc.psa_price FROM psa_price_current pc JOIN psa_specs ps ON ps.psa_spec_pk = pc.population_spec_pk WHERE ps.variant_id = v.variant_id AND pc.grade_value = 10 ORDER BY pc.observed_at DESC LIMIT 1) AS latest_psa10_price,
  (SELECT sale_price FROM psa_sales sl JOIN psa_specs ps ON ps.psa_spec_pk = sl.sales_spec_pk WHERE ps.variant_id = v.variant_id ORDER BY sl.sale_date DESC LIMIT 1) AS latest_sale_price,
  (SELECT sale_date FROM psa_sales sl JOIN psa_specs ps ON ps.psa_spec_pk = sl.sales_spec_pk WHERE ps.variant_id = v.variant_id ORDER BY sl.sale_date DESC LIMIT 1) AS latest_sale_date,
  (SELECT COUNT(*) FROM psa_sales sl JOIN psa_specs ps ON ps.psa_spec_pk = sl.sales_spec_pk WHERE ps.variant_id = v.variant_id) AS sale_count
FROM variants v
JOIN cards c ON c.card_id = v.card_id
JOIN sets s ON s.set_id = c.set_id;

CREATE VIEW IF NOT EXISTS v_variant_detail AS
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
  v.attributes_json AS variant_attributes_json,
  s.set_id,
  s.language,
  s.source_set_id,
  s.name AS set_name,
  s.series,
  s.release_date,
  (SELECT COUNT(*) FROM source_links sl WHERE sl.target_type = 'variant' AND sl.target_id = v.variant_id AND sl.match_status IN ('matched', 'manual')) AS matched_source_count,
  (SELECT COUNT(*) FROM assets a WHERE a.target_type = 'variant' AND a.target_id = v.variant_id) AS asset_count,
  (SELECT COUNT(*) FROM psa_sales ps JOIN psa_specs psp ON psp.psa_spec_pk = ps.sales_spec_pk WHERE psp.variant_id = v.variant_id) AS sale_count
FROM variants v
JOIN cards c ON c.card_id = v.card_id
JOIN sets s ON s.set_id = c.set_id;

CREATE VIEW IF NOT EXISTS v_open_match_reviews AS
SELECT
  mr.match_review_id,
  mr.source_record_id,
  sr.source,
  sr.namespace,
  sr.source_key,
  sr.entity_type,
  sr.language,
  mr.target_type,
  mr.candidate_target_id,
  mr.reason,
  mr.candidates_json,
  mr.created_at
FROM match_reviews mr
JOIN source_records sr ON sr.source_record_id = mr.source_record_id
WHERE mr.status = 'open';
