import { existsSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { DATA_DIR } from '../core/config/config.ts';
import { openCliDb } from '../cli/context.ts';
import { createRun, finishRun } from '../core/queue/run.ts';
import { sweepQueue } from '../core/queue/scheduler.ts';
import { logEvent } from '../core/events/eventLog.ts';
import { recordStageActivity, type StageState } from './stageState.ts';
import { clearStageRun, readStageControl, stageTickDecision } from './stageControl.ts';
import { beginSupervisor, endSupervisor, ensureSupervisorPipelineRun, getSupervisorState } from './supervisorState.ts';
import { SUPERVISOR_STAGES, type StageContext, type StageTick, type StageTickResult, type SupervisorStage } from './stages/types.ts';
import { tickIngest } from './stages/ingest.ts';
import { tickEbayMatch } from './stages/ebayMatch.ts';
import { tickPsa } from './stages/psa.ts';
import { closePsaBrowser, releasePsaBrowserIfIdle } from './stages/psaBrowser.ts';
import { tickPublish } from './stages/publish.ts';
import { tickReconcile } from './stages/reconcile.ts';
import { retryDeadLetters } from './deadLetters.ts';

export const STOP_FILE = path.join(DATA_DIR, 'pipeline.stop');

const REGISTRY: Record<SupervisorStage, { tick: StageTick; maxTickMs: number }> = {
  ingest:         { tick: tickIngest,      maxTickMs: 180_000 },
  'ebay-match':   { tick: tickEbayMatch,   maxTickMs: 120_000 },
  psa:            { tick: tickPsa,         maxTickMs: 180_000 },
  publish:        { tick: tickPublish,     maxTickMs: 120_000 },
  reconcile:      { tick: tickReconcile,   maxTickMs: 900_000 },
};

const BACKOFF_LADDER_MS = [5_000, 15_000, 60_000, 120_000];
const LOOP_FLOOR_MS = Number(process.env.SCRAPERBASE_SUPERVISOR_LOOP_MS) || 750;
/** Safety cap on how many ticks one `pipeline stage run --drain` poke may run. */
const MANUAL_DRAIN_MAX = 200;

function timeoutRace<T>(promise: Promise<T>, ms: number): Promise<T | { __timedOut: true }> {
  return Promise.race([promise, new Promise<{ __timedOut: true }>((resolve) => setTimeout(() => resolve({ __timedOut: true }), ms))]);
}

function recordPause(db: DatabaseSync, pipelineRunId: string, stage: SupervisorStage, pause: NonNullable<StageTickResult['pause']>): void {
  const now = new Date().toISOString();
  const open = db.prepare(`SELECT 1 FROM pipeline_pauses WHERE pipeline_run_id=? AND stage_name=? AND resolved_at IS NULL`)
    .get(pipelineRunId, stage);
  if (!open) {
    db.prepare(`INSERT INTO pipeline_pauses (pipeline_run_id,stage_name,source,reason,resume_after,created_at)
      VALUES (?,?,?,?,?,?)`).run(pipelineRunId, stage, pause.source, pause.reason, pause.resumeAfter, now);
  }
}

function clearPause(db: DatabaseSync, pipelineRunId: string, stage: SupervisorStage): void {
  db.prepare(`UPDATE pipeline_pauses SET resolved_at=? WHERE pipeline_run_id=? AND stage_name=? AND resolved_at IS NULL`)
    .run(new Date().toISOString(), pipelineRunId, stage);
}

export interface SupervisorOptions {
  stages?: SupervisorStage[];
  retryFailed?: boolean;
  /** Run every eligible stage exactly once, then return (used by `pipeline tick`). */
  once?: boolean;
  loopFloorMs?: number;
}

/**
 * The long-running pipeline supervisor. One process, one DB connection, stages
 * advancing cooperatively -- each does a bounded unit of work per tick and
 * commits as it goes, so matched auctions and PSA facts drip into the UI
 * continuously instead of after a multi-hour batch.
 */
export async function runSupervisor(dbInput: DatabaseSync | null, opts: SupervisorOptions = {}): Promise<void> {
  const db = dbInput ?? openCliDb();
  const ownsDb = dbInput == null;
  const stages = (opts.stages && opts.stages.length ? opts.stages : [...SUPERVISOR_STAGES])
    .filter((s): s is SupervisorStage => (SUPERVISOR_STAGES as readonly string[]).includes(s));

  if (existsSync(STOP_FILE)) rmSync(STOP_FILE);

  const runId = createRun(db, 'pipeline supervisor', { stages }, true);
  const pipelineRunId = ensureSupervisorPipelineRun(db);
  beginSupervisor(db, runId, pipelineRunId);
  if (opts.retryFailed) {
    for (const stage of stages) retryDeadLetters(db, { stage });
  }

  let draining = false;
  const requestStop = (why: string): void => {
    if (draining) return;
    draining = true;
    logEvent(db, { runId, level: 'info', category: 'system', message: `Supervisor draining (${why})` });
  };
  process.once('SIGINT', () => requestStop('SIGINT'));
  process.once('SIGTERM', () => requestStop('SIGTERM'));

  const backoffIndex = new Map<SupervisorStage, number>();
  const nextAt = new Map<SupervisorStage, number>();
  const manualDrainCount = new Map<SupervisorStage, number>();

  const ctxFor = (): StageContext => ({
    runId, pipelineRunId,
    now: () => new Date(),
    log: (message: string) => { console.log(`[${new Date().toISOString()}] ${message}`); },
    draining: () => draining,
  });

  console.log(`pipeline supervisor ${runId} started (stages: ${stages.join(', ')})`);

  try {
    for (;;) {
      if (draining || existsSync(STOP_FILE)) break;
      sweepQueue(db, runId);
      let didWork = false;

      for (const stage of stages) {
        if (draining) break;
        const now = Date.now();
        // `pipeline tick` is an explicit one-shot -- it ignores the park flag and
        // backoff and runs every requested stage once.
        const decision = opts.once
          ? { tick: true, manual: false, drain: false }
          : stageTickDecision(readStageControl(db, stage), nextAt.get(stage) ?? 0, now);
        if (!decision.tick) continue;

        db.prepare(`UPDATE pipeline_stage_status SET state='working', last_tick_at=? WHERE stage=?`)
          .run(new Date().toISOString(), stage);

        let result: StageTickResult;
        let state: StageState = 'idle';
        try {
          const raced = await timeoutRace(REGISTRY[stage].tick(db, ctxFor()), REGISTRY[stage].maxTickMs);
          if ('__timedOut' in raced) {
            state = 'stalled';
            result = { workDone: 0, note: `tick exceeded ${Math.round(REGISTRY[stage].maxTickMs / 1000)}s watchdog` };
            logEvent(db, { runId, level: 'warn', category: 'system', message: `Stage '${stage}' hit its watchdog; moving on` });
            nextAt.set(stage, Date.now() + 60_000);
          } else {
            result = raced;
          }
        } catch (error) {
          state = 'backing_off';
          result = { workDone: 0, note: `error: ${error instanceof Error ? error.message : String(error)}` };
          logEvent(db, { runId, level: 'error', category: 'system', message: `Stage '${stage}' threw: ${result.note}` });
        }

        if (result.pause) {
          state = 'paused';
          recordPause(db, pipelineRunId, stage, result.pause);
          nextAt.set(stage, Date.now() + 30 * 60_000);
        } else {
          clearPause(db, pipelineRunId, stage);
        }

        if (state !== 'stalled' && state !== 'backing_off' && state !== 'paused') {
          if (result.workDone > 0) {
            didWork = true;
            backoffIndex.set(stage, 0);
            state = 'working';
            nextAt.set(stage, Date.now() + 1_000);
          } else {
            const idx = Math.min((backoffIndex.get(stage) ?? -1) + 1, BACKOFF_LADDER_MS.length - 1);
            backoffIndex.set(stage, idx);
            state = 'idle';
            nextAt.set(stage, Date.now() + BACKOFF_LADDER_MS[idx]!);
          }
        }
        if (result.nextEligibleAt) {
          nextAt.set(stage, Math.max(nextAt.get(stage) ?? 0, Date.parse(result.nextEligibleAt)));
        }

        recordStageActivity(db, stage, result, state);

        // Resolve a manual `pipeline stage run` poke: keep re-ticking only while
        // it asked to drain and there is still work, otherwise clear the request
        // so a parked stage goes back to sleep.
        if (decision.manual) {
          const drained = manualDrainCount.get(stage) ?? 0;
          if (decision.drain && result.workDone > 0 && !result.pause && drained + 1 < MANUAL_DRAIN_MAX && !draining) {
            manualDrainCount.set(stage, drained + 1);
            nextAt.set(stage, Date.now() + 1_000);
            didWork = true;
          } else {
            clearStageRun(db, stage);
            manualDrainCount.delete(stage);
          }
        }
      }

      await releasePsaBrowserIfIdle(Date.now());

      if (opts.once) break;
      if (!didWork) await sleep(opts.loopFloorMs ?? LOOP_FLOOR_MS);
      else await sleep(50);
    }
  } finally {
    await closePsaBrowser();
    finishRun(db, runId, 'completed');
    endSupervisor(db);
    for (const stage of stages) {
      db.prepare(`UPDATE pipeline_stage_status SET state='idle' WHERE stage=? AND state='working'`).run(stage);
    }
    if (existsSync(STOP_FILE)) rmSync(STOP_FILE);
    console.log('pipeline supervisor stopped');
    if (ownsDb) db.close();
  }
}

/** One bounded pass of one stage (or all), for `pipeline tick`. */
export async function runOneTick(stage: SupervisorStage | 'all'): Promise<void> {
  const stages = stage === 'all' ? [...SUPERVISOR_STAGES] : [stage];
  await runSupervisor(null, { stages, once: true });
}

export function requestSupervisorStop(): void {
  writeFileSync(STOP_FILE, `stop requested ${new Date().toISOString()}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
