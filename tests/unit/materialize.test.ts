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
function seedCardVariant(db: ReturnType<typeof openDb>, args: { setName: string; cardLocalId: string; cardNumber: string; cardName: string; totalCards?: number; language?: string; dexId?: number; sourceSetId?: string }): number {
  const now = '2026-08-28T00:00:00.000Z';
  const sourceSetId = args.sourceSetId ?? `test-set-${seedCardVariantCounter++}`;
  const set = db.prepare(
    `INSERT INTO sets (language, source_set_id, name, total_cards, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING set_id`,
  ).get(args.language ?? 'en', sourceSetId, args.setName, args.totalCards ?? null, now, now) as { set_id: number };
  const attributes = JSON.stringify(args.dexId == null ? {} : { dexId: [args.dexId] });
  const card = db.prepare(
    `INSERT INTO cards (set_id, local_id, name, number, attributes_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING card_id`,
  ).get(set.set_id, args.cardLocalId, args.cardName, args.cardNumber, attributes, now, now) as { card_id: number };
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

test('matches a PSA-10 eBay listing to its variant and tracks price history idempotently', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'scraperbase-ebay-match-'));
  const db = openDb(path.join(root, 'db.sqlite'));
  const dirs: ObjectStoreDirs = { objectsDir: path.join(root, 'ebay-raw'), objectsTmpDir: path.join(root, 'ebay-raw', 'tmp') };
  try {
    // `SV-P` is the set code printed on the card and read straight out of the
    // title, so the fixture set has to carry it as its tcgdex id.
    const variantId = seedCardVariant(db, { language: 'ja', sourceSetId: 'SV-P', setName: 'SV-P Werbekarten', cardLocalId: '218', cardNumber: '218', cardName: 'Pikachu', dexId: 25 });
    const runId = createRun(db, 'ebay-fixture', {});
    await addEbayItemObservation(db, dirs, runId, 'de', '206485945782', psa10DeListing());

    const first = await materialize(db, { includeTcgdex: false, includePsa: false, ebayDirs: dirs });
    assert.equal(first.ebayListings, 1);
    assert.equal(first.matchedEbayListings, 1);
    assert.equal(first.ebayPriceObservations, 1);
    const listing = db.prepare(`SELECT card_id, variant_id, match_status, match_tier, variant_confidence, grade_value, is_lot FROM ebay_listings`).get() as
      { card_id: number; variant_id: number; match_status: string; match_tier: string; variant_confidence: string; grade_value: number; is_lot: number };
    assert.equal(listing.variant_id, variantId);
    assert.equal(listing.match_status, 'matched');
    assert.equal(listing.match_tier, 'strong');
    // The card has exactly one variant, so the variant follows from the card
    // by elimination rather than from any finish wording in the listing.
    assert.equal(listing.variant_confidence, 'proven');
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

    const comparison = db.prepare(`SELECT ebay_psa10_listing_count, ebay_psa10_min_price FROM v_ebay_psa10_price_comparison WHERE variant_id = ?`)
      .get(variantId) as { ebay_psa10_listing_count: number; ebay_psa10_min_price: number };
    assert.equal(comparison.ebay_psa10_listing_count, 1);
    assert.equal(comparison.ebay_psa10_min_price, 199);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('incremental materialize touches only the named eBay listing and leaves others alone', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'scraperbase-ebay-incremental-'));
  const db = openDb(path.join(root, 'db.sqlite'));
  const dirs: ObjectStoreDirs = { objectsDir: path.join(root, 'ebay-raw'), objectsTmpDir: path.join(root, 'ebay-raw', 'tmp') };
  try {
    const variantId = seedCardVariant(db, { language: 'ja', sourceSetId: 'SV-P', setName: 'SV-P Werbekarten', cardLocalId: '218', cardNumber: '218', cardName: 'Pikachu', dexId: 25 });
    const runId = createRun(db, 'ebay-incremental-fixture', {});
    await addEbayItemObservation(db, dirs, runId, 'de', '206485945782', psa10DeListing());
    await addEbayItemObservation(db, dirs, runId, 'de', '999999999999', psa10DeListing({ itemId: 'v1|999999999999|0', legacyItemId: '999999999999', itemWebUrl: 'https://www.ebay.de/itm/999999999999' }));

    // Full pass materializes both.
    const full = await materialize(db, { includeTcgdex: false, includePsa: false, ebayDirs: dirs });
    assert.equal(full.ebayListings, 2);
    const before = db.prepare(`SELECT item_id, last_seen_at FROM ebay_listings ORDER BY item_id`).all() as Array<{ item_id: string; last_seen_at: string }>;

    // A new observation for just one item; incremental pass re-materializes only it.
    await addEbayItemObservation(db, dirs, runId, 'de', '206485945782', psa10DeListing({ price: { value: '150.00', currency: 'EUR' } }), '2026-09-01T00:00:00.000Z');
    const inc = await materialize(db, {
      includeTcgdex: false, includePsa: false, ebayDirs: dirs,
      incremental: true, changedEbayScopeKeys: new Set(['item:de:206485945782']),
      now: '2026-09-01T12:00:00.000Z',
    });
    assert.equal(inc.ebayListings, 1, 'only the one changed listing is processed');

    const after = db.prepare(`SELECT item_id, last_seen_at FROM ebay_listings ORDER BY item_id`).all() as Array<{ item_id: string; last_seen_at: string }>;
    assert.equal(after.find((r) => r.item_id === '999999999999')!.last_seen_at, before.find((r) => r.item_id === '999999999999')!.last_seen_at, 'untouched listing unchanged');
    assert.notEqual(after.find((r) => r.item_id === '206485945782')!.last_seen_at, before.find((r) => r.item_id === '206485945782')!.last_seen_at, 'changed listing re-materialized');
    assert.equal((db.prepare(`SELECT COUNT(*) n FROM ebay_listing_price_observations`).get() as { n: number }).n, 3);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('skips non-PSA-10 graded eBay listings and records multi-card lots without queueing them', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'scraperbase-ebay-skip-'));
  const db = openDb(path.join(root, 'db.sqlite'));
  const dirs: ObjectStoreDirs = { objectsDir: path.join(root, 'ebay-raw'), objectsTmpDir: path.join(root, 'ebay-raw', 'tmp') };
  try {
    seedCardVariant(db, { language: 'ja', sourceSetId: 'SV-P', setName: 'SV-P Werbekarten', cardLocalId: '218', cardNumber: '218', cardName: 'Pikachu', dexId: 25 });
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
    const lot = db.prepare(`SELECT match_status, match_tier, is_lot FROM ebay_listings`).get() as { match_status: string; match_tier: string; is_lot: number };
    assert.equal(lot.is_lot, 1);
    assert.equal(lot.match_tier, 'lot');
    assert.equal(lot.match_status, 'unmatched');
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM match_reviews WHERE status = 'open'`).get() as { n: number }).n, 0,
      'a lot has no single right answer, so it is recorded rather than queued for a human');
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a listing for another trading card game is recorded out of scope, not queued for review', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'scraperbase-ebay-scope-'));
  const db = openDb(path.join(root, 'db.sqlite'));
  const dirs: ObjectStoreDirs = { objectsDir: path.join(root, 'ebay-raw'), objectsTmpDir: path.join(root, 'ebay-raw', 'tmp') };
  try {
    const runId = createRun(db, 'ebay-scope-fixture', {});
    await addEbayItemObservation(db, dirs, runId, 'de', '3001', psa10DeListing({
      title: 'PSA 10 FEST Promo - Android 17 & 18 Cell EX20-04 Promo DBS Super Heroes',
      localizedAspects: [{ name: 'Spiel', value: 'Dragon Ball Super CG' }],
    }));

    const result = await materialize(db, { includeTcgdex: false, includePsa: false, ebayDirs: dirs });
    assert.equal(result.ebayListings, 1);
    const row = db.prepare(`SELECT match_tier, card_id FROM ebay_listings`).get() as { match_tier: string; card_id: number | null };
    assert.equal(row.match_tier, 'out-of-scope');
    assert.equal(row.card_id, null);
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM match_reviews WHERE status = 'open'`).get() as { n: number }).n, 0);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a confidently identified set with no cards ingested is reported as a catalogue gap, not review work', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'scraperbase-ebay-gap-'));
  const db = openDb(path.join(root, 'db.sqlite'));
  const dirs: ObjectStoreDirs = { objectsDir: path.join(root, 'ebay-raw'), objectsTmpDir: path.join(root, 'ebay-raw', 'tmp') };
  try {
    // The set row exists (tcgdex set index was fetched) but its cards were
    // never hydrated -- 81 of 555 catalogue sets are in exactly this state.
    const now = '2026-08-28T00:00:00.000Z';
    db.prepare(`INSERT INTO sets (language, source_set_id, name, total_cards, official_cards, created_at, updated_at)
      VALUES ('ja', 'CP6', 'Expansion Pack 20th Anniversary', 87, 87, ?, ?)`).run(now, now);
    const runId = createRun(db, 'ebay-gap-fixture', {});
    await addEbayItemObservation(db, dirs, runId, 'de', '4001', psa10DeListing({
      title: 'PSA 10 Charizard 1st Edition Japanese 20th Anniversary 011/087 CP6',
      localizedAspects: [{ name: 'Spiel', value: 'Pokémon TCG' }, { name: 'Sprache', value: 'Japanisch' }],
    }));

    await materialize(db, { includeTcgdex: false, includePsa: false, ebayDirs: dirs });
    const row = db.prepare(`SELECT match_tier, match_method FROM ebay_listings`).get() as { match_tier: string; match_method: string };
    assert.equal(row.match_tier, 'catalogue-gap');
    assert.equal(row.match_method, 'ebay-catalogue-gap');
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM match_reviews WHERE status = 'open'`).get() as { n: number }).n, 0);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('an unresolvable listing is queued, and resolving it manually also teaches the set alias', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'scraperbase-ebay-unmatched-'));
  const db = openDb(path.join(root, 'db.sqlite'));
  const dirs: ObjectStoreDirs = { objectsDir: path.join(root, 'ebay-raw'), objectsTmpDir: path.join(root, 'ebay-raw', 'tmp') };
  try {
    const runId = createRun(db, 'ebay-unmatched-fixture', {});
    // No set code in the title: nothing here identifies the set, which is the
    // only situation that legitimately needs a human.
    await addEbayItemObservation(db, dirs, runId, 'de', '2001', psa10DeListing({
      title: 'Pokemon Japanese Pikachu C PSA 10 Gem Mint Promotional Cards 218',
    }));

    const result = await materialize(db, { includeTcgdex: false, includePsa: false, ebayDirs: dirs });
    assert.equal(result.ebayListings, 1);
    assert.equal(result.matchedEbayListings, 0);
    assert.equal((db.prepare(`SELECT match_tier FROM ebay_listings`).get() as { match_tier: string }).match_tier, 'review');
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM match_reviews WHERE status = 'open' AND target_type = 'variant'`).get() as { n: number }).n, 1);

    const sourceRecordId = (db.prepare(`SELECT source_record_id FROM ebay_listings`).get() as { source_record_id: number }).source_record_id;
    const variantId = seedCardVariant(db, { language: 'ja', setName: 'Scarlet & Violet Promos', cardLocalId: '218', cardNumber: '218', cardName: 'Pikachu', dexId: 25 });
    setMatchOverride(db, sourceRecordId, 'variant', variantId, 'confirmed after manual review');

    const second = await materialize(db, { includeTcgdex: false, includePsa: false, ebayDirs: dirs });
    assert.equal(second.matchedEbayListings, 1);
    const row = db.prepare(`SELECT match_status, match_tier, variant_id FROM ebay_listings`).get() as { match_status: string; match_tier: string; variant_id: number };
    assert.equal(row.match_status, 'manual');
    assert.equal(row.match_tier, 'exact');
    assert.equal(row.variant_id, variantId);
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM match_reviews WHERE status = 'open'`).get() as { n: number }).n, 0);

    // The human did more than fix one row: "SV-P Werbekarten" is now known to
    // mean this set, so every sibling listing using that wording matches on
    // the next run without being queued again.
    const alias = db.prepare(`SELECT alias_text, source_set_id, origin FROM ebay_set_aliases`).get() as
      { alias_text: string; source_set_id: string; origin: string } | undefined;
    assert.ok(alias, 'the resolved set text is recorded as a learned alias');
    assert.equal(alias.alias_text, 'sv_p_werbekarten');
    assert.equal(alias.origin, 'learned');
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function addCertObservation(
  db: ReturnType<typeof openDb>,
  runId: string,
  certNumber: string,
  html: string,
  observedAt = '2026-08-31T00:00:00.000Z',
): Promise<void> {
  // Deliberately written to the DEFAULT object store, which is where the cert
  // collector puts it -- the eBay raw store is a different directory.
  const scopeKey = `cert:${certNumber}`;
  const workItemId = enqueueWorkItem(db, { source: 'psa', queue: 'psa_cert', entityType: 'cert', scopeKey, params: {} });
  const object = await writeObject(db, {
    source: 'psa', mediaKind: 'html', mediaType: 'text/html', ext: 'html', body: Buffer.from(html, 'utf8'),
  });
  const attempt = db.prepare(
    `INSERT INTO attempts (work_item_id, run_id, started_at, finished_at, outcome, http_status, request_method, request_url, byte_size, content_hash, source_identity)
     VALUES (?, ?, ?, ?, 'success', 200, 'GET', ?, ?, ?, 'psa') RETURNING attempt_id`,
  ).get(workItemId, runId, observedAt, observedAt, `https://www.psacard.com/cert/${certNumber}`, object.byteSize, object.hash) as { attempt_id: number };
  db.prepare(
    `INSERT INTO observations (attempt_id, work_item_id, hash, observed_at, entity_type, scope_key, is_first_observation_of_hash)
     VALUES (?, ?, ?, ?, 'cert', ?, 1)`,
  ).run(attempt.attempt_id, workItemId, object.hash, observedAt, scopeKey);
}

test('a stored cert page identifies the listing even though eBay payloads live in a different object store', async () => {
  // Regression: buildCertVariantMap was handed the eBay raw dirs, so every cert
  // read missed, the map came back empty and no listing was ever identified by
  // its slab. The two stores being different directories is the whole point.
  const root = await mkdtemp(path.join(tmpdir(), 'scraperbase-cert-store-'));
  const db = openDb(path.join(root, 'db.sqlite'));
  const ebayDirs: ObjectStoreDirs = { objectsDir: path.join(root, 'ebay-raw'), objectsTmpDir: path.join(root, 'ebay-raw', 'tmp') };
  try {
    const variantId = seedCardVariant(db, { language: 'ja', sourceSetId: 'SV-P', setName: 'SV-P Werbekarten', cardLocalId: '218', cardNumber: '218', cardName: 'Pikachu', dexId: 25 });
    const runId = createRun(db, 'cert-fixture', {});
    const now = '2026-08-31T00:00:00.000Z';
    // A population spec PSA already knows, pointing at the seeded variant.
    const record = db.prepare(`INSERT INTO source_records (source, namespace, source_key, entity_type, first_seen_at, last_seen_at)
      VALUES ('psa','population','4881155','population',?,?) RETURNING source_record_id`).get(now, now) as { source_record_id: number };
    db.prepare(`INSERT INTO psa_specs (namespace, spec_id, source_record_id, variant_id, release, source_card_id, finish, match_status, match_method, fetched_at)
      VALUES ('population','4881155',?,?,'SV-P','SV-P-218','holo','matched','psa-explicit-selection',?)`).run(record.source_record_id, variantId, now);

    await addEbayItemObservation(db, ebayDirs, runId, 'de', '206485945782', psa10DeListing({
      localizedAspects: [
        { name: 'Kartenname', value: 'Pikachu' },
        { name: 'Kartennummer', value: '218' },
        { name: 'Set', value: 'SV-P Werbekarten' },
        { name: 'Sprache', value: 'Japanische' },
        { name: 'Zertifizierungsnummer', value: '70352452' },
      ],
    }));
    await addCertObservation(db, runId, '70352452', '<a href="/spec/psa/4881155">Population report</a>');

    await materialize(db, { includeTcgdex: false, includePsa: false, ebayDirs, objectStoreDirs: undefined });
    const listing = db.prepare(`SELECT variant_id, match_method, match_tier, variant_confidence FROM ebay_listings`).get() as
      { variant_id: number; match_method: string; match_tier: string; variant_confidence: string };
    assert.equal(listing.match_method, 'ebay-psa-cert', 'the cert, not the title, identified the slab');
    assert.equal(listing.variant_id, variantId);
    assert.equal(listing.match_tier, 'exact');
    assert.equal(listing.variant_confidence, 'proven');
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a cert naming a SpecID no pop-report crawl has reached still becomes a fetchable spec', async () => {
  // Most modern Japanese sets have no mapped PSA heading, so the spec the cert
  // names does not exist yet. The cert plus the listing's own match is enough
  // to create it, which is what puts the auction in front of the fetch queues.
  const root = await mkdtemp(path.join(tmpdir(), 'scraperbase-cert-mint-'));
  const db = openDb(path.join(root, 'db.sqlite'));
  const ebayDirs: ObjectStoreDirs = { objectsDir: path.join(root, 'ebay-raw'), objectsTmpDir: path.join(root, 'ebay-raw', 'tmp') };
  try {
    const variantId = seedCardVariant(db, { language: 'ja', sourceSetId: 'SV-P', setName: 'SV-P Werbekarten', cardLocalId: '218', cardNumber: '218', cardName: 'Pikachu', dexId: 25 });
    const runId = createRun(db, 'cert-mint-fixture', {});
    await addEbayItemObservation(db, ebayDirs, runId, 'de', '206485945782', psa10DeListing({
      localizedAspects: [
        { name: 'Kartenname', value: 'Pikachu' },
        { name: 'Kartennummer', value: '218' },
        { name: 'Set', value: 'SV-P Werbekarten' },
        { name: 'Sprache', value: 'Japanische' },
        { name: 'Zertifizierungsnummer', value: '143313510' },
      ],
    }));
    // First pass establishes the listing -> variant link the mint reads from.
    await materialize(db, { includeTcgdex: false, includePsa: false, ebayDirs });
    await addCertObservation(db, runId, '143313510', '{"specId":"14158169"}');

    await materialize(db, { includeTcgdex: false, includePsa: false, ebayDirs });
    const spec = db.prepare(`SELECT spec_id, variant_id, match_status, match_method, release FROM psa_specs WHERE namespace='population'`).get() as
      { spec_id: string; variant_id: number; match_status: string; match_method: string; release: string };
    assert.equal(spec.spec_id, '14158169');
    assert.equal(spec.variant_id, variantId);
    assert.equal(spec.match_status, 'matched');
    assert.equal(spec.match_method, 'psa-cert-lookup', 'distinguishable from a pop-report match');
    assert.equal(spec.release, 'SV-P');

    // Minting is idempotent and never clobbers an existing spec row.
    await materialize(db, { includeTcgdex: false, includePsa: false, ebayDirs });
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM psa_specs WHERE namespace='population'`).get() as { n: number }).n, 1);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
