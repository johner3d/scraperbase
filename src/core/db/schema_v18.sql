-- v18: re-run the v17 pause sweep with a working comparison.
--
-- v17 compared `resume_after < datetime('now')`, i.e. an ISO-8601 string with a
-- 'T' separator against SQLite's space-separated format. 'T' sorts above ' ',
-- so every elapsed pause compared as still in the future and survived the
-- sweep. datetime() on both sides is the fix.
UPDATE pipeline_pauses
   SET resolved_at = datetime('now')
 WHERE resolved_at IS NULL
   AND (stage_name IN ('psa-fetch', 'psa-cert', 'psa-identity')
        OR (resume_after IS NOT NULL AND datetime(resume_after) < datetime('now')));
