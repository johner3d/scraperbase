-- Professional pipeline orchestration, provenance and immutable publication.

CREATE TABLE IF NOT EXISTS pipeline_runs (
  pipeline_run_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running','completed','failed','cancelled')),
  active_stage TEXT,
  config_json TEXT NOT NULL,
  error_message TEXT,
  resumed_from TEXT REFERENCES pipeline_runs(pipeline_run_id)
);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_status ON pipeline_runs(status, created_at DESC);

CREATE TABLE IF NOT EXISTS pipeline_stages (
  pipeline_run_id TEXT NOT NULL REFERENCES pipeline_runs(pipeline_run_id) ON DELETE CASCADE,
  stage_name TEXT NOT NULL,
  stage_order INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','running','completed','failed','skipped')) DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  ended_at TEXT,
  summary_json TEXT,
  error_message TEXT,
  PRIMARY KEY (pipeline_run_id, stage_name)
);
CREATE INDEX IF NOT EXISTS idx_pipeline_stages_status ON pipeline_stages(pipeline_run_id, status, stage_order);

CREATE TABLE IF NOT EXISTS ebay_campaigns (
  campaign_id TEXT PRIMARY KEY,
  pipeline_run_id TEXT NOT NULL REFERENCES pipeline_runs(pipeline_run_id) ON DELETE CASCADE,
  query_text TEXT NOT NULL,
  normalized_query TEXT NOT NULL,
  marketplace TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','running','complete','incomplete','failed')) DEFAULT 'pending',
  coverage_status TEXT NOT NULL CHECK (coverage_status IN ('unknown','complete','api_window','quota_paused','failed')) DEFAULT 'unknown',
  total_reported INTEGER,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (pipeline_run_id, normalized_query, marketplace)
);
CREATE INDEX IF NOT EXISTS idx_ebay_campaigns_run ON ebay_campaigns(pipeline_run_id, marketplace);

CREATE TABLE IF NOT EXISTS ebay_campaign_items (
  campaign_id TEXT NOT NULL REFERENCES ebay_campaigns(campaign_id) ON DELETE CASCADE,
  marketplace TEXT NOT NULL,
  item_id TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (campaign_id, marketplace, item_id)
);
CREATE INDEX IF NOT EXISTS idx_ebay_campaign_items_item ON ebay_campaign_items(marketplace, item_id);

CREATE TABLE IF NOT EXISTS match_decision_revisions (
  match_decision_revision_id INTEGER PRIMARY KEY AUTOINCREMENT,
  pipeline_run_id TEXT REFERENCES pipeline_runs(pipeline_run_id),
  source_record_id INTEGER NOT NULL REFERENCES source_records(source_record_id) ON DELETE CASCADE,
  observation_id INTEGER REFERENCES observations(observation_id),
  matcher_version TEXT NOT NULL,
  decision_hash TEXT NOT NULL,
  target_type TEXT CHECK (target_type IN ('card','variant')),
  target_id INTEGER,
  match_status TEXT NOT NULL CHECK (match_status IN ('matched','unmatched','ambiguous','manual')),
  match_tier TEXT NOT NULL,
  score REAL,
  runner_up_score REAL,
  reason TEXT,
  signals_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (source_record_id, observation_id, matcher_version, decision_hash)
);
CREATE INDEX IF NOT EXISTS idx_match_decisions_source ON match_decision_revisions(source_record_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_match_decisions_run ON match_decision_revisions(pipeline_run_id, match_tier);

CREATE TABLE IF NOT EXISTS match_override_revisions (
  match_override_revision_id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_record_id INTEGER REFERENCES source_records(source_record_id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('card','variant','set')),
  target_id TEXT,
  action TEXT NOT NULL CHECK (action IN ('activate','revoke','dismiss')),
  reviewer TEXT NOT NULL,
  note TEXT NOT NULL,
  supersedes_revision_id INTEGER REFERENCES match_override_revisions(match_override_revision_id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_match_override_revisions_source ON match_override_revisions(source_record_id, created_at DESC);

CREATE TABLE IF NOT EXISTS pipeline_gaps (
  pipeline_gap_id INTEGER PRIMARY KEY AUTOINCREMENT,
  pipeline_run_id TEXT NOT NULL REFERENCES pipeline_runs(pipeline_run_id) ON DELETE CASCADE,
  gap_type TEXT NOT NULL CHECK (gap_type IN ('catalogue-gap','psa-identity-gap','card-level','flagged','review','out-of-scope','lot')),
  source_record_id INTEGER REFERENCES source_records(source_record_id) ON DELETE SET NULL,
  subject TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE (pipeline_run_id, gap_type, source_record_id, subject)
);
CREATE INDEX IF NOT EXISTS idx_pipeline_gaps_run ON pipeline_gaps(pipeline_run_id, gap_type);

CREATE TABLE IF NOT EXISTS publication_generations (
  generation_id TEXT PRIMARY KEY,
  pipeline_run_id TEXT REFERENCES pipeline_runs(pipeline_run_id),
  status TEXT NOT NULL CHECK (status IN ('assembling','validated','published','failed')),
  snapshot_path TEXT,
  manifest_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  validated_at TEXT,
  published_at TEXT,
  error_message TEXT
);
CREATE INDEX IF NOT EXISTS idx_publication_generations_status ON publication_generations(status, published_at DESC);

CREATE TABLE IF NOT EXISTS publication_state (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  active_generation_id TEXT REFERENCES publication_generations(generation_id),
  updated_at TEXT NOT NULL
);
INSERT OR IGNORE INTO publication_state(singleton_id, active_generation_id, updated_at)
VALUES (1, NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'));

ALTER TABLE match_reviews ADD COLUMN resolved_by TEXT;
ALTER TABLE match_reviews ADD COLUMN resolution_note TEXT;
ALTER TABLE match_reviews ADD COLUMN resolution_target_type TEXT;
ALTER TABLE match_reviews ADD COLUMN resolution_target_id TEXT;
