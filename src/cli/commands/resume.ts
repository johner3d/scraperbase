import { openCliDb } from '../context.ts';
import { runCommand, type RunCliOptions } from './run.ts';

/**
 * `resume` is deliberately thin: the durable queue (sweepQueue reclaiming
 * leased/partial/retryable items) is what makes resuming safe, not this
 * command. This just re-reads the previous run's config and calls `run`
 * again so the user doesn't have to retype flags.
 */
export async function resumeCommand(_args: string[]): Promise<void> {
  const db = openCliDb();
  const last = db.prepare('SELECT config_json FROM runs ORDER BY created_at DESC LIMIT 1').get() as
    | { config_json: string }
    | undefined;
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
  ];
  if (cfg.scope) args.push('--scope', cfg.scope);
  await runCommand(args);
}
