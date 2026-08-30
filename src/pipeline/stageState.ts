import type { DatabaseSync } from 'node:sqlite';
import { openDeadLetterCount } from './deadLetters.ts';
import type { StageTickResult, SupervisorStage } from './stages/types.ts';

export type StageState = 'idle' | 'working' | 'backing_off' | 'paused' | 'stalled';

export interface StageStatusRow {
  stage: string;
  state: StageState;
  last_activity_at: string | null;
  last_tick_at: string | null;
  items_done_total: number;
  items_done_window: number;
  window_started_at: string | null;
  dead_letter_open: number;
  next_eligible_at: string | null;
  note: string | null;
}

const WINDOW_MS = 5 * 60_000;

export function readStageStatus(db: DatabaseSync, stage?: string): StageStatusRow[] {
  const where = stage ? 'WHERE stage=?' : '';
  const params = stage ? [stage] : [];
  return db.prepare(`SELECT * FROM pipeline_stage_status ${where} ORDER BY stage`).all(...params) as unknown as StageStatusRow[];
}

export function getNextEligibleAt(db: DatabaseSync, stage: string): string | null {
  const row = db.prepare(`SELECT next_eligible_at FROM pipeline_stage_status WHERE stage=?`).get(stage) as
    { next_eligible_at: string | null } | undefined;
  return row?.next_eligible_at ?? null;
}

/**
 * Record the outcome of one stage tick: throughput window, activity timestamps,
 * derived state, and the dead-letter count for the dashboard.
 */
export function recordStageActivity(
  db: DatabaseSync,
  stage: SupervisorStage,
  result: StageTickResult,
  state: StageState,
): void {
  const now = new Date();
  const nowIso = now.toISOString();
  const existing = db.prepare(`SELECT items_done_window, window_started_at FROM pipeline_stage_status WHERE stage=?`)
    .get(stage) as { items_done_window: number; window_started_at: string | null } | undefined;
  const windowStart = existing?.window_started_at ? Date.parse(existing.window_started_at) : 0;
  const rolled = !windowStart || now.getTime() - windowStart >= WINDOW_MS;
  const windowCount = (rolled ? 0 : existing?.items_done_window ?? 0) + result.workDone;
  db.prepare(
    `UPDATE pipeline_stage_status SET
       state=?,
       last_tick_at=?,
       last_activity_at=CASE WHEN ?>0 THEN ? ELSE last_activity_at END,
       items_done_total=items_done_total+?,
       items_done_window=?,
       window_started_at=CASE WHEN ? THEN ? ELSE window_started_at END,
       dead_letter_open=?,
       next_eligible_at=?,
       note=?
     WHERE stage=?`,
  ).run(
    state, nowIso,
    result.workDone, nowIso,
    result.workDone,
    windowCount,
    rolled ? 1 : 0, nowIso,
    openDeadLetterCount(db, stage),
    result.nextEligibleAt ?? null,
    result.note ?? null,
    stage,
  );
}

/** Throughput per minute over the rolling window. */
export function throughputPerMinute(row: StageStatusRow): number {
  if (!row.window_started_at) return 0;
  const elapsedMin = Math.max(1 / 60, (Date.now() - Date.parse(row.window_started_at)) / 60_000);
  return Number((row.items_done_window / Math.min(elapsedMin, WINDOW_MS / 60_000)).toFixed(2));
}
