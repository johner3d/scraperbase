import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb } from '../../src/core/db/client.ts';
import {
  clearStageRun,
  readStageControl,
  requestStageRun,
  setStageAuto,
  stageTickDecision,
} from '../../src/pipeline/stageControl.ts';

type Db = ReturnType<typeof openDb>;
async function withDb<T>(fn: (db: Db) => Promise<T> | T): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'scraperbase-stage-'));
  const db = openDb(path.join(root, 'db.sqlite'));
  try { return await fn(db); } finally { db.close(); await rm(root, { recursive: true, force: true }); }
}

test('stage control flags round-trip through pipeline_stage_status', async () => {
  await withDb((db) => {
    assert.deepEqual(readStageControl(db, 'ingest'), { autoEnabled: true, runRequestedAt: null, runDrain: false });

    setStageAuto(db, 'ingest', false);
    assert.equal(readStageControl(db, 'ingest').autoEnabled, false);
    // Other stages untouched.
    assert.equal(readStageControl(db, 'psa-fetch').autoEnabled, true);

    requestStageRun(db, 'ingest', true);
    const c = readStageControl(db, 'ingest');
    assert.ok(c.runRequestedAt);
    assert.equal(c.runDrain, true);

    clearStageRun(db, 'ingest');
    assert.equal(readStageControl(db, 'ingest').runRequestedAt, null);
    assert.equal(readStageControl(db, 'ingest').runDrain, false);
    // Park flag survives the run clear.
    assert.equal(readStageControl(db, 'ingest').autoEnabled, false);
  });
});

test('stageTickDecision: park, manual poke, and backoff', () => {
  const now = 1_000_000;
  // parked, no poke -> never ticks
  assert.deepEqual(
    stageTickDecision({ autoEnabled: false, runRequestedAt: null, runDrain: false }, 0, now),
    { tick: false, manual: false, drain: false },
  );
  // parked + poke -> ticks, manual, ignores backoff far in the future
  assert.deepEqual(
    stageTickDecision({ autoEnabled: false, runRequestedAt: 'x', runDrain: true }, now + 1e9, now),
    { tick: true, manual: true, drain: true },
  );
  // auto + backoff not elapsed -> no tick
  assert.equal(
    stageTickDecision({ autoEnabled: true, runRequestedAt: null, runDrain: false }, now + 5000, now).tick,
    false,
  );
  // auto + backoff elapsed -> tick
  assert.equal(
    stageTickDecision({ autoEnabled: true, runRequestedAt: null, runDrain: false }, now - 1, now).tick,
    true,
  );
});

test('unknown stage names are rejected', async () => {
  await withDb((db) => {
    assert.throws(() => setStageAuto(db, 'nonsense', false), /Unknown stage/);
    assert.throws(() => requestStageRun(db, 'nonsense', false), /Unknown stage/);
  });
});
