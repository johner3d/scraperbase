-- Durable quota pauses, immutable PSA target manifests and explicit coverage.

ALTER TABLE ebay_campaigns ADD COLUMN resume_after TEXT;
ALTER TABLE ebay_campaigns ADD COLUMN pause_reason TEXT;

CREATE TABLE IF NOT EXISTS pipeline_pauses (
  pipeline_pause_id INTEGER PRIMARY KEY AUTOINCREMENT,
  pipeline_run_id TEXT NOT NULL REFERENCES pipeline_runs(pipeline_run_id) ON DELETE CASCADE,
  stage_name TEXT NOT NULL,
  source TEXT NOT NULL,
  reason TEXT NOT NULL,
  resume_after TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_pipeline_pauses_active
  ON pipeline_pauses(pipeline_run_id, resolved_at, created_at DESC);

CREATE TABLE IF NOT EXISTS pipeline_psa_targets (
  pipeline_psa_target_id INTEGER PRIMARY KEY AUTOINCREMENT,
  pipeline_run_id TEXT NOT NULL REFERENCES pipeline_runs(pipeline_run_id) ON DELETE CASCADE,
  population_spec_id TEXT NOT NULL,
  sales_spec_id TEXT,
  variant_id INTEGER NOT NULL REFERENCES variants(variant_id) ON DELETE RESTRICT,
  source_set_id TEXT NOT NULL,
  source_card_id TEXT NOT NULL,
  finish TEXT NOT NULL,
  print_run_marker TEXT NOT NULL,
  micro_variant TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (pipeline_run_id, population_spec_id, variant_id)
);
CREATE INDEX IF NOT EXISTS idx_pipeline_psa_targets_run
  ON pipeline_psa_targets(pipeline_run_id, variant_id);

CREATE TABLE IF NOT EXISTS pipeline_psa_target_listings (
  pipeline_psa_target_id INTEGER NOT NULL REFERENCES pipeline_psa_targets(pipeline_psa_target_id) ON DELETE CASCADE,
  ebay_listing_id INTEGER NOT NULL REFERENCES ebay_listings(ebay_listing_id) ON DELETE CASCADE,
  PRIMARY KEY (pipeline_psa_target_id, ebay_listing_id)
);
CREATE INDEX IF NOT EXISTS idx_pipeline_psa_target_listings_listing
  ON pipeline_psa_target_listings(ebay_listing_id);

CREATE TABLE IF NOT EXISTS pipeline_psa_coverage (
  pipeline_psa_target_id INTEGER NOT NULL REFERENCES pipeline_psa_targets(pipeline_psa_target_id) ON DELETE CASCADE,
  phase TEXT NOT NULL CHECK (phase IN ('population','guide','sales')),
  status TEXT NOT NULL CHECK (status IN
    ('pending','identity_missing','raw_missing','raw_present','processed','no_data','rate_limited','failed')),
  raw_observation_id INTEGER REFERENCES observations(observation_id),
  source_record_id INTEGER REFERENCES source_records(source_record_id),
  row_count INTEGER,
  detail_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (pipeline_psa_target_id, phase)
);
CREATE INDEX IF NOT EXISTS idx_pipeline_psa_coverage_status
  ON pipeline_psa_coverage(status, phase, updated_at);

PRAGMA optimize;
