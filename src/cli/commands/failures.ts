import { parseArgs } from 'node:util';
import type { SQLInputValue } from 'node:sqlite';
import { openCliDb } from '../context.ts';

interface FailureRow {
  work_item_id: string;
  state: string;
  attempts: number;
  max_attempts: number;
  available_at: string;
  last_error: string | null;
}

export async function failuresCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { source: { type: 'string' }, queue: { type: 'string' } } });

  const db = openCliDb();
  const clauses = [`state IN ('retryable_failed','permanent_failed')`];
  const params: SQLInputValue[] = [];
  if (values.source) {
    clauses.push('source = ?');
    params.push(values.source);
  }
  if (values.queue) {
    clauses.push('queue = ?');
    params.push(values.queue);
  }

  const rows = db
    .prepare(
      `SELECT work_item_id, state, attempts, max_attempts, available_at, last_error
       FROM work_items WHERE ${clauses.join(' AND ')} ORDER BY updated_at DESC`,
    )
    .all(...params) as unknown as FailureRow[];

  db.close();

  if (rows.length === 0) {
    console.log('No failures.');
    return;
  }
  for (const row of rows) {
    console.log(
      `[${row.state}] ${row.work_item_id} (attempt ${row.attempts}/${row.max_attempts}) ` +
        `next=${row.available_at} error=${row.last_error ?? '(none)'}`,
    );
  }
}
