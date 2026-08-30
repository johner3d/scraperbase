import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fetchRaw } from '../../src/core/http/fetchClient.ts';
import { openDb } from '../../src/core/db/client.ts';
import { createRun } from '../../src/core/queue/run.ts';
import { enqueueWorkItem, claimNext } from '../../src/core/queue/scheduler.ts';
import { processItem, type Collector } from '../../src/core/queue/runner.ts';

/** A server that accepts the connection and then never answers. */
async function hangingServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(() => {
    /* intentionally never write a response */
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

test('fetchRaw: aborts a stalled request within the timeout instead of hanging forever', async () => {
  const srv = await hangingServer();
  try {
    const start = Date.now();
    await assert.rejects(
      () => fetchRaw(srv.url, {}, { timeoutMs: 150 }),
      (err: unknown) => err instanceof Error && /abort|timeout/i.test(err.name + err.message),
    );
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 2_000, `expected fetchRaw to abort quickly, took ${elapsed}ms`);
  } finally {
    await srv.close();
  }
});

test('processItem: a fetch timeout becomes a retryable_failed transition, not a thrown crash', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'scraperbase-fetch-timeout-'));
  const db = openDb(path.join(root, 'db.sqlite'));
  const srv = await hangingServer();
  try {
    const runId = createRun(db, 'fetch-timeout-fixture', {});
    enqueueWorkItem(db, { source: 'test', queue: 'timeout_queue', entityType: 'thing', scopeKey: 'item:1', params: {} });
    const item = claimNext(db, 'timeout_queue', 'owner', 60_000)!;

    const collector: Collector = async () => {
      await fetchRaw(srv.url, {}, { timeoutMs: 100 });
      return { outcome: 'success', final: 'succeeded', sourceIdentity: 'test' };
    };

    const result = await processItem(db, item, collector, { runId });
    assert.equal(result.final, 'retryable_failed');

    const row = db.prepare(`SELECT state FROM work_items WHERE work_item_id=?`).get(item.work_item_id) as { state: string };
    assert.equal(row.state, 'retryable_failed');
  } finally {
    await srv.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
