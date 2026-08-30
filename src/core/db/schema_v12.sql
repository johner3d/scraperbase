-- Source-scoped eBay pauses and append-only PSA manifest revisions.

ALTER TABLE pipeline_psa_targets ADD COLUMN manifest_revision INTEGER NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS pipeline_psa_manifest_revisions (
  pipeline_run_id TEXT NOT NULL REFERENCES pipeline_runs(pipeline_run_id) ON DELETE CASCADE,
  manifest_revision INTEGER NOT NULL,
  ebay_complete INTEGER NOT NULL CHECK (ebay_complete IN (0,1)),
  new_target_count INTEGER NOT NULL DEFAULT 0,
  listing_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (pipeline_run_id, manifest_revision)
);

INSERT OR IGNORE INTO pipeline_psa_manifest_revisions
  (pipeline_run_id,manifest_revision,ebay_complete,new_target_count,listing_count,created_at)
SELECT t.pipeline_run_id,1,0,COUNT(DISTINCT t.pipeline_psa_target_id),COUNT(DISTINCT l.ebay_listing_id),MIN(t.created_at)
FROM pipeline_psa_targets t
LEFT JOIN pipeline_psa_target_listings l ON l.pipeline_psa_target_id=t.pipeline_psa_target_id
GROUP BY t.pipeline_run_id;

CREATE INDEX IF NOT EXISTS idx_pipeline_psa_targets_revision
  ON pipeline_psa_targets(pipeline_run_id, manifest_revision, variant_id);

PRAGMA optimize;
