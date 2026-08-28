-- Schema version 1. Applied once via PRAGMA user_version gating in client.ts.
-- All CREATE statements are idempotent (IF NOT EXISTS) so this file can be
-- safely re-run.

-- Operational sessions (a process invocation of `run`/`resume`), not the durable queue itself.
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running','completed','failed','cancelled')),
  cli_command TEXT NOT NULL,
  config_json TEXT NOT NULL
);

-- The durable, shared, cross-run work queue. Idempotency key = (source, queue, scope_key).
CREATE TABLE IF NOT EXISTS work_items (
  work_item_id TEXT PRIMARY KEY,           -- readable: "<source>::<queue>::<scope_key>"
  source TEXT NOT NULL,                    -- 'tcgdex' | 'psa'
  queue TEXT NOT NULL,                     -- catalogue_json | images | psa_discovery |
                                            -- psa_population | psa_cardfacts_html | psa_sales
  entity_type TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  params_json TEXT NOT NULL,               -- pagination cursor, grade/qualifier filters, etc.
  priority INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL CHECK (state IN
    ('pending','leased','running','succeeded','retryable_failed','permanent_failed',
     'partial','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 8,
  lease_owner TEXT,
  lease_expires_at TEXT,
  available_at TEXT NOT NULL,              -- backoff scheduling; not claimable before this
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_error TEXT,
  depends_on TEXT REFERENCES work_items(work_item_id),
  UNIQUE (source, queue, scope_key)
);
CREATE INDEX IF NOT EXISTS idx_work_items_claimable ON work_items(queue, state, available_at);

-- One row per physical network/browser operation (every attempt, incl. failures & unchanged).
CREATE TABLE IF NOT EXISTS attempts (
  attempt_id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_item_id TEXT NOT NULL REFERENCES work_items(work_item_id),
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN
    ('success','unchanged','failure','timeout','rate_limited','auth_redirect','schema_drift')),
  http_status INTEGER,
  request_method TEXT,
  request_url TEXT,
  request_params_json TEXT,
  response_headers_json TEXT,              -- allowlisted headers only, never cookies/auth
  byte_size INTEGER,
  duration_ms INTEGER,
  retry_after_ms INTEGER,
  error_message TEXT,
  content_hash TEXT REFERENCES raw_objects(hash),
  source_identity TEXT NOT NULL            -- e.g. 'tcgdex:en' or 'psa:browser-profile-1'
);
CREATE INDEX IF NOT EXISTS idx_attempts_work_item ON attempts(work_item_id);

-- Content-addressed metadata; bytes live on disk under data/objects/.
CREATE TABLE IF NOT EXISTS raw_objects (
  hash TEXT PRIMARY KEY,                   -- sha256 hex
  media_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  first_seen_at TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  compression TEXT
);

-- Append-only ledger: "at time T, this work item observed this content." Never overwritten.
CREATE TABLE IF NOT EXISTS observations (
  observation_id INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_id INTEGER NOT NULL REFERENCES attempts(attempt_id),
  work_item_id TEXT NOT NULL REFERENCES work_items(work_item_id),
  hash TEXT NOT NULL REFERENCES raw_objects(hash),
  observed_at TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  is_first_observation_of_hash INTEGER NOT NULL,
  sale_fingerprint TEXT                    -- PSA sales only: hash(auction_house,lot,date,price,
);                                          -- cert) for dedup; NOT parsing, just an idempotency key
CREATE INDEX IF NOT EXISTS idx_observations_scope ON observations(entity_type, scope_key);

-- Structural relationships, incl. the two PSA namespaces linked without assuming equality.
CREATE TABLE IF NOT EXISTS relationships (
  relationship_id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_type TEXT NOT NULL,
  from_key TEXT NOT NULL,
  to_type TEXT NOT NULL,
  to_key TEXT NOT NULL,
  relationship_type TEXT NOT NULL,         -- e.g. 'psa_cardfacts_links_to_apr_spec'
  confidence REAL,                         -- null/1.0 for structurally-discovered links
  source_of_truth TEXT NOT NULL,           -- e.g. 'psa_cardfacts_html'
  created_at TEXT NOT NULL
);

-- Explicit separate-namespace registry PSA requires.
CREATE TABLE IF NOT EXISTS psa_identity_map (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  namespace TEXT NOT NULL CHECK (namespace IN ('population','sales')),
  source_id TEXT NOT NULL,
  entity_key TEXT NOT NULL,
  discovered_at TEXT NOT NULL,
  UNIQUE (namespace, source_id)
);

-- Pagination/coverage checkpoints -- page-level, not just card-level.
CREATE TABLE IF NOT EXISTS coverage (
  coverage_id TEXT PRIMARY KEY,            -- scope key, e.g. 'psa:sales:specId=190786:grade=10'
  source TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('in_progress','complete','cutoff','unknown')),
  last_page_completed INTEGER,
  cursor_json TEXT,
  exhaustion_evidence TEXT,                -- 'source_exhausted' | 'page_cap_reached' |
                                            -- 'user_cutoff' | 'auth_failure' | 'transient_failure'
  updated_at TEXT NOT NULL
);

-- Versioned, rerunnable parser contract (schema only for now; no parsers implemented yet).
CREATE TABLE IF NOT EXISTS parser_executions (
  execution_id INTEGER PRIMARY KEY AUTOINCREMENT,
  parser_name TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  observation_id INTEGER NOT NULL REFERENCES observations(observation_id),
  executed_at TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('success','failure','partial')),
  error_message TEXT,
  output_summary_json TEXT
);

CREATE TABLE IF NOT EXISTS events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT REFERENCES runs(run_id),
  ts TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('info','warn','error')),
  category TEXT NOT NULL,   -- acquisition|coverage|parsing|matching|system|auth|schema_drift|...
  message TEXT NOT NULL,
  data_json TEXT
);

CREATE TABLE IF NOT EXISTS counters (
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  metric_name TEXT NOT NULL,
  value INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, metric_name)
);
