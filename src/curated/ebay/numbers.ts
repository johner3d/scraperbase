/**
 * Card-number parsing for eBay listing text.
 *
 * v1 (`ebayMatch.extractNumber`) returned a single winner and understood only
 * `NNN/MMM`, `#NNN` and a bare number. Measured against the stored corpus that
 * misses whole families of real printed numbers -- `SWSH132`, `GG30/GG70`,
 * `SM246`, `TG12`, `001/SV-P`, `020/M-P` -- and, worse, it has to *guess*
 * which of several fraction-looking strings in a title is the card number
 * before it has any set context to judge with.
 *
 * This module deliberately does not guess. It returns every plausible reading,
 * each carrying where it came from and how much it should be trusted, and lets
 * candidate generation and scoring decide which one actually resolves against
 * the catalogue.
 *
 * In tcgdex, `cards.number` and `cards.local_id` are always identical (checked
 * across all 56,385 rows) and take three shapes: pure digits (53,578), a
 * letter prefix plus digits like `SWSH132`/`TG12`/`DP01` (2,671), and digits
 * plus a letter suffix like `101A` (58).
 */

export type CardNumberKind = 'fraction' | 'promo-fraction' | 'hash' | 'alnum' | 'bare';
export type EvidenceSource = 'aspect' | 'title' | 'description';

export interface CardNumberCandidate {
  /** The printed number, uppercased, exactly as written. Leading zeros are kept here; `numberForms()` produces the padding variants. */
  value: string;
  /** Numeric denominator of `NNN/MMM`, i.e. the set's printed card count. */
  printedTotal: number | null;
  /** Non-numeric denominator of `NNN/CODE` -- `001/SV-P`, `020/M-P`. That is a set code, and a far stronger set signal than any name text. */
  denominatorCode: string | null;
  kind: CardNumberKind;
  source: EvidenceSource;
  /** 0..1 prior on this reading being the real card number, before any catalogue lookup. */
  weight: number;
}

// A grade is written as a fraction right next to a grading company's name --
// "PSA 10 / OVP", "9 / PSA", "PSA 10 / BGS 10" -- and titles routinely contain
// both a real card-number fraction and one of these decoys. Carried over from
// v1, where these lists were the only defence against reading the grade as a
// card number.
const GRADING_WORDS = new Set(['psa', 'bgs', 'cgc', 'sgc', 'ace', 'tag']);
const NON_SET_DENOMINATORS = new Set(['psa', 'bgs', 'cgc', 'sgc', 'no', 'auto', 'ovp', 'gem', 'mint', 'nm', 'mt', 'eur', 'usd', 'gbp']);

// Letter prefixes that only ever appear in grading or marketing noise.
// Everything else is emitted, just at a low weight -- an unknown prefix that
// happens to match a local_id in the resolved set is good evidence, and one
// that matches nothing costs nothing.
const NON_CARD_PREFIXES = new Set(['psa', 'bgs', 'cgc', 'sgc', 'gem', 'mt', 'nm', 'lp', 'ovp', 'eur', 'usd', 'gbp', 'ver', 'no', 'nr', 'x', 'lot', 'pcs', 'stk', 'st']);

const FRACTION = /(\d{1,4})\s*\/\s*([A-Za-z0-9][A-Za-z0-9-]*)/g;
const HASH_NUMBER = /#\s*(\d{1,4}[A-Za-z]?)\b/g;
const ALNUM_NUMBER = /\b([A-Za-z]{1,4})[-\s]?(\d{1,4})\b/g;
const BARE_NUMBER = /^\s*(\d{1,4}[A-Za-z]?)\s*$/;

function precedingWord(raw: string, index: number): string {
  return raw.slice(0, index).trim().split(/\s+/).pop()?.toLowerCase().replace(/[^a-z]/g, '') ?? '';
}

/**
 * Every form of a printed number worth trying against `cards.local_id`: as
 * written, without leading zeros, and zero-padded. eBay sellers and tcgdex
 * disagree constantly about padding ("011" vs "11", "1" vs "001"), and in v1
 * that disagreement alone sent otherwise perfect aspect matches to review.
 */
export function numberForms(value: string): string[] {
  const raw = value.trim().toUpperCase();
  if (!raw) return [];
  const forms = new Set<string>([raw]);
  const digits = /^0*(\d+)([A-Z]?)$/.exec(raw);
  if (digits) {
    forms.add(digits[1]! + digits[2]!);
    if (digits[1]!.length < 3) forms.add(digits[1]!.padStart(3, '0') + digits[2]!);
  }
  const prefixed = /^([A-Z]+)-?0*(\d+)$/.exec(raw);
  if (prefixed) {
    forms.add(`${prefixed[1]}${prefixed[2]}`);
    forms.add(`${prefixed[1]}${prefixed[2]!.padStart(2, '0')}`);
    forms.add(`${prefixed[1]}${prefixed[2]!.padStart(3, '0')}`);
  }
  return [...forms];
}

/** Source-level trust: an item-specific the seller filled in beats the title, which beats the free-text description. */
const SOURCE_WEIGHT: Record<EvidenceSource, number> = { aspect: 1, title: 0.85, description: 0.45 };

function push(out: CardNumberCandidate[], candidate: CardNumberCandidate): void {
  // The same reading usually turns up in both title and description -- keep
  // the stronger one rather than letting repetition inflate the evidence.
  const existing = out.find((c) => c.value === candidate.value && c.printedTotal === candidate.printedTotal);
  if (!existing) { out.push(candidate); return; }
  if (candidate.weight > existing.weight) Object.assign(existing, candidate);
}

/**
 * Pulls every plausible card number out of one piece of listing text, ordered
 * strongest-first. Callers should treat the whole list as alternatives rather
 * than taking the head.
 */
export function extractNumbers(raw: string | null | undefined, source: EvidenceSource, knownPrefixes?: Set<string>): CardNumberCandidate[] {
  if (!raw) return [];
  const text = raw.trim();
  if (!text) return [];
  const base = SOURCE_WEIGHT[source];
  const out: CardNumberCandidate[] = [];

  // An aspect value that is nothing but a number is the most reliable signal
  // available, so it is recognised before the generic patterns.
  const bare = BARE_NUMBER.exec(text);
  if (bare) push(out, { value: bare[1]!.toUpperCase(), printedTotal: null, denominatorCode: null, kind: 'bare', source, weight: base });

  for (const match of text.matchAll(FRACTION)) {
    if (GRADING_WORDS.has(precedingWord(text, match.index))) continue;
    const denominator = match[2]!;
    if (NON_SET_DENOMINATORS.has(denominator.toLowerCase())) continue;
    const numeric = /^\d+$/.test(denominator);
    // A denominator only counts as a set code when it is letters and
    // punctuation ("SV-P", "M-P", "S-P"). "030/GG70" and "012/TG30" are a
    // number over a *subset* size, and reading "GG70" as a set code invented
    // catalogue gaps for sets that do not exist.
    const isSetCode = !numeric && /^[A-Za-z][A-Za-z-]*$/.test(denominator) && denominator.length >= 2;
    push(out, {
      value: match[1]!.toUpperCase(),
      printedTotal: numeric ? Number(denominator) : null,
      denominatorCode: isSetCode ? denominator.toUpperCase() : null,
      kind: numeric ? 'fraction' : 'promo-fraction',
      source,
      weight: base * 0.95,
    });
  }

  for (const match of text.matchAll(HASH_NUMBER)) {
    push(out, { value: match[1]!.toUpperCase(), printedTotal: null, denominatorCode: null, kind: 'hash', source, weight: base * 0.8 });
  }

  // Letter-prefixed numbers are only read out of aspects and titles: seller
  // descriptions are prose, and prose produces a steady stream of
  // word-plus-number garbage ("ein 2021", "sind 100", "bis 10") that reads as
  // a card number and then suppresses better evidence.
  for (const match of source === 'description' ? [] : text.matchAll(ALNUM_NUMBER)) {
    const prefix = match[1]!.toLowerCase();
    if (NON_CARD_PREFIXES.has(prefix)) continue;
    // When the caller supplies the prefixes the catalogue actually uses
    // (SWSH, TG, GG, DP, RC...), anything else is a word that happens to sit
    // next to a number, not a printed card number.
    if (knownPrefixes && !knownPrefixes.has(prefix)) continue;
    // "SWSH 132" and "SWSH132" are the same printed number; normalizing the
    // separator away lines it up with cards.local_id.
    push(out, { value: `${match[1]!.toUpperCase()}${match[2]}`, printedTotal: null, denominatorCode: null, kind: 'alnum', source, weight: base * 0.55 });
  }

  return out.sort((a, b) => b.weight - a.weight);
}

// Years, grades and the "of N" half of a fraction we already read. A bare
// integer in a title is only worth trying once everything better has failed.
const YEAR = /^(19|20)\d{2}$/;
const GRADE_VALUES = new Set(['8', '9', '10']);

/**
 * Last-resort reading: standalone integers in a title.
 *
 * A large share of this corpus is titles transcribed off the PSA slab label,
 * which puts the card number last and unadorned -- "NIDOKING POKEMON EXPANSION
 * 20TH ANN 1ST ED HOLO JAP 043 2016 PSA 10", "... HIDDEN FATES 2019 44 PSA
 * 10". v1 produced no candidate at all for these, and they were the single
 * largest group in the review queue. Only called when no better-formed number
 * was found, capped, and weighted low enough that set and species evidence
 * decides which of the resulting candidates is real.
 */
export function extractLooseNumbers(raw: string | null | undefined, source: EvidenceSource, limit = 3): CardNumberCandidate[] {
  if (!raw) return [];
  const out: CardNumberCandidate[] = [];
  for (const match of raw.matchAll(/\b(\d{1,4})\b/g)) {
    const value = match[1]!;
    if (YEAR.test(value)) continue;
    if (GRADE_VALUES.has(value) && /psa|bgs|cgc|sgc|gem|mint/i.test(raw.slice(Math.max(0, match.index - 12), match.index + 14))) continue;
    push(out, { value, printedTotal: null, denominatorCode: null, kind: 'bare', source, weight: SOURCE_WEIGHT[source] * 0.5 });
    if (out.length >= limit) break;
  }
  return out;
}

/** Merges candidates from several texts, keeping the strongest reading of each distinct number. */
export function mergeNumbers(groups: CardNumberCandidate[][]): CardNumberCandidate[] {
  const out: CardNumberCandidate[] = [];
  for (const group of groups) for (const candidate of group) push(out, candidate);
  return out.sort((a, b) => b.weight - a.weight);
}

/** Distinct printed numbers in one text -- two or more means a multi-card lot, which no single variant can represent. */
export function distinctPrintedNumbers(candidates: CardNumberCandidate[]): number {
  return new Set(
    candidates
      .filter((c) => c.kind === 'fraction' || c.kind === 'promo-fraction')
      .map((c) => c.value.replace(/^0+(?=\d)/, '')),
  ).size;
}
