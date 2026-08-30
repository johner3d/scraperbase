import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb } from '../../src/core/db/client.ts';
import { createEbayMatcher, type EbayItemDetail } from '../../src/curated/ebay/index.ts';

/**
 * These exercise the matcher against a miniature catalogue built to contain
 * the traps the real one contains: the same printed number in several sets and
 * languages, a Japanese set whose card names share no characters with the
 * listing, a secret rare numbered above its set, and a set whose cards were
 * never ingested.
 */

const NOW = '2026-08-28T00:00:00.000Z';

interface SeedSet { sourceSetId: string; name: string; language: string; total?: number | null; official?: number | null; releaseDate?: string; series?: string }
interface SeedCard { set: string; language: string; localId: string; name: string; dexId?: number; hp?: number; illustrator?: string; rarity?: string }

function seed(db: ReturnType<typeof openDb>, sets: SeedSet[], cards: SeedCard[]): Map<string, number> {
  const setIds = new Map<string, number>();
  for (const set of sets) {
    const row = db.prepare(`INSERT INTO sets (language, source_set_id, name, series, release_date, total_cards, official_cards, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?) RETURNING set_id`)
      .get(set.language, set.sourceSetId, set.name, set.series ?? null, set.releaseDate ?? null, set.total ?? null, set.official ?? null, NOW, NOW) as { set_id: number };
    setIds.set(`${set.sourceSetId}/${set.language}`, row.set_id);
  }
  const cardIds = new Map<string, number>();
  for (const card of cards) {
    const setId = setIds.get(`${card.set}/${card.language}`)!;
    const attributes = JSON.stringify({
      ...(card.dexId == null ? {} : { dexId: [card.dexId] }),
      ...(card.hp == null ? {} : { hp: card.hp }),
      ...(card.illustrator == null ? {} : { illustrator: card.illustrator }),
    });
    const row = db.prepare(`INSERT INTO cards (set_id, local_id, name, number, rarity, attributes_json, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?) RETURNING card_id`)
      .get(setId, card.localId, card.name, card.localId, card.rarity ?? null, attributes, NOW, NOW) as { card_id: number };
    db.prepare(`INSERT INTO variants (card_id, variant_key, finish, display_label, attributes_json, created_at, updated_at)
      VALUES (?,?,?,?,'{}',?,?)`).run(row.card_id, 'holo|||standard|', 'holo', 'Holo', NOW, NOW);
    cardIds.set(`${card.set}/${card.language}/${card.localId}`, row.card_id);
  }
  return cardIds;
}

function listing(title: string, aspects: Array<[string, string]> = []): EbayItemDetail {
  return {
    itemId: 'v1|1|0',
    title,
    conditionId: '2750',
    conditionDescriptors: [
      { name: 'Bewertungsexperte', values: [{ content: 'Professional Sports Authenticator (PSA)' }] },
      { name: 'Bewertung', values: [{ content: '10' }] },
    ],
    localizedAspects: aspects.map(([name, value]) => ({ name, value })),
  };
}

async function withCatalogue(fn: (db: ReturnType<typeof openDb>, cards: Map<string, number>) => void): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'scraperbase-ebay-matcher-'));
  const db = openDb(path.join(root, 'db.sqlite'));
  try {
    const cards = seed(db, [
      { sourceSetId: 'SV8', name: '超電ブレイカー', language: 'ja', total: 138, official: 106, releaseDate: '2024-10-18' },
      { sourceSetId: 'sv08', name: 'Surging Sparks', language: 'en', total: 252, official: 191, releaseDate: '2024-11-08' },
      { sourceSetId: 'base1', name: 'Base Set', language: 'en', total: 102, official: 102, releaseDate: '1999-01-09' },
      { sourceSetId: 'base1', name: 'Basis-Set', language: 'de', total: 102, official: 102, releaseDate: '1999-01-09' },
      { sourceSetId: 'A1', name: 'Genetic Apex', language: 'en', total: 286, official: 226, releaseDate: '2024-10-30', series: 'Pokémon TCG Pocket' },
      { sourceSetId: 'CP6', name: '20th Anniversary', language: 'ja', total: 87, official: 87, releaseDate: '2016-09-16' },
    ], [
      { set: 'SV8', language: 'ja', localId: '132', name: 'ピカチュウex', dexId: 25, hp: 200, illustrator: 'PLANETA Mochizuki' },
      { set: 'SV8', language: 'ja', localId: '025', name: 'ライチュウ', dexId: 26 },
      { set: 'sv08', language: 'en', localId: '132', name: 'Latias ex', dexId: 380 },
      { set: 'base1', language: 'en', localId: '25', name: 'Pikachu', dexId: 25, hp: 40, illustrator: 'Mitsuhiro Arita', rarity: 'Common' },
      { set: 'base1', language: 'de', localId: '25', name: 'Pikachu', dexId: 25, hp: 40, illustrator: 'Mitsuhiro Arita' },
      { set: 'A1', language: 'en', localId: '25', name: 'Pikachu', dexId: 25, hp: 60 },
    ]);
    fn(db, cards);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
}

// The alias file is production data; these tests must not depend on it.
const NO_ALIASES = path.join(tmpdir(), 'scraperbase-no-such-alias-file.json');

test('a Japanese set code printed in the title resolves the set and the card', async () => {
  await withCatalogue((db, cards) => {
    const matcher = createEbayMatcher(db, NO_ALIASES);
    const result = matcher.match(listing('PSA 10 Pikachu ex 132/106 SV8 Japanese SAR Pokemon GEM MINT'));
    assert.equal(result.decision.cardId, cards.get('SV8/ja/132'));
    assert.equal(result.decision.tier, 'strong');
    assert.equal(result.sets[0]?.set.sourceSetId, 'SV8');
  });
});

test('a card numbered above its set is a secret rare, not a contradiction', async () => {
  await withCatalogue((db, cards) => {
    // 132 > the 106 official cards, and 106 is exactly what the denominator
    // says: that agreement is what identifies the set.
    const matcher = createEbayMatcher(db, NO_ALIASES);
    const result = matcher.match(listing('PSA 10 Pikachu ex 132/106 Super Electric Breaker Japanese'));
    assert.equal(result.decision.cardId, cards.get('SV8/ja/132'));
    assert.ok(result.ranked[0]!.features.some((f) => f.startsWith('total:106')));
  });
});

test('a Japanese card is matched from an English title through the Pokedex, not its name', async () => {
  await withCatalogue((db, cards) => {
    // Nothing in "Pikachu" appears in ピカチュウex; the species id is the only
    // signal that crosses the language barrier.
    const matcher = createEbayMatcher(db, NO_ALIASES);
    const result = matcher.match(listing('PSA 10 Pikachu ex SV8 Japanese Ultra Rare Pokemon Card'));
    assert.equal(result.decision.cardId, cards.get('SV8/ja/132'));
    assert.ok(result.ranked[0]!.features.some((f) => f.startsWith('species:25')));
  });
});

test('digital-only Pokemon TCG Pocket cards are never candidates for a graded listing', async () => {
  await withCatalogue((db, cards) => {
    const matcher = createEbayMatcher(db, NO_ALIASES);
    const result = matcher.match(listing('PSA 10 Pikachu 25/102 Base Set English'));
    assert.equal(result.decision.cardId, cards.get('base1/en/25'));
    assert.ok(!result.ranked.some((c) => c.set.sourceSetId === 'A1'), 'a set that only exists in an app cannot be in a slab');
  });
});

test('HP and illustrator separate two same-numbered cards that nothing else separates', async () => {
  await withCatalogue((db, cards) => {
    const matcher = createEbayMatcher(db, NO_ALIASES);
    const result = matcher.match(listing('PSA 10 Pikachu 25 Pokemon Card', [
      ['Kartennummer', '25'],
      ['HP', '40'],
      ['Zeichner', 'Mitsuhiro Arita'],
      ['Sprache', 'Englisch'],
    ]));
    assert.equal(result.decision.cardId, cards.get('base1/en/25'));
    assert.ok(result.ranked[0]!.features.some((f) => f.startsWith('hp:40')));
    assert.ok(result.ranked[0]!.features.some((f) => f.startsWith('illustrator:')));
  });
});

test('a set whose cards were never ingested is reported as a catalogue gap rather than queued', async () => {
  await withCatalogue((db) => {
    const matcher = createEbayMatcher(db, NO_ALIASES);
    const result = matcher.match(listing('PSA 10 Charizard 1st Edition Japanese 20th Anniversary 011/087 CP6'));
    assert.equal(result.decision.tier, 'catalogue-gap');
    assert.match(result.decision.reason ?? '', /CP6/);
  });
});

test('a set code that exists in no catalogue set of that language is a gap, not a cross-language guess', async () => {
  await withCatalogue((db) => {
    // "265/S-P" is a Japanese promo. Matching it to some other set that
    // happens to share letters would be a confident wrong answer.
    const matcher = createEbayMatcher(db, NO_ALIASES);
    const result = matcher.match(listing('Pokemon Japanese Pikachu VMAX PSA 10 Gem Mint 265/S-P'));
    assert.equal(result.decision.tier, 'catalogue-gap');
    assert.equal(result.decision.cardId, null);
  });
});

test('a seller-declared language that contradicts the card costs score but never removes the answer', async () => {
  await withCatalogue((db, cards) => {
    // Sellers mislabel language constantly. When it was a hard filter, one
    // wrong item-specific eliminated every candidate and the listing became
    // unmatchable; now it is one disagreeing signal among several.
    const matcher = createEbayMatcher(db, NO_ALIASES);
    const result = matcher.match(listing('PSA 10 Pikachu ex 132/106 SV8 Pokemon', [['Sprache', 'Englisch']]));
    assert.equal(result.decision.cardId, cards.get('SV8/ja/132'));
    assert.ok(result.ranked[0]!.features.some((f) => f.startsWith('lang-mismatch:')));
  });
});

test('a bare number with nothing to place it is queued rather than guessed', async () => {
  await withCatalogue((db) => {
    const matcher = createEbayMatcher(db, NO_ALIASES);
    const result = matcher.match(listing('Pokemon Karte PSA 10 Gem Mint 25'));
    assert.equal(result.decision.tier, 'review');
    assert.equal(result.decision.cardId, null);
  });
});

test('the set alias table places a set the catalogue only stores in Japanese', async () => {
  await withCatalogue((db, cards) => {
    db.prepare(`INSERT INTO ebay_set_aliases (alias_text, language, source_set_id, origin, created_at) VALUES (?,?,?,'learned',?)`)
      .run('super_electric_breaker', 'ja', 'SV8', NOW);
    const matcher = createEbayMatcher(db, NO_ALIASES);
    const result = matcher.match(listing('PSA 10 Pikachu ex Japanese 132', [['Set', 'Super Electric Breaker']]));
    assert.equal(result.decision.cardId, cards.get('SV8/ja/132'));
    assert.ok(result.sets[0]!.reasons.some((r) => r.startsWith('alias:')));
  });
});
