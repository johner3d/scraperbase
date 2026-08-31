import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb } from '../../src/core/db/client.ts';
import { ensureSupervisorPipelineRun } from '../../src/pipeline/supervisorState.ts';
import { __resetPsaCircuit, notePsaSuccess, psaCircuitOpen, tripPsaCircuit } from '../../src/pipeline/psaCircuit.ts';

type Db = ReturnType<typeof openDb>;
async function withDb<T>(fn: (db: Db) => Promise<T> | T): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'scraperbase-psacircuit-'));
  const db = openDb(path.join(root, 'db.sqlite'));
  try { return await fn(db); } finally { db.close(); await rm(root, { recursive: true, force: true }); }
}

test('psa circuit-breaker opens on a 429, escalates, and records one pause', async () => {
  await withDb((db) => {
    __resetPsaCircuit();
    const runId = ensureSupervisorPipelineRun(db);

    assert.equal(psaCircuitOpen(db, runId).open, false);

    const first = tripPsaCircuit(db, runId, 'fetch');
    assert.equal(first.open, true);
    assert.ok(Date.parse(first.until!) - Date.now() <= 31 * 60_000);
    assert.equal(psaCircuitOpen(db, runId).open, true);

    const second = tripPsaCircuit(db, runId, 'cert');
    assert.ok(Date.parse(second.until!) - Date.now() > 31 * 60_000, 'second strike backs off further');

    const openRows = db.prepare(
      `SELECT COUNT(*) n FROM pipeline_pauses WHERE stage_name='psa' AND resolved_at IS NULL`,
    ).get() as { n: number };
    assert.equal(openRows.n, 1, 'exactly one open pause row, not one per strike');

    notePsaSuccess(db, runId);
    const stillOpen = db.prepare(
      `SELECT COUNT(*) n FROM pipeline_pauses WHERE stage_name='psa' AND resolved_at IS NULL`,
    ).get() as { n: number };
    assert.equal(stillOpen.n, 0, 'a clean tick resolves the pause');
  });
});

test('psa circuit-breaker rehydrates an active block from the DB after a restart', async () => {
  await withDb((db) => {
    __resetPsaCircuit();
    const runId = ensureSupervisorPipelineRun(db);
    tripPsaCircuit(db, runId, 'fetch');

    // Simulate a fresh process: wipe in-memory state, keep the DB row.
    __resetPsaCircuit();
    assert.equal(psaCircuitOpen(db, runId).open, true, 'block survives a restart via the persisted pause');
  });
});
