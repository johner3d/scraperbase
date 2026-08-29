-- Additive migration for persisted manual source-to-variant corrections.
-- Kept separate so databases already upgraded to schema v2 receive it too.

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
