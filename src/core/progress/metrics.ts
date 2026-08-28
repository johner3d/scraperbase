import type { DatabaseSync } from 'node:sqlite';

export function bumpCounter(db: DatabaseSync, runId: string, metric: string, delta = 1): void {
  db.prepare(
    `INSERT INTO counters (run_id, metric_name, value) VALUES (?, ?, ?)
     ON CONFLICT(run_id, metric_name) DO UPDATE SET value = value + excluded.value`,
  ).run(runId, metric, delta);
}

export function getCounters(db: DatabaseSync, runId: string): Record<string, number> {
  const rows = db.prepare(`SELECT metric_name, value FROM counters WHERE run_id = ?`).all(runId) as {
    metric_name: string;
    value: number;
  }[];
  return Object.fromEntries(rows.map((r) => [r.metric_name, r.value]));
}
