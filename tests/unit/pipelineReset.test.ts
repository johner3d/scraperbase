import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb } from '../../src/core/db/client.ts';
import { resetPipelineToLiveAuctions } from '../../src/pipeline/reset.ts';
import { ensureSupervisorPipelineRun } from '../../src/pipeline/supervisorState.ts';
import { addSearchTerm } from '../../src/pipeline/searchTerms.ts';

const NOW = '2026-08-30T00:00:00.000Z';
type Db = ReturnType<typeof openDb>;

async function withDb<T>(fn: (db: Db) => Promise<T> | T): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'scraperbase-pipeline-reset-'));
  const db = openDb(path.join(root, 'db.sqlite'));
  try { return await fn(db); } finally { db.close(); await rm(root, { recursive: true, force: true }); }
}

function seedVariant(db: Db): number {
  const setId = (db.prepare(
    `INSERT INTO sets (language, source_set_id, name, release_date, created_at, updated_at)
     VALUES ('en','base1','Base Set','1999-01-09',?,?) RETURNING set_id`,
  ).get(NOW, NOW) as { set_id: number }).set_id;
  const cardId = (db.prepare(
    `INSERT INTO cards (set_id, local_id, name, number, attributes_json, local_sort_key, created_at, updated_at)
     VALUES (?, '4', 'Card 4', '4', '{}', '4', ?, ?) RETURNING card_id`,
  ).get(setId, NOW, NOW) as { card_id: number }).card_id;
  return (db.prepare(
    `INSERT INTO variants (card_id, variant_key, finish, print_run_marker, display_label, attributes_json, created_at, updated_at)
     VALUES (?, 'holo', 'holo', 'unlimited', 'Holo', '{}', ?, ?) RETURNING variant_id`,
  ).get(cardId, NOW, NOW) as { variant_id: number }).variant_id;
}

function seedWorkItem(db: Db, queue: string, scopeKey: string, state: string): void {
  db.prepare(
    `INSERT INTO work_items (work_item_id, source, queue, entity_type, scope_key, params_json, state, available_at, created_at, updated_at)
     VALUES (?, 'ebay', ?, 'x', ?, '{}', ?, ?, ?, ?)`,
  ).run(`ebay::${queue}::${scopeKey}`, queue, scopeKey, state, NOW, NOW, NOW);
}

test('resetPipelineToLiveAuctions narrows to one auction term and clears pipeline state', async () => {
  await withDb((db) => {
    const runId = ensureSupervisorPipelineRun(db);

    // Two non-auction terms + one auction term already present.
    addSearchTerm(db, { query: 'charizard psa 10', marketplace: 'de', buyingOption: 'fixed' });
    addSearchTerm(db, { query: 'base set', marketplace: 'de', buyingOption: 'all' });
    addSearchTerm(db, { query: 'pikachu psa 10', marketplace: 'de', buyingOption: 'auction', minBids: 3, endingWithinHours: 12 });

    // A frozen PSA target + its manifest revision.
    const variantId = seedVariant(db);
    const targetId = (db.prepare(
      `INSERT INTO pipeline_psa_targets
         (pipeline_run_id, population_spec_id, sales_spec_id, variant_id, source_set_id, source_card_id,
          finish, print_run_marker, micro_variant, created_at, manifest_revision)
       VALUES (?, '600001', '600001', ?, 'base1', 'base1-4', 'holo', 'unlimited', NULL, ?, 1) RETURNING pipeline_psa_target_id`,
    ).get(runId, variantId, NOW) as { pipeline_psa_target_id: number }).pipeline_psa_target_id;
    db.prepare(`INSERT INTO pipeline_psa_coverage (pipeline_psa_target_id, phase, status, updated_at)
      VALUES (?, 'population', 'pending', ?)`).run(targetId, NOW);
    db.prepare(`INSERT INTO pipeline_psa_manifest_revisions
      (pipeline_run_id, manifest_revision, ebay_complete, new_target_count, listing_count, created_at)
      VALUES (?, 1, 1, 1, 0, ?)`).run(runId, NOW);

    // Outstanding work + an open dead-letter.
    seedWorkItem(db, 'ebay_search', 'a', 'pending');
    seedWorkItem(db, 'ebay_item_detail', 'b', 'retryable_failed');
    seedWorkItem(db, 'psa_enrichment_population', 'c', 'leased');
    seedWorkItem(db, 'psa_cert', 'd', 'succeeded'); // terminal -- must survive
    db.prepare(`INSERT INTO pipeline_dead_letters (stage, scope_key, reason, first_seen_at, last_seen_at)
      VALUES ('psa-fetch', 'spec=600001', 'boom', ?, ?)`).run(NOW, NOW);

    const ebayListingsBefore = (db.prepare(`SELECT COUNT(*) n FROM variants`).get() as { n: number }).n;

    const summary = resetPipelineToLiveAuctions(db, { marketplace: 'de', query: 'pikachu psa 10' });

    assert.equal(summary.termsDisabled, 2);
    assert.equal(summary.auctionTerm.created, false);
    assert.equal(summary.psaTargetsDeleted, 1);
    assert.equal(summary.deadLettersResolved, 1);
    assert.deepEqual(Object.keys(summary.workItemsCancelled).sort(),
      ['ebay_item_detail', 'ebay_search', 'psa_enrichment_population']);

    const terms = db.prepare(`SELECT buying_option, enabled, min_bids, ending_within_hours FROM ebay_search_terms
      ORDER BY buying_option`).all() as Array<{ buying_option: string; enabled: number; min_bids: number; ending_within_hours: number }>;
    const enabled = terms.filter((t) => t.enabled === 1);
    assert.equal(enabled.length, 1);
    assert.equal(enabled[0]!.buying_option, 'auction');
    assert.equal(enabled[0]!.min_bids, 1);
    assert.equal(enabled[0]!.ending_within_hours, 72);

    assert.equal((db.prepare(`SELECT COUNT(*) n FROM pipeline_psa_targets`).get() as { n: number }).n, 0);
    assert.equal((db.prepare(`SELECT COUNT(*) n FROM pipeline_psa_coverage`).get() as { n: number }).n, 0);
    assert.equal((db.prepare(`SELECT state FROM work_items WHERE queue='psa_cert'`).get() as { state: string }).state, 'succeeded');
    assert.equal((db.prepare(`SELECT COUNT(*) n FROM work_items WHERE state='cancelled'`).get() as { n: number }).n, 3);
    assert.equal((db.prepare(`SELECT COUNT(*) n FROM pipeline_dead_letters WHERE resolved_at IS NULL`).get() as { n: number }).n, 0);
    assert.equal((db.prepare(`SELECT COUNT(*) n FROM variants`).get() as { n: number }).n, ebayListingsBefore);
  });
});

test('resetPipelineToLiveAuctions --dry-run reports changes but writes nothing', async () => {
  await withDb((db) => {
    ensureSupervisorPipelineRun(db);
    addSearchTerm(db, { query: 'charizard psa 10', marketplace: 'de', buyingOption: 'fixed' });

    const summary = resetPipelineToLiveAuctions(db, { marketplace: 'de', query: 'pikachu psa 10', dryRun: true });
    assert.equal(summary.dryRun, true);
    assert.equal(summary.termsDisabled, 1);
    assert.equal(summary.auctionTerm.created, true);

    // Nothing persisted: the fixed term is still enabled, no auction term exists.
    const terms = db.prepare(`SELECT buying_option, enabled FROM ebay_search_terms`).all() as Array<{ buying_option: string; enabled: number }>;
    assert.equal(terms.length, 1);
    assert.equal(terms[0]!.buying_option, 'fixed');
    assert.equal(terms[0]!.enabled, 1);
  });
});

test('resetPipelineToLiveAuctions creates the auction term when none exists', async () => {
  await withDb((db) => {
    ensureSupervisorPipelineRun(db);
    const summary = resetPipelineToLiveAuctions(db, { marketplace: 'de', query: 'pikachu psa 10' });
    assert.equal(summary.auctionTerm.created, true);
    const term = db.prepare(`SELECT query_text, buying_option, enabled, min_bids, ending_within_hours, last_enqueued_at
      FROM ebay_search_terms`).get() as Record<string, unknown>;
    assert.equal(term.query_text, 'pikachu psa 10');
    assert.equal(term.buying_option, 'auction');
    assert.equal(term.enabled, 1);
    assert.equal(term.min_bids, 1);
    assert.equal(term.ending_within_hours, 72);
    assert.equal(term.last_enqueued_at, null);
  });
});
