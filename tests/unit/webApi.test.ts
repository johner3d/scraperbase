import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../../src/core/db/client.ts';
import { getAuction, getAuctionFacets, getCard, getMarket, getPopulation, listAuctions, listCards, listSources, listVariants } from '../../src/web/api.ts';

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'scraperbase-web-'));
  const dbPath = path.join(dir, 'db.sqlite');
  const db = openDb(dbPath);
  const now = '2026-08-28T12:00:00.000Z';
  const set = db.prepare(`INSERT INTO sets (language, source_set_id, name, release_date, created_at, updated_at) VALUES ('en', 'base1', 'Base Set', '1999-01-09', ?, ?) RETURNING set_id`).get(now, now) as { set_id: number };
  const card = db.prepare(`INSERT INTO cards (set_id, local_id, number, name, category, rarity, attributes_json, detail_status, created_at, updated_at) VALUES (?, '1', '1', 'Alakazam', 'Pokémon', 'Rare', '{}', 'hydrated', ?, ?) RETURNING card_id`).get(set.set_id, now, now) as { card_id: number };
  const variant = db.prepare(`INSERT INTO variants (card_id, variant_key, finish, print_run_marker, display_label, attributes_json, created_at, updated_at) VALUES (?, 'holo|unlimited|', 'Holo', 'Unlimited', 'Unlimited · Holo', '{}', ?, ?) RETURNING variant_id`).get(card.card_id, now, now) as { variant_id: number };
  const pop = db.prepare(`INSERT INTO psa_specs (namespace, spec_id, variant_id, release, source_card_id, finish, print_run_marker, source_url, match_status, fetched_at) VALUES ('population', 'pop-1', ?, 'base1', 'base1-1', 'Holo', 'Unlimited', 'https://psa.test/pop', 'matched', ?) RETURNING psa_spec_pk`).get(variant.variant_id, now) as { psa_spec_pk: number };
  const sales = db.prepare(`INSERT INTO psa_specs (namespace, spec_id, variant_id, release, source_card_id, finish, print_run_marker, source_url, match_status, fetched_at) VALUES ('sales', 'sales-1', ?, 'base1', 'base1-1', 'Holo', 'Unlimited', 'https://psa.test/sales', 'matched', ?) RETURNING psa_spec_pk`).get(variant.variant_id, now) as { psa_spec_pk: number };
  db.prepare(`INSERT INTO psa_population_current (population_spec_pk, grade_key, grade_value, qualified, population_count, total_population, observed_at) VALUES (?, '10', 10, 0, 7, 100, ?)`).run(pop.psa_spec_pk, now);
  db.prepare(`INSERT INTO psa_price_current (population_spec_pk, grade_key, grade_value, most_recent_price, average_price, psa_price, observed_at) VALUES (?, '10', 10, 1000, 900, 800, ?)`).run(pop.psa_spec_pk, now);
  db.prepare(`INSERT INTO psa_sales (sales_spec_pk, sale_item_id, sale_date, sale_price, grade_value, auction_house, observed_at) VALUES (?, 'sale-1', '2026-08-01', 1200, 10, 'eBay', ?)`).run(sales.psa_spec_pk, now);
  return { db, dbPath, dir, cardId: card.card_id, variantId: variant.variant_id };
}

test('web API searches, filters, and aggregates curated records', async () => {
  const f = await fixture();
  try {
    const cards = listCards(f.db, new URLSearchParams('q=Alakazam&language=en&pageSize=1'));
    assert.equal(cards.total, 1);
    assert.equal(cards.items[0]!.name, 'Alakazam');
    assert.equal(cards.items[0]!.detailStatus, 'hydrated');
    assert.equal(cards.items[0]!.variantCoverage, 'complete');
    assert.equal(cards.items[0]!.variantCount, 1);
    const variants = listVariants(f.db, new URLSearchParams('set=Base%20Set&finish=Holo&printRunMarker=Unlimited'));
    assert.equal(variants.total, 1);
    assert.equal(variants.items[0]!.psa10Population, 7);
    assert.equal(variants.items[0]!.psaMatchStatus, 'matched');
    const market = getMarket(f.db, f.variantId);
    assert.equal(market.populationAvailable, true);
    assert.equal(market.priceGuideAvailable, true);
    assert.equal(market.salesAvailable, true);
    assert.equal(market.psa10Price, 800);
    assert.equal(market.sales12Month, 1);
    assert.equal(market.monthly[0]!.count, 1);
    const population = getPopulation(f.db, f.variantId);
    assert.equal(population.totalGraded, 100);
    assert.equal(population.prices[0]!.psaPrice, 800);
  } finally { f.db.close(); await rm(f.dir, { recursive: true, force: true }); }
});

test('PSA availability is explicit for a variant with no matched PSA source', async () => {
  const f = await fixture();
  try {
    const now = '2026-08-28T12:00:00.000Z';
    const variant = f.db.prepare(`INSERT INTO variants (card_id,variant_key,display_label,attributes_json,created_at,updated_at)
      VALUES (?, 'normal||||standard|', 'Normal', '{}', ?, ?) RETURNING variant_id`).get(f.cardId,now,now) as {variant_id:number};
    const market=getMarket(f.db,variant.variant_id),population=getPopulation(f.db,variant.variant_id);
    assert.equal(market.populationAvailable,false);
    assert.equal(market.priceGuideAvailable,false);
    assert.equal(market.salesAvailable,false);
    assert.equal(population.available,false);
  } finally { f.db.close(); await rm(f.dir,{recursive:true,force:true}); }
});

test('newer empty PSA sales snapshots do not hide an earlier populated sales spec', async () => {
  const f = await fixture();
  try {
    const newer = '2026-08-30T12:00:00.000Z';
    f.db.prepare(`INSERT INTO psa_specs
      (namespace,spec_id,variant_id,release,source_card_id,finish,print_run_marker,source_url,match_status,fetched_at,coverage_total_count,coverage_complete)
      VALUES ('sales','empty-newer',?,'base1','base1-1','Holo','Unlimited','https://psa.test/empty','matched',?,0,1)`)
      .run(f.variantId,newer);
    const market = getMarket(f.db,f.variantId);
    assert.equal(market.sales.length,1);
    assert.equal(market.sales[0]!.saleItemId,'sale-1');
    const variants=listVariants(f.db,new URLSearchParams('q=Alakazam'));
    assert.equal(variants.items[0]!.saleCount,1);
  } finally { f.db.close(); await rm(f.dir,{recursive:true,force:true}); }
});

test('index-only cards report unknown variant coverage instead of zero variants', async () => {
  const f = await fixture();
  try {
    const now = '2026-08-28T12:00:00.000Z';
    f.db.prepare(`INSERT INTO cards (set_id, local_id, number, name, attributes_json, created_at, updated_at)
      VALUES ((SELECT set_id FROM sets WHERE source_set_id='base1'), '2', '2', 'Blastoise', '{}', ?, ?)`).run(now, now);
    const cards = listCards(f.db, new URLSearchParams('q=Blastoise'));
    assert.equal(cards.total, 1);
    assert.equal(cards.items[0]!.detailStatus, 'stub');
    assert.equal(cards.items[0]!.variantCoverage, 'unknown');
    assert.equal(cards.items[0]!.variantCount, null);
  } finally { f.db.close(); await rm(f.dir, { recursive: true, force: true }); }
});

test('web API uses a read-only SQLite connection', async () => {
  const f = await fixture();
  f.db.close();
  const readonly = new DatabaseSync(f.dbPath, { readOnly: true });
  readonly.exec('PRAGMA query_only = ON');
  assert.throws(() => readonly.prepare('INSERT INTO sets (language, source_set_id, name, created_at, updated_at) VALUES (\'de\', \'x\', \'X\', \'a\', \'a\')').run(), /readonly|query only/i);
  readonly.close();
  await rm(f.dir, { recursive: true, force: true });
});

test('sources reports unresolved source records without hiding them', async () => {
  const f = await fixture();
  try {
    const now = '2026-08-28T12:00:00.000Z';
    f.db.prepare(`INSERT INTO source_records (source, namespace, source_key, entity_type, first_seen_at, last_seen_at) VALUES ('psa', 'population', 'unresolved-1', 'population', ?, ?)`).run(now, now);
    const sources = listSources(f.db);
    const psa = sources.find((source) => source.source === 'psa-population');
    assert.ok(psa);
    assert.equal(psa.unresolvedRecords, 1);
    assert.equal(psa.status, 'partial');
    const tcgdex = sources.find((source) => source.source === 'tcgdex');
    assert.ok(tcgdex?.languages?.some((item) => item.language === 'en'));
  } finally { f.db.close(); await rm(f.dir, { recursive: true, force: true }); }
});

test('card sorting is natural, monthly median is exact, and language links require the same source set', async () => {
  const f=await fixture();
  try {
    const now='2026-08-28T12:00:00.000Z';
    f.db.prepare(`INSERT INTO cards(set_id,local_id,local_sort_key,number,name,attributes_json,created_at,updated_at) VALUES
      ((SELECT set_id FROM sets WHERE source_set_id='base1'),'10','000000000010','10','Card Ten','{}',?,?),
      ((SELECT set_id FROM sets WHERE source_set_id='base1'),'2','000000000002','2','Card Two','{}',?,?)`).run(now,now,now,now);
    const sorted=listCards(f.db,new URLSearchParams('sort=number_asc&pageSize=10'));
    assert.deepEqual(sorted.items.map((card)=>card.number),['1','2','10']);
    const salesPk=(f.db.prepare(`SELECT psa_spec_pk FROM psa_specs WHERE namespace='sales'`).get() as {psa_spec_pk:number}).psa_spec_pk;
    f.db.prepare(`INSERT INTO psa_sales(sales_spec_pk,sale_item_id,sale_date,sale_price,grade_value,observed_at) VALUES(?,'sale-2','2026-08-15',1000,10,?)`).run(salesPk,now);
    assert.equal(getMarket(f.db,f.variantId).monthly[0]!.medianPrice,1100);
    const deSet=(f.db.prepare(`INSERT INTO sets(language,source_set_id,name,created_at,updated_at) VALUES('de','base1','Grundset',?,?) RETURNING set_id`).get(now,now) as {set_id:number}).set_id;
    f.db.prepare(`INSERT INTO cards(set_id,local_id,name,attributes_json,created_at,updated_at) VALUES(?,'1','Simsala','{}',?,?)`).run(deSet,now,now);
    const otherSet=(f.db.prepare(`INSERT INTO sets(language,source_set_id,name,created_at,updated_at) VALUES('en','base2','Jungle',?,?) RETURNING set_id`).get(now,now) as {set_id:number}).set_id;
    f.db.prepare(`INSERT INTO cards(set_id,local_id,name,attributes_json,created_at,updated_at) VALUES(?,'1','Clefable','{}',?,?)`).run(otherSet,now,now);
    const detail=getCard(f.db,f.cardId)!;
    assert.deepEqual(detail.alsoPrintedIn.map((card)=>card.setName),['Grundset']);
  } finally { f.db.close(); await rm(f.dir,{recursive:true,force:true}); }
});

test('live auctions enforce trusted scope and calculate dated EUR comparisons', async()=>{
  const f=await fixture();
  try{
    const observed='2026-08-30T09:00:00.000Z',now=new Date(observed);
    const source=(f.db.prepare(`INSERT INTO source_records(source,namespace,source_key,entity_type,first_seen_at,last_seen_at)
      VALUES('ebay','de','auction-1','item',?,?) RETURNING source_record_id`).get(observed,observed) as {source_record_id:number}).source_record_id;
    const listing=(f.db.prepare(`INSERT INTO ebay_listings(source_record_id,marketplace,item_id,item_web_url,title,grader,grade_value,is_lot,
      card_id,variant_id,match_status,match_tier,flagged,signals_json,first_seen_at,last_seen_at,primary_image_url,shipping_cost_value,shipping_cost_currency)
      VALUES(?,'de','auction-1','https://www.ebay.test/auction-1','PSA 10 Alakazam Base Set','PSA',10,0,?,?,'matched','strong',0,'{}',?,?,'https://images.test/auction.jpg',5,'EUR') RETURNING ebay_listing_id`)
      .get(source,f.cardId,f.variantId,observed,observed) as {ebay_listing_id:number}).ebay_listing_id;
    f.db.prepare(`INSERT INTO ebay_listing_price_observations(ebay_listing_id,observed_at,price_value,price_currency,buying_options_json,
      current_bid_price,minimum_bid_price,bid_count,item_end_date,snapshot_fingerprint) VALUES(?, ?,400,'EUR','["AUCTION"]',400,410,3,'2026-08-30T10:00:00.000Z','one')`).run(listing,observed);
    f.db.prepare(`INSERT INTO exchange_rates(source,rate_date,base_currency,quote_currency,rate,observed_at)
      VALUES('ecb','2026-08-30','EUR','USD',2,?)`).run(observed);
    const page=listAuctions(f.db,new URLSearchParams('psaPrice=available&discountMin=0'),now);
    assert.equal(page.total,1);assert.equal(page.summary.ending24Hours,1);assert.equal(page.items[0]!.comparison.psaGuideEur,400);assert.equal(page.items[0]!.comparison.discountPercent,0);
    assert.equal(page.items[0]!.minimumBid,410);assert.equal(getAuctionFacets(f.db,now).sets[0]!.id,'base1');
    const ended=getAuction(f.db,listing,new Date('2026-08-30T11:00:00.000Z'));
    assert.ok(ended);assert.equal(ended.auction.active,false);assert.equal(ended.priceHistory.length,1);
    f.db.prepare(`UPDATE ebay_listings SET flagged=1,match_tier='flagged' WHERE ebay_listing_id=?`).run(listing);
    assert.equal(listAuctions(f.db,new URLSearchParams(),now).total,0);
  }finally{f.db.close();await rm(f.dir,{recursive:true,force:true})}
});
