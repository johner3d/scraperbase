-- Streamlined pipeline: managed eBay search terms, per-stage live status,
-- a visible dead-letter queue, an incremental-materialize dirty set, and a
-- single-row supervisor state. All additive.

-- ---------------------------------------------------------------------------
-- Persistent, per-term-configurable eBay searches. Replaces one-shot --query
-- args as the source of what the pipeline watches. Each row carries the eBay
-- Browse API knobs that keep a search targeted and cheap.
CREATE TABLE IF NOT EXISTS ebay_search_terms (
  search_term_id           INTEGER PRIMARY KEY AUTOINCREMENT,
  query_text               TEXT NOT NULL,
  normalized_query         TEXT NOT NULL,
  marketplace              TEXT NOT NULL,
  buying_option            TEXT NOT NULL DEFAULT 'auction' CHECK (buying_option IN ('auction','fixed','all')),
  min_bids                 INTEGER NOT NULL DEFAULT 1,
  ending_within_hours      INTEGER,
  price_min                REAL,
  price_max                REAL,
  category_ids             TEXT,
  refresh_interval_minutes INTEGER NOT NULL DEFAULT 30,
  max_items                INTEGER NOT NULL DEFAULT 500,
  daily_call_budget        INTEGER,
  priority                 INTEGER NOT NULL DEFAULT 0,
  enabled                  INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  last_enqueued_at         TEXT,
  last_completed_at        TEXT,
  last_result_count        INTEGER,
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL,
  UNIQUE (normalized_query, marketplace, buying_option)
);
CREATE INDEX IF NOT EXISTS idx_ebay_search_terms_due
  ON ebay_search_terms(enabled, priority DESC, last_enqueued_at);

-- Group the per-refresh execution record (ebay_campaigns) back to its term so
-- the dashboard funnel can be shown per search. NULL for one-off `pipeline run`
-- campaigns.
ALTER TABLE ebay_campaigns ADD COLUMN search_term_id INTEGER REFERENCES ebay_search_terms(search_term_id);

-- ---------------------------------------------------------------------------
-- One row per pipeline stage, upserted by the supervisor on every tick so the
-- UI can show live state without inspecting the work queue itself.
CREATE TABLE IF NOT EXISTS pipeline_stage_status (
  stage             TEXT PRIMARY KEY,
  state             TEXT NOT NULL DEFAULT 'idle'
                      CHECK (state IN ('idle','working','backing_off','paused','stalled')),
  last_activity_at  TEXT,
  last_tick_at      TEXT,
  items_done_total  INTEGER NOT NULL DEFAULT 0,
  items_done_window INTEGER NOT NULL DEFAULT 0,
  window_started_at TEXT,
  dead_letter_open  INTEGER NOT NULL DEFAULT 0,
  next_eligible_at  TEXT,
  note              TEXT
);
INSERT OR IGNORE INTO pipeline_stage_status(stage) VALUES
  ('ingest'),('ebay-match'),('psa-cert'),('psa-identity'),('psa-fetch'),('publish'),('reconcile');

-- ---------------------------------------------------------------------------
-- Items a stage gave up on (work_item exhausted its attempts). Surfaced in the
-- UI and cleared by `pipeline retry`. A stage records these and keeps going
-- instead of aborting the whole run.
CREATE TABLE IF NOT EXISTS pipeline_dead_letters (
  dead_letter_id INTEGER PRIMARY KEY AUTOINCREMENT,
  stage          TEXT NOT NULL,
  scope_key      TEXT NOT NULL,
  work_item_id   TEXT REFERENCES work_items(work_item_id),
  reason         TEXT NOT NULL,
  detail_json    TEXT NOT NULL DEFAULT '{}',
  first_seen_at  TEXT NOT NULL,
  last_seen_at   TEXT NOT NULL,
  resolved_at    TEXT,
  UNIQUE (stage, scope_key)
);
CREATE INDEX IF NOT EXISTS idx_pipeline_dead_letters_open
  ON pipeline_dead_letters(stage, resolved_at);

-- ---------------------------------------------------------------------------
-- Incremental-materialize dirty set: an eBay item-detail fetch marks the item's
-- observation scope key here (source record may not exist yet at fetch time);
-- tickEbayMatch re-materializes just these and clears them.
CREATE TABLE IF NOT EXISTS materialize_dirty (
  kind        TEXT NOT NULL CHECK (kind IN ('ebay-item','psa-spec')),
  ref         TEXT NOT NULL,
  marked_at   TEXT NOT NULL,
  PRIMARY KEY (kind, ref)
);

-- ---------------------------------------------------------------------------
-- Single long-lived supervisor. run_id ties every stage's sub-runs and the
-- exclusive-writer lock to one process; publish_dirty/last_publish_at drive the
-- debounced publish stage.
CREATE TABLE IF NOT EXISTS pipeline_supervisor_state (
  singleton_id     INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  run_id           TEXT,               -- the exclusive-writer `runs` row
  pipeline_run_id  TEXT,               -- the `pipeline_runs` row for pipeline-domain FKs
  started_at       TEXT,
  stopped_at       TEXT,
  publish_dirty    INTEGER NOT NULL DEFAULT 0,
  last_publish_at  TEXT,
  updated_at       TEXT
);
INSERT OR IGNORE INTO pipeline_supervisor_state(singleton_id, updated_at)
VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ','now'));

PRAGMA optimize;
