import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../../src/core/db/client.ts';
import { createRun } from '../../src/core/queue/run.ts';
import { runQueue } from '../../src/core/queue/runner.ts';
import {
  createSyntheticCollector,
  enqueueSyntheticItems,
  SYNTHETIC_QUEUE,
} from '../../src/sources/synthetic/echoSource.ts';

const CLI_PATH = fileURLToPath(new URL('../../src/cli/index.ts', import.meta.url));

function spawnCli(dataDir: string, args: string[]): ReturnType<typeof spawn> {
  return spawn(process.execPath, [CLI_PATH, ...args], {
    env: { ...process.env, SCRAPERBASE_DATA_DIR: dataDir },
    stdio: 'ignore',
  });
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<number | null> {
  return new Promise((resolve) => child.once('exit', (code) => resolve(code)));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** node:sqlite rows have a null prototype; normalize before deepEqual. */
function plain<T>(rows: T[]): T[] {
  return JSON.parse(JSON.stringify(rows)) as T[];
}

/**
 * WAL mode leaves -shm/-wal files that Windows can hold onto for a moment
 * after DatabaseSync#close() returns, which makes an immediate rm() flaky
 * with EBUSY. Retry instead of failing the test over cleanup timing.
 */
async function rmWithRetry(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EBUSY' || attempt === 9) throw err;
      await sleep(100);
    }
  }
}

interface WorkItemStateRow {
  state: string;
  n: number;
}

/**
 * Polls the DB (created by a just-spawned subprocess, so it may not exist
 * yet) until it reports a "partway done" state, instead of guessing a fixed
 * sleep duration -- Node/process startup time is too variable on CI/local
 * Windows machines to hardcode a delay reliably.
 */
async function waitUntilPartlySucceeded(
  dbPath: string,
  itemCount: number,
  maxWaitMs: number,
): Promise<number> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    try {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      const row = db.prepare(`SELECT COUNT(*) as n FROM work_items WHERE state = 'succeeded'`).get() as {
        n: number;
      };
      db.close();
      if (row.n > 0 && row.n < itemCount) return row.n;
    } catch {
      // DB not created yet, or momentarily locked by the writer -- keep polling.
    }
    await sleep(25);
  }
  throw new Error(`Timed out waiting for a partial completion state at ${dbPath}`);
}

test(
  'a killed (SIGKILL) run leaves no duplicates, and resume drives the queue to full completion',
  { timeout: 30_000 },
  async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'scraperbase-crash-'));
    try {
      const ITEM_COUNT = 30;
      const dbPath = path.join(dataDir, 'db.sqlite');

      // Short lease TTL so the lease abandoned by the killed process is
      // provably stale (not just "not yet expired") by the time we resume.
      const first = spawnCli(dataDir, [
        'run',
        '--source',
        'synthetic',
        '--count',
        String(ITEM_COUNT),
        '--concurrency',
        '2',
        '--synthetic-delay-ms',
        '150',
        '--lease-ttl-ms',
        '800',
      ]);

      const midSucceeded = await waitUntilPartlySucceeded(dbPath, ITEM_COUNT, 10_000);
      assert.ok(midSucceeded > 0 && midSucceeded < ITEM_COUNT);

      first.kill('SIGKILL');
      await waitForExit(first);

      // Wait past the lease TTL so the abandoned lease is definitely stale,
      // then resume with a fresh, well-behaved process.
      await sleep(1000);

      const second = spawnCli(dataDir, ['resume']);
      const exitCode = await waitForExit(second);
      assert.equal(exitCode, 0);

      const finalDb = new DatabaseSync(dbPath);
      try {
        const finalStates = finalDb
          .prepare('SELECT state, COUNT(*) as n FROM work_items GROUP BY state')
          .all() as unknown as WorkItemStateRow[];
        assert.deepEqual(plain(finalStates), [{ state: 'succeeded', n: ITEM_COUNT }]);

        const rawObjectCount = finalDb.prepare('SELECT COUNT(*) as n FROM raw_objects').get() as { n: number };
        assert.equal(rawObjectCount.n, ITEM_COUNT, 'each synthetic item has distinct content -> distinct objects');

        const observationCount = finalDb.prepare('SELECT COUNT(*) as n FROM observations').get() as { n: number };
        assert.equal(
          observationCount.n,
          ITEM_COUNT,
          'exactly one observation per item -- no duplicate observation from the crashed attempt',
        );

        const duplicated = finalDb
          .prepare(
            `SELECT work_item_id, COUNT(*) as n FROM attempts WHERE outcome = 'success' GROUP BY work_item_id HAVING n > 1`,
          )
          .all();
        assert.deepEqual(duplicated, []);
      } finally {
        finalDb.close();
      }
    } finally {
      await rmWithRetry(dataDir);
    }
  },
);

// A real subprocess SIGINT test isn't meaningful on Windows: Node maps a
// cross-process kill('SIGINT') to TerminateProcess there (the same as
// SIGKILL), so the child never gets to run its signal handler -- only a
// genuine interactive Ctrl+C in a foreground console does. So the graceful
// drain path (stop claiming, let the in-flight item finish, release its
// lease, exit 0) is exercised in-process instead, driving the same
// `isDraining()` flag the real SIGINT handler flips.
test(
  'runQueue drains gracefully when isDraining() flips: releases leases, and a second pass finishes the rest without duplication',
  { timeout: 15_000 },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'scraperbase-drain-'));
    const dbPath = path.join(root, 'db.sqlite');
    try {
      const ITEM_COUNT = 20;
      const db = openDb(dbPath);
      const runId1 = createRun(db, 'test-drain', {});
      enqueueSyntheticItems(db, ITEM_COUNT);

      let draining = false;
      const drainTimer = setTimeout(() => {
        draining = true;
      }, 80);

      await runQueue(db, {
        queue: SYNTHETIC_QUEUE,
        collector: createSyntheticCollector({ delayMs: 30 }),
        concurrency: 2,
        leaseTtlMs: 60_000,
        runId: runId1,
        isDraining: () => draining,
      });
      clearTimeout(drainTimer);

      const midStates = db.prepare('SELECT state, COUNT(*) as n FROM work_items GROUP BY state').all() as unknown as
        WorkItemStateRow[];
      const midSucceeded = midStates.find((s) => s.state === 'succeeded')?.n ?? 0;
      const midInFlight = midStates.find((s) => s.state === 'leased' || s.state === 'running')?.n ?? 0;

      assert.ok(midSucceeded > 0 && midSucceeded < ITEM_COUNT, `expected a partial run, got ${midSucceeded}/${ITEM_COUNT}`);
      assert.equal(midInFlight, 0, 'a graceful drain must release every lease before returning');

      const runId2 = createRun(db, 'test-drain-resume', {});
      await runQueue(db, {
        queue: SYNTHETIC_QUEUE,
        collector: createSyntheticCollector({ delayMs: 10 }),
        concurrency: 3,
        leaseTtlMs: 60_000,
        runId: runId2,
        isDraining: () => false,
      });

      const finalStates = db.prepare('SELECT state, COUNT(*) as n FROM work_items GROUP BY state').all() as unknown as
        WorkItemStateRow[];
      assert.deepEqual(plain(finalStates), [{ state: 'succeeded', n: ITEM_COUNT }]);

      const observationCount = db.prepare('SELECT COUNT(*) as n FROM observations').get() as { n: number };
      assert.equal(observationCount.n, ITEM_COUNT);

      db.close();
    } finally {
      await rmWithRetry(root);
    }
  },
);
