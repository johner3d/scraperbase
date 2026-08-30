import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb } from '../../src/core/db/client.ts';
import { recordStageActivity, readStageStatus } from '../../src/pipeline/stageState.ts';
import { supervisorStatus } from '../../src/pipeline/supervisorStatus.ts';
import { addSearchTerm } from '../../src/pipeline/searchTerms.ts';

type Db = ReturnType<typeof openDb>;
async function withDb<T>(fn: (db: Db) => Promise<T> | T): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'scraperbase-supervisor-'));
  const db = openDb(path.join(root, 'db.sqlite'));
  try { return await fn(db); } finally { db.close(); await rm(root, { recursive: true, force: true }); }
}

test('recordStageActivity tracks throughput window and derived state', async () => {
  await withDb((db) => {
    recordStageActivity(db, 'ingest', { workDone: 3, note: 'seeded' }, 'working');
    recordStageActivity(db, 'ingest', { workDone: 2 }, 'working');
    const row = readStageStatus(db, 'ingest')[0]!;
    assert.equal(row.items_done_total, 5);
    assert.equal(row.items_done_window, 5);
    assert.equal(row.state, 'working');
    assert.ok(row.last_activity_at);

    recordStageActivity(db, 'ingest', { workDone: 0, nextEligibleAt: '2099-01-01T00:00:00.000Z' }, 'idle');
    const idle = readStageStatus(db, 'ingest')[0]!;
    assert.equal(idle.state, 'idle');
    assert.equal(idle.items_done_total, 5, 'total is unchanged by a no-op tick');
    assert.equal(idle.next_eligible_at, '2099-01-01T00:00:00.000Z');
  });
});

test('supervisorStatus reports every stage, quota, and per-term funnels', async () => {
  await withDb((db) => {
    addSearchTerm(db, { query: 'charizard psa 10', marketplace: 'de' });
    const status = supervisorStatus(db);
    assert.equal(status.running, false);
    assert.deepEqual(status.stages.map((s) => s.stage).sort(),
      ['ebay-match', 'ingest', 'psa-cert', 'psa-fetch', 'psa-identity', 'publish', 'reconcile']);
    assert.equal(status.quota.limit, 4500);
    assert.equal(status.terms.length, 1);
    assert.deepEqual(status.terms[0]!.funnel, { found: 0, detailed: 0, matched: 0, psaTargetedLive: 0, population: 0, guide: 0, sales: 0 });
  });
});
