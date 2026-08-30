import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export interface SupervisorStateRow {
  singleton_id: 1;
  run_id: string | null;
  pipeline_run_id: string | null;
  started_at: string | null;
  stopped_at: string | null;
  publish_dirty: 0 | 1;
  last_publish_at: string | null;
  updated_at: string | null;
}

export function getSupervisorState(db: DatabaseSync): SupervisorStateRow {
  return db.prepare(`SELECT * FROM pipeline_supervisor_state WHERE singleton_id=1`).get() as unknown as SupervisorStateRow;
}

/**
 * The `pipeline_runs` row the supervisor's pipeline-domain writes hang off
 * (campaigns, PSA targets, gaps, publication generations all FK to it). Reused
 * across restarts -- there is only ever one supervisor pipeline run.
 */
export function ensureSupervisorPipelineRun(db: DatabaseSync): string {
  const existing = getSupervisorState(db).pipeline_run_id;
  if (existing && db.prepare(`SELECT 1 FROM pipeline_runs WHERE pipeline_run_id=?`).get(existing)) return existing;
  // A previous supervisor pipeline run exists but is finished -- reopen it so
  // history (campaigns, targets, generations) stays attached to one row.
  const prior = db.prepare(`SELECT pipeline_run_id FROM pipeline_runs WHERE json_extract(config_json,'$.kind')='supervisor' ORDER BY created_at DESC LIMIT 1`)
    .get() as { pipeline_run_id: string } | undefined;
  const now = new Date().toISOString();
  if (prior) {
    db.prepare(`UPDATE pipeline_runs SET status='running', active_stage='supervisor', ended_at=NULL WHERE pipeline_run_id=?`).run(prior.pipeline_run_id);
    return prior.pipeline_run_id;
  }
  const id = randomUUID();
  db.prepare(
    `INSERT INTO pipeline_runs (pipeline_run_id,created_at,started_at,status,active_stage,config_json)
     VALUES (?,?,?,'running','supervisor',?)`,
  ).run(id, now, now, JSON.stringify({ kind: 'supervisor' }));
  return id;
}

export function beginSupervisor(db: DatabaseSync, runId: string, pipelineRunId: string): void {
  const now = new Date().toISOString();
  db.prepare(`UPDATE pipeline_supervisor_state SET run_id=?, pipeline_run_id=?, started_at=?, stopped_at=NULL, updated_at=? WHERE singleton_id=1`)
    .run(runId, pipelineRunId, now, now);
}

export function endSupervisor(db: DatabaseSync): void {
  const now = new Date().toISOString();
  const state = getSupervisorState(db);
  if (state.pipeline_run_id) {
    db.prepare(`UPDATE pipeline_runs SET status='completed', active_stage=NULL, ended_at=? WHERE pipeline_run_id=? AND status='running'`)
      .run(now, state.pipeline_run_id);
  }
  db.prepare(`UPDATE pipeline_supervisor_state SET run_id=NULL, stopped_at=?, updated_at=? WHERE singleton_id=1`).run(now, now);
}

/** Any stage that wrote user-visible rows calls this so the publish tick fires. */
export function markPublishDirty(db: DatabaseSync): void {
  db.prepare(`UPDATE pipeline_supervisor_state SET publish_dirty=1, updated_at=? WHERE singleton_id=1`)
    .run(new Date().toISOString());
}

export function clearPublishDirty(db: DatabaseSync, publishedAt: string): void {
  db.prepare(`UPDATE pipeline_supervisor_state SET publish_dirty=0, last_publish_at=?, updated_at=? WHERE singleton_id=1`)
    .run(publishedAt, publishedAt);
}
