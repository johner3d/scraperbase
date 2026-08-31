-- Per-stage auto/manual control for the supervisor. `auto_enabled=0` parks a
-- stage off the auto loop; `run_requested_at` is a one-shot poke the running
-- daemon honours (and clears) even for a parked stage; `run_drain` makes that
-- poke keep ticking until the stage's queue is idle.

ALTER TABLE pipeline_stage_status ADD COLUMN auto_enabled INTEGER NOT NULL DEFAULT 1 CHECK (auto_enabled IN (0,1));
ALTER TABLE pipeline_stage_status ADD COLUMN run_requested_at TEXT;
ALTER TABLE pipeline_stage_status ADD COLUMN run_drain INTEGER NOT NULL DEFAULT 0 CHECK (run_drain IN (0,1));

PRAGMA optimize;
