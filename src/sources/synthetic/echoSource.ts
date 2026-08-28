// A dev/test-only "source" with no real network I/O. It exists purely so the
// queue engine (leasing, crash-recovery, resumability, dedup) can be
// exercised and verified in isolation, before the real TCGdex/PSA collectors
// exist. Not part of the acquisition product itself.
import type { DatabaseSync } from 'node:sqlite';
import type { Collector } from '../../core/queue/runner.ts';
import { enqueueWorkItem } from '../../core/queue/scheduler.ts';

export const SYNTHETIC_QUEUE = 'synthetic_echo';

export interface SyntheticOptions {
  delayMs?: number;
}

export function createSyntheticCollector(opts: SyntheticOptions = {}): Collector {
  const delayMs = opts.delayMs ?? 20;
  return async (_db, item) => {
    if (delayMs > 0) await sleep(delayMs);
    const params = JSON.parse(item.params_json) as { index: number };
    const body = Buffer.from(JSON.stringify({ index: params.index, scopeKey: item.scope_key }));
    return {
      outcome: 'success',
      final: 'succeeded',
      sourceIdentity: 'synthetic',
      requestUrl: `synthetic://item/${params.index}`,
      object: { source: 'synthetic', mediaKind: 'json', mediaType: 'application/json', ext: 'json', body },
    };
  };
}

export function enqueueSyntheticItems(db: DatabaseSync, count: number): void {
  for (let i = 0; i < count; i++) {
    enqueueWorkItem(db, {
      source: 'synthetic',
      queue: SYNTHETIC_QUEUE,
      entityType: 'synthetic_item',
      scopeKey: `item:${i}`,
      params: { index: i },
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
