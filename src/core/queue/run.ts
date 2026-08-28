import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export type RunStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export function createRun(db: DatabaseSync, cliCommand: string, config: unknown): string {
  const runId = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO runs (run_id, created_at, started_at, status, cli_command, config_json)
     VALUES (?, ?, ?, 'running', ?, ?)`,
  ).run(runId, now, now, cliCommand, JSON.stringify(config));
  return runId;
}

export function finishRun(db: DatabaseSync, runId: string, status: RunStatus): void {
  db.prepare(`UPDATE runs SET status=?, ended_at=? WHERE run_id=?`).run(status, new Date().toISOString(), runId);
}
