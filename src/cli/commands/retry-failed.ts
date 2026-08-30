import { parseArgs } from 'node:util';
import type { SQLInputValue } from 'node:sqlite';
import { openCliDb } from '../context.ts';
import { resetPermanentFailures } from '../../core/queue/scheduler.ts';

export async function retryFailedCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      source: { type: 'string' },
      queue: { type: 'string' },
      all: { type: 'boolean', default: false },
    },
  });

  const db = openCliDb();

  if (values.all) {
    const n = resetPermanentFailures(db, {
      source: values.source as string | undefined,
      queue: values.queue as string | undefined,
    });
    console.log(`Reset ${n} permanently-failed item(s) back to pending.`);
  } else {
    const now = new Date().toISOString();
    const clauses = [`state='retryable_failed'`];
    const whereParams: SQLInputValue[] = [];
    if (values.source) {
      clauses.push('source = ?');
      whereParams.push(values.source);
    }
    if (values.queue) {
      clauses.push('queue = ?');
      whereParams.push(values.queue);
    }
    const result = db
      .prepare(`UPDATE work_items SET state='pending', available_at=?, updated_at=? WHERE ${clauses.join(' AND ')}`)
      .run(now, now, ...whereParams);
    console.log(`Fast-tracked ${result.changes} retryable item(s) past their backoff.`);
  }

  db.close();
}
