import { normalizePart } from '../materialize.ts';
import { nameTokens, listingSpecies, type CatalogueIndexes } from './lexicon.ts';
import { numberForms } from './numbers.ts';
import { siblingCards, type CardCandidate } from './candidates.ts';
import type { ListingEvidence } from './evidence.ts';

/**
 * Scores one candidate card against one listing.
 *
 * Every feature is independent evidence and contributes its own weight, so a
 * candidate can survive a missing signal (eBay listings are missing something
 * more often than not) but cannot survive contradicting several at once. v1
 * had two features -- number and name -- with an all-or-nothing rule between
 * them; the corpus shows that is both too strict (a mistranslated card name
 * killed correct matches) and too loose (a bare number coincidence looked the
 * same as a real hit).
 *
 * Three features do most of the disambiguation work and none of them existed
 * before, all three coming out of `cards.attributes_json`, which tcgdex has
 * hydrated for all 56,385 catalogue cards:
 *
 *  - species (national Pokedex id), the only signal that survives the language
 *    barrier -- most of this corpus is Japanese cards described in English or
 *    German, where card-name text can never agree with the catalogue;
 *  - HP, carried by 1,875 listings as an item-specific;
 *  - illustrator, carried by 2,122.
 *
 * A Pikachu with 60 HP drawn by a named artist is essentially unique across
 * the whole catalogue.
 */

export interface ScoredCandidate extends CardCandidate {
  score: number;
  features: string[];
}

const WEIGHTS = {
  numberExact: 0.42,
  set: 0.4,
  nameOverlap: 0.26,
  nameFull: 0.06,
  nameSibling: 0.2,
  nameMissing: -0.12,
  speciesMatch: 0.26,
  speciesMismatch: -0.14,
  speciesAbsent: -0.08,
  hpMatch: 0.24,
  // Seller-entered HP is often copied from the wrong card or left at a
  // template default, so a disagreement is a doubt, not a disqualification.
  hpMismatch: -0.1,
  illustratorMatch: 0.24,
  illustratorMismatch: -0.06,
  languageMatch: 0.1,
  // Seller-declared language is wrong often enough that it must not be a hard
  // filter -- a Japanese card listed as "English" used to have its entire set
  // eliminated from consideration, leaving nothing to match at all. It is
  // weighed like any other disagreeing signal instead.
  languageMismatch: -0.22,
  rarityMatch: 0.06,
  psaGraded: 0.08,
  officialTotal: 0.3,
  printedTotal: 0.24,
  totalMismatch: -0.1,
  yearMatch: 0.12,
  yearFar: -0.1,
};

function overlap(a: Set<string>, b: Set<string>): number {
  if (!a.size) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / a.size;
}

export function scoreCandidate(evidence: ListingEvidence, candidate: CardCandidate, indexes: CatalogueIndexes, listingTokens: Set<string>, listingDexIds: Set<number>): ScoredCandidate {
  const features: string[] = [];
  let score = 0;
  const add = (weight: number, feature: string): void => { score += weight; features.push(feature); };

  if (candidate.number) {
    // The blocker only guarantees *some* padding form lined up; confirm the
    // catalogue number really is one of this reading's forms before paying out
    // the largest single weight in the model.
    const forms = new Set(numberForms(candidate.number.value));
    if (forms.has(candidate.card.localId) || numberForms(candidate.card.localId).some((form) => forms.has(form))) {
      add(WEIGHTS.numberExact * candidate.number.weight, `number:${candidate.number.value}(${candidate.number.kind})`);
    }
  }

  if (candidate.setScore > 0) add(WEIGHTS.set * candidate.setScore, `set:${candidate.set.sourceSetId}@${candidate.setScore.toFixed(2)}`);

  // Set attributes judged against *this* candidate's own set, not against the
  // set resolver's shortlist. Japanese listings are the reason: they routinely
  // carry no set name we can read and no set code, only "030/100", and dozens
  // of sets share a printed total -- so the right set often never makes the
  // resolver's top few. Checking the denominator per candidate instead lets
  // the card number, the set size and the species agree on an answer the set
  // resolver alone could not reach.
  //
  // `officialCards` is checked before `totalCards` because the printed
  // denominator is the *official* count: a secret rare like 219/191 has a
  // number above it, which is confirmation rather than contradiction.
  const printedTotal = candidate.number?.printedTotal ?? null;
  if (printedTotal != null) {
    if (candidate.set.officialCards === printedTotal) add(WEIGHTS.officialTotal, `total:${printedTotal}`);
    else if (candidate.set.totalCards === printedTotal) add(WEIGHTS.printedTotal, `total~:${printedTotal}`);
    else if (candidate.set.officialCards != null || candidate.set.totalCards != null) add(WEIGHTS.totalMismatch, `total-mismatch:${printedTotal}`);
  }

  if (evidence.year != null && candidate.set.year != null) {
    const diff = Math.abs(evidence.year - candidate.set.year);
    if (diff <= 1) add(WEIGHTS.yearMatch, `year:${candidate.set.year}`);
    else if (diff > 3) add(WEIGHTS.yearFar, `year-off:${candidate.set.year}`);
  }

  const nameCoverage = overlap(candidate.card.nameTokens, listingTokens);
  if (nameCoverage > 0) {
    add(WEIGHTS.nameOverlap * nameCoverage, `name:${candidate.card.name}@${nameCoverage.toFixed(2)}`);
    if (nameCoverage === 1) add(WEIGHTS.nameFull, 'name-full');
  } else if (candidate.card.nameTokens.size) {
    // The catalogue name in this card's own language appears nowhere in the
    // listing. That is normal for a Japanese card sold under its English name,
    // so check the cross-language sibling before holding it against the
    // candidate.
    let siblingBest = 0;
    for (const sibling of siblingCards(indexes, candidate.card)) siblingBest = Math.max(siblingBest, overlap(sibling.nameTokens, listingTokens));
    if (siblingBest > 0) add(WEIGHTS.nameSibling * siblingBest, `name-sibling@${siblingBest.toFixed(2)}`);
    else add(WEIGHTS.nameMissing, 'name-absent');
  }

  // Species, via the national Pokedex id. This is what makes Japanese cards
  // matchable at all: the listing says "Pikachu", the catalogue says
  // ピカチュウ, and no amount of token overlap will ever connect the two --
  // but both cards carry dexId 25.
  if (listingDexIds.size) {
    if (!candidate.card.dexIds.length) {
      // The listing names a Pokemon but this candidate is a Trainer or Energy
      // card, which carries no Pokedex id. Weak rather than fatal: some
      // Trainers are named after a Pokemon.
      add(WEIGHTS.speciesAbsent, 'species-absent');
    } else if (candidate.card.dexIds.some((id) => listingDexIds.has(id))) {
      add(WEIGHTS.speciesMatch, `species:${candidate.card.dexIds.join('/')}`);
    } else {
      add(WEIGHTS.speciesMismatch, 'species-mismatch');
    }
  }

  if (evidence.hp != null && candidate.card.hp != null) {
    if (evidence.hp === candidate.card.hp) add(WEIGHTS.hpMatch, `hp:${evidence.hp}`);
    else add(WEIGHTS.hpMismatch, `hp-mismatch:${evidence.hp}!=${candidate.card.hp}`);
  }

  if (evidence.illustrator && candidate.card.illustrator) {
    const listed = nameTokens(evidence.illustrator);
    const actual = nameTokens(candidate.card.illustrator);
    if (overlap(actual, listed) > 0) add(WEIGHTS.illustratorMatch, `illustrator:${candidate.card.illustrator}`);
    else add(WEIGHTS.illustratorMismatch, 'illustrator-mismatch');
  }

  if (evidence.language && evidence.languageSupported) {
    if (candidate.set.language === evidence.language) add(WEIGHTS.languageMatch, `lang:${evidence.language}`);
    else add(WEIGHTS.languageMismatch, `lang-mismatch:${evidence.language}!=${candidate.set.language}`);
  }

  if (evidence.rarity && candidate.card.rarity) {
    const listed = normalizePart(evidence.rarity);
    const actual = normalizePart(candidate.card.rarity);
    if (listed && actual && (listed === actual || listed.includes(actual) || actual.includes(listed))) add(WEIGHTS.rarityMatch, `rarity:${candidate.card.rarity}`);
  }

  // PSA has actually graded a 10 of this card. Positive-only: PSA spec
  // coverage outside English is thin, so an absent population says nothing.
  if ((indexes.psa10PopByCard.get(candidate.card.cardId) ?? 0) > 0) add(WEIGHTS.psaGraded, 'psa10-pop');

  // Deliberately not clamped to 1. Clamping made every well-evidenced
  // candidate score exactly 1.00, which erased the margin between the right
  // card and its near-twin (the same card's secret-rare reprint, the same set
  // in another language) and pushed thousands of certain matches into the
  // "too close to call" bucket. The absolute value only has to be comparable
  // against the thresholds; the *difference* between candidates is what
  // decides, so the sum is left free to grow.
  return { ...candidate, score: Math.max(0, score), features };
}

export function scoreAll(evidence: ListingEvidence, candidates: CardCandidate[], indexes: CatalogueIndexes): ScoredCandidate[] {
  const listingTokens = nameTokens(evidence.searchText);
  const listingDexIds = listingSpecies(listingTokens, indexes);
  return candidates
    .map((candidate) => scoreCandidate(evidence, candidate, indexes, listingTokens, listingDexIds))
    .sort((a, b) => b.score - a.score);
}
