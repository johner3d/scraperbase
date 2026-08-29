import { openCliDb } from '../context.ts';
import { runCommand, type RunCliOptions } from './run.ts';

/**
 * `resume` is deliberately thin: the durable queue (sweepQueue reclaiming
 * leased/partial/retryable items) is what makes resuming safe, not this
 * command. This just re-reads the previous run's config and calls `run`
 * again so the user doesn't have to retype flags.
 */
export async function resumeCommand(argsInput: string[]): Promise<void> {
  const db = openCliDb();
  const requested = argsInput[0];
  const last = (requested
    ? db.prepare('SELECT run_id,config_json FROM runs WHERE run_id=?').get(requested)
    : db.prepare("SELECT run_id,config_json FROM runs WHERE status IN ('running','cancelled','failed') AND cli_command LIKE 'run --source %' ORDER BY created_at DESC LIMIT 1").get()) as
    | { run_id: string; config_json: string }
    | undefined;
  if (last) db.prepare(`UPDATE runs SET status='cancelled',ended_at=?,heartbeat_at=? WHERE run_id=? AND status='running'`).run(new Date().toISOString(),new Date().toISOString(),last.run_id);
  db.close();

  if (!last) {
    console.error('No previous run to resume.');
    process.exitCode = 1;
    return;
  }

  const cfg = JSON.parse(last.config_json) as RunCliOptions;
  const args = [
    '--source',
    cfg.source,
    '--concurrency',
    String(cfg.concurrency),
    '--lease-ttl-ms',
    String(cfg.leaseTtlMs),
    '--count',
    String(cfg.syntheticCount),
    '--synthetic-delay-ms',
    String(cfg.syntheticDelayMs),
    '--lang',
    cfg.lang,
    '--stage',
    cfg.stage ?? 'index',
    '--priority',
    cfg.priority ?? 'psa',
  ];
  if (cfg.scope) args.push('--scope', cfg.scope);
  await runCommand(args);
}
