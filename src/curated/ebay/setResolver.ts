import { normalizePart } from '../materialize.ts';
import { setTokens, type CatalogueIndexes, type SetRow } from './lexicon.ts';
import type { ListingEvidence } from './evidence.ts';

/**
 * Resolves which tcgdex set a listing is about.
 *
 * This is the piece v1 did not have at all, and the reason it linked 57 of
 * 4,650 listings: without a set, a card number is looked up across all three
 * languages and 555 sets at once, where "#25" exists dozens of times over. The
 * corpus supplies set evidence in four independent forms, and this module
 * scores all of them together rather than trusting any one:
 *
 *  - the denominator of a promo number (`001/SV-P`, `020/M-P`) IS a set code;
 *  - JP set codes are printed on the card and copied into titles verbatim
 *    ("... 011/087 CP6", "Dark Phantasma S10A"), and `sets.source_set_id` is
 *    exactly that code;
 *  - the `Set` item-specific, which is often an eBay auto-translation
 *    ("Super elektrischer Schutzschalter" for Super Electric Breaker) and so
 *    needs an alias table rather than string matching;
 *  - the printed denominator of `NNN/MMM`, which is the set's card count.
 *
 * Returns a ranked list. Downstream scoring re-uses the set score rather than
 * treating the top set as fact, because a wrong set that outranks the right
 * one by a nose should not silently decide the card.
 */

export interface SetCandidate {
  set: SetRow;
  /** 0..1. */
  score: number;
  reasons: string[];
}

/** A code read out of free text is only trustworthy when it looks like a code: letters *and* digits, at least three characters. Bare-alpha ids in the catalogue ("sp", "rc", "lc", "np", "svp") are ordinary words in a listing title and would fire constantly. */
function looksLikeCode(token: string): boolean {
  return token.length >= 3 && /[a-z]/.test(token) && /\d/.test(token);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/** Share of the set's own name tokens present in the listing text. Directional on purpose: a title says far more than a set name does, so overlap must be measured against the shorter, more specific side. */
function coverage(setNameTokens: Set<string>, listingTokens: Set<string>): number {
  if (!setNameTokens.size) return 0;
  let shared = 0;
  for (const token of setNameTokens) if (listingTokens.has(token)) shared += 1;
  return shared / setNameTokens.size;
}

const WEIGHTS = {
  codeFromDenominator: 0.6,
  codeFromDenominatorLoose: 0.45,
  codeFromText: 0.5,
  codeFromTextLoose: 0.32,
  alias: 0.55,
  exactName: 0.55,
  nameJaccard: 0.4,
  titleCoverage: 0.3,
  titleCoverageFull: 0.45,
  officialTotal: 0.3,
  printedTotal: 0.25,
  yearExact: 0.15,
  yearNear: 0.08,
  yearFar: -0.12,
  language: 0.12,
  languageMismatch: -0.25,
};

/** Enough evidence that the set can be treated as known rather than guessed. Calibrated so a code hit alone, or an alias/exact-name hit alone, clears it. */
export const SET_CONFIDENT = 0.45;

interface Accum { score: number; reasons: string[] }

function add(accum: Accum, weight: number, reason: string): void {
  accum.score += weight;
  accum.reasons.push(reason);
}

export function resolveSets(evidence: ListingEvidence, indexes: CatalogueIndexes, limit = 8): SetCandidate[] {
  const listingTokens = setTokens(evidence.searchText);
  const titleTokens = normalizePart(evidence.title).split('_').filter(Boolean);
  // Hyphenated promo codes ("M-P", "S-P", "SV-P") are torn apart by
  // normalizePart, so adjacent short tokens are rejoined. Restricted to pairs
  // that were short on both sides, which is what a split code looks like --
  // rejoining arbitrary words would invent codes that are not there.
  const joined = titleTokens.slice(0, -1)
    .map((token, index) => ({ token, next: titleTokens[index + 1]! }))
    .filter(({ token, next }) => token.length <= 2 && next.length <= 2)
    .map(({ token, next }) => token + next);

  const codeHits = new Map<number, string>();
  const looseCodeHits = new Map<number, string>();
  for (const code of evidence.setCodeHints) {
    const key = code.toLowerCase();
    for (const set of indexes.setsByCode.get(key) ?? []) codeHits.set(set.setId, `denominator:${code}`);
    for (const set of indexes.setsByLooseCode.get(key.replace(/[^a-z0-9]/g, '')) ?? []) if (!codeHits.has(set.setId)) looseCodeHits.set(set.setId, `denominator~:${code}`);
  }
  const textCodeHits = new Map<number, string>();
  const textLooseHits = new Map<number, string>();
  for (const token of titleTokens) {
    if (!looksLikeCode(token)) continue;
    for (const set of indexes.setsByCode.get(token) ?? []) textCodeHits.set(set.setId, `code:${token}`);
  }
  for (const token of [...titleTokens.filter((token) => token.length >= 3), ...joined]) {
    for (const set of indexes.setsByLooseCode.get(token) ?? []) if (!textCodeHits.has(set.setId)) textLooseHits.set(set.setId, `code~:${token}`);
  }

  // Set aspects and the aliases they resolve to.
  const aliasHits = new Map<string, string>();
  const exactNameKeys = new Set<string>();
  const setTextTokens: Array<Set<string>> = [];
  for (const text of evidence.setTexts) {
    const key = normalizePart(text);
    if (!key) continue;
    exactNameKeys.add(key);
    setTextTokens.push(setTokens(text));
    for (const alias of indexes.aliases.get(key) ?? []) {
      if (alias.language && evidence.language && alias.language !== evidence.language) continue;
      aliasHits.set(alias.sourceSetId.toLowerCase(), text);
    }
  }
  // A set code can also arrive as the whole aspect value ("Set: CP6").
  for (const key of exactNameKeys) {
    for (const set of indexes.setsByCode.get(key) ?? []) textCodeHits.set(set.setId, `aspect-code:${key}`);
  }

  const printedTotals = new Set(evidence.numbers.map((n) => n.printedTotal).filter((total): total is number => total != null));

  const out: SetCandidate[] = [];
  for (const set of indexes.sets) {
    if (set.digital) continue;

    const accum: Accum = { score: 0, reasons: [] };
    // Language is scored, never filtered: the `Sprache` item-specific is
    // seller-entered and regularly wrong, and eliminating every set of the
    // "other" language on the strength of it leaves nothing to match.
    if (evidence.language && evidence.languageSupported) {
      if (set.language === evidence.language) add(accum, WEIGHTS.language, `lang:${set.language}`);
      else add(accum, WEIGHTS.languageMismatch, `lang-mismatch:${set.language}`);
    }
    const codeReason = codeHits.get(set.setId);
    if (codeReason) add(accum, WEIGHTS.codeFromDenominator, codeReason);
    else if (looseCodeHits.has(set.setId)) add(accum, WEIGHTS.codeFromDenominatorLoose, looseCodeHits.get(set.setId)!);
    const textReason = textCodeHits.get(set.setId);
    if (textReason) add(accum, WEIGHTS.codeFromText, textReason);
    else if (textLooseHits.has(set.setId)) add(accum, WEIGHTS.codeFromTextLoose, textLooseHits.get(set.setId)!);

    if (aliasHits.has(set.sourceSetId.toLowerCase())) add(accum, WEIGHTS.alias, `alias:${aliasHits.get(set.sourceSetId.toLowerCase())}`);
    if (exactNameKeys.has(set.nameKey)) add(accum, WEIGHTS.exactName, `set-name:${set.name}`);
    else {
      let best = 0;
      for (const tokens of setTextTokens) best = Math.max(best, jaccard(tokens, set.nameTokens));
      if (best >= 0.5) add(accum, WEIGHTS.nameJaccard * best, `set-name~${best.toFixed(2)}`);
    }

    // A distinctive multi-word set name appearing complete in the listing text
    // ("... HIDDEN FATES ...", "... Ascended Heroes ...") is as good as the Set
    // item-specific -- most sellers put the set in the title and nowhere else.
    const titleCoverage = coverage(set.nameTokens, listingTokens);
    if (titleCoverage === 1 && set.nameTokens.size >= 2) add(accum, WEIGHTS.titleCoverageFull, `set-in-text:${set.name}`);
    else if (titleCoverage >= 0.6) add(accum, WEIGHTS.titleCoverage * titleCoverage, `set-in-text~${titleCoverage.toFixed(2)}`);

    if (set.officialCards != null && printedTotals.has(set.officialCards)) add(accum, WEIGHTS.officialTotal, `official-total:${set.officialCards}`);
    else if (set.totalCards != null && printedTotals.has(set.totalCards)) add(accum, WEIGHTS.printedTotal, `printed-total:${set.totalCards}`);

    if (evidence.year != null && set.year != null) {
      const diff = Math.abs(evidence.year - set.year);
      if (diff === 0) add(accum, WEIGHTS.yearExact, `year:${set.year}`);
      else if (diff <= 1) add(accum, WEIGHTS.yearNear, `year~${set.year}`);
      else if (diff > 3) add(accum, WEIGHTS.yearFar, `year-off:${set.year}`);
    }

    // A set that only "matched" by being in the right language is not a
    // candidate, it is every set in that language.
    const languageOnly = accum.reasons.length === 1 && accum.reasons[0]!.startsWith('lang:');
    if (accum.score > 0 && !languageOnly) out.push({ set, score: Math.min(1, accum.score), reasons: accum.reasons });
  }

  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}
