import type { DatabaseSync } from 'node:sqlite';
import { normalizePart } from './materialize.ts';

export interface EbayAspectPair { name?: string; value?: string }
export interface EbayConditionDescriptorValue { content?: string }
export interface EbayConditionDescriptor { name?: string; values?: EbayConditionDescriptorValue[] }
export interface EbayMoney { value?: string; currency?: string }

export interface EbayItemDetail {
  itemId?: string;
  legacyItemId?: string;
  itemWebUrl?: string;
  title?: string;
  conditionId?: string;
  conditionDescriptors?: EbayConditionDescriptor[];
  localizedAspects?: EbayAspectPair[];
  price?: EbayMoney;
  currentBidPrice?: EbayMoney;
  bidCount?: number;
  buyingOptions?: string[];
  itemEndDate?: string | null;
  quantity?: number;
  [key: string]: unknown;
}

// eBay's standard "professionally graded" condition id. Anything without it
// is never a graded single card, so it's excluded before any matching runs.
const GRADED_CONDITION_ID = '2750';

/**
 * Aspect/condition-descriptor label -> canonical concept, seeded from the
 * labels actually observed live across DE/GB/ES listings (see
 * docs/ebay-raw-fetch.md). Labels are matched after normalizePart(), so case
 * and punctuation differences collapse automatically. New marketplaces will
 * need new entries added here as their label strings are seen.
 */
const GRADER_LABELS = new Set(['professional_grader', 'bewertungsexperte', 'grado_profesional', 'professionele_grader', 'classificateur_professionnel']);
const GRADE_LABELS = new Set(['grade', 'bewertung', 'grado', 'note', 'nota']);
const CERT_LABELS = new Set(['certification_number', 'zertifizierungsnummer', 'numero_de_certificacion', 'numero_de_certification']);
const CARD_NAME_LABELS = new Set(['card_name', 'kartenname', 'nombre_de_la_carta', 'nom_de_la_carte']);
const CARD_NUMBER_LABELS = new Set(['card_number', 'kartennummer', 'numero_de_carta', 'numero_de_carte']);
const SET_LABELS = new Set(['set']);
const LANGUAGE_LABELS = new Set(['language', 'sprache', 'idioma', 'langue']);

function collectAspectPairs(item: EbayItemDetail): Array<{ label: string; value: string }> {
  const pairs: Array<{ label: string; value: string }> = [];
  for (const descriptor of item.conditionDescriptors ?? []) {
    const value = descriptor.values?.[0]?.content;
    if (descriptor.name && value) pairs.push({ label: normalizePart(descriptor.name), value: value.trim() });
  }
  for (const aspect of item.localizedAspects ?? []) {
    if (aspect.name && aspect.value) pairs.push({ label: normalizePart(aspect.name), value: aspect.value.trim() });
  }
  return pairs;
}

function firstValue(pairs: Array<{ label: string; value: string }>, labels: Set<string>): string | null {
  for (const pair of pairs) if (labels.has(pair.label)) return pair.value;
  return null;
}

// Sellers routinely leave optional item-specifics as an explicit "not
// applicable" placeholder rather than omitting them; treat those the same as
// missing data instead of matching against the literal text.
const NA_VALUES = new Set(['na', 'n_a', 'nein', 'no', 'none', '']);
function meaningful(value: string | null): string | null {
  if (!value) return null;
  return NA_VALUES.has(normalizePart(value)) ? null : value;
}

export interface GradingInfo {
  grader: string | null;
  gradeLabel: string | null;
  gradeValue: number | null;
  certNumber: string | null;
  method: 'condition-descriptors' | 'title-fallback' | 'none';
}

const TITLE_GRADER_GRADE = /\b(PSA|BGS|CGC|SGC)\s*[- ]?\s*(10|9\.5|9|8\.5|8)\b/i;

/**
 * Structured `conditionDescriptors` (eBay's own standardized grading fields)
 * are the primary signal -- far more reliable than the free-text title, which
 * sellers write inconsistently. Title regex is only a fallback for listings
 * that omit the descriptors.
 */
export function extractGrading(item: EbayItemDetail): GradingInfo {
  const pairs = collectAspectPairs(item);
  const graderRaw = firstValue(pairs, GRADER_LABELS);
  const gradeRaw = firstValue(pairs, GRADE_LABELS);
  const certNumber = meaningful(firstValue(pairs, CERT_LABELS));
  if (item.conditionId === GRADED_CONDITION_ID && (graderRaw || gradeRaw)) {
    return {
      grader: graderRaw?.trim() ?? null,
      gradeLabel: gradeRaw?.trim() ?? null,
      gradeValue: gradeRaw ? Number(gradeRaw.replace(',', '.')) : null,
      certNumber,
      method: 'condition-descriptors',
    };
  }
  const titleMatch = TITLE_GRADER_GRADE.exec(item.title ?? '');
  if (titleMatch) {
    return { grader: titleMatch[1]!.toUpperCase(), gradeLabel: titleMatch[2]!, gradeValue: Number(titleMatch[2]), certNumber, method: 'title-fallback' };
  }
  return { grader: null, gradeLabel: null, gradeValue: null, certNumber, method: 'none' };
}

// The grader aspect/descriptor value is a free-text company name, not a code
// -- observed live as both "PSA" and "Professional Sports Authenticator
// (PSA)" -- so this looks for the abbreviation as a whole word rather than
// requiring an exact match.
const PSA_GRADER = /(^|[^a-z0-9])psa([^a-z0-9]|$)/i;

/** v1 ingestion scope, per explicit user decision: only PSA-graded 10s become `ebay_listings` rows. */
export function isPsa10(grading: GradingInfo): boolean {
  return PSA_GRADER.test(grading.grader ?? '') && grading.gradeValue === 10;
}

const LOT_KEYWORDS = /\b(lot of|bundle|joblot|job lot|sammellos|konvolut|lote de)\b/i;

/** Multi-card listings can't be mapped to one variant, so they're flagged and excluded rather than guessed at. */
export function isLot(item: EbayItemDetail): boolean {
  if ((item.quantity ?? 1) > 1) return true;
  return LOT_KEYWORDS.test(item.title ?? '');
}

export interface CardIdentity {
  cardName: string | null;
  cardNumber: string | null;
  /** The printed set-total denominator from "NNN/MMM" (e.g. 25 from "001/025"), when it's numeric. Cross-checked against `sets.total_cards`. */
  cardTotal: number | null;
  setName: string | null;
  language: string | null;
  confidence: 'aspects' | 'title-fallback';
}

// Card numbers show up as "011/087" (numerator/set-total, both digits),
// "001/SV-P" or "020/M-p" (numerator over a non-numeric promo-set code), or a
// bare "#028"/"028" with no denominator at all. Our catalogue only stores the
// numerator (e.g. cards.number = '11'), so every one of these forms needs
// reducing to just that leading number before it's usable for matching --
// storing "011/087" whole (as the raw aspect text arrives) never matches
// anything and was silently sending most aspect-matched listings to review.
// When the denominator IS numeric, it also doubles as the set's printed
// total card count -- a second, independent signal used later to disambiguate
// same-numbered cards across different sets (see findCandidateVariants).
const FRACTION = /\b(\d{1,4})\s*\/\s*([A-Za-z0-9-]+)\b/g;
const HASH_NUMBER = /#\s*(\d{1,4})\b/;
const BARE_NUMBER = /^\s*(\d{1,4})\s*$/;

// A grade is also written as a fraction-looking string right next to a
// grading company's name -- "PSA 10 / OVP", "9 / PSA", "PSA 10 / BGS 10" --
// which is not a card number at all. Titles routinely contain both a real
// card-number fraction and one of these decoys, so every candidate is
// checked in left-to-right order and the first one that survives validation
// wins, rather than accepting (or giving up on) whichever comes first.
const GRADING_WORDS = new Set(['psa', 'bgs', 'cgc', 'sgc']);
const NON_SET_DENOMINATORS = new Set(['psa', 'bgs', 'cgc', 'sgc', 'no', 'auto', 'ovp', 'gem', 'mint']);

function precedingWord(raw: string, index: number): string {
  return raw.slice(0, index).trim().split(/\s+/).pop()?.toLowerCase().replace(/[^a-z]/g, '') ?? '';
}

interface NumberExtraction { number: string; total: number | null }

function extractNumber(raw: string): NumberExtraction | null {
  for (const match of raw.matchAll(FRACTION)) {
    const denominator = match[2]!.toLowerCase();
    if (GRADING_WORDS.has(precedingWord(raw, match.index))) continue;
    if (NON_SET_DENOMINATORS.has(denominator)) continue;
    return { number: match[1]!, total: /^\d+$/.test(match[2]!) ? Number(match[2]) : null };
  }
  const hash = HASH_NUMBER.exec(raw);
  if (hash) return { number: hash[1]!, total: null };
  const bare = BARE_NUMBER.exec(raw);
  return bare ? { number: bare[1]!, total: null } : null;
}

/**
 * Structured `localizedAspects` (card name + number) are the primary
 * identity signal. When a listing omits them, falls back to a card-number
 * pattern in the title and flags the identity as lower-confidence.
 */
export function extractCardIdentity(item: EbayItemDetail): CardIdentity {
  const pairs = collectAspectPairs(item);
  const cardName = meaningful(firstValue(pairs, CARD_NAME_LABELS));
  const cardNumberAspect = meaningful(firstValue(pairs, CARD_NUMBER_LABELS));
  const setName = meaningful(firstValue(pairs, SET_LABELS));
  const language = meaningful(firstValue(pairs, LANGUAGE_LABELS));
  const fromAspect = cardNumberAspect ? extractNumber(cardNumberAspect) : null;
  if (cardName && fromAspect) return { cardName, cardNumber: fromAspect.number, cardTotal: fromAspect.total, setName, language, confidence: 'aspects' };
  const fromTitle = extractNumber(item.title ?? '');
  const chosen = fromAspect ?? fromTitle;
  return { cardName, cardNumber: chosen?.number ?? null, cardTotal: chosen?.total ?? null, setName, language, confidence: 'title-fallback' };
}

// Generic Pokemon TCG/marketplace jargon that shows up in almost every
// listing and card name alike (rarity tiers, mechanics, boilerplate). Sharing
// one of these tokens proves nothing about card identity -- e.g. two entirely
// unrelated VMAX cards both contain "vmax" -- so they're excluded from
// corroboration even though they're long enough to otherwise pass.
const GENERIC_NAME_TOKENS = new Set([
  'pokemon', 'pokemon_tcg', 'card', 'cards', 'psa', 'gem', 'mint', 'promo', 'promos',
  'japanese', 'japan', 'english', 'holo', 'holofoil', 'rare', 'secret', 'ultra', 'ex', 'gx',
  'vmax', 'vstar', 'the', 'with', 'and', 'full', 'art', 'ball', 'light', 'dark', 'team',
  'star', 'stars', 'box', 'deck', 'pack', 'set', 'collection', 'edition', 'shiny', 'mega',
]);

export interface VariantCandidate { variantId: number; cardId: number }

export interface CandidateSearchResult {
  candidates: VariantCandidate[];
  /**
   * True when `candidates` was narrowed by a card-name and/or set-total
   * match, not just a card-number coincidence. Card numbers repeat
   * constantly across our ~56k-card, multi-language, multi-set catalogue
   * (e.g. ten different "Bulbasaur #1" printings), so a bare number hit with
   * no corroborating signal is not trustworthy enough to auto-match -- the
   * caller should route it to review instead of accepting it silently.
   */
  corroborated: boolean;
}

// Token-overlap rather than raw substring containment: normalizePart()
// collapses a whole run of non-Latin script (Japanese/Korean/Chinese) down to
// nothing, or to a single stray Latin/digit fragment it happened to contain
// (e.g. "ポリゴンZ" -> "z"). Both an empty string and a short fragment like
// "z" are trivial substrings of almost any other normalized name, so naive
// `.includes()` checks would spuriously "corroborate" an unrelated card.
// Requiring a shared token of at least 3 characters, and excluding generic
// TCG jargon, avoids both failure modes while still matching real names
// across languages that share a transliterated core word (e.g. "Pikachu").
function nameTokens(value: string): string[] {
  return normalizePart(value).split('_').filter((token) => token.length >= 3 && !GENERIC_NAME_TOKENS.has(token));
}

/**
 * Matches on card number first (the strongest, least ambiguous signal
 * available from eBay data), then applies two independent checks:
 *
 * 1. A hard prefilter on the set's printed total card count (the numeric
 *    denominator of "NNN/MMM", cross-checked against `sets.total_cards`).
 *    A *known* mismatch disqualifies a candidate outright -- e.g. a
 *    "Parasol Lady 089/062" listing's denominator (62) ruling out an
 *    unrelated "Pokémon Center Lady" candidate whose set actually has 111
 *    cards, regardless of what name-token overlap says below. A candidate
 *    with no recorded total (null) is neither confirmed nor excluded by
 *    this check.
 * 2. Card-name token overlap on the surviving pool, required for
 *    `corroborated` -- a number/total match alone is still not proof of
 *    identity (observed live: a "Jynx" listing's 074/141 fraction
 *    coincidentally matched an unrelated Darkrai card's number AND its
 *    set's size, with no name in common at all).
 *
 * Falls back to the pre-name pool only when name-narrowing would eliminate
 * every candidate, since eBay card-name spelling/translation is unreliable --
 * but callers must not treat that fallback as corroborated.
 */
export function findCandidateVariants(db: DatabaseSync, identity: CardIdentity): CandidateSearchResult {
  if (!identity.cardNumber) return { candidates: [], corroborated: false };
  const stripped = identity.cardNumber.replace(/^0+(?=\d)/, '');
  const rows = db.prepare(`
    SELECT v.variant_id AS variantId, v.card_id AS cardId, c.name AS cardName, s.total_cards AS totalCards
    FROM variants v JOIN cards c ON c.card_id = v.card_id JOIN sets s ON s.set_id = c.set_id
    WHERE c.number = ? OR c.local_id = ? OR c.number = ? OR c.local_id = ?
  `).all(identity.cardNumber, identity.cardNumber, stripped, stripped) as unknown as
    Array<VariantCandidate & { cardName: string; totalCards: number | null }>;
  const toCandidates = (list: typeof rows): VariantCandidate[] => list.map(({ variantId, cardId }) => ({ variantId, cardId }));

  const totalConsistent = identity.cardTotal != null
    ? rows.filter((row) => row.totalCards == null || row.totalCards === identity.cardTotal)
    : rows;

  const wantedTokens = new Set(identity.cardName ? nameTokens(identity.cardName) : []);
  const byName = wantedTokens.size ? totalConsistent.filter((row) => nameTokens(row.cardName).some((token) => wantedTokens.has(token))) : [];
  const nameNarrowed = byName.length > 0;

  return { candidates: toCandidates(nameNarrowed ? byName : totalConsistent), corroborated: nameNarrowed };
}
