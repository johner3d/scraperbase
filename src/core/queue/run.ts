import { randomUUID } from 'node:crypto';
import os from 'node:os';
import type { DatabaseSync } from 'node:sqlite';

export type RunStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export function createRun(db: DatabaseSync, cliCommand: string, config: unknown, exclusive = false): string {
  const runId = randomUUID();
  const now = new Date().toISOString();
  const staleBefore = new Date(Date.now() - 2 * 60_000).toISOString();
  db.prepare(`UPDATE runs SET status='cancelled', ended_at=?
    WHERE status='running' AND COALESCE(heartbeat_at, started_at, created_at) < ?`).run(now, staleBefore);
  const active = exclusive ? db.prepare(`SELECT run_id, cli_command FROM runs WHERE status='running' LIMIT 1`).get() as
    | { run_id: string; cli_command: string }
    | undefined : undefined;
  if (active) throw new Error(`Another writer is active (${active.cli_command}, run ${active.run_id}). Wait for it or cancel it first.`);
  const stage = typeof config === 'object' && config && 'stage' in config ? String((config as { stage?: unknown }).stage ?? '') : null;
  db.prepare(
    `INSERT INTO runs (run_id, created_at, started_at, status, cli_command, config_json, host_name, process_id, heartbeat_at, stage)
     VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?, ?)`,
  ).run(runId, now, now, cliCommand, JSON.stringify(config), os.hostname(), process.pid, now, stage);
  return runId;
}

export function finishRun(db: DatabaseSync, runId: string, status: RunStatus): void {
  const now = new Date().toISOString();
  db.prepare(`UPDATE runs SET status=?, ended_at=?, heartbeat_at=? WHERE run_id=?`).run(status, now, now, runId);
}
