import type { DatabaseSync } from 'node:sqlite';

export type EventLevel = 'info' | 'warn' | 'error';

export function logEvent(
  db: DatabaseSync,
  opts: { runId?: string | null; level: EventLevel; category: string; message: string; data?: unknown },
): void {
  db.prepare(
    `INSERT INTO events (run_id, ts, level, category, message, data_json) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.runId ?? null,
    new Date().toISOString(),
    opts.level,
    opts.category,
    opts.message,
    opts.data === undefined ? null : JSON.stringify(opts.data),
  );
}
