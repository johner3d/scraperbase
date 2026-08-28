import { parseArgs } from 'node:util';
import { openCliDb } from '../context.ts';
import { createRun, finishRun } from '../../core/queue/run.ts';
import { runQueue } from '../../core/queue/runner.ts';
import { logEvent } from '../../core/events/eventLog.ts';
import { createRateLimiter } from '../../core/http/rateLimiter.ts';
import {
  createSyntheticCollector,
  enqueueSyntheticItems,
  SYNTHETIC_QUEUE,
} from '../../sources/synthetic/echoSource.ts';
import { createTcgdexDiscoveryCollector, seedDiscovery } from '../../sources/tcgdex/discovery.ts';
import { createTcgdexCatalogueCollector } from '../../sources/tcgdex/collectors/catalogue.ts';
import { createTcgdexImageCollector } from '../../sources/tcgdex/collectors/images.ts';
import { DEFAULT_TCGDEX_LANGUAGES } from '../../sources/tcgdex/config.ts';

export interface RunCliOptions {
  source: string;
  concurrency: number;
  leaseTtlMs: number;
  syntheticCount: number;
  syntheticDelayMs: number;
  scope?: string;
  lang: string;
}

export async function runCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      source: { type: 'string', default: 'synthetic' },
      concurrency: { type: 'string', default: '5' },
      count: { type: 'string', default: '20' },
      'lease-ttl-ms': { type: 'string', default: '300000' },
      'synthetic-delay-ms': { type: 'string', default: '20' },
      scope: { type: 'string' },
      lang: { type: 'string', default: DEFAULT_TCGDEX_LANGUAGES.join(',') },
    },
  });

  const opts: RunCliOptions = {
    source: values.source as string,
    concurrency: Number(values.concurrency),
    leaseTtlMs: Number(values['lease-ttl-ms']),
    syntheticCount: Number(values.count),
    syntheticDelayMs: Number(values['synthetic-delay-ms']),
    scope: values.scope as string | undefined,
    lang: values.lang as string,
  };

  const db = openCliDb();
  const runId = createRun(db, `run --source ${opts.source}`, opts);
  logEvent(db, {
    runId,
    level: 'info',
    category: 'system',
    message: `Run started (source=${opts.source}, concurrency=${opts.concurrency})`,
  });

  let draining = false;
  const onSignal = (signal: string) => {
    if (draining) return;
    draining = true;
    logEvent(db, { runId, level: 'warn', category: 'system', message: `Received ${signal}, draining...` });
    console.error(`\nReceived ${signal} -- finishing in-flight work, then stopping (no new work claimed)...`);
  };
  const sigintHandler = () => onSignal('SIGINT');
  const sigtermHandler = () => onSignal('SIGTERM');
  process.once('SIGINT', sigintHandler);
  process.once('SIGTERM', sigtermHandler);

  try {
    if (opts.source === 'synthetic') {
      const existing = db.prepare(`SELECT COUNT(*) as n FROM work_items WHERE source='synthetic'`).get() as {
        n: number;
      };
      if (existing.n === 0) enqueueSyntheticItems(db, opts.syntheticCount);
      await runQueue(db, {
        queue: SYNTHETIC_QUEUE,
        collector: createSyntheticCollector({ delayMs: opts.syntheticDelayMs }),
        concurrency: opts.concurrency,
        leaseTtlMs: opts.leaseTtlMs,
        runId,
        isDraining: () => draining,
      });
    } else if (opts.source === 'tcgdex') {
      const langs = opts.lang.split(',').map((s) => s.trim()).filter(Boolean);
      const setFilter = opts.scope?.startsWith('set:') ? opts.scope.slice('set:'.length) : undefined;
      const rateLimiter = createRateLimiter({ minDelayMs: 50, jitterMs: 20 });

      seedDiscovery(db, langs);

      await runQueue(db, {
        queue: 'tcgdex_discovery',
        collector: createTcgdexDiscoveryCollector({ rateLimiter, setFilter }),
        concurrency: opts.concurrency,
        leaseTtlMs: opts.leaseTtlMs,
        runId,
        isDraining: () => draining,
      });
      await runQueue(db, {
        queue: 'catalogue_json',
        collector: createTcgdexCatalogueCollector({ rateLimiter }),
        concurrency: opts.concurrency,
        leaseTtlMs: opts.leaseTtlMs,
        runId,
        isDraining: () => draining,
      });
      await runQueue(db, {
        queue: 'images',
        collector: createTcgdexImageCollector({ rateLimiter }),
        concurrency: opts.concurrency,
        leaseTtlMs: opts.leaseTtlMs,
        runId,
        isDraining: () => draining,
      });
    } else {
      console.error(`Source '${opts.source}' is not implemented yet (PSA arrives in Phase 3).`);
      process.exitCode = 1;
    }
    finishRun(db, runId, draining ? 'cancelled' : 'completed');
  } catch (err) {
    finishRun(db, runId, 'failed');
    logEvent(db, {
      runId,
      level: 'error',
      category: 'system',
      message: `Run failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    throw err;
  } finally {
    process.removeListener('SIGINT', sigintHandler);
    process.removeListener('SIGTERM', sigtermHandler);
    db.close();
  }
}
