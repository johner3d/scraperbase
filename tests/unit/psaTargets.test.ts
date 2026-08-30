import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb } from '../../src/core/db/client.ts';
import { selectEbayMatchedTargets } from '../../src/curated/psaTargets.ts';

const NOW = '2026-08-30T00:00:00.000Z';

type Db = ReturnType<typeof openDb>;

async function withDb<T>(fn: (db: Db) => Promise<T> | T): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'scraperbase-psa-targets-'));
  const db = openDb(path.join(root, 'db.sqlite'));
  try {
    return await fn(db);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
}

/** One set, one card, one variant; returns the variant_id. */
function seedVariant(db: Db, sourceSetId: string, releaseDate: string, localId: string): number {
  const existing = db.prepare(`SELECT set_id FROM sets WHERE source_set_id=?`).get(sourceSetId) as { set_id: number } | undefined;
  const setId = existing?.set_id ?? (db.prepare(
    `INSERT INTO sets (language, source_set_id, name, release_date, created_at, updated_at)
     VALUES ('en', ?, ?, ?, ?, ?) RETURNING set_id`,
  ).get(sourceSetId, sourceSetId, releaseDate, NOW, NOW) as { set_id: number }).set_id;
  const card = db.prepare(
    `INSERT INTO cards (set_id, local_id, name, number, attributes_json, local_sort_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, '{}', ?, ?, ?) RETURNING card_id`,
  ).get(setId, localId, `Card ${localId}`, localId, localId, NOW, NOW) as { card_id: number };
  return (db.prepare(
    `INSERT INTO variants (card_id, variant_key, finish, print_run_marker, display_label, attributes_json, created_at, updated_at)
     VALUES (?, 'holo', 'holo', 'unlimited', 'Holo Unlimited', '{}', ?, ?) RETURNING variant_id`,
  ).get(card.card_id, NOW, NOW) as { variant_id: number }).variant_id;
}

function seedSpec(db: Db, variantId: number, specId: string): void {
  const record = db.prepare(
    `INSERT INTO source_records (source, namespace, source_key, entity_type, language, first_seen_at, last_seen_at)
     VALUES ('psa', 'population', ?, 'population', 'en', ?, ?) RETURNING source_record_id`,
  ).get(specId, NOW, NOW) as { source_record_id: number };
  db.prepare(
    `INSERT INTO psa_specs (namespace, spec_id, source_record_id, variant_id, match_status, fetched_at)
     VALUES ('population', ?, ?, ?, 'matched', ?)`,
  ).run(specId, record.source_record_id, variantId, NOW);
}

interface ListingOptions {
  tier?: string;
  flagged?: 0 | 1;
  isLot?: 0 | 1;
  grade?: number | null;
  status?: string;
}

let listingSeq = 0;
function seedListing(db: Db, variantId: number | null, options: ListingOptions = {}): void {
  listingSeq++;
  const itemId = `v1|${listingSeq}|0`;
  const record = db.prepare(
    `INSERT INTO source_records (source, namespace, source_key, entity_type, language, first_seen_at, last_seen_at)
     VALUES ('ebay', 'item', ?, 'item', 'en', ?, ?) RETURNING source_record_id`,
  ).get(itemId, NOW, NOW) as { source_record_id: number };
  db.prepare(
    `INSERT INTO ebay_listings (source_record_id, marketplace, item_id, title, variant_id, match_status, match_tier,
       flagged, is_lot, grade_value, first_seen_at, last_seen_at)
     VALUES (?, 'EBAY_US', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.source_record_id, itemId, `Listing ${itemId}`, variantId, options.status ?? 'matched', options.tier ?? 'strong',
    options.flagged ?? 0, options.isLot ?? 0, options.grade === undefined ? 10 : options.grade, NOW, NOW,
  );
}

test('two matched listings on the same variant collapse to one fetch target', async () => {
  await withDb((db) => {
    const variantId = seedVariant(db, 'base1', '1999-01-09', '4');
    seedSpec(db, variantId, '600001');
    seedListing(db, variantId);
    seedListing(db, variantId);

    const targets = selectEbayMatchedTargets(db);
    assert.equal(targets.selections.length, 1);
    assert.equal(targets.selections[0]!.psaSpecId, 600001);
    // CardFacts for population (the only page with the price/census tables),
    // /spec/psa/ for the sales session the tRPC API requires.
    assert.equal(targets.selections[0]!.popSourceUrl, 'https://www.psacard.com/cardfacts/pokemon/base-set/card/600001');
    assert.equal(targets.selections[0]!.salesSourceUrl, 'https://www.psacard.com/spec/psa/600001');
    assert.equal(targets.variantCount, 1);
    assert.equal(targets.listingCount, 2);
    assert.equal(targets.unresolvedVariants, 0);
  });
});

test('a matched variant with no PSA spec is reported, never fetched', async () => {
  await withDb((db) => {
    const withSpec = seedVariant(db, 'base1', '1999-01-09', '4');
    seedSpec(db, withSpec, '600001');
    seedListing(db, withSpec);

    const noSpec = seedVariant(db, 'S12a', '2022-12-02', '200');
    seedListing(db, noSpec);
    seedListing(db, noSpec);

    const targets = selectEbayMatchedTargets(db);
    assert.deepEqual(targets.selections.map((s) => s.psaSpecId), [600001]);
    assert.equal(targets.unresolvedVariants, 1);
    assert.deepEqual(targets.unresolved, [{ sourceSetId: 'S12a', releaseDate: '2022-12-02', variants: 1 }]);
  });
});

test('unmatched listings and listings with no variant are never targets', async () => {
  await withDb((db) => {
    const variantId = seedVariant(db, 'base1', '1999-01-09', '4');
    seedSpec(db, variantId, '600001');
    seedListing(db, variantId, { status: 'unmatched' });
    seedListing(db, null, { tier: 'catalogue-gap' });

    const targets = selectEbayMatchedTargets(db);
    assert.equal(targets.selections.length, 0);
    assert.equal(targets.unresolvedVariants, 0);
  });
});

test('tier, flagged and live-auction filters narrow the target list', async () => {
  await withDb((db) => {
    const strong = seedVariant(db, 'base1', '1999-01-09', '4');
    seedSpec(db, strong, '600001');
    seedListing(db, strong, { tier: 'strong' });

    const flagged = seedVariant(db, 'base1', '1999-01-09', '15');
    seedSpec(db, flagged, '600002');
    seedListing(db, flagged, { tier: 'flagged', flagged: 1 });

    const raw = seedVariant(db, 'base1', '1999-01-09', '58');
    seedSpec(db, raw, '600003');
    seedListing(db, raw, { tier: 'strong', grade: null });

    assert.equal(selectEbayMatchedTargets(db).selections.length, 3);
    assert.deepEqual(
      selectEbayMatchedTargets(db, { tiers: ['strong'] }).selections.map((s) => s.psaSpecId),
      [600001, 600003],
    );
    assert.deepEqual(
      selectEbayMatchedTargets(db, { excludeFlagged: true }).selections.map((s) => s.psaSpecId),
      [600001, 600003],
    );
    // live auctions = trusted tier + unflagged + single card + PSA 10
    assert.deepEqual(
      selectEbayMatchedTargets(db, { liveAuctionsOnly: true }).selections.map((s) => s.psaSpecId),
      [600001],
    );
  });
});

test('limit truncates the deduplicated list and totalSpecs keeps the full count', async () => {
  await withDb((db) => {
    for (const [index, localId] of ['4', '15', '58'].entries()) {
      const variantId = seedVariant(db, 'base1', '1999-01-09', localId);
      seedSpec(db, variantId, `60000${index + 1}`);
      seedListing(db, variantId);
    }

    const targets = selectEbayMatchedTargets(db, { limit: 2 });
    assert.equal(targets.selections.length, 2);
    assert.equal(targets.totalSpecs, 3);
    assert.equal(targets.variantCount, 2);
    assert.equal(targets.listingCount, 2);
  });
});
