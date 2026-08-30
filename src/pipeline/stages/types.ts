import type { DatabaseSync } from 'node:sqlite';

/**
 * The supervisor's stage list, in dependency order. Not the same as the legacy
 * `PIPELINE_STAGES` (which is the one-shot sequential run) -- each of these
 * advances independently on its own tick.
 *
 * HARD RULE for every tick implementation: never `await` between
 * `db.exec('BEGIN IMMEDIATE')` and `COMMIT`. The single shared connection means
 * an await inside an open transaction can interleave another stage's writes.
 * `processItem` and `materialize` already respect this.
 */
export const SUPERVISOR_STAGES = [
  'ingest',
  'ebay-match',
  'psa-cert',
  'psa-identity',
  'psa-fetch',
  'publish',
  'reconcile',
] as const;

export type SupervisorStage = typeof SUPERVISOR_STAGES[number];

export interface StageContext {
  /** The supervisor's long-lived `runs` row id -- pass to runQueue. */
  runId: string;
  /** The supervisor's `pipeline_runs` row id -- pass to materialize / snapshotPsaTargets / publication. */
  pipelineRunId: string;
  now(): Date;
  log(message: string): void;
  /** True once a stop was requested -- long ticks should bail at a safe point. */
  draining(): boolean;
}

export interface StagePause {
  source: string;
  reason: string;
  resumeAfter: string | null;
}

export interface StageTickResult {
  /** Units of real work done this tick. 0 -> the supervisor backs this stage off. */
  workDone: number;
  /** New dead-letter rows recorded this tick. */
  deadLettered?: number;
  /** Don't tick this stage again until this ISO time (quota reset, rate-limit, nothing-to-do-for-a-while). */
  nextEligibleAt?: string;
  /** One-line human status for the dashboard. */
  note?: string;
  /** A cooperative pause the operator must resolve (expired PSA session, etc.). */
  pause?: StagePause;
}

export type StageTick = (db: DatabaseSync, ctx: StageContext) => Promise<StageTickResult>;
