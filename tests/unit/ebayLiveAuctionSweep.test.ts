import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb } from '../../src/core/db/client.ts';
import { seedEbayLiveAuctionSearch } from '../../src/sources/ebay/discovery.ts';

async function withDb<T>(fn: (db: ReturnType<typeof openDb>) => Promise<T> | T): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'scraperbase-ebay-live-auction-'));
  const db = openDb(path.join(root, 'db.sqlite'));
  try {
    return await fn(db);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
}

test('seedEbayLiveAuctionSearch enqueues one live-auction search work item with a resolved cutoff', async () => {
  await withDb((db) => {
    const now = new Date('2026-08-30T12:00:00.000Z');
    seedEbayLiveAuctionSearch(db, { marketplace: 'de', query: 'pokemon psa 10', limit: 200, minBidCount: 1, endingWithinHours: 72, now });

    const rows = db.prepare(
      `SELECT scope_key, params_json FROM work_items WHERE source='ebay' AND queue='ebay_search'`,
    ).all() as unknown as Array<{ scope_key: string; params_json: string }>;
    assert.equal(rows.length, 1);
    assert.match(rows[0]!.scope_key, /mode=live_auctions/);
    const params = JSON.parse(rows[0]!.params_json);
    assert.equal(params.query, 'pokemon psa 10');
    assert.equal(params.mode, 'live_auctions');
    assert.equal(params.minBidCount, 1);
    assert.equal(params.endingBeforeAt, '2026-09-02T12:00:00.000Z');
  });
});

test('seedEbayLiveAuctionSearch is idempotent within the same cutoff window (re-seeding does not duplicate work)', async () => {
  await withDb((db) => {
    const now = new Date('2026-08-30T12:00:00.000Z');
    seedEbayLiveAuctionSearch(db, { marketplace: 'de', query: 'pokemon psa 10', limit: 200, now });
    seedEbayLiveAuctionSearch(db, { marketplace: 'de', query: 'pokemon psa 10', limit: 200, now });
    const count = db.prepare(`SELECT COUNT(*) n FROM work_items WHERE source='ebay' AND queue='ebay_search'`).get() as { n: number };
    assert.equal(count.n, 1);
  });
});

test('a fresh cutoff (a later day) produces a new, distinct search work item instead of colliding with a prior day\'s sweep', async () => {
  await withDb((db) => {
    seedEbayLiveAuctionSearch(db, { marketplace: 'de', query: 'pokemon psa 10', limit: 200, now: new Date('2026-08-30T12:00:00.000Z') });
    seedEbayLiveAuctionSearch(db, { marketplace: 'de', query: 'pokemon psa 10', limit: 200, now: new Date('2026-08-31T12:00:00.000Z') });
    const rows = db.prepare(`SELECT params_json FROM work_items WHERE source='ebay' AND queue='ebay_search'`).all() as unknown as Array<{ params_json: string }>;
    assert.equal(rows.length, 2);
    const cutoffs = new Set(rows.map((r) => JSON.parse(r.params_json).endingBeforeAt));
    assert.equal(cutoffs.size, 2);
  });
});
