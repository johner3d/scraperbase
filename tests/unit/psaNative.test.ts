import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb } from '../../src/core/db/client.ts';
import { materialize } from '../../src/curated/materialize.ts';
import { autoMatchHeading, scoreCandidates } from '../../src/curated/psaSetMatch.ts';
import { matchPsaCardRow, type PsaSetItemRow } from '../../src/curated/psaCardMatch.ts';
import { enqueueWorkItem } from '../../src/core/queue/scheduler.ts';
import { createRun } from '../../src/core/queue/run.ts';
import { writeObject, type ObjectStoreDirs } from '../../src/core/objectstore/store.ts';

const NOW = '2026-08-29T00:00:00.000Z';

function seedBasepSet(db: ReturnType<typeof openDb>): { setId: number } {
  const set = db.prepare(
    `INSERT INTO sets (language, source_set_id, name, total_cards, created_at, updated_at) VALUES ('en', 'basep', 'Wizards Black Star Promos', 53, ?, ?) RETURNING set_id`,
  ).get(NOW, NOW) as { set_id: number };
  const surfing = db.prepare(
    `INSERT INTO cards (set_id, local_id, name, number, attributes_json, created_at, updated_at) VALUES (?, '28', 'Surfing Pikachu', '28', '{}', ?, ?) RETURNING card_id`,
  ).get(set.set_id, NOW, NOW) as { card_id: number };
  const stadium = db.prepare(
    `INSERT INTO cards (set_id, local_id, name, number, attributes_json, created_at, updated_at) VALUES (?, '41', 'Lucky Stadium', '41', '{}', ?, ?) RETURNING card_id`,
  ).get(set.set_id, NOW, NOW) as { card_id: number };
  db.prepare(
    `INSERT INTO variants (card_id, variant_key, finish, size, display_label, attributes_json, created_at, updated_at)
     VALUES (?, 'normal|||standard|', 'normal', 'standard', 'Normal', '{}', ?, ?),
            (?, 'normal|||standard|', 'normal', 'standard', 'Normal', '{}', ?, ?)`,
  ).run(surfing.card_id, NOW, NOW, stadium.card_id, NOW, NOW);
  return { setId: set.set_id };
}

async function withDb<T>(fn: (db: ReturnType<typeof openDb>, dirs: ObjectStoreDirs) => Promise<T> | T): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'scraperbase-psa-native-'));
  const db = openDb(path.join(root, 'db.sqlite'));
  const dirs: ObjectStoreDirs = { objectsDir: path.join(root, 'objects'), objectsTmpDir: path.join(root, 'objects', 'tmp') };
  try {
    return await fn(db, dirs);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
}

test('psaSetMatch: a PSA heading name auto-matches the right tcgdex set by token overlap', async () => {
  await withDb((db) => {
    seedBasepSet(db);
    const candidates = scoreCandidates(db, 'Pokemon Promo Black Star');
    assert.ok(candidates.length >= 1);
    assert.equal(candidates[0]!.sourceSetId, 'basep');

    const row = db.prepare(
      `INSERT INTO psa_set_map (psa_heading_id, psa_heading_name, language, match_status, created_at, updated_at)
       VALUES (81226, 'Pokemon Promo Black Star', 'en', 'unmatched', ?, ?) RETURNING psa_set_map_id`,
    ).get(NOW, NOW) as { psa_set_map_id: number };
    const result = autoMatchHeading(db, row.psa_set_map_id, 'Pokemon Promo Black Star', NOW);
    assert.equal(result.status, 'matched');
    assert.equal(result.sourceSetId, 'basep');
  });
});

test('psaSetMatch: a heading with no plausible tcgdex candidate is left unmatched, not guessed', async () => {
  await withDb((db) => {
    seedBasepSet(db);
    const candidates = scoreCandidates(db, 'Digimon Digi-Battle Promo');
    assert.equal(candidates.length, 0);
  });
});

test('psaSetMatch: a specific Diamond & Pearl expansion beats the generic era name', async () => {
  await withDb((db) => {
    db.prepare(
      `INSERT INTO sets (language, source_set_id, name, series, total_cards, created_at, updated_at)
       VALUES ('en', 'dp1', 'Diamond & Pearl', 'Diamond & Pearl', 130, ?, ?),
              ('en', 'dp7', 'Stormfront', 'Diamond & Pearl', 106, ?, ?)`,
    ).run(NOW, NOW, NOW, NOW);
    const candidates = scoreCandidates(db, 'Pokemon Diamond &amp; Pearl Stormfront');
    assert.equal(candidates[0]?.sourceSetId, 'dp7');
  });
});

test('psaSetMatch: accented Pokémon is treated as the same stopword as Pokemon', async () => {
  await withDb((db) => {
    db.prepare(
      `INSERT INTO sets (language, source_set_id, name, series, total_cards, created_at, updated_at)
       VALUES ('en', 'ru1', 'Pokémon Rumble', 'Platinum', 16, ?, ?)`,
    ).run(NOW, NOW);
    assert.equal(scoreCandidates(db, 'Pokemon Rumble')[0]?.sourceSetId, 'ru1');
  });
});

function pikachuRow(overrides: Partial<PsaSetItemRow> = {}): PsaSetItemRow {
  return {
    SpecID: 525134,
    SubjectName: 'Surfing Pikachu',
    Variety: 'Pokemon League',
    CardNumber: '28',
    Grade10: 1218,
    Grade9: 2767,
    GradeTotal: 6373,
    HalfGradeTotal: 67,
    QualifiedGradeTotal: 1,
    ...overrides,
  };
}

test('psaCardMatch: matches Surfing Pikachu #28 by card number within the mapped set', async () => {
  await withDb((db) => {
    seedBasepSet(db);
    const result = matchPsaCardRow(db, 'basep', 'en', pikachuRow());
    assert.equal(result.status, 'matched');
    assert.equal(result.variantParts?.finish, 'normal');
  });
});

test('psaCardMatch: skips a non-English Variety row rather than mis-linking it to the English set', async () => {
  await withDb((db) => {
    seedBasepSet(db);
    const result = matchPsaCardRow(db, 'basep', 'en', pikachuRow({ Variety: 'Pokemon League-French', SubjectName: 'Pikachu Surfeur' }));
    assert.equal(result.status, 'skipped');
  });
});

test('psaCardMatch: a card number absent from the set is unmatched, not silently dropped', async () => {
  await withDb((db) => {
    seedBasepSet(db);
    const result = matchPsaCardRow(db, 'basep', 'en', pikachuRow({ CardNumber: '999' }));
    assert.equal(result.status, 'unmatched');
  });
});

test('materializePsaNative end-to-end: a discovered GetSetItems payload resolves Surfing Pikachu #28 to a matched psa_specs row', async () => {
  await withDb(async (db, dirs) => {
    seedBasepSet(db);
    const now = new Date().toISOString();

    const runId = createRun(db, 'psa-native-fixture', {});
    const workItemId = enqueueWorkItem(db, { source: 'psa', queue: 'psa_pop_set_items', entityType: 'pop_set_items', scopeKey: 'pop_set_items:81226', params: {} });
    const object = await writeObject(db, {
      source: 'psa', mediaKind: 'json', mediaType: 'application/json', ext: 'json',
      body: Buffer.from(JSON.stringify({ recordsTotal: 2, data: [pikachuRow(), { SpecID: 866497, SubjectName: 'Lucky Stadium', Variety: null, CardNumber: '41', GradeTotal: 10, HalfGradeTotal: 0, QualifiedGradeTotal: 0 }] }), 'utf8'),
    }, dirs);
    const attempt = db.prepare(
      `INSERT INTO attempts (work_item_id, run_id, started_at, finished_at, outcome, http_status, request_method, request_url, byte_size, content_hash, source_identity)
       VALUES (?, ?, ?, ?, 'success', 200, 'POST', 'https://www.psacard.com/Pop/GetSetItems', ?, ?, 'psa:pop_set_items:81226') RETURNING attempt_id`,
    ).get(workItemId, runId, now, now, object.byteSize, object.hash) as { attempt_id: number };
    db.prepare(
      `INSERT INTO observations (attempt_id, work_item_id, hash, observed_at, entity_type, scope_key, is_first_observation_of_hash)
       VALUES (?, ?, ?, ?, 'pop_set_items', 'pop_set_items:81226', 1)`,
    ).run(attempt.attempt_id, workItemId, object.hash, now);

    db.prepare(
      `INSERT INTO psa_set_map (psa_heading_id, psa_heading_name, language, match_status, created_at, updated_at)
       VALUES (81226, 'Pokemon Promo Black Star', 'en', 'unmatched', ?, ?)`,
    ).run(now, now);

    const result = await materialize(db, { includeTcgdex: false, includeEbay: false, objectStoreDirs: dirs, now });
    assert.ok(result.matchedPsaSpecs >= 2, `expected at least 2 matched PSA specs, got ${result.matchedPsaSpecs}`);

    const row = db.prepare(
      `SELECT ps.match_status FROM psa_specs ps WHERE ps.namespace='population' AND ps.spec_id='525134'`,
    ).get() as { match_status: string } | undefined;
    assert.equal(row?.match_status, 'matched');

    const pop10 = db.prepare(
      `SELECT population_count FROM psa_population_current pc JOIN psa_specs ps ON ps.psa_spec_pk = pc.population_spec_pk
       WHERE ps.spec_id = '525134' AND pc.grade_value = 10 AND pc.qualified = 0`,
    ).get() as { population_count: number } | undefined;
    assert.equal(pop10?.population_count, 1218);
  });
});

async function seedPopSetItemsObservation(
  db: ReturnType<typeof openDb>,
  dirs: ObjectStoreDirs,
  runId: string,
  headingId: number,
  body: Buffer,
): Promise<void> {
  const now = new Date().toISOString();
  const workItemId = enqueueWorkItem(db, { source: 'psa', queue: 'psa_pop_set_items', entityType: 'pop_set_items', scopeKey: `pop_set_items:${headingId}`, params: {} });
  const object = await writeObject(db, { source: 'psa', mediaKind: 'json', mediaType: 'application/json', ext: 'json', body }, dirs);
  const attempt = db.prepare(
    `INSERT INTO attempts (work_item_id, run_id, started_at, finished_at, outcome, http_status, request_method, request_url, byte_size, content_hash, source_identity)
     VALUES (?, ?, ?, ?, 'success', 200, 'POST', 'https://www.psacard.com/Pop/GetSetItems', ?, ?, ?) RETURNING attempt_id`,
  ).get(workItemId, runId, now, now, object.byteSize, object.hash, `psa:pop_set_items:${headingId}`) as { attempt_id: number };
  db.prepare(
    `INSERT INTO observations (attempt_id, work_item_id, hash, observed_at, entity_type, scope_key, is_first_observation_of_hash)
     VALUES (?, ?, ?, ?, 'pop_set_items', ?, 1)`,
  ).run(attempt.attempt_id, workItemId, object.hash, now, `pop_set_items:${headingId}`);
}

test('materializePsaNative: one heading whose stored observation is not valid GetSetItems JSON (e.g. PSA served an HTML "not found" page with HTTP 200) is skipped, not fatal to the whole import', async () => {
  await withDb(async (db, dirs) => {
    seedBasepSet(db);
    const now = new Date().toISOString();
    const runId = createRun(db, 'psa-native-bad-json-fixture', {});

    // Heading 81226 resolves fine.
    await seedPopSetItemsObservation(db, dirs, runId, 81226, Buffer.from(
      JSON.stringify({ recordsTotal: 1, data: [pikachuRow()] }), 'utf8',
    ));
    // Heading 99999 got PSA's Next.js app-shell "not found" HTML page back
    // with an HTTP 200 -- not JSON at all, but still recorded as an
    // observation by the generic record-everything queue runner.
    await seedPopSetItemsObservation(db, dirs, runId, 99999, Buffer.from(
      '<!DOCTYPE html><html lang="en-US"><head><title>Not Found</title></head><body>Not Found</body></html>', 'utf8',
    ));

    db.prepare(
      `INSERT INTO psa_set_map (psa_heading_id, psa_heading_name, language, match_status, created_at, updated_at)
       VALUES (81226, 'Pokemon Promo Black Star', 'en', 'unmatched', ?, ?)`,
    ).run(now, now);
    // Manually mapped (bypassing name-based auto-match, which wouldn't find
    // a candidate for this made-up name) so the bad-JSON heading actually
    // reaches materializePsaNative's per-heading loop instead of being
    // filtered out earlier as unmatched.
    db.prepare(
      `INSERT INTO psa_set_map (psa_heading_id, psa_heading_name, language, match_status, source_set_id, created_at, updated_at)
       VALUES (99999, 'Some Dead Heading', 'en', 'manual', 'basep', ?, ?)`,
    ).run(now, now);

    const result = await materialize(db, { includeTcgdex: false, includeEbay: false, objectStoreDirs: dirs, now });
    assert.ok(result.matchedPsaSpecs >= 1, `expected the good heading to still materialize, got ${result.matchedPsaSpecs}`);

    const row = db.prepare(
      `SELECT ps.match_status FROM psa_specs ps WHERE ps.namespace='population' AND ps.spec_id='525134'`,
    ).get() as { match_status: string } | undefined;
    assert.equal(row?.match_status, 'matched');
  });
});
