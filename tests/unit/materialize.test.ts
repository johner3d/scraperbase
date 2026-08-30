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

let seedCardVariantCounter = 0;
function seedCardVariant(db: ReturnType<typeof openDb>, args: { setName: string; cardLocalId: string; cardNumber: string; cardName: string; totalCards?: number }): number {
  const now = '2026-08-28T00:00:00.000Z';
  const sourceSetId = `test-set-${seedCardVariantCounter++}`;
  const set = db.prepare(
    `INSERT INTO sets (language, source_set_id, name, total_cards, created_at, updated_at) VALUES ('en', ?, ?, ?, ?, ?) RETURNING set_id`,
  ).get(sourceSetId, args.setName, args.totalCards ?? null, now, now) as { set_id: number };
  const card = db.prepare(
    `INSERT INTO cards (set_id, local_id, name, number, attributes_json, created_at, updated_at) VALUES (?, ?, ?, ?, '{}', ?, ?) RETURNING card_id`,
  ).get(set.set_id, args.cardLocalId, args.cardName, args.cardNumber, now, now) as { card_id: number };
  const key = variantKey({ finish: 'holo' });
  const variant = db.prepare(
    `INSERT INTO variants (card_id, variant_key, finish, display_label, attributes_json, created_at, updated_at) VALUES (?, ?, 'holo', 'Holo', '{}', ?, ?) RETURNING variant_id`,
  ).get(card.card_id, key, now, now) as { variant_id: number };
  return variant.variant_id;
}

async function addEbayItemObservation(
  db: ReturnType<typeof openDb>,
  dirs: ObjectStoreDirs,
  runId: string,
  marketplace: string,
  itemId: string,
  value: unknown,
  observedAt = '2026-08-29T00:00:00.000Z',
): Promise<void> {
  const scopeKey = `item:${marketplace}:${itemId}`;
  const workItemId = enqueueWorkItem(db, { source: 'ebay', queue: 'ebay_item_detail', entityType: 'item', scopeKey, params: {} });
  const object = await writeObject(db, {
    source: 'ebay',
    mediaKind: 'json',
    mediaType: 'application/json',
    ext: 'json',
    body: Buffer.from(JSON.stringify(value), 'utf8'),
  }, dirs);
  const attempt = db.prepare(
    `INSERT INTO attempts (work_item_id, run_id, started_at, finished_at, outcome, http_status, request_method, request_url, byte_size, content_hash, source_identity)
     VALUES (?, ?, ?, ?, 'success', 200, 'GET', ?, ?, ?, ?) RETURNING attempt_id`,
  ).get(workItemId, runId, observedAt, observedAt, `https://api.ebay.com/buy/browse/v1/item/${itemId}`, object.byteSize, object.hash, `ebay:${marketplace}`) as { attempt_id: number };
  db.prepare(
    `INSERT INTO observations (attempt_id, work_item_id, hash, observed_at, entity_type, scope_key, is_first_observation_of_hash)
     VALUES (?, ?, ?, ?, 'item', ?, 1)`,
  ).run(attempt.attempt_id, workItemId, object.hash, observedAt, scopeKey);
}

function psa10DeListing(overrides: Record<string, unknown> = {}): unknown {
  return {
    itemId: 'v1|206485945782|0',
    legacyItemId: '206485945782',
    itemWebUrl: 'https://www.ebay.de/itm/206485945782',
    title: 'Pokemon Japanese Pikachu C PSA 10 Gem Mint SV-P Promotional Cards SV-P 218',
    conditionId: '2750',
    conditionDescriptors: [
      { name: 'Bewertungsexperte', values: [{ content: 'Professional Sports Authenticator (PSA)' }] },
      { name: 'Bewertung', values: [{ content: '10' }] },
    ],
    localizedAspects: [
      { name: 'Kartenname', value: 'Pikachu' },
      { name: 'Kartennummer', value: '218' },
      { name: 'Set', value: 'SV-P Werbekarten' },
      { name: 'Sprache', value: 'Japanische' },
      { name: 'Zertifizierungsnummer', value: 'NA' },
    ],
    price: { value: '257.14', currency: 'EUR' },
    buyingOptions: ['FIXED_PRICE'],
    ...overrides,
  };
}

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

test('matches a PSA-10 eBay listing to its variant via structured aspects and tracks price history idempotently', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'scraperbase-ebay-match-'));
  const db = openDb(path.join(root, 'db.sqlite'));
  const dirs: ObjectStoreDirs = { objectsDir: path.join(root, 'ebay-raw'), objectsTmpDir: path.join(root, 'ebay-raw', 'tmp') };
  try {
    const variantId = seedCardVariant(db, { setName: 'SV-P Werbekarten', cardLocalId: '218', cardNumber: '218', cardName: 'Pikachu' });
    const runId = createRun(db, 'ebay-fixture', {});
    await addEbayItemObservation(db, dirs, runId, 'de', '206485945782', psa10DeListing());

    const first = await materialize(db, { includeTcgdex: false, includePsa: false, ebayDirs: dirs });
    assert.equal(first.ebayListings, 1);
    assert.equal(first.matchedEbayListings, 1);
    assert.equal(first.ebayPriceObservations, 1);
    const listing = db.prepare(`SELECT variant_id, match_status, match_method, grader, grade_value, is_lot FROM ebay_listings`).get() as
      { variant_id: number; match_status: string; match_method: string; grader: string; grade_value: number; is_lot: number };
    assert.equal(listing.variant_id, variantId);
    assert.equal(listing.match_status, 'matched');
    assert.equal(listing.match_method, 'ebay-aspect-match');
    assert.equal(listing.grade_value, 10);
    assert.equal(listing.is_lot, 0);
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM ebay_listing_price_observations`).get() as { n: number }).n, 1);
    assert.equal((db.prepare(`SELECT price_value FROM ebay_listing_price_observations`).get() as { price_value: number }).price_value, 257.14);

    // Re-running with no new raw data is idempotent: no duplicate rows.
    const second = await materialize(db, { includeTcgdex: false, includePsa: false, ebayDirs: dirs });
    assert.equal(second.ebayListings, 1);
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM ebay_listings`).get() as { n: number }).n, 1);
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM ebay_listing_price_observations`).get() as { n: number }).n, 1);

    // A daily re-scrape that observes a changed price appends new history
    // instead of overwriting it.
    await addEbayItemObservation(db, dirs, runId, 'de', '206485945782', psa10DeListing({ price: { value: '199.00', currency: 'EUR' } }), '2026-08-30T00:00:00.000Z');
    const third = await materialize(db, { includeTcgdex: false, includePsa: false, ebayDirs: dirs });
    assert.equal(third.ebayPriceObservations, 1);
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM ebay_listing_price_observations`).get() as { n: number }).n, 2);

    const comparison = db.prepare(`SELECT ebay_psa10_listing_count, ebay_psa10_min_price, ebay_psa10_max_price FROM v_ebay_psa10_price_comparison WHERE variant_id = ?`)
      .get(variantId) as { ebay_psa10_listing_count: number; ebay_psa10_min_price: number; ebay_psa10_max_price: number };
    assert.equal(comparison.ebay_psa10_listing_count, 1);
    assert.equal(comparison.ebay_psa10_min_price, 199);
    assert.equal(comparison.ebay_psa10_max_price, 199);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('skips non-PSA-10 graded eBay listings and excludes multi-card lots from variant matching', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'scraperbase-ebay-skip-'));
  const db = openDb(path.join(root, 'db.sqlite'));
  const dirs: ObjectStoreDirs = { objectsDir: path.join(root, 'ebay-raw'), objectsTmpDir: path.join(root, 'ebay-raw', 'tmp') };
  try {
    seedCardVariant(db, { setName: 'SV-P Werbekarten', cardLocalId: '218', cardNumber: '218', cardName: 'Pikachu' });
    const runId = createRun(db, 'ebay-skip-fixture', {});
    await addEbayItemObservation(db, dirs, runId, 'de', '1001', psa10DeListing({
      conditionDescriptors: [
        { name: 'Bewertungsexperte', values: [{ content: 'Professional Sports Authenticator (PSA)' }] },
        { name: 'Bewertung', values: [{ content: '9' }] },
      ],
    }));
    await addEbayItemObservation(db, dirs, runId, 'de', '1002', psa10DeListing({ title: 'Pokemon Lot of 5 PSA 10 Gem Mint Cards' }));

    const result = await materialize(db, { includeTcgdex: false, includePsa: false, ebayDirs: dirs });
    assert.equal(result.ebayListings, 1, 'only the lot listing becomes a row; the grade-9 item is skipped entirely');
    const lot = db.prepare(`SELECT match_status, match_method, is_lot FROM ebay_listings`).get() as { match_status: string; match_method: string; is_lot: number };
    assert.equal(lot.is_lot, 1);
    assert.equal(lot.match_status, 'unmatched');
    assert.equal(lot.match_method, 'ebay-lot-excluded');
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM match_reviews WHERE status = 'open'`).get() as { n: number }).n, 0, 'lot exclusion is structural, not a review-worthy ambiguity');
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a non-Latin-script card name never spuriously corroborates an unrelated English identity', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'scraperbase-ebay-script-'));
  const db = openDb(path.join(root, 'db.sqlite'));
  const dirs: ObjectStoreDirs = { objectsDir: path.join(root, 'ebay-raw'), objectsTmpDir: path.join(root, 'ebay-raw', 'tmp') };
  try {
    // normalizePart() strips non-Latin scripts to an empty string; without a
    // guard, "".includes()-style checks make an empty string spuriously
    // match everything, which would wrongly corroborate this unrelated card.
    seedCardVariant(db, { setName: 'Unrelated Japanese Set', cardLocalId: '218', cardNumber: '218', cardName: 'カポエラー' });
    const runId = createRun(db, 'ebay-script-fixture', {});
    await addEbayItemObservation(db, dirs, runId, 'de', '4001', psa10DeListing());

    const result = await materialize(db, { includeTcgdex: false, includePsa: false, ebayDirs: dirs });
    assert.equal(result.matchedEbayListings, 0);
    assert.equal((db.prepare(`SELECT match_status FROM ebay_listings`).get() as { match_status: string }).match_status, 'ambiguous');
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a stray single-letter fragment left by normalizing a mixed-script name never corroborates a match', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'scraperbase-ebay-fragment-'));
  const db = openDb(path.join(root, 'db.sqlite'));
  const dirs: ObjectStoreDirs = { objectsDir: path.join(root, 'ebay-raw'), objectsTmpDir: path.join(root, 'ebay-raw', 'tmp') };
  try {
    // normalizePart('ポリゴンZ') collapses the katakana run to nothing and
    // keeps only the trailing ASCII 'Z' -> the single-character token "z".
    // The identity name below ("...Filzhut", German for "...Felt Hat")
    // contains a literal "z" -- naive substring matching would treat that as
    // corroboration. It must not: "z" is below the minimum token length.
    seedCardVariant(db, { setName: 'Unrelated Japanese Set', cardLocalId: '218', cardNumber: '218', cardName: 'ポリゴンZ' });
    const correctVariantId = seedCardVariant(db, { setName: 'SVP Black Star Promos', cardLocalId: '218', cardNumber: '218', cardName: 'Pikachu with Grey Felt Hat' });
    const runId = createRun(db, 'ebay-fragment-fixture', {});
    await addEbayItemObservation(db, dirs, runId, 'de', '5001', psa10DeListing({
      localizedAspects: [
        { name: 'Kartenname', value: 'Pikachu mit grauem Filzhut' },
        { name: 'Kartennummer', value: '218' },
      ],
    }));

    const result = await materialize(db, { includeTcgdex: false, includePsa: false, ebayDirs: dirs });
    assert.equal(result.matchedEbayListings, 1, 'the shared "pikachu" token across languages should corroborate the correct card');
    const listing = db.prepare(`SELECT match_status, variant_id FROM ebay_listings`).get() as { match_status: string; variant_id: number };
    assert.equal(listing.match_status, 'matched');
    assert.equal(listing.variant_id, correctVariantId);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('reduces a "numerator/set-total" aspect value to just the numerator our catalogue stores', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'scraperbase-ebay-fraction-'));
  const db = openDb(path.join(root, 'db.sqlite'));
  const dirs: ObjectStoreDirs = { objectsDir: path.join(root, 'ebay-raw'), objectsTmpDir: path.join(root, 'ebay-raw', 'tmp') };
  try {
    const variantId = seedCardVariant(db, { setName: '20th Anniversary', cardLocalId: '011', cardNumber: '011', cardName: 'Charizard' });
    const runId = createRun(db, 'ebay-fraction-fixture', {});
    await addEbayItemObservation(db, dirs, runId, 'de', '7001', psa10DeListing({
      title: 'PSA 10 Charizard 1st Edition Japanese 20th Anniversary 011/087 CP6',
      localizedAspects: [
        { name: 'Kartenname', value: 'Charizard' },
        { name: 'Kartennummer', value: '011/087' },
      ],
    }));

    const result = await materialize(db, { includeTcgdex: false, includePsa: false, ebayDirs: dirs });
    assert.equal(result.matchedEbayListings, 1);
    const listing = db.prepare(`SELECT variant_id, extracted_card_number FROM ebay_listings`).get() as { variant_id: number; extracted_card_number: string };
    assert.equal(listing.variant_id, variantId);
    assert.equal(listing.extracted_card_number, '011');
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('extracts a card number from a promo-style title fraction and a bare hash number', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'scraperbase-ebay-promo-number-'));
  const db = openDb(path.join(root, 'db.sqlite'));
  const dirs: ObjectStoreDirs = { objectsDir: path.join(root, 'ebay-raw'), objectsTmpDir: path.join(root, 'ebay-raw', 'tmp') };
  try {
    const svp = seedCardVariant(db, { setName: 'Scarlet & Violet Promos', cardLocalId: '001', cardNumber: '001', cardName: 'Pikachu' });
    const dreamLeague = seedCardVariant(db, { setName: 'Dream League', cardLocalId: '054', cardNumber: '054', cardName: 'Pikachu' });
    const runId = createRun(db, 'ebay-promo-number-fixture', {});
    // Card name comes from the aspect (as it did in the real listings this
    // reproduces), but the "Kartennummer" aspect is missing/NA -- the number
    // has to come from the title-fallback path.
    await addEbayItemObservation(db, dirs, runId, 'de', '7101', psa10DeListing({
      title: 'PSA 10 Pikachu Japanese Promo Scarlet Violet Pre Order 001/SV-P Pokemon',
      localizedAspects: [{ name: 'Kartenname', value: 'Pikachu' }],
    }));
    await addEbayItemObservation(db, dirs, runId, 'de', '7102', psa10DeListing({
      title: '2019 Pokemon Pikachu Dream League Japanese Sun & Moon #054 PSA 10 GEM MINT',
      localizedAspects: [{ name: 'Kartenname', value: 'Pikachu' }],
    }));

    const result = await materialize(db, { includeTcgdex: false, includePsa: false, ebayDirs: dirs });
    assert.equal(result.matchedEbayListings, 2);
    const rows = db.prepare(`SELECT item_id, variant_id, extracted_card_number FROM ebay_listings ORDER BY item_id`).all() as Array<{ item_id: string; variant_id: number; extracted_card_number: string }>;
    assert.deepEqual(rows.map((r) => [r.item_id, r.variant_id, r.extracted_card_number]), [
      ['7101', svp, '001'],
      ['7102', dreamLeague, '054'],
    ]);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('does not mistake a grade-vs-grader fraction ("PSA 10 / OVP") in the title for a card number', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'scraperbase-ebay-grade-fraction-'));
  const db = openDb(path.join(root, 'db.sqlite'));
  const dirs: ObjectStoreDirs = { objectsDir: path.join(root, 'ebay-raw'), objectsTmpDir: path.join(root, 'ebay-raw', 'tmp') };
  try {
    // Observed live: "[PSA 10 / OVP] Jap. Yokohama..." has no real card
    // number anywhere in the title -- "10 / OVP" is a grade next to a
    // condition abbreviation ("OVP" = original packaging), not a card
    // number. It must not be extracted as one and coincidentally matched to
    // an unrelated card that happens to be numbered 10.
    seedCardVariant(db, { setName: 'Unrelated Set', cardLocalId: '10', cardNumber: '10', cardName: 'Pokémon Park' });
    const runId = createRun(db, 'ebay-grade-fraction-fixture', {});
    await addEbayItemObservation(db, dirs, runId, 'de', '9001', psa10DeListing({
      title: '[PSA 10 / OVP] Jap. Yokohama Full Pokémon Center Set Holo Pikachu',
      localizedAspects: [{ name: 'Kartenname', value: 'Pokémon Center' }],
    }));

    const result = await materialize(db, { includeTcgdex: false, includePsa: false, ebayDirs: dirs });
    assert.equal(result.matchedEbayListings, 0);
    const listing = db.prepare(`SELECT match_status, extracted_card_number FROM ebay_listings`).get() as { match_status: string; extracted_card_number: string | null };
    assert.equal(listing.extracted_card_number, null);
    assert.equal(listing.match_status, 'unmatched');
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('picks the real card-number fraction over an earlier grade-fraction decoy in the same title', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'scraperbase-ebay-decoy-fraction-'));
  const db = openDb(path.join(root, 'db.sqlite'));
  const dirs: ObjectStoreDirs = { objectsDir: path.join(root, 'ebay-raw'), objectsTmpDir: path.join(root, 'ebay-raw', 'tmp') };
  try {
    // "PSA 10 / AUTO 10" (a grade fraction) appears before the real card
    // number "270/Sm-p" later in the same title -- the real one must still
    // be found, not abandoned just because an earlier candidate was invalid.
    const variantId = seedCardVariant(db, { setName: 'Sun & Moon Promos', cardLocalId: '270', cardNumber: '270', cardName: "Red's Pikachu" });
    const runId = createRun(db, 'ebay-decoy-fraction-fixture', {});
    await addEbayItemObservation(db, dirs, runId, 'de', '9101', psa10DeListing({
      title: "PSA 10 / AUTO 10 Dual - Red's Pikachu # 270/Sm-p Veronica Taylor",
      localizedAspects: [{ name: 'Kartenname', value: "Red's Pikachu" }],
    }));

    const result = await materialize(db, { includeTcgdex: false, includePsa: false, ebayDirs: dirs });
    assert.equal(result.matchedEbayListings, 1);
    const listing = db.prepare(`SELECT variant_id, extracted_card_number FROM ebay_listings`).get() as { variant_id: number; extracted_card_number: string };
    assert.equal(listing.extracted_card_number, '270');
    assert.equal(listing.variant_id, variantId);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a shared "Mega" mechanic token does not corroborate two otherwise unrelated cards', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'scraperbase-ebay-mega-'));
  const db = openDb(path.join(root, 'db.sqlite'));
  const dirs: ObjectStoreDirs = { objectsDir: path.join(root, 'ebay-raw'), objectsTmpDir: path.join(root, 'ebay-raw', 'tmp') };
  try {
    // A seller-garbled "card name" aspect containing the whole promo name
    // ("Poncho Pikachu Mega Campaign") only overlaps an unrelated "Mega
    // Gardevoir ex" candidate on the generic mechanic word "Mega".
    seedCardVariant(db, { setName: 'Unrelated Set', cardLocalId: '203', cardNumber: '203', cardName: 'Mega Gardevoir ex' });
    const runId = createRun(db, 'ebay-mega-fixture', {});
    await addEbayItemObservation(db, dirs, runId, 'de', '9201', psa10DeListing({
      title: 'PSA 10 2015 POKEMON JAPANESE XY PROMO #203 PONCHO PIKACHU MEGA CAMPAIGN',
      localizedAspects: [{ name: 'Kartenname', value: 'PONCHO PIKACHU MEGA CAMPAIGN' }],
    }));

    const result = await materialize(db, { includeTcgdex: false, includePsa: false, ebayDirs: dirs });
    assert.equal(result.matchedEbayListings, 0);
    assert.equal((db.prepare(`SELECT match_status FROM ebay_listings`).get() as { match_status: string }).match_status, 'ambiguous');
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('disambiguates same-numbered, same-named cards across sets using the printed set-total denominator', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'scraperbase-ebay-total-'));
  const db = openDb(path.join(root, 'db.sqlite'));
  const dirs: ObjectStoreDirs = { objectsDir: path.join(root, 'ebay-raw'), objectsTmpDir: path.join(root, 'ebay-raw', 'tmp') };
  try {
    // "Bulbasaur" is card #1 in many different sets/reprints -- a bare
    // number+name match alone stays ambiguous across all of them. The
    // listing's own "001/025" fraction names a set with exactly 25 cards,
    // which uniquely picks out the McDonald's promo set among them.
    seedCardVariant(db, { setName: 'Base Set', cardLocalId: '1', cardNumber: '1', cardName: 'Bulbasaur', totalCards: 102 });
    seedCardVariant(db, { setName: 'Detective Pikachu', cardLocalId: '1', cardNumber: '1', cardName: 'Bulbasaur', totalCards: 18 });
    const correctVariantId = seedCardVariant(db, { setName: "McDonald's Collection 2021", cardLocalId: '001', cardNumber: '001', cardName: 'Bulbasaur', totalCards: 25 });
    const runId = createRun(db, 'ebay-total-fixture', {});
    await addEbayItemObservation(db, dirs, runId, 'de', '8001', psa10DeListing({
      title: 'Pokemon 2021 Celebrations Mcdonalds Bulbasaur Holo 001/025 PSA 10',
      localizedAspects: [{ name: 'Kartenname', value: 'Bulbasaur' }],
    }));

    const result = await materialize(db, { includeTcgdex: false, includePsa: false, ebayDirs: dirs });
    assert.equal(result.matchedEbayListings, 1);
    const listing = db.prepare(`SELECT variant_id, match_status FROM ebay_listings`).get() as { variant_id: number; match_status: string };
    assert.equal(listing.match_status, 'matched');
    assert.equal(listing.variant_id, correctVariantId);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('the printed set-total alone, with no name corroboration at all, does not auto-match', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'scraperbase-ebay-total-alone-'));
  const db = openDb(path.join(root, 'db.sqlite'));
  const dirs: ObjectStoreDirs = { objectsDir: path.join(root, 'ebay-raw'), objectsTmpDir: path.join(root, 'ebay-raw', 'tmp') };
  try {
    // A "Jynx" listing's 074/141 fraction happens to match an unrelated
    // Darkrai card's number AND its set's total card count -- neither the
    // aspect nor the title carries a name that corroborates "Darkrai", so
    // this coincidence alone must not be accepted as a match.
    seedCardVariant(db, { setName: 'Unrelated 141-card set', cardLocalId: '074', cardNumber: '074', cardName: 'Darkrai', totalCards: 141 });
    const runId = createRun(db, 'ebay-total-alone-fixture', {});
    await addEbayItemObservation(db, dirs, runId, 'de', '8101', psa10DeListing({
      title: "2001 Will's Jynx 074/141 1st Edition Vs Pokemon Japanese PSA 10",
      localizedAspects: [],
    }));

    const result = await materialize(db, { includeTcgdex: false, includePsa: false, ebayDirs: dirs });
    assert.equal(result.matchedEbayListings, 0);
    assert.equal((db.prepare(`SELECT match_status FROM ebay_listings`).get() as { match_status: string }).match_status, 'ambiguous');
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a common English word like "Ball" shared between unrelated card names does not corroborate a match', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'scraperbase-ebay-commonword-'));
  const db = openDb(path.join(root, 'db.sqlite'));
  const dirs: ObjectStoreDirs = { objectsDir: path.join(root, 'ebay-raw'), objectsTmpDir: path.join(root, 'ebay-raw', 'tmp') };
  try {
    // "Poke Ball" (the listing's card) and "Eevee on the Ball" (an unrelated
    // catalogue card sharing the same number) only overlap on the generic
    // word "ball" -- that must not count as corroboration. Total left
    // unknown (null) so this isolates the stopword check specifically, not
    // the separate total-mismatch prefilter covered by the "Lady" test below.
    seedCardVariant(db, { setName: 'Unrelated Set', cardLocalId: '002', cardNumber: '002', cardName: 'Eevee on the Ball' });
    const runId = createRun(db, 'ebay-commonword-fixture', {});
    await addEbayItemObservation(db, dirs, runId, 'de', '8201', psa10DeListing({
      title: 'PSA 10 Poke Ball #002 25th Anniversary Golden Box 2021 Pokemon Karte JP',
      localizedAspects: [{ name: 'Kartenname', value: 'Poke Ball' }],
    }));

    const result = await materialize(db, { includeTcgdex: false, includePsa: false, ebayDirs: dirs });
    assert.equal(result.matchedEbayListings, 0);
    assert.equal((db.prepare(`SELECT match_status FROM ebay_listings`).get() as { match_status: string }).match_status, 'ambiguous');
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a known set-total mismatch disqualifies a candidate outright, even when a common word overlaps', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'scraperbase-ebay-total-mismatch-'));
  const db = openDb(path.join(root, 'db.sqlite'));
  const dirs: ObjectStoreDirs = { objectsDir: path.join(root, 'ebay-raw'), objectsTmpDir: path.join(root, 'ebay-raw', 'tmp') };
  try {
    // "Parasol Lady" (089/062, a 62-card set) and an unrelated "Pokémon
    // Center Lady" in a 111-card set only share the generic word "lady".
    // The listing's own denominator (62) is known to mismatch the
    // candidate's recorded total (111), which must disqualify it outright --
    // this is a stronger, more principled guard than trying to stopword-list
    // every common noun that could ever appear in a card name.
    seedCardVariant(db, { setName: 'Unrelated Set', cardLocalId: '089', cardNumber: '089', cardName: 'Pokémon Center Lady', totalCards: 111 });
    const runId = createRun(db, 'ebay-total-mismatch-fixture', {});
    await addEbayItemObservation(db, dirs, runId, 'de', '8301', psa10DeListing({
      title: 'Pokemon Parasol Lady 089/062 SAR FA Scarlet Violet / Raging Surf SV3a JP PSA 10',
      localizedAspects: [{ name: 'Kartenname', value: 'Parasol Lady' }],
    }));

    const result = await materialize(db, { includeTcgdex: false, includePsa: false, ebayDirs: dirs });
    assert.equal(result.matchedEbayListings, 0);
    assert.equal((db.prepare(`SELECT match_status FROM ebay_listings`).get() as { match_status: string }).match_status, 'unmatched');
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a shared generic TCG term like "VMAX" does not corroborate two unrelated cards', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'scraperbase-ebay-generic-'));
  const db = openDb(path.join(root, 'db.sqlite'));
  const dirs: ObjectStoreDirs = { objectsDir: path.join(root, 'ebay-raw'), objectsTmpDir: path.join(root, 'ebay-raw', 'tmp') };
  try {
    // A seller pasted the whole listing title into the "card name" item
    // specific (a real, observed data-quality issue) -- the only catalogue
    // card sharing that number is an unrelated VMAX card, and "vmax" alone
    // must not be treated as corroboration.
    seedCardVariant(db, { setName: 'VSTAR Universe', cardLocalId: '222', cardNumber: '222', cardName: 'Deoxys VMAX' });
    const runId = createRun(db, 'ebay-generic-fixture', {});
    await addEbayItemObservation(db, dirs, runId, 'de', '6001', psa10DeListing({
      title: 'PSA 10 PIKACHU V POKEMON VMAX CLIMAX SWSH JAPANESE 2021 222/184 CRS GEM MINT BGS',
      localizedAspects: [
        { name: 'Kartenname', value: 'Fa pikachu V Pokemon Vmax Climax Swsh Japanese 2021 222 Psa 10' },
      ],
    }));

    const result = await materialize(db, { includeTcgdex: false, includePsa: false, ebayDirs: dirs });
    assert.equal(result.matchedEbayListings, 0);
    assert.equal((db.prepare(`SELECT match_status FROM ebay_listings`).get() as { match_status: string }).match_status, 'ambiguous');
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('does not auto-match on card number alone when no unrelated card shares a corroborating name', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'scraperbase-ebay-coincidence-'));
  const db = openDb(path.join(root, 'db.sqlite'));
  const dirs: ObjectStoreDirs = { objectsDir: path.join(root, 'ebay-raw'), objectsTmpDir: path.join(root, 'ebay-raw', 'tmp') };
  try {
    // The catalogue's only card numbered '218' is an unrelated card in an
    // unrelated set -- the listing's own card name ('Pikachu') doesn't match
    // it, so this must not be silently treated as a confirmed match.
    seedCardVariant(db, { setName: 'Some Unrelated Set', cardLocalId: '218', cardNumber: '218', cardName: 'Gengar' });
    const runId = createRun(db, 'ebay-coincidence-fixture', {});
    await addEbayItemObservation(db, dirs, runId, 'de', '3001', psa10DeListing());

    const result = await materialize(db, { includeTcgdex: false, includePsa: false, ebayDirs: dirs });
    assert.equal(result.matchedEbayListings, 0);
    const listing = db.prepare(`SELECT match_status, variant_id FROM ebay_listings`).get() as { match_status: string; variant_id: number | null };
    assert.equal(listing.match_status, 'ambiguous');
    assert.equal(listing.variant_id, null);
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM match_reviews WHERE status = 'open'`).get() as { n: number }).n, 1);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('queues an open review when a PSA-10 eBay listing matches no candidate variant', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'scraperbase-ebay-unmatched-'));
  const db = openDb(path.join(root, 'db.sqlite'));
  const dirs: ObjectStoreDirs = { objectsDir: path.join(root, 'ebay-raw'), objectsTmpDir: path.join(root, 'ebay-raw', 'tmp') };
  try {
    const runId = createRun(db, 'ebay-unmatched-fixture', {});
    await addEbayItemObservation(db, dirs, runId, 'de', '2001', psa10DeListing());

    const result = await materialize(db, { includeTcgdex: false, includePsa: false, ebayDirs: dirs });
    assert.equal(result.ebayListings, 1);
    assert.equal(result.matchedEbayListings, 0);
    assert.equal((db.prepare(`SELECT match_status FROM ebay_listings`).get() as { match_status: string }).match_status, 'unmatched');
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM match_reviews WHERE status = 'open' AND target_type = 'variant'`).get() as { n: number }).n, 1);

    const sourceRecordId = (db.prepare(`SELECT source_record_id FROM ebay_listings`).get() as { source_record_id: number }).source_record_id;
    const variantId = seedCardVariant(db, { setName: 'SV-P Werbekarten', cardLocalId: '218', cardNumber: '218', cardName: 'Pikachu' });
    setMatchOverride(db, sourceRecordId, 'variant', variantId, 'confirmed after manual review');
    const second = await materialize(db, { includeTcgdex: false, includePsa: false, ebayDirs: dirs });
    assert.equal(second.matchedEbayListings, 1);
    assert.equal((db.prepare(`SELECT match_status, variant_id FROM ebay_listings`).get() as { match_status: string; variant_id: number }).match_status, 'manual');
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM match_reviews WHERE status = 'open'`).get() as { n: number }).n, 0);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
