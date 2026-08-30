import type { DatabaseSync } from 'node:sqlite';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { normalizePart } from '../materialize.ts';
import { DATA_DIR } from '../../core/config/config.ts';
import { numberForms } from './numbers.ts';

/**
 * Catalogue-side indexes, built once per materialize run and reused for every
 * listing. Matching 4,650 listings against 555 sets and 56,385 cards is
 * hopeless as 4,650 rounds of table scans; everything the set resolver and the
 * scorer need in the inner loop is held in memory here instead.
 */

export interface SetRow {
  setId: number;
  sourceSetId: string;
  /** Lowercased `source_set_id` -- for JP sets this is the code printed on the card ("CP6", "S10a", "SV8"). */
  codeKey: string;
  /** `codeKey` with punctuation removed, so "SV-P" also answers to "svp" at a lower weight. */
  looseCodeKey: string;
  name: string;
  nameKey: string;
  nameTokens: Set<string>;
  series: string | null;
  year: number | null;
  totalCards: number | null;
  officialCards: number | null;
  language: string;
  /** Pokémon TCG Pocket sets are an in-app game with no physical cards. They can never answer a graded-card listing, and in v1 they were a large source of bogus same-number candidates. */
  digital: boolean;
}

export interface CardRow {
  cardId: number;
  setId: number;
  localId: string;
  name: string;
  nameTokens: Set<string>;
  rarity: string | null;
  hp: number | null;
  illustrator: string | null;
  /** National Pokedex ids from tcgdex. Language-independent, which makes it the only way to check "is this listing about Pikachu?" against a card whose catalogue name is ピカチュウ. */
  dexIds: number[];
}

export interface AliasRow { sourceSetId: string; language: string | null; origin: string }

export interface CatalogueIndexes {
  sets: SetRow[];
  setsById: Map<number, SetRow>;
  setsByCode: Map<string, SetRow[]>;
  setsByLooseCode: Map<string, SetRow[]>;
  cardsById: Map<number, CardRow>;
  /** Uppercased printed number (every padding form) -> cards. The main blocking index. */
  cardsByNumber: Map<string, CardRow[]>;
  cardsBySet: Map<number, CardRow[]>;
  /** Set ids with no card rows at all -- 81 of 555, mostly older Japanese sets tcgdex details were never fetched for. Listings that resolve to one of these are a catalogue gap, not a matching failure, and must not be queued for manual work. */
  emptySets: Set<number>;
  /** Lowercased letter prefixes that really start a printed card number ("swsh", "tg", "gg", "dp", "rc"), taken from `cards.local_id`. Used to reject prose like "ein 2021" being read as a card number. */
  numberPrefixes: Set<string>;
  /** Name token -> national Pokedex id, restricted to tokens that identify exactly one species across the whole catalogue ("pikachu", "glurak", "bisasam"). Ambiguous tokens are dropped rather than guessed. */
  dexIdByNameToken: Map<string, number>;
  /** card_id -> PSA population at grade 10. A PSA-10 listing must be of a card PSA has actually graded a 10 of, so a non-zero entry is real evidence -- but a zero is not evidence against, because PSA spec coverage is far from complete outside English. */
  psa10PopByCard: Map<number, number>;
  /** variant_id -> PSA population at grade 10. When exactly one of a card's variants has been graded a 10, that variant is the only thing a PSA-10 listing can be. */
  psa10PopByVariant: Map<number, number>;
  /** normalizePart()-ed free-text set name -> tcgdex set ids. */
  aliases: Map<string, AliasRow[]>;
}

const DIGITAL_SERIES = /pocket/i;

// Set-name words that carry no identifying information -- every second set is
// a "Pokemon ... Collection". Same idea as psaSetMatch's STOPWORDS, extended
// for the wording eBay sellers and eBay's own auto-translation use.
const SET_STOPWORDS = new Set([
  'pokemon', 'tcg', 'card', 'cards', 'karte', 'karten', 'sammelkartenspiel',
  'the', 'of', 'and', 'und', 'set', 'sets', 'edition', 'collection', 'kollektion',
  'expansion', 'erweiterung', 'pack', 'deck', 'series', 'serie', 'game', 'spiel', 'jcc', 'gcc',
]);

// Generic TCG/marketplace jargon shared by card names and listing boilerplate
// alike. Two unrelated VMAX cards both contain "vmax", so these prove nothing
// about identity and are excluded from name overlap.
const NAME_STOPWORDS = new Set([
  'pokemon', 'card', 'cards', 'psa', 'gem', 'mint', 'promo', 'promos', 'japanese', 'japan',
  'english', 'holo', 'holofoil', 'rare', 'secret', 'ultra', 'the', 'with', 'and', 'full',
  'art', 'star', 'stars', 'box', 'deck', 'pack', 'set', 'collection', 'edition', 'shiny',
]);

export function setTokens(value: string): Set<string> {
  return new Set(normalizePart(value).split('_').filter((token) => token.length >= 2 && !SET_STOPWORDS.has(token)));
}

/**
 * Token-overlap rather than substring containment: normalizePart() collapses a
 * run of non-Latin script down to nothing, or to a stray fragment it happened
 * to contain ("ポリゴンZ" -> "z"). Both an empty string and "z" are trivial
 * substrings of almost any other name, so `.includes()` would spuriously
 * corroborate unrelated cards. Requiring a shared token of at least three
 * characters avoids that while still matching transliterated names.
 */
export function nameTokens(value: string): Set<string> {
  // Purely numeric tokens are excluded because several catalogue names embed
  // the printed number ("アリアドス-008/092" in the e-Card sets). Left in, they
  // let a listing's card number masquerade as a card-*name* match, which is
  // circular evidence and was scoring unrelated cards on live data.
  return new Set(normalizePart(value).split('_').filter((token) => token.length >= 3 && !/^\d+$/.test(token) && !NAME_STOPWORDS.has(token)));
}

/** Which Pokemon the listing text names, resolved through the unambiguous part of the species lexicon. */
export function listingSpecies(listingTokens: Set<string>, indexes: Pick<CatalogueIndexes, 'dexIdByNameToken'>): Set<number> {
  const ids = new Set<number>();
  for (const token of listingTokens) {
    const dexId = indexes.dexIdByNameToken.get(token);
    if (dexId != null) ids.add(dexId);
  }
  return ids;
}

function releaseYear(releaseDate: string | null): number | null {
  const match = releaseDate ? /^(\d{4})/.exec(releaseDate) : null;
  return match ? Number(match[1]) : null;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value); else map.set(key, [value]);
}

function pushAlias(map: Map<string, AliasRow[]>, text: string, row: AliasRow): void {
  const key = normalizePart(text);
  if (!key) return;
  const list = map.get(key);
  if (!list) { map.set(key, [row]); return; }
  if (!list.some((entry) => entry.sourceSetId === row.sourceSetId && entry.language === row.language)) list.push(row);
}

/** `_comment` entries are allowed in the alias file so the mapping can explain itself; anything without both an alias and a target is skipped. */
interface AliasFileEntry { alias?: string | string[]; sourceSetId?: string; language?: string }

/**
 * Curated aliases ship as a file rather than a migration because they are
 * data, not schema: the list grows every time a new marketplace or a new eBay
 * auto-translation shows up, and it should be reviewable in a diff. Learned
 * aliases (written when a human resolves a review) live in `ebay_set_aliases`
 * alongside them.
 */
export function loadAliases(db: DatabaseSync, aliasFile = path.join(DATA_DIR, 'aliases', 'ebay-sets.json')): Map<string, AliasRow[]> {
  const map = new Map<string, AliasRow[]>();
  if (existsSync(aliasFile)) {
    for (const entry of JSON.parse(readFileSync(aliasFile, 'utf8')) as AliasFileEntry[]) {
      if (!entry.alias || !entry.sourceSetId) continue;
      const aliases = Array.isArray(entry.alias) ? entry.alias : [entry.alias];
      for (const alias of aliases) pushAlias(map, alias, { sourceSetId: entry.sourceSetId, language: entry.language ?? null, origin: 'curated' });
    }
  }
  for (const row of db.prepare('SELECT alias_text, language, source_set_id, origin FROM ebay_set_aliases').all() as unknown as
    Array<{ alias_text: string; language: string | null; source_set_id: string; origin: string }>) {
    pushAlias(map, row.alias_text, { sourceSetId: row.source_set_id, language: row.language, origin: row.origin });
  }
  // Every PSA heading already mapped to a tcgdex set is a free, human-grade
  // alias: PSA heading names ("2016 Pokemon XY Evolutions") are exactly the
  // wording eBay sellers copy off the slab label.
  for (const row of db.prepare(`SELECT psa_heading_name, source_set_id, language FROM psa_set_map
    WHERE source_set_id IS NOT NULL AND match_status IN ('matched', 'manual')`).all() as unknown as
    Array<{ psa_heading_name: string; source_set_id: string; language: string | null }>) {
    pushAlias(map, row.psa_heading_name, { sourceSetId: row.source_set_id, language: row.language, origin: 'curated' });
  }
  return map;
}

interface CardQueryRow { card_id: number; set_id: number; local_id: string; name: string; rarity: string | null; attributes_json: string }

export function buildIndexes(db: DatabaseSync, aliasFile?: string): CatalogueIndexes {
  const setRows = db.prepare(`SELECT set_id, source_set_id, name, series, release_date, total_cards, official_cards, language FROM sets`).all() as unknown as
    Array<{ set_id: number; source_set_id: string; name: string; series: string | null; release_date: string | null; total_cards: number | null; official_cards: number | null; language: string }>;

  const sets: SetRow[] = setRows.map((row) => ({
    setId: row.set_id,
    sourceSetId: row.source_set_id,
    codeKey: row.source_set_id.toLowerCase(),
    looseCodeKey: row.source_set_id.toLowerCase().replace(/[^a-z0-9]/g, ''),
    name: row.name,
    nameKey: normalizePart(row.name),
    nameTokens: setTokens(row.name),
    series: row.series,
    year: releaseYear(row.release_date),
    totalCards: row.total_cards,
    officialCards: row.official_cards,
    language: row.language,
    digital: DIGITAL_SERIES.test(row.series ?? ''),
  }));

  const setsById = new Map(sets.map((set) => [set.setId, set]));
  const setsByCode = new Map<string, SetRow[]>();
  const setsByLooseCode = new Map<string, SetRow[]>();
  for (const set of sets) {
    push(setsByCode, set.codeKey, set);
    push(setsByLooseCode, set.looseCodeKey, set);
  }

  const cardsById = new Map<number, CardRow>();
  const cardsByNumber = new Map<string, CardRow[]>();
  const cardsBySet = new Map<number, CardRow[]>();
  for (const row of db.prepare('SELECT card_id, set_id, local_id, name, rarity, attributes_json FROM cards').all() as unknown as CardQueryRow[]) {
    const attributes = JSON.parse(row.attributes_json || '{}') as { hp?: unknown; illustrator?: unknown; dexId?: unknown };
    const card: CardRow = {
      cardId: row.card_id,
      setId: row.set_id,
      localId: row.local_id.toUpperCase(),
      name: row.name,
      nameTokens: nameTokens(row.name),
      rarity: row.rarity,
      hp: typeof attributes.hp === 'number' ? attributes.hp : null,
      illustrator: typeof attributes.illustrator === 'string' ? attributes.illustrator : null,
      dexIds: Array.isArray(attributes.dexId) ? attributes.dexId.filter((id): id is number => typeof id === 'number') : [],
    };
    cardsById.set(card.cardId, card);
    push(cardsBySet, card.setId, card);
    // Indexed under every padding form so a listing's "011" and the
    // catalogue's "11" meet without either side being rewritten at query time.
    for (const form of numberForms(card.localId)) push(cardsByNumber, form, card);
  }

  // Species lexicon: a token is only kept when every card whose name contains
  // it shares one Pokedex id. Built from Latin-script names (en/de); it is
  // then applied to Japanese cards, which is the whole point -- eBay titles
  // say "Pikachu" where the catalogue says ピカチュウ.
  const dexCandidates = new Map<string, Set<number>>();
  for (const card of cardsById.values()) {
    if (card.dexIds.length !== 1) continue;
    for (const token of card.nameTokens) {
      const seen = dexCandidates.get(token);
      if (seen) seen.add(card.dexIds[0]!); else dexCandidates.set(token, new Set([card.dexIds[0]!]));
    }
  }
  const dexIdByNameToken = new Map<string, number>();
  for (const [token, ids] of dexCandidates) if (ids.size === 1) dexIdByNameToken.set(token, [...ids][0]!);

  const emptySets = new Set(sets.filter((set) => !cardsBySet.has(set.setId)).map((set) => set.setId));

  const numberPrefixes = new Set<string>();
  for (const card of cardsById.values()) {
    const prefix = /^([A-Z]+)-?\d+$/.exec(card.localId);
    if (prefix) numberPrefixes.add(prefix[1]!.toLowerCase());
  }

  const psa10PopByCard = new Map<number, number>();
  const psa10PopByVariant = new Map<number, number>();
  for (const row of db.prepare(`SELECT v.card_id AS cardId, s.variant_id AS variantId, SUM(p.population_count) AS pop
    FROM psa_population_current p
    JOIN psa_specs s ON s.psa_spec_pk = p.population_spec_pk
    JOIN variants v ON v.variant_id = s.variant_id
    WHERE p.grade_key = '10' AND p.qualified = 0
    GROUP BY v.card_id, s.variant_id`).all() as unknown as Array<{ cardId: number; variantId: number; pop: number }>) {
    psa10PopByCard.set(row.cardId, (psa10PopByCard.get(row.cardId) ?? 0) + row.pop);
    psa10PopByVariant.set(row.variantId, (psa10PopByVariant.get(row.variantId) ?? 0) + row.pop);
  }

  return { sets, setsById, setsByCode, setsByLooseCode, cardsById, cardsByNumber, cardsBySet, emptySets, numberPrefixes, dexIdByNameToken, psa10PopByCard, psa10PopByVariant, aliases: loadAliases(db, aliasFile) };
}
