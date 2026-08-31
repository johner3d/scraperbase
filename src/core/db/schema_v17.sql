-- v17: housekeeping for the PSA stage consolidation.
--
-- 1. A `psa-fetch` pause row survived the three-stage -> one-stage merge with
--    resume_after NULL, i.e. indefinite, owned by a pipeline run that no longer
--    exists. Nothing named `psa-fetch` ticks any more, so it can never be
--    resolved by the code that created it.
-- 2. The old `ebay-ingest` daily-budget pauses are likewise orphaned by run id
--    and their resume_after is long past.
UPDATE pipeline_pauses
   SET resolved_at = datetime('now')
 WHERE resolved_at IS NULL
   AND (stage_name IN ('psa-fetch', 'psa-cert', 'psa-identity')
        OR (resume_after IS NOT NULL AND datetime(resume_after) < datetime('now')));
