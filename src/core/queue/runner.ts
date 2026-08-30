import type { DatabaseSync } from 'node:sqlite';
import { withTransaction } from '../db/client.ts';
import { writeObject, type WriteObjectInput } from '../objectstore/store.ts';
import { bumpCounter } from '../progress/metrics.ts';
import { logEvent } from '../events/eventLog.ts';
import {
  claimNext,
  enqueueWorkItem,
  markFailed,
  markPartial,
  markSucceeded,
  sweepQueue,
} from './scheduler.ts';
import { leaseOwnerId, type EnqueueSpec, type WorkItemRow } from './workItem.ts';

export type AttemptOutcome =
  | 'success'
  | 'unchanged'
  | 'failure'
  | 'timeout'
  | 'rate_limited'
  | 'auth_redirect'
  | 'schema_drift';

export interface CollectorContext {
  runId: string;
}

export interface CollectorOutcome {
  outcome: AttemptOutcome;
  final: 'succeeded' | 'partial' | 'retryable_failed' | 'permanent_failed';
  sourceIdentity: string;
  httpStatus?: number;
  requestMethod?: string;
  requestUrl?: string;
  requestParams?: unknown;
  responseHeaders?: Record<string, string>;
  byteSize?: number;
  durationMs?: number;
  retryAfterMs?: number;
  errorMessage?: string;
  object?: WriteObjectInput;
  saleFingerprint?: string;
  enqueueNext?: EnqueueSpec[];
}

export type Collector = (db: DatabaseSync, item: WorkItemRow, ctx: CollectorContext) => Promise<CollectorOutcome>;

/**
 * Runs one work item to completion: invoke the collector, atomically write
 * any raw object to the content-addressed store, then -- in a single SQLite
 * transaction -- record the attempt, the observation (if any), enqueue any
 * discovered downstream work, update counters, and transition the work
 * item's state. A work item is never marked done until all of that commits.
 */
export async function processItem(
  db: DatabaseSync,
  item: WorkItemRow,
  collector: Collector,
  ctx: CollectorContext,
): Promise<CollectorOutcome> {
  const startedAt = new Date().toISOString();
  let result: CollectorOutcome;
  try {
    result = await collector(db, item, ctx);
  } catch (err) {
    result = {
      outcome: 'failure',
      final: 'retryable_failed',
      sourceIdentity: item.source,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }

  let contentHash: string | null = null;
  let isNewObject = false;
  let byteSize = result.byteSize ?? null;
  if (result.object) {
    const written = await writeObject(db, result.object, result.object.dirs);
    contentHash = written.hash;
    isNewObject = written.isNew;
    byteSize = written.byteSize;
  }

  const finishedAt = new Date().toISOString();

  withTransaction(db, () => {
    const attemptRow = db
      .prepare(
        `INSERT INTO attempts (work_item_id, run_id, started_at, finished_at, outcome, http_status,
           request_method, request_url, request_params_json, response_headers_json, byte_size,
           duration_ms, retry_after_ms, error_message, content_hash, source_identity)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING attempt_id`,
      )
      .get(
        item.work_item_id,
        ctx.runId,
        startedAt,
        finishedAt,
        result.outcome,
        result.httpStatus ?? null,
        result.requestMethod ?? null,
        result.requestUrl ?? null,
        result.requestParams !== undefined ? JSON.stringify(result.requestParams) : null,
        result.responseHeaders !== undefined ? JSON.stringify(result.responseHeaders) : null,
        byteSize,
        result.durationMs ?? null,
        result.retryAfterMs ?? null,
        result.errorMessage ?? null,
        contentHash,
        result.sourceIdentity,
      ) as { attempt_id: number };

    if (contentHash) {
      db.prepare(
        `INSERT INTO observations (attempt_id, work_item_id, hash, observed_at, entity_type, scope_key,
           is_first_observation_of_hash, sale_fingerprint)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        attemptRow.attempt_id,
        item.work_item_id,
        contentHash,
        finishedAt,
        item.entity_type,
        item.scope_key,
        isNewObject ? 1 : 0,
        result.saleFingerprint ?? null,
      );
    }

    for (const spec of result.enqueueNext ?? []) enqueueWorkItem(db, spec);

    switch (result.final) {
      case 'succeeded':
        markSucceeded(db, item.work_item_id);
        break;
      case 'partial':
        markPartial(db, item.work_item_id, result.errorMessage);
        break;
      case 'retryable_failed':
        markFailed(db, item, result.errorMessage ?? 'unknown error', true);
        break;
      case 'permanent_failed':
        markFailed(db, item, result.errorMessage ?? 'unknown error', false);
        break;
    }

    bumpCounter(db, ctx.runId, 'requests_total');
    bumpCounter(db, ctx.runId, result.outcome === 'success' || result.outcome === 'unchanged'
      ? 'requests_success'
      : 'requests_failed');
    if (byteSize) bumpCounter(db, ctx.runId, 'bytes_total', byteSize);
    if (item.attempts > 1) bumpCounter(db, ctx.runId, 'retries_total');
    if (result.httpStatus) bumpCounter(db, ctx.runId, `http_status_${Math.floor(result.httpStatus / 100)}xx`);
  });

  return result;
}

export interface RunQueueOptions {
  queue: string;
  collector: Collector;
  concurrency: number;
  leaseTtlMs: number;
  runId: string;
  pollIntervalMs?: number;
  isDraining: () => boolean;
  entityTypes?: string[];
  minimumPriority?: number;
  scopeContains?: string;
  /**
   * Safety valve, not a guarantee: after this many consecutive non-success
   * outcomes across the whole queue (any worker), pause `cooldownMs` before
   * claiming more work rather than hammering a rate-limited or re-challenging
   * upstream site. Ports `psa-fetch.ts`'s `maybeCooldown` into the generic
   * runner so every collector can opt in, not just the legacy PSA scripts.
   * Undefined (the default) preserves old behavior: no pause, ever.
   */
  cooldown?: { afterConsecutiveFailures: number; cooldownMs: number };
  /** Stop claiming fresh work after the first upstream rate-limit response. */
  haltOnRateLimit?: boolean;
  /**
   * Stop claiming fresh work once this many items have been processed in this
   * call (across all workers). Lets the supervisor run a bounded slice of a
   * queue per tick instead of draining it fully. Items already in flight still
   * finish; the rest stay pending for the next call.
   */
  maxItems?: number;
  /** Optional hook after each item commits, used for incremental downstream materialization. */
  onItemComplete?: (result:CollectorOutcome,item:WorkItemRow)=>Promise<void>|void;
}

const SUCCESS_FINAL_STATES: ReadonlySet<CollectorOutcome['final']> = new Set(['succeeded', 'partial']);

/**
 * Drives one queue to exhaustion with a small worker pool. Exits once no
 * worker can claim anything AND no worker is currently mid-item (so a
 * discovery item's downstream fan-out is never missed by an early exit).
 * There is no separate "resume" code path: calling this again after a
 * crash or Ctrl+C just continues, because sweepQueue() reclaims whatever
 * was left leased/partial/retryable.
 */
export async function runQueue(db: DatabaseSync, opts: RunQueueOptions): Promise<void> {
  const leaseOwner = leaseOwnerId(opts.runId);
  sweepQueue(db, opts.runId);
  const pollMs = opts.pollIntervalMs ?? 100;
  let activeCount = 0;
  let consecutiveFailures = 0;
  let haltedByRateLimit = false;
  let processed = 0;

  async function worker(): Promise<void> {
    while (!opts.isDraining() && !haltedByRateLimit) {
      if (opts.maxItems != null && processed >= opts.maxItems) return;
      db.prepare('UPDATE runs SET heartbeat_at = ? WHERE run_id = ?').run(new Date().toISOString(), opts.runId);
      const item = claimNext(db, opts.queue, leaseOwner, opts.leaseTtlMs, {
        entityTypes: opts.entityTypes,
        minimumPriority: opts.minimumPriority,
        scopeContains: opts.scopeContains,
      });
      if (!item) {
        if (activeCount === 0) return;
        await sleep(pollMs);
        continue;
      }
      activeCount++;
      processed++;
      try {
        const result = await processItem(db, item, opts.collector, { runId: opts.runId });
        if (opts.onItemComplete) await opts.onItemComplete(result,item);
        if (opts.haltOnRateLimit && (result.outcome === 'rate_limited' || result.httpStatus === 429)) {
          haltedByRateLimit = true;
          logEvent(db, {
            runId: opts.runId,
            level: 'warn',
            category: 'system',
            message: `Rate limit on queue '${opts.queue}' -- halting this queue resumably before claiming fresh work`,
          });
        }
        if (opts.cooldown) {
          if (SUCCESS_FINAL_STATES.has(result.final)) {
            consecutiveFailures = 0;
          } else {
            consecutiveFailures++;
            if (consecutiveFailures >= opts.cooldown.afterConsecutiveFailures) {
              logEvent(db, {
                runId: opts.runId,
                level: 'warn',
                category: 'system',
                message: `${consecutiveFailures} consecutive failures on queue '${opts.queue}' -- cooling down for ${opts.cooldown.cooldownMs}ms before continuing`,
              });
              await sleep(opts.cooldown.cooldownMs);
              consecutiveFailures = 0;
            }
          }
        }
      } finally {
        activeCount--;
      }
    }
  }

  await Promise.all(Array.from({ length: opts.concurrency }, () => worker()));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
