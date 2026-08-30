import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb } from '../../src/core/db/client.ts';
import { selectEbayMatchedTargets } from '../../src/curated/psaTargets.ts';
import { snapshotPsaTargets } from '../../src/pipeline/psaManifest.ts';
import { createPipelineRun } from '../../src/pipeline/store.ts';

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
  /** ISO end date for the listing's latest price observation, if any. */
  itemEndDate?: string;
}

let listingSeq = 0;
function seedListing(db: Db, variantId: number | null, options: ListingOptions = {}): number {
  listingSeq++;
  const itemId = `v1|${listingSeq}|0`;
  const record = db.prepare(
    `INSERT INTO source_records (source, namespace, source_key, entity_type, language, first_seen_at, last_seen_at)
     VALUES ('ebay', 'item', ?, 'item', 'en', ?, ?) RETURNING source_record_id`,
  ).get(itemId, NOW, NOW) as { source_record_id: number };
  const listing = db.prepare(
    `INSERT INTO ebay_listings (source_record_id, marketplace, item_id, title, variant_id, match_status, match_tier,
       flagged, is_lot, grade_value, first_seen_at, last_seen_at)
     VALUES (?, 'EBAY_US', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING ebay_listing_id`,
  ).get(
    record.source_record_id, itemId, `Listing ${itemId}`, variantId, options.status ?? 'matched', options.tier ?? 'strong',
    options.flagged ?? 0, options.isLot ?? 0, options.grade === undefined ? 10 : options.grade, NOW, NOW,
  ) as { ebay_listing_id: number };
  if (options.itemEndDate) {
    db.prepare(
      `INSERT INTO ebay_listing_price_observations (ebay_listing_id, observed_at, item_end_date, buying_options_json, snapshot_fingerprint)
       VALUES (?, ?, ?, '[]', ?)`,
    ).run(listing.ebay_listing_id, NOW, options.itemEndDate, `fp-${listing.ebay_listing_id}`);
  }
  return listing.ebay_listing_id;
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

    assert.equal(selectEbayMatchedTargets(db).selections.length, 2);
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

test('specs behind a still-live auction are fetched before specs whose auctions already ended', async () => {
  await withDb((db) => {
    const ended = seedVariant(db, 'base1', '1999-01-09', '4');
    seedSpec(db, ended, '600001');
    seedListing(db, ended, { itemEndDate: '2026-01-01T00:00:00.000Z' }); // long past

    const soon = seedVariant(db, 'base1', '1999-01-09', '58');
    seedSpec(db, soon, '600003');
    seedListing(db, soon, { itemEndDate: '2026-09-05T00:00:00.000Z' }); // ends soon

    const later = seedVariant(db, 'base1', '1999-01-09', '77');
    seedSpec(db, later, '600004');
    seedListing(db, later, { itemEndDate: '2026-12-31T00:00:00.000Z' }); // ends later

    const noEndDate = seedVariant(db, 'base1', '1999-01-09', '15');
    seedSpec(db, noEndDate, '600002');
    seedListing(db, noEndDate); // no price observation at all

    const targets = selectEbayMatchedTargets(db);
    // Live auctions first, soonest-ending first; specs with no future auction
    // (ended or unknown) fall to the back, in their prior release-order.
    assert.deepEqual(targets.selections.map((s) => s.psaSpecId), [600003, 600004, 600002, 600001]);
  });
});

test('a pipeline PSA manifest is immutable across later catalogue changes', async () => {
  await withDb((db) => {
    const first=seedVariant(db,'base1','1999-01-09','4');seedSpec(db,first,'600001');seedListing(db,first);
    const runId=createPipelineRun(db,{queries:['pikachu psa 10'],marketplaces:['de'],maxItems:0,pageLimit:200,
      concurrency:1,psaMaxAgeDays:7,salesAuditDays:30,allSales:true});
    const before=snapshotPsaTargets(db,runId);assert.equal(before.specs,1);assert.equal(before.listings,1);
    const later=seedVariant(db,'base1','1999-01-09','15');seedSpec(db,later,'600002');seedListing(db,later);
    const after=snapshotPsaTargets(db,runId);
    assert.deepEqual(after.selections.map((entry)=>entry.psaSpecId),[600001]);
    assert.equal(after.listings,1);
  });
});

test('a refreshed PSA manifest appends a revision without replacing prior targets', async () => {
  await withDb((db) => {
    const first=seedVariant(db,'base1','1999-01-09','4');seedSpec(db,first,'600001');seedListing(db,first);
    const runId=createPipelineRun(db,{queries:['pikachu psa 10'],marketplaces:['de'],maxItems:0,pageLimit:200,
      concurrency:1,psaMaxAgeDays:7,salesAuditDays:30,allSales:true});
    const before=snapshotPsaTargets(db,runId,{refresh:true,ebayComplete:false});
    assert.equal(before.latestRevision,1);assert.equal(before.specs,1);
    const later=seedVariant(db,'base1','1999-01-09','15');seedSpec(db,later,'600002');seedListing(db,later);
    const after=snapshotPsaTargets(db,runId,{refresh:true,ebayComplete:true});
    assert.equal(after.latestRevision,2);assert.equal(after.revisions,2);assert.equal(after.specs,2);
    assert.deepEqual(after.selections.map((entry)=>entry.psaSpecId).sort(),[600001,600002]);
    const revisions=(db.prepare(`SELECT manifest_revision,ebay_complete,new_target_count FROM pipeline_psa_manifest_revisions
      WHERE pipeline_run_id=? ORDER BY manifest_revision`).all(runId) as unknown as Array<Record<string,number>>)
      .map((row)=>({...row}));
    assert.deepEqual(revisions,[
      {manifest_revision:1,ebay_complete:0,new_target_count:1},
      {manifest_revision:2,ebay_complete:1,new_target_count:1},
    ]);
  });
});
