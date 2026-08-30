import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb } from '../../src/core/db/client.ts';
import { createRun } from '../../src/core/queue/run.ts';
import { enqueueWorkItem } from '../../src/core/queue/scheduler.ts';
import { runQueue, type Collector } from '../../src/core/queue/runner.ts';

async function withDb<T>(fn: (db: ReturnType<typeof openDb>) => Promise<T> | T): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'scraperbase-runner-cooldown-'));
  const db = openDb(path.join(root, 'db.sqlite'));
  try {
    return await fn(db);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
}

test('runQueue: pauses for cooldownMs after N consecutive non-success outcomes, then keeps draining', async () => {
  await withDb(async (db) => {
    const runId = createRun(db, 'cooldown-fixture', {});
    for (let i = 0; i < 5; i++) {
      enqueueWorkItem(db, { source: 'test', queue: 'cooldown_queue', entityType: 'thing', scopeKey: `item:${i}`, params: {} });
    }

    const callTimes: number[] = [];
    let call = 0;
    const collector: Collector = async () => {
      callTimes.push(Date.now());
      call++;
      // First 3 items fail (rate-limited); the rest succeed.
      if (call <= 3) {
        return { outcome: 'rate_limited', final: 'retryable_failed', sourceIdentity: 'test', errorMessage: '429' };
      }
      return { outcome: 'success', final: 'succeeded', sourceIdentity: 'test' };
    };

    const cooldownMs = 200;
    await runQueue(db, {
      queue: 'cooldown_queue',
      collector,
      concurrency: 1,
      leaseTtlMs: 60_000,
      runId,
      isDraining: () => false,
      cooldown: { afterConsecutiveFailures: 3, cooldownMs },
    });

    assert.equal(call, 5, 'all 5 work items should eventually be processed');

    // The gap between the 3rd (failing) call and the 4th call must be at
    // least the configured cooldown -- proof the circuit breaker actually
    // paused instead of immediately claiming the next pending item.
    const gapAfterThirdFailure = callTimes[3]! - callTimes[2]!;
    assert.ok(
      gapAfterThirdFailure >= cooldownMs,
      `expected >= ${cooldownMs}ms pause after 3 consecutive failures, got ${gapAfterThirdFailure}ms`,
    );

    const failedRow = db.prepare(
      `SELECT count(*) as n FROM work_items WHERE source='test' AND queue='cooldown_queue' AND state='retryable_failed'`,
    ).get() as { n: number };
    assert.equal(failedRow.n, 3);

    const succeededRow = db.prepare(
      `SELECT count(*) as n FROM work_items WHERE source='test' AND queue='cooldown_queue' AND state='succeeded'`,
    ).get() as { n: number };
    assert.equal(succeededRow.n, 2);

    const cooldownEvent = db.prepare(
      `SELECT message FROM events WHERE category='system' AND message LIKE '%cooling down%'`,
    ).get() as { message: string } | undefined;
    assert.ok(cooldownEvent, 'expected a logged cooldown event');
  });
});

test('runQueue: without a cooldown option, consecutive failures never pause (unchanged default behavior)', async () => {
  await withDb(async (db) => {
    const runId = createRun(db, 'no-cooldown-fixture', {});
    for (let i = 0; i < 4; i++) {
      enqueueWorkItem(db, { source: 'test', queue: 'no_cooldown_queue', entityType: 'thing', scopeKey: `item:${i}`, params: {} });
    }

    const collector: Collector = async () => ({ outcome: 'rate_limited', final: 'retryable_failed', sourceIdentity: 'test', errorMessage: '429' });

    const start = Date.now();
    await runQueue(db, {
      queue: 'no_cooldown_queue',
      collector,
      concurrency: 1,
      leaseTtlMs: 60_000,
      runId,
      isDraining: () => false,
    });
    const elapsed = Date.now() - start;

    assert.ok(elapsed < 2_000, `expected no cooldown pause without opts.cooldown, took ${elapsed}ms`);
  });
});

test('runQueue: haltOnRateLimit leaves fresh work pending for a later resume', async () => {
  await withDb(async (db) => {
    const runId = createRun(db, 'rate-limit-halt-fixture', {});
    for (let i = 0; i < 5; i++) {
      enqueueWorkItem(db, { source: 'test', queue: 'rate_limit_queue', entityType: 'thing', scopeKey: `item:${i}`, params: {} });
    }
    let calls = 0;
    const collector: Collector = async () => {
      calls++;
      return { outcome: 'rate_limited', final: 'retryable_failed', sourceIdentity: 'test', httpStatus: 429 };
    };
    await runQueue(db, {
      queue: 'rate_limit_queue', collector, concurrency: 1, leaseTtlMs: 60_000, runId,
      isDraining: () => false, haltOnRateLimit: true,
    });
    assert.equal(calls, 1);
    const states = db.prepare(`SELECT state,COUNT(*) n FROM work_items WHERE queue='rate_limit_queue' GROUP BY state`).all() as unknown as Array<{state:string;n:number}>;
    assert.deepEqual(Object.fromEntries(states.map((row)=>[row.state,Number(row.n)])), { pending: 4, retryable_failed: 1 });
  });
});
