import type { CatalogueIndexes, CardRow, SetRow } from './lexicon.ts';
import { nameTokens, listingSpecies } from './lexicon.ts';
import { numberForms, type CardNumberCandidate } from './numbers.ts';
import { SET_CONFIDENT, type SetCandidate } from './setResolver.ts';
import type { ListingEvidence } from './evidence.ts';

/**
 * Candidate generation: recall first.
 *
 * v1 used one blocker -- card number over the whole catalogue -- and then
 * *narrowed* it until at most one row survived, which is why 2,079 listings
 * ended up with no candidate at all and 2,514 with too many. Precision is not
 * this stage's job; it belongs to scoring, which can weigh several
 * disagreeing signals against each other. What matters here is that the right
 * card is somewhere in the pool.
 *
 * Blockers are unioned, and each candidate remembers which ones found it,
 * because "found by number AND by name AND inside the resolved set" is itself
 * the strongest evidence available.
 */

export interface CardCandidate {
  card: CardRow;
  set: SetRow;
  /** Which blockers produced this candidate -- kept for scoring and for the review UI. */
  blockers: string[];
  /** The listing number reading that matched this card, if any. */
  number: CardNumberCandidate | null;
  /** Score of this card's set from the set resolver, 0 when the set was not independently indicated. */
  setScore: number;
}

// A number that resolves nowhere near the listing's set can still be right,
// but the pool has to stay bounded: "1" alone matches 555 cards.
const MAX_CANDIDATES = 400;
const MAX_NUMBER_READINGS = 6;

/** Only digital-only sets are excluded outright. Language disagreement is scored, not filtered -- see the language weights in score.ts. */
function eligible(set: SetRow): boolean {
  return !set.digital;
}

export function generateCandidates(evidence: ListingEvidence, sets: SetCandidate[], indexes: CatalogueIndexes): CardCandidate[] {
  const setScores = new Map<number, number>(sets.map((candidate) => [candidate.set.setId, candidate.score]));
  const confidentSets = sets.filter((candidate) => candidate.score >= SET_CONFIDENT);
  const found = new Map<number, CardCandidate>();

  const record = (card: CardRow, blocker: string, number: CardNumberCandidate | null): void => {
    const set = indexes.setsById.get(card.setId);
    if (!set || !eligible(set)) return;
    const existing = found.get(card.cardId);
    if (existing) {
      if (!existing.blockers.includes(blocker)) existing.blockers.push(blocker);
      if (number && (!existing.number || number.weight > existing.number.weight)) existing.number = number;
      return;
    }
    found.set(card.cardId, { card, set, blockers: [blocker], number, setScore: setScores.get(card.setId) ?? 0 });
  };

  // Blocker 1+2 -- printed number, preferring the resolved set but not
  // requiring it. Every padding form of every plausible reading is tried.
  //
  // The exception is a bare integer scraped out of a title: "... 2019 44 PSA
  // 10" reads 44 as a card number, which is right often enough to be worth
  // trying but wrong often enough that it must not be allowed to nominate
  // cards from every set in the catalogue at once. Those are only followed
  // inside a set the listing independently points at.
  for (const number of evidence.numbers.slice(0, MAX_NUMBER_READINGS)) {
    const looseTitleNumber = number.kind === 'bare' && number.source === 'title';
    for (const form of numberForms(number.value)) {
      for (const card of indexes.cardsByNumber.get(form) ?? []) {
        const inResolvedSet = setScores.has(card.setId);
        if (looseTitleNumber && !inResolvedSet) continue;
        record(card, inResolvedSet ? 'number+set' : 'number', number);
      }
    }
  }

  // Blocker 3 -- card name inside a confidently resolved set. This is the only
  // route for listings whose number never made it into the title (promos
  // written as "SWSH132" in a form we failed to read, or omitted entirely).
  const listingTokens = nameTokens(evidence.searchText);
  const dexIds = listingSpecies(listingTokens, indexes);
  for (const candidate of confidentSets) {
    for (const card of indexes.cardsBySet.get(candidate.set.setId) ?? []) {
      for (const token of card.nameTokens) {
        if (listingTokens.has(token)) { record(card, 'name+set', null); break; }
      }
      // Blocker 4 -- species inside a confident set. The name blocker cannot
      // fire for Japanese sets, whose card names are kana the listing never
      // contains; the Pokedex id is the same on both sides regardless of
      // language, so "Pikachu ... SV8a" still finds the right handful of cards.
      if (dexIds.size && card.dexIds.some((id) => dexIds.has(id))) record(card, 'species+set', null);
    }
  }

  const all = [...found.values()];
  if (all.length <= MAX_CANDIDATES) return all;
  // Over the cap the pool is dominated by same-numbered cards from unrelated
  // sets; keep the ones the set evidence actually points at.
  return all
    .sort((a, b) => (b.setScore - a.setScore) || (b.blockers.length - a.blockers.length))
    .slice(0, MAX_CANDIDATES);
}

/**
 * The same physical card in another language: same set code, same printed
 * number. eBay titles routinely name a Japanese card in English ("Dark
 * Phantasma Magnezone V"), so the English sibling's name is the only thing the
 * listing text can be checked against.
 */
export function siblingCards(indexes: CatalogueIndexes, card: CardRow): CardRow[] {
  const set = indexes.setsById.get(card.setId);
  if (!set) return [];
  const out: CardRow[] = [];
  for (const sibling of indexes.setsByCode.get(set.codeKey) ?? []) {
    if (sibling.setId === set.setId) continue;
    for (const other of indexes.cardsBySet.get(sibling.setId) ?? []) {
      if (other.localId === card.localId) out.push(other);
    }
  }
  return out;
}
