import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb } from '../../src/core/db/client.ts';
import { materialize, setMatchOverride, variantKey } from '../../src/curated/materialize.ts';
import { createRun } from '../../src/core/queue/run.ts';
import { enqueueWorkItem } from '../../src/core/queue/scheduler.ts';
import { writeObject, type ObjectStoreDirs } from '../../src/core/objectstore/store.ts';

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function seedEnglishVariant(db: ReturnType<typeof openDb>, printRunMarker = 'unlimited'): number {
  const now = '2026-08-28T00:00:00.000Z';
  const set = db.prepare(
    `INSERT INTO sets (language, source_set_id, name, created_at, updated_at) VALUES ('en', 'base1', 'Base Set', ?, ?) RETURNING set_id`,
  ).get(now, now) as { set_id: number };
  const card = db.prepare(
    `INSERT INTO cards (set_id, local_id, name, attributes_json, created_at, updated_at) VALUES (?, '1', 'Alakazam', '{}', ?, ?) RETURNING card_id`,
  ).get(set.set_id, now, now) as { card_id: number };
  const key = variantKey({ finish: 'holo', printRunMarker, microVariant: undefined });
  const variant = db.prepare(
    `INSERT INTO variants (card_id, variant_key, finish, print_run_marker, display_label, attributes_json, created_at, updated_at)
     VALUES (?, ?, 'holo', ?, ?, '{}', ?, ?) RETURNING variant_id`,
  ).get(card.card_id, key, printRunMarker, `holo / ${printRunMarker}`, now, now) as { variant_id: number };
  return variant.variant_id;
}

function populationFile(specId: number, salesSpecId: number, marker = 'unlimited'): unknown {
  return {
    release: 'base1',
    sourceCardId: 'base1-1',
    finish: 'holo',
    printRunMarker: marker,
    psaSpecId: specId,
    popSourceUrl: `https://www.psacard.com/cardfacts/pokemon/base-set/card/${specId}`,
    salesSpecId,
    fetchedAt: '2026-08-28T12:00:00.000Z',
    populationRaw: JSON.stringify({ Results: [{ Counts: [{ Grade10: 3, Grade10Q: 1, GradeTotal: 4, HalfGradeTotal: 0, QualifiedTotal: 1 }] }] }),
    priceRows: [{ gradeText: 'GEM - MT 10', mostRecentText: '$100.00', averageText: '$90.00', psaPriceText: '$80.00' }],
    censusRows: [{ position: 1, gradeLabel: 'GEM MT 10 (3)', pedigree: '' }],
    html: '<html></html>',
  };
}

function salesFile(specId: number): unknown {
  return {
    release: 'base1',
    sourceCardId: 'base1-1',
    finish: 'holo',
    printRunMarker: 'unlimited',
    psaSpecId: 605243,
    salesSpecId: specId,
    salesSourceUrl: `https://www.psacard.com/spec/psa/${specId}`,
    fetchedAt: '2026-08-28T12:01:00.000Z',
    grade: '10',
    sales: [{
      saleItemId: 'ebay-1',
      certNumber: '123',
      auctionHouse: 'eBay',
      saleDate: '2026-08-27T10:00:00.000Z',
      saleType: 'Auction',
      salePrice: 123.45,
      gradeValue: 10,
      lotNumber: '1',
      listingURL: 'https://example.test/1',
      imageURL: null,
      thumbnailURL: null,
      qualifierCode: null,
      dnaGradeValue: null,
      gradingCompany: 'PSA',
    }],
  };
}

async function addTcgdexObservation(
  db: ReturnType<typeof openDb>,
  dirs: ObjectStoreDirs,
  runId: string,
  lang: string,
  entityType: 'set' | 'card',
  scopeKey: string,
  value: unknown,
): Promise<void> {
  const workItemId = enqueueWorkItem(db, { source: 'tcgdex', queue: 'catalogue_json', entityType, scopeKey, params: {} });
  const object = await writeObject(db, {
    source: 'tcgdex',
    mediaKind: 'json',
    mediaType: 'application/json',
    ext: 'json',
    body: Buffer.from(JSON.stringify(value), 'utf8'),
  }, dirs);
  const attempt = db.prepare(
    `INSERT INTO attempts (work_item_id, run_id, started_at, finished_at, outcome, http_status, request_method, request_url, byte_size, content_hash, source_identity)
     VALUES (?, ?, ?, ?, 'success', 200, 'GET', ?, ?, ?, ?) RETURNING attempt_id`,
  ).get(workItemId, runId, '2026-08-28T00:00:00.000Z', '2026-08-28T00:00:00.000Z', `https://example.test/${lang}/${scopeKey}`, object.byteSize, object.hash, `tcgdex:${lang}`) as { attempt_id: number };
  db.prepare(
    `INSERT INTO observations (attempt_id, work_item_id, hash, observed_at, entity_type, scope_key, is_first_observation_of_hash)
     VALUES (?, ?, ?, ?, ?, ?, 1)`,
  ).run(attempt.attempt_id, workItemId, object.hash, '2026-08-28T00:00:00.000Z', entityType, scopeKey);
}

async function addTcgdexImageObservation(
  db: ReturnType<typeof openDb>,
  dirs: ObjectStoreDirs,
  runId: string,
  lang: string,
  cardSourceId: string,
  body: Buffer,
): Promise<string> {
  const scopeKey = `${lang}:image:card:${cardSourceId}:high:webp`;
  const workItemId = enqueueWorkItem(db, { source: 'tcgdex', queue: 'images', entityType: 'card_image', scopeKey, params: {} });
  const object = await writeObject(db, { source: 'tcgdex', mediaKind: 'image', mediaType: 'image/webp', ext: 'webp', body }, dirs);
  const attempt = db.prepare(
    `INSERT INTO attempts (work_item_id, run_id, started_at, finished_at, outcome, http_status, request_method, request_url, byte_size, content_hash, source_identity)
     VALUES (?, ?, ?, ?, 'success', 200, 'GET', ?, ?, ?, ?) RETURNING attempt_id`,
  ).get(workItemId, runId, '2026-08-28T00:00:00.000Z', '2026-08-28T00:00:00.000Z', `https://assets.test/${cardSourceId}/high.webp`, object.byteSize, object.hash, `tcgdex:${lang}`) as { attempt_id: number };
  db.prepare(
    `INSERT INTO observations (attempt_id, work_item_id, hash, observed_at, entity_type, scope_key, is_first_observation_of_hash)
     VALUES (?, ?, ?, ?, 'card_image', ?, 1)`,
  ).run(attempt.attempt_id, workItemId, object.hash, '2026-08-28T00:00:00.000Z', scopeKey);
  return object.hash;
}

test('materializes TCGdex sets, cards, variants, and language-specific records', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'scraperbase-tcgdex-'));
  const db = openDb(path.join(root, 'db.sqlite'));
  const dirs: ObjectStoreDirs = { objectsDir: path.join(root, 'objects'), objectsTmpDir: path.join(root, 'objects', 'tmp') };
  try {
    const runId = createRun(db, 'tcgdex-fixture', {});
    await addTcgdexObservation(db, dirs, runId, 'en', 'set', 'en:set:base1', {
      id: 'base1', name: 'Base Set', series: 'Base', cardCount: { total: 1, official: 1 }, cards: [{ id: 'base1-1', localId: '1', name: 'Alakazam' }],
    });
    await addTcgdexObservation(db, dirs, runId, 'en', 'card', 'en:card:base1-1', {
      id: 'base1-1', localId: '1', name: 'Alakazam', category: 'Pokemon', rarity: 'Rare', image: 'https://assets.test/base1-1', set: { id: 'base1' }, variants: { holo: true, normal: false },
    });
    await addTcgdexObservation(db, dirs, runId, 'de', 'set', 'de:set:base1', {
      id: 'base1', name: 'Grundset', cards: [{ id: 'base1-1', localId: '1', name: 'Simsala' }],
    });
    await addTcgdexObservation(db, dirs, runId, 'de', 'card', 'de:card:base1-1', {
      id: 'base1-1', localId: '1', name: 'Simsala', set: { id: 'base1' }, variants: { normal: true },
    });

    const result = await materialize(db, { includePsa: false, objectStoreDirs: dirs });
    assert.equal(result.sets, 2);
    assert.equal(result.cards, 2);
    assert.equal(result.variants, 2);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM sets').get() as { n: number }).n, 2);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM cards').get() as { n: number }).n, 2);
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM variants v JOIN cards c ON c.card_id = v.card_id JOIN sets s ON s.set_id = c.set_id WHERE s.language = 'en' AND v.finish = 'holo'`).get() as { n: number }).n, 1);
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM source_links WHERE match_status = 'matched'`).get() as { n: number }).n, 6);
    const imageHash = await addTcgdexImageObservation(db, dirs, runId, 'en', 'base1-1', Buffer.from('card-image'));
    const linked = await materialize(db, { includePsa: false, objectStoreDirs: dirs });
    assert.equal(linked.localAssetsLinked, 1);
    assert.equal((db.prepare(`SELECT object_hash FROM assets WHERE target_type='card' AND is_primary=1`).get() as {object_hash:string}).object_hash, imageHash);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('materializes matched PSA population and sales data idempotently', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'scraperbase-materialize-'));
  const psaDir = path.join(root, 'psa-raw');
  const db = openDb(path.join(root, 'db.sqlite'));
  try {
    const variantId = seedEnglishVariant(db);
    await writeJson(path.join(psaDir, 'base1', 'population', '605243.json'), populationFile(605243, 544022));
    await writeJson(path.join(psaDir, 'base1', 'sales', '544022.json'), salesFile(544022));

    const first = await materialize(db, { includeTcgdex: false, psaDir });
    assert.equal(first.matchedPsaSpecs, 2);
    assert.equal((db.prepare('SELECT variant_id FROM psa_specs WHERE namespace = \'population\'').get() as { variant_id: number }).variant_id, variantId);
    assert.equal((db.prepare('SELECT population_count FROM psa_population_current WHERE grade_value = 10 AND qualified = 0').get() as { population_count: number }).population_count, 3);
    assert.equal((db.prepare('SELECT total_population FROM psa_population_current LIMIT 1').get() as { total_population: number }).total_population, 5);
    assert.equal((db.prepare('SELECT psa_price FROM psa_price_current WHERE grade_value = 10').get() as { psa_price: number }).psa_price, 80);
    assert.equal((db.prepare('SELECT sale_price FROM psa_sales').get() as { sale_price: number }).sale_price, 123.45);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM psa_spec_pairs').get() as { n: number }).n, 1);

    const second = await materialize(db, { includeTcgdex: false, psaDir });
    assert.equal(second.matchedPsaSpecs, 2);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM psa_specs').get() as { n: number }).n, 2);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM psa_sales').get() as { n: number }).n, 1);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM psa_population_current').get() as { n: number }).n, 13);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('set briefs create searchable stubs and detailed TCGdex issues create four complete Base Set variants', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'scraperbase-stubs-'));
  const db = openDb(path.join(root, 'db.sqlite'));
  const dirs: ObjectStoreDirs = { objectsDir: path.join(root, 'objects'), objectsTmpDir: path.join(root, 'objects', 'tmp') };
  try {
    const runId = createRun(db, 'tcgdex-stub-fixture', {});
    await addTcgdexObservation(db, dirs, runId, 'en', 'set', 'en:set:base1', {
      id: 'base1', name: 'Base Set', serie: { id: 'base', name: 'Base' }, releaseDate: '1999-01-09',
      cards: [{ id: 'base1-1', localId: '1', name: 'Alakazam', image: 'https://assets.test/base1/1' }, { id: 'base1-2', localId: '2', name: 'Blastoise' }],
    });
    await addTcgdexObservation(db, dirs, runId, 'en', 'card', 'en:card:base1-1', {
      id: 'base1-1', localId: '1', name: 'Alakazam', set: { id: 'base1' }, variants_detailed: [
        { type: 'holo', subtype: 'unlimited', size: 'standard', variantId: 'a' },
        { type: 'holo', subtype: 'shadowless', size: 'standard', stamp: ['1st-edition'], variantId: 'b' },
        { type: 'holo', subtype: 'shadowless', size: 'standard', variantId: 'c' },
        { type: 'holo', subtype: '1999-2000-copyright', size: 'standard', variantId: 'd' },
      ],
    });
    const result = await materialize(db, { includePsa: false, objectStoreDirs: dirs });
    assert.equal(result.cards, 2);
    assert.equal(result.hydratedCards, 1);
    assert.equal((db.prepare(`SELECT detail_status FROM cards WHERE local_id='2'`).get() as {detail_status:string}).detail_status, 'stub');
    assert.equal((db.prepare(`SELECT series FROM sets`).get() as {series:string}).series, 'Base');
    const labels=(db.prepare(`SELECT display_label FROM variants ORDER BY variant_id`).all() as unknown as Array<{display_label:string}>).map((row)=>row.display_label);
    assert.deepEqual(labels, ['Unlimited · Holo','Shadowless · 1st Edition · Holo','Shadowless · Holo','Unlimited · Holo · 1999–2000 copyright']);
  } finally { db.close(); await rm(root, {recursive:true,force:true}); }
});

test('German Base Set variants use canonical labels and collapse inherited English-only Pikachu issues', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'scraperbase-german-base-'));
  const db = openDb(path.join(root, 'db.sqlite'));
  const dirs: ObjectStoreDirs = { objectsDir: path.join(root, 'objects'), objectsTmpDir: path.join(root, 'objects', 'tmp') };
  const englishVariants = [
    { type: 'normal', subtype: 'unlimited', size: 'standard', variantId: 'unlimited' },
    { type: 'normal', subtype: 'shadowless', size: 'standard', stamp: ['1st-edition'], variantId: 'shadowless-first' },
    { type: 'normal', subtype: 'shadowless', size: 'standard', variantId: 'shadowless' },
    { type: 'normal', subtype: 'shadowless-red-cheek', size: 'standard', variantId: 'red-cheek' },
    { type: 'normal', subtype: 'shadowless-red-cheek', size: 'standard', stamp: ['1st-edition'], variantId: 'red-cheek-first' },
    { type: 'normal', subtype: '1999-2000-copyright', size: 'standard', variantId: 'copyright' },
    { type: 'normal', size: 'jumbo', variantId: 'jumbo' },
    { type: 'normal', subtype: 'unlimited', size: 'standard', stamp: ['poketour-99'], variantId: 'poketour' },
  ];
  const germanVariants = [
    { type: 'Normal', subtype: 'unbegrenzt', size: 'Standard', variantId: 'unlimited' },
    { type: 'Normal', subtype: 'schattenlos', size: 'Standard', stamp: ['1. Auflage'], variantId: 'shadowless-first' },
    { type: 'Normal', subtype: 'schattenlos', size: 'Standard', variantId: 'shadowless' },
    { type: 'Normal', subtype: 'schattenlose rote Wange', size: 'Standard', variantId: 'red-cheek' },
    { type: 'Normal', subtype: 'schattenlose rote Wange', size: 'Standard', stamp: ['1. Auflage'], variantId: 'red-cheek-first' },
    { type: 'Normal', subtype: 'Copyright 1999-2000', size: 'Standard', variantId: 'copyright' },
    { type: 'Normal', size: 'Jumbo', variantId: 'jumbo' },
    { type: 'Normal', subtype: 'unbegrenzt', size: 'Standard', stamp: ['PokeTour 1999'], variantId: 'poketour' },
  ];
  try {
    const runId = createRun(db, 'tcgdex-german-base-fixture', {});
    for (const [language, setName, variants] of [['en', 'Base Set', englishVariants], ['de', 'Grundset', germanVariants]] as const) {
      await addTcgdexObservation(db, dirs, runId, language, 'set', `${language}:set:base1`, {
        id: 'base1', name: setName, releaseDate: '1999-01-09', cards: [{ id: 'base1-58', localId: '58', name: 'Pikachu' }],
      });
      await addTcgdexObservation(db, dirs, runId, language, 'card', `${language}:card:base1-58`, {
        id: 'base1-58', localId: '58', name: 'Pikachu', category: 'Pokemon', set: { id: 'base1' }, variants_detailed: variants,
      });
    }

    await materialize(db, { includePsa: false, objectStoreDirs: dirs });
    const rows = db.prepare(`SELECT v.variant_key,v.print_run_marker,v.micro_variant,v.size,v.stamps_json,v.display_label,v.attributes_json
      FROM variants v JOIN cards c ON c.card_id=v.card_id JOIN sets s ON s.set_id=c.set_id
      WHERE s.language='de' AND s.source_set_id='base1' AND c.local_id='58' ORDER BY v.print_run_marker`).all() as unknown as Array<Record<string,string|null>>;
    assert.deepEqual(rows.map(({variant_key,print_run_marker,micro_variant,size,stamps_json,display_label})=>
      ({variant_key,print_run_marker,micro_variant,size,stamps_json,display_label})),[
      {variant_key:'normal|first_edition||standard|',print_run_marker:'first_edition',micro_variant:null,size:'standard',stamps_json:'[]',display_label:'1st Edition · Normal'},
      {variant_key:'normal|unlimited||standard|',print_run_marker:'unlimited',micro_variant:null,size:'standard',stamps_json:'[]',display_label:'Unlimited · Normal'},
    ]);
    assert.ok(rows.every((row)=>!/(schatten|wange|unbegrenzt|auflage|jumbo|poketour)/i.test(row.display_label??'')));
    assert.ok(rows.some((row)=>String(row.attributes_json).includes('schattenlose rote Wange')),
      'localized source text remains available only as raw provenance');
  } finally { db.close(); await rm(root, {recursive:true,force:true}); }
});

test('keeps a PSA issue with no catalogue card unresolved and creates one open review', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'scraperbase-review-'));
  const psaDir = path.join(root, 'psa-raw');
  const db = openDb(path.join(root, 'db.sqlite'));
  try {
    const variantId = seedEnglishVariant(db, 'unlimited');
    const missing = populationFile(700001, 700002, 'shadowless_first_edition') as Record<string, unknown>;
    missing.release = 'base2';
    missing.sourceCardId = 'base2-1';
    await writeJson(path.join(psaDir, 'base2', 'population', '700001.json'), missing);
    const result = await materialize(db, { includeTcgdex: false, psaDir });
    assert.equal(result.matchedPsaSpecs, 0);
    assert.equal((db.prepare(`SELECT match_status FROM psa_specs WHERE namespace = 'population'`).get() as { match_status: string }).match_status, 'unmatched');
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM match_reviews WHERE status = 'open'`).get() as { n: number }).n, 1);
    assert.equal((db.prepare(`SELECT variant_id FROM psa_specs WHERE namespace = 'population'`).get() as { variant_id: number | null }).variant_id, null);

    const sourceRecordId = (db.prepare(`SELECT source_record_id FROM psa_specs WHERE namespace = 'population'`).get() as { source_record_id: number }).source_record_id;
    setMatchOverride(db, sourceRecordId, 'variant', variantId, 'confirmed shadowless issue');
    await materialize(db, { includeTcgdex: false, psaDir });
    assert.equal((db.prepare(`SELECT match_status FROM psa_specs WHERE namespace = 'population'`).get() as { match_status: string }).match_status, 'manual');
    assert.equal((db.prepare(`SELECT variant_id FROM psa_specs WHERE namespace = 'population'`).get() as { variant_id: number | null }).variant_id, variantId);
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM match_reviews WHERE status = 'open'`).get() as { n: number }).n, 0);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('language-specific cards and variants remain distinct', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'scraperbase-language-'));
  const db = openDb(path.join(root, 'db.sqlite'));
  try {
    const now = '2026-08-28T00:00:00.000Z';
    const insertSet = db.prepare(`INSERT INTO sets (language, source_set_id, name, created_at, updated_at) VALUES (?, 'base1', ?, ?, ?) RETURNING set_id`);
    const en = insertSet.get('en', 'Base Set', now, now) as { set_id: number };
    const de = insertSet.get('de', 'Grundset', now, now) as { set_id: number };
    const insertCard = db.prepare(`INSERT INTO cards (set_id, local_id, name, attributes_json, created_at, updated_at) VALUES (?, '1', ?, '{}', ?, ?) RETURNING card_id`);
    const enCard = insertCard.get(en.set_id, 'Alakazam', now, now) as { card_id: number };
    const deCard = insertCard.get(de.set_id, 'Simsala', now, now) as { card_id: number };
    assert.notEqual(enCard.card_id, deCard.card_id);
    db.prepare(`INSERT INTO variants (card_id, variant_key, display_label, attributes_json, created_at, updated_at) VALUES (?, 'holo|unlimited|', 'Holo / unlimited', '{}', ?, ?), (?, 'holo|first_edition|', 'Holo / first edition', '{}', ?, ?)`)
      .run(enCard.card_id, now, now, enCard.card_id, now, now);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM variants WHERE card_id = ?').get(enCard.card_id) as { n: number }).n, 2);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
