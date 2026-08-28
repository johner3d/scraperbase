import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { computeBackoffMs } from './backoff.ts';
import { workItemId, type EnqueueSpec, type WorkItemRow } from './workItem.ts';
import { logEvent } from '../events/eventLog.ts';

export function enqueueWorkItem(db: DatabaseSync, spec: EnqueueSpec): string {
  const id = workItemId(spec.source, spec.queue, spec.scopeKey);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO work_items
       (work_item_id, source, queue, entity_type, scope_key, params_json, priority, state,
        attempts, max_attempts, available_at, created_at, updated_at, depends_on)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    spec.source,
    spec.queue,
    spec.entityType,
    spec.scopeKey,
    JSON.stringify(spec.params ?? {}),
    spec.priority ?? 0,
    spec.maxAttempts ?? 8,
    now,
    now,
    now,
    spec.dependsOn ?? null,
  );
  return id;
}

export interface SweepResult {
  reclaimedLeases: number;
  requeuedPartial: number;
  requeuedRetryable: number;
}

/**
 * Maintenance pass, safe to call at the start of every claim cycle:
 *  - leases abandoned by a crashed process (lease_expires_at in the past) go back to pending
 *  - 'partial' items (interrupted mid-checkpoint, but not an error) go back to pending
 *  - 'retryable_failed' items whose backoff has elapsed go back to pending
 * This -- not a special "resume mode" -- is the entire crash-recovery mechanism.
 */
export function sweepQueue(db: DatabaseSync, runId: string | null = null): SweepResult {
  const now = new Date().toISOString();

  const expired = db
    .prepare(`SELECT work_item_id FROM work_items WHERE state IN ('leased','running') AND lease_expires_at < ?`)
    .all(now) as { work_item_id: string }[];
  if (expired.length > 0) {
    db.prepare(
      `UPDATE work_items SET state='pending', lease_owner=NULL, lease_expires_at=NULL, updated_at=?
       WHERE state IN ('leased','running') AND lease_expires_at < ?`,
    ).run(now, now);
    for (const row of expired) {
      logEvent(db, {
        runId,
        level: 'warn',
        category: 'system',
        message: `Reclaimed abandoned lease for ${row.work_item_id}`,
      });
    }
  }

  const partialResult = db
    .prepare(`UPDATE work_items SET state='pending', updated_at=? WHERE state='partial'`)
    .run(now);

  const retryableResult = db
    .prepare(`UPDATE work_items SET state='pending', updated_at=? WHERE state='retryable_failed' AND available_at <= ?`)
    .run(now, now);

  return {
    reclaimedLeases: expired.length,
    requeuedPartial: Number(partialResult.changes),
    requeuedRetryable: Number(retryableResult.changes),
  };
}

/** Atomically claims and leases the highest-priority claimable item in `queue`, if any. */
export function claimNext(
  db: DatabaseSync,
  queue: string,
  leaseOwner: string,
  leaseTtlMs: number,
): WorkItemRow | undefined {
  const nowIso = new Date().toISOString();
  const leaseExpiresAt = new Date(Date.now() + leaseTtlMs).toISOString();

  return db
    .prepare(
      `UPDATE work_items
       SET state='leased', lease_owner=?, lease_expires_at=?, attempts=attempts+1, updated_at=?
       WHERE work_item_id = (
         SELECT work_item_id FROM work_items
         WHERE queue = ? AND state = 'pending' AND available_at <= ?
         ORDER BY priority DESC, created_at ASC
         LIMIT 1
       )
       RETURNING *`,
    )
    .get(leaseOwner, leaseExpiresAt, nowIso, queue, nowIso) as WorkItemRow | undefined;
}

export function heartbeat(db: DatabaseSync, id: string, leaseOwner: string, leaseTtlMs: number): void {
  const leaseExpiresAt = new Date(Date.now() + leaseTtlMs).toISOString();
  db.prepare(`UPDATE work_items SET lease_expires_at=? WHERE work_item_id=? AND lease_owner=?`).run(
    leaseExpiresAt,
    id,
    leaseOwner,
  );
}

export function markSucceeded(db: DatabaseSync, id: string): void {
  db.prepare(
    `UPDATE work_items SET state='succeeded', lease_owner=NULL, lease_expires_at=NULL, last_error=NULL, updated_at=?
     WHERE work_item_id=?`,
  ).run(new Date().toISOString(), id);
}

/** Interrupted mid-checkpoint but not an error -- the sweep will requeue it automatically. */
export function markPartial(db: DatabaseSync, id: string, note?: string): void {
  db.prepare(
    `UPDATE work_items SET state='partial', lease_owner=NULL, lease_expires_at=NULL, last_error=?, updated_at=?
     WHERE work_item_id=?`,
  ).run(note ?? null, new Date().toISOString(), id);
}

export function markFailed(db: DatabaseSync, item: WorkItemRow, error: string, retryable: boolean): void {
  const now = new Date().toISOString();
  if (retryable && item.attempts < item.max_attempts) {
    const availableAt = new Date(Date.now() + computeBackoffMs(item.attempts)).toISOString();
    db.prepare(
      `UPDATE work_items SET state='retryable_failed', lease_owner=NULL, lease_expires_at=NULL,
         last_error=?, available_at=?, updated_at=? WHERE work_item_id=?`,
    ).run(error, availableAt, now, item.work_item_id);
  } else {
    db.prepare(
      `UPDATE work_items SET state='permanent_failed', lease_owner=NULL, lease_expires_at=NULL,
         last_error=?, updated_at=? WHERE work_item_id=?`,
    ).run(error, now, item.work_item_id);
  }
}

/** Used by `retry-failed --all`: gives up-for-good items another chance. */
export function resetPermanentFailures(db: DatabaseSync, source?: string, queue?: string): number {
  const now = new Date().toISOString();
  const clauses = [`state='permanent_failed'`];
  const params: SQLInputValue[] = [];
  if (source) {
    clauses.push('source=?');
    params.push(source);
  }
  if (queue) {
    clauses.push('queue=?');
    params.push(queue);
  }
  const result = db
    .prepare(
      `UPDATE work_items SET state='pending', attempts=0, available_at=?, last_error=NULL, updated_at=?
       WHERE ${clauses.join(' AND ')}`,
    )
    .run(now, now, ...params);
  return Number(result.changes);
}

export function cancelByScopePrefix(db: DatabaseSync, prefix: string): number {
  const now = new Date().toISOString();
  const escaped = prefix.replace(/[%_\\]/g, (c) => `\\${c}`);
  const result = db
    .prepare(
      `UPDATE work_items SET state='cancelled', lease_owner=NULL, lease_expires_at=NULL, updated_at=?
       WHERE state IN ('pending','leased') AND scope_key LIKE ? ESCAPE '\\'`,
    )
    .run(now, `${escaped}%`);
  return Number(result.changes);
}
