import type { DatabaseSync } from 'node:sqlite';
import { normalizePart } from './materialize.ts';

// Native PSA-card <-> tcgdex-card/variant matching. Input is one row from
// PSA's /Pop/GetSetItems response (see src/sources/psa/collectors/setItems.ts):
// { CardNumber, SubjectName, Variety, SpecID, Grade1..Grade10, ... }. There is
// no pre-resolved identity handed to us (unlike the old clean_rewrite
// snapshot) -- the card number is the primary signal, corroborated by name.

export interface PsaSetItemRow {
  SpecID: number;
  SubjectName: string;
  Variety: string | null;
  CardNumber: string | null;
  CardNumberSort?: number | null;
  [key: string]: unknown;
}

export interface CardMatchResult {
  status: 'matched' | 'ambiguous' | 'unmatched' | 'skipped';
  cardId: number | null;
  variantParts: { finish: string; printRunMarker: string; microVariant: string } | null;
  reason?: string;
}

const NON_ENGLISH_VARIETY = /-(french|german|italian|spanish|japanese|korean|portuguese|chinese)\b/i;

/**
 * A single PSA heading can mix English rows with foreign-language rows
 * distinguished only by the `Variety` suffix (confirmed live: heading 81226
 * "Pokemon Promo Black Star" contains both "Pokemon League" and "Pokemon
 * League-French" rows). Those foreign rows belong to a *different* tcgdex
 * set than the heading's own English mapping, which this pass doesn't yet
 * resolve -- skip them explicitly rather than mis-link them to the English set.
 */
export function isEnglishRow(row: PsaSetItemRow): boolean {
  const variety = row.Variety ?? '';
  if (NON_ENGLISH_VARIETY.test(variety)) return false;
  return normalizePart(variety) !== 'italian' && normalizePart(variety) !== 'french' && normalizePart(variety) !== 'german';
}

/** Strips PSA's variant-suffix conventions off a subject name to get the bare card name for matching. */
function bareCardName(subjectName: string): string {
  return subjectName
    .replace(/-\s*(Holo|Reverse Foil|1st Edition|Shadowless|Unlimited|Staff|Prerelease)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

interface VariantSignals {
  finish: string;
  printRunMarker: string;
  microVariant: string;
}

function inferVariantSignals(subjectName: string, variety: string | null): VariantSignals {
  const haystack = `${subjectName} ${variety ?? ''}`;
  const finish = /reverse\s*foil/i.test(haystack) ? 'reverse' : /holo/i.test(haystack) ? 'holo' : 'normal';
  const printRunMarker = /1st\s*edition/i.test(haystack) ? 'first_edition' : /shadowless/i.test(haystack) ? 'shadowless' : 'unlimited';
  const microVariant = variety ? normalizePart(variety.replace(NON_ENGLISH_VARIETY, '')) : '';
  return { finish, printRunMarker, microVariant };
}

function normalizeCardNumber(value: string | null | undefined): string {
  if (!value) return '';
  return value.trim().replace(/^0+(?=\d)/, '').toUpperCase();
}

interface CardRow {
  card_id: number;
  local_id: string;
  name: string;
}

/**
 * Matches one GetSetItems row to a tcgdex card within the given (already
 * set-mapped) source_set_id, using card number as the primary signal and
 * name as corroboration. Never guesses across an ambiguous number match.
 */
export function matchPsaCardRow(db: DatabaseSync, sourceSetId: string, language: string, row: PsaSetItemRow): CardMatchResult {
  if (!isEnglishRow(row)) return { status: 'skipped', cardId: null, variantParts: null, reason: 'non-English Variety, cross-set resolution not yet supported' };

  const number = normalizeCardNumber(row.CardNumber);
  if (!number) return { status: 'unmatched', cardId: null, variantParts: null, reason: 'PSA row has no CardNumber' };

  const setCards = db.prepare(
    `SELECT c.card_id, c.local_id, c.name FROM cards c JOIN sets s ON s.set_id = c.set_id WHERE s.language = ? AND s.source_set_id = ?`,
  ).all(language, sourceSetId) as unknown as CardRow[];
  const pool = setCards.filter((c) => normalizeCardNumber(c.local_id) === number);

  if (pool.length === 0) return { status: 'unmatched', cardId: null, variantParts: null, reason: `no card numbered ${number} in ${sourceSetId}` };

  if (pool.length === 1) {
    return { status: 'matched', cardId: pool[0]!.card_id, variantParts: inferVariantSignals(row.SubjectName, row.Variety) };
  }

  // Multiple cards share this number (rare, but tcgdex does this for some
  // promo sets) -- corroborate with a normalized name-token overlap.
  const wantedTokens = new Set(normalizePart(bareCardName(row.SubjectName)).split('_').filter(Boolean));
  const scored = pool.map((c) => {
    const cardTokens = new Set(normalizePart(c.name).split('_').filter(Boolean));
    let overlap = 0;
    for (const t of wantedTokens) if (cardTokens.has(t)) overlap++;
    return { card: c, overlap };
  }).sort((a, b) => b.overlap - a.overlap);

  if (scored[0]!.overlap > 0 && (scored.length === 1 || scored[0]!.overlap > scored[1]!.overlap)) {
    return { status: 'matched', cardId: scored[0]!.card.card_id, variantParts: inferVariantSignals(row.SubjectName, row.Variety) };
  }
  return { status: 'ambiguous', cardId: null, variantParts: null, reason: `${pool.length} cards numbered ${number} in ${sourceSetId}, name corroboration inconclusive` };
}
