import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb } from '../../src/core/db/client.ts';
import { enqueueWorkItem, markFailed } from '../../src/core/queue/scheduler.ts';
import { listDeadLetters, openDeadLetterCount, recordDeadLetter, resolveDeadLetter, retryDeadLetters } from '../../src/pipeline/deadLetters.ts';

type Db = ReturnType<typeof openDb>;
async function withDb<T>(fn: (db: Db) => Promise<T> | T): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'scraperbase-dead-letters-'));
  const db = openDb(path.join(root, 'db.sqlite'));
  try { return await fn(db); } finally { db.close(); await rm(root, { recursive: true, force: true }); }
}

test('dead-letters: record is idempotent, resolve hides it, retry re-pends the work and clears the row', async () => {
  await withDb((db) => {
    // A permanently-failed work item behind a psa-fetch dead-letter.
    const id = enqueueWorkItem(db, { source: 'psa', queue: 'psa_enrichment_sales', entityType: 'sales_snapshot', scopeKey: 'enrichment:sales:spec=999', params: {} });
    const item = db.prepare(`SELECT * FROM work_items WHERE work_item_id=?`).get(id) as { work_item_id: string; attempts: number; max_attempts: number; source: string; queue: string; scope_key: string; state: string; params_json: string; entity_type: string };
    markFailed(db, { ...item, attempts: 8 } as never, 'boom', false);
    assert.equal((db.prepare(`SELECT state FROM work_items WHERE work_item_id=?`).get(id) as { state: string }).state, 'permanent_failed');

    recordDeadLetter(db, { stage: 'psa-fetch', scopeKey: 'enrichment:sales:spec=999', workItemId: id, reason: 'boom' });
    recordDeadLetter(db, { stage: 'psa-fetch', scopeKey: 'enrichment:sales:spec=999', workItemId: id, reason: 'boom again' });
    assert.equal(listDeadLetters(db).length, 1, 'same (stage,scope) upserts, not duplicates');
    assert.equal(openDeadLetterCount(db, 'psa-fetch'), 1);

    resolveDeadLetter(db, 'psa-fetch', 'enrichment:sales:spec=999');
    assert.equal(openDeadLetterCount(db, 'psa-fetch'), 0);
    assert.equal(listDeadLetters(db, { includeResolved: true }).length, 1);

    // Re-open then retry: work goes back to pending, dead-letter row removed.
    recordDeadLetter(db, { stage: 'psa-fetch', scopeKey: 'enrichment:sales:spec=999', workItemId: id, reason: 'boom' });
    const result = retryDeadLetters(db, { stage: 'psa-fetch' });
    assert.equal(result.reset, 1);
    assert.equal(result.cleared, 1);
    assert.equal((db.prepare(`SELECT state FROM work_items WHERE work_item_id=?`).get(id) as { state: string }).state, 'pending');
    assert.equal(listDeadLetters(db).length, 0);
  });
});
