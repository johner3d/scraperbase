import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb } from '../../src/core/db/client.ts';
import {
  addSearchTerm,
  dueSearchTerms,
  markTermEnqueued,
  parseDurationMinutes,
  parseEndingWithinHours,
  removeSearchTerm,
  searchParamsForTerm,
  setSearchTermEnabled,
  updateSearchTerm,
} from '../../src/pipeline/searchTerms.ts';
import { buildSearchUrl } from '../../src/sources/ebay/collectors/search.ts';

type Db = ReturnType<typeof openDb>;

async function withDb<T>(fn: (db: Db) => Promise<T> | T): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'scraperbase-search-terms-'));
  const db = openDb(path.join(root, 'db.sqlite'));
  try {
    return await fn(db);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
}

test('parseDurationMinutes / parseEndingWithinHours accept the documented shapes', () => {
  assert.equal(parseDurationMinutes('20m'), 20);
  assert.equal(parseDurationMinutes('2h'), 120);
  assert.equal(parseDurationMinutes('1d'), 1440);
  assert.equal(parseDurationMinutes('45'), 45);
  assert.equal(parseEndingWithinHours('72h'), 72);
  assert.equal(parseEndingWithinHours('3d'), 72);
  assert.equal(parseEndingWithinHours('none'), null);
});

test('search terms: add applies auction defaults, set patches, enable/disable, remove', async () => {
  await withDb((db) => {
    const term = addSearchTerm(db, { query: 'Charizard PSA 10', marketplace: 'de' });
    assert.equal(term.buying_option, 'auction');
    assert.equal(term.min_bids, 1);
    assert.equal(term.ending_within_hours, 72);
    assert.equal(term.enabled, 1);

    assert.throws(() => addSearchTerm(db, { query: 'charizard  psa  10', marketplace: 'de' }), /already exists/);

    const patched = updateSearchTerm(db, String(term.search_term_id), { minBids: 3, priceMax: 4000, refreshIntervalMinutes: 20 });
    assert.equal(patched.min_bids, 3);
    assert.equal(patched.price_max, 4000);
    assert.equal(patched.refresh_interval_minutes, 20);

    assert.equal(setSearchTermEnabled(db, 'Charizard PSA 10', false).enabled, 0);
    assert.equal(dueSearchTerms(db).length, 0, 'disabled terms are never due');

    removeSearchTerm(db, String(term.search_term_id));
    assert.equal(db.prepare('SELECT COUNT(*) n FROM ebay_search_terms').get()!.n, 0);
  });
});

test('dueSearchTerms respects the refresh interval and priority order', async () => {
  await withDb((db) => {
    const a = addSearchTerm(db, { query: 'a', marketplace: 'de', refreshIntervalMinutes: 30, priority: 1 });
    const b = addSearchTerm(db, { query: 'b', marketplace: 'de', refreshIntervalMinutes: 30, priority: 9 });

    // Nothing enqueued yet -> both due, higher priority first.
    assert.deepEqual(dueSearchTerms(db).map((t) => t.search_term_id), [b.search_term_id, a.search_term_id]);

    markTermEnqueued(db, a.search_term_id, new Date());
    markTermEnqueued(db, b.search_term_id, new Date());
    assert.equal(dueSearchTerms(db).length, 0, 'just-enqueued terms are not due again');

    // Fast-forward the "now" we ask about past the interval.
    const later = new Date(Date.now() + 31 * 60_000);
    assert.equal(dueSearchTerms(db, later).length, 2);
  });
});

test('searchParamsForTerm -> buildSearchUrl emits targeted filters per config', async () => {
  await withDb((db) => {
    const auction = addSearchTerm(db, {
      query: 'base set psa 10', marketplace: 'de', minBids: 2, endingWithinHours: 48,
      priceMin: 50, priceMax: 4000, categoryIds: '183454',
    });
    const url = buildSearchUrl(searchParamsForTerm(auction, 200, new Date('2026-08-31T00:00:00.000Z')));
    assert.match(url, /buyingOptions%3A%7BAUCTION%7D/);
    assert.match(url, /sort=endingSoonest/);
    assert.match(url, /itemEndDate/);
    assert.match(url, /price%3A%5B50\.00\.\.4000\.00%5D/);
    assert.match(url, /category_ids=183454/);

    const fixed = addSearchTerm(db, { query: 'fixed cards', marketplace: 'international', buyingOption: 'fixed' });
    const fixedUrl = buildSearchUrl(searchParamsForTerm(fixed));
    assert.match(fixedUrl, /FIXED_PRICE/);
    assert.doesNotMatch(fixedUrl, /sort=endingSoonest/);
  });
});
