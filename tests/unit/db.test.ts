import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb } from '../../src/core/db/client.ts';

const EXPECTED_TABLES = [
  'runs',
  'work_items',
  'attempts',
  'raw_objects',
  'observations',
  'relationships',
  'psa_identity_map',
  'coverage',
  'parser_executions',
  'events',
  'counters',
  'source_records',
  'sets',
  'cards',
  'variants',
  'source_links',
  'match_reviews',
  'match_overrides',
  'assets',
  'psa_specs',
  'psa_spec_pairs',
  'psa_population_current',
  'psa_price_current',
  'psa_census_current',
  'psa_sales',
  'ebay_listings',
  'ebay_listing_price_observations',
  'psa_set_map',
  'ebay_set_aliases',
  'exchange_rates',
  'pipeline_runs',
  'pipeline_stages',
  'ebay_campaigns',
  'ebay_campaign_items',
  'match_decision_revisions',
  'match_override_revisions',
  'pipeline_gaps',
  'publication_generations',
  'publication_state',
  'pipeline_pauses',
  'pipeline_psa_targets',
  'pipeline_psa_target_listings',
  'pipeline_psa_coverage',
  'pipeline_psa_manifest_revisions',
];

test('openDb creates every table and is idempotent across repeated opens', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'scraperbase-db-'));
  const dbPath = path.join(root, 'db.sqlite');
  try {
    const db1 = openDb(dbPath);
    const tables = db1
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name).sort();
    assert.deepEqual(names, [...EXPECTED_TABLES].sort());
    db1.close();

    // Re-opening (simulating a second process/run) must not error or reset data.
    const db2 = openDb(dbPath);
    try {
      const version = db2.prepare('PRAGMA user_version').get() as { user_version: number };
      assert.equal(version.user_version, 12);
    } finally {
      db2.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('openDb enforces foreign keys', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'scraperbase-db-fk-'));
  const dbPath = path.join(root, 'db.sqlite');
  try {
    const db = openDb(dbPath);
    assert.throws(() => {
      db.prepare(
        `INSERT INTO attempts (work_item_id, run_id, started_at, outcome, source_identity)
         VALUES ('missing::queue::key', 'missing-run', '2026-01-01T00:00:00Z', 'success', 'test')`,
      ).run();
    }, /FOREIGN KEY constraint failed/);
    db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
