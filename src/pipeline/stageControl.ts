import type { DatabaseSync } from 'node:sqlite';
import { SUPERVISOR_STAGES, type SupervisorStage } from './stages/types.ts';

/**
 * Per-stage auto/manual control, stored on `pipeline_stage_status`. Lets an
 * operator park one stage off the supervisor's auto loop (`auto_enabled=0`)
 * without stopping the daemon, and poke it on demand (`run_requested_at`). The
 * daemon reads this at the top of every stage iteration, so a CLI write lands
 * within one loop (~1s) -- no restart, no exclusive-writer-lock fight.
 */

export interface StageControl {
  autoEnabled: boolean;
  runRequestedAt: string | null;
  runDrain: boolean;
}

export interface StageTickDecision {
  /** Whether the stage should tick this loop iteration. */
  tick: boolean;
  /** This tick is a one-shot / drain poke, not the auto cadence. */
  manual: boolean;
  /** The poke should keep ticking until the stage's queue is idle. */
  drain: boolean;
}

export function assertSupervisorStage(value: string): SupervisorStage {
  if (!(SUPERVISOR_STAGES as readonly string[]).includes(value)) {
    throw new Error(`Unknown stage "${value}". Known: ${SUPERVISOR_STAGES.join(', ')}`);
  }
  return value as SupervisorStage;
}

export function readStageControl(db: DatabaseSync, stage: string): StageControl {
  const row = db.prepare(
    `SELECT auto_enabled, run_requested_at, run_drain FROM pipeline_stage_status WHERE stage=?`,
  ).get(stage) as { auto_enabled: number; run_requested_at: string | null; run_drain: number } | undefined;
  return {
    autoEnabled: row ? row.auto_enabled === 1 : true,
    runRequestedAt: row?.run_requested_at ?? null,
    runDrain: row ? row.run_drain === 1 : false,
  };
}

export function setStageAuto(db: DatabaseSync, stage: string, enabled: boolean): void {
  assertSupervisorStage(stage);
  db.prepare(`UPDATE pipeline_stage_status SET auto_enabled=? WHERE stage=?`).run(enabled ? 1 : 0, stage);
}

export function requestStageRun(db: DatabaseSync, stage: string, drain: boolean): void {
  assertSupervisorStage(stage);
  db.prepare(`UPDATE pipeline_stage_status SET run_requested_at=?, run_drain=? WHERE stage=?`)
    .run(new Date().toISOString(), drain ? 1 : 0, stage);
}

export function clearStageRun(db: DatabaseSync, stage: string): void {
  db.prepare(`UPDATE pipeline_stage_status SET run_requested_at=NULL, run_drain=0 WHERE stage=?`).run(stage);
}

/**
 * The single "should this stage tick now?" rule, shared by the daemon loop and
 * its tests. `backoffUntil` is the loop's existing per-stage `nextAt` value.
 */
export function stageTickDecision(control: StageControl, backoffUntil: number, now: number): StageTickDecision {
  if (control.runRequestedAt) return { tick: true, manual: true, drain: control.runDrain };
  if (!control.autoEnabled) return { tick: false, manual: false, drain: false };
  return { tick: now >= backoffUntil, manual: false, drain: false };
}
