import type { DatabaseSync } from 'node:sqlite';
import { resetPermanentFailures } from '../core/queue/scheduler.ts';

export interface DeadLetterRow {
  dead_letter_id: number;
  stage: string;
  scope_key: string;
  work_item_id: string | null;
  reason: string;
  detail_json: string;
  first_seen_at: string;
  last_seen_at: string;
  resolved_at: string | null;
}

/**
 * Record (or refresh) a work item a stage has given up on. The stage keeps
 * going instead of aborting; the UI and `pipeline failures` surface these, and
 * `pipeline retry` clears them.
 */
export function recordDeadLetter(db: DatabaseSync, args: {
  stage: string; scopeKey: string; workItemId?: string | null; reason: string; detail?: unknown;
}): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO pipeline_dead_letters (stage,scope_key,work_item_id,reason,detail_json,first_seen_at,last_seen_at)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(stage,scope_key) DO UPDATE SET
       work_item_id=excluded.work_item_id, reason=excluded.reason, detail_json=excluded.detail_json,
       last_seen_at=excluded.last_seen_at, resolved_at=NULL`,
  ).run(args.stage, args.scopeKey, args.workItemId ?? null, args.reason,
    JSON.stringify(args.detail ?? {}), now, now);
}

export function listDeadLetters(db: DatabaseSync, opts: { stage?: string; includeResolved?: boolean } = {}): DeadLetterRow[] {
  const clauses: string[] = [];
  const params: string[] = [];
  if (opts.stage) { clauses.push('stage=?'); params.push(opts.stage); }
  if (!opts.includeResolved) clauses.push('resolved_at IS NULL');
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM pipeline_dead_letters ${where} ORDER BY last_seen_at DESC`)
    .all(...params) as unknown as DeadLetterRow[];
}

export function openDeadLetterCount(db: DatabaseSync, stage: string): number {
  return Number((db.prepare(`SELECT COUNT(*) n FROM pipeline_dead_letters WHERE stage=? AND resolved_at IS NULL`)
    .get(stage) as { n: number }).n);
}

/** Mark one dead-letter thread "won't fix" without retrying it. */
export function resolveDeadLetter(db: DatabaseSync, stage: string, scopeKey: string): number {
  return Number(db.prepare(`UPDATE pipeline_dead_letters SET resolved_at=? WHERE stage=? AND scope_key=? AND resolved_at IS NULL`)
    .run(new Date().toISOString(), stage, scopeKey).changes);
}

const STAGE_QUEUES: Record<string, string[]> = {
  ingest: ['ebay_search', 'ebay_item_detail'],
  'ebay-match': [],
  'psa-cert': ['psa_cert'],
  'psa-identity': ['psa_pop_discovery', 'psa_pop_set_items'],
  'psa-fetch': ['psa_enrichment_population', 'psa_enrichment_sales'],
};

/**
 * Re-pend the failed work behind a stage's dead-letters and drop the
 * dead-letter rows (they'll be re-recorded if the work fails again). With
 * `scopePrefix`, only the matching items.
 */
export function retryDeadLetters(db: DatabaseSync, args: { stage?: string; scopePrefix?: string; all?: boolean }): { reset: number; cleared: number } {
  let reset = 0;
  const queues = args.stage ? (STAGE_QUEUES[args.stage] ?? []) : ([] as string[]);
  if (args.all && !args.stage) {
    reset += resetPermanentFailures(db, { scopePrefix: args.scopePrefix });
  } else {
    for (const queue of queues) {
      reset += resetPermanentFailures(db, { queue, scopePrefix: args.scopePrefix });
    }
  }
  const clauses: string[] = [];
  const params: string[] = [];
  if (args.stage) { clauses.push('stage=?'); params.push(args.stage); }
  if (args.scopePrefix) { clauses.push(`scope_key LIKE ? ESCAPE '\\'`); params.push(`${args.scopePrefix.replace(/[%_\\]/g, (c) => `\\${c}`)}%`); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const cleared = Number(db.prepare(`DELETE FROM pipeline_dead_letters ${where}`).run(...params).changes);
  return { reset, cleared };
}
