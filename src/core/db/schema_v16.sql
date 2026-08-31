-- The three PSA supervisor stages (psa-cert / psa-identity / psa-fetch) are now
-- one `psa` stage: one warm shared browser, one shared rate budget + 429
-- circuit-breaker, one bounded tick that spends the budget fetch-first. Migrate
-- the per-stage control rows to match.

INSERT OR IGNORE INTO pipeline_stage_status(stage) VALUES ('psa');

-- Carry a manual park forward: if any old PSA stage was parked, keep `psa` parked.
UPDATE pipeline_stage_status SET auto_enabled = 0
  WHERE stage = 'psa'
    AND (SELECT MIN(auto_enabled) FROM pipeline_stage_status
         WHERE stage IN ('psa-cert','psa-identity','psa-fetch')) = 0;

DELETE FROM pipeline_stage_status WHERE stage IN ('psa-cert','psa-identity','psa-fetch');

PRAGMA optimize;
