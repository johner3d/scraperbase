import type { CatalogueIndexes } from './lexicon.ts';
import type { ScoredCandidate } from './score.ts';
import type { ListingEvidence } from './evidence.ts';
import { SET_CONFIDENT } from './setResolver.ts';

/**
 * Turns a ranked candidate list into an outcome.
 *
 * The tiering exists because "matched or reviewed" is the wrong binary for
 * this data. Two thirds of the review queue v1 produced were listings where
 * the *card* was obvious and only the finish was not -- eBay listings almost
 * never state holo vs reverse holo -- and asking a human to pick between
 * "Pikachu 25/102 Holo" and "Pikachu 25/102 Reverse" from the same title they
 * already can't tell apart is not work, it is noise. Those become
 * `card-level`: the card is recorded, the variant is honestly left open.
 *
 * The review budget is ~5% of listings, so medium-confidence answers are
 * accepted and flagged rather than queued.
 */

export type MatchTier = 'exact' | 'strong' | 'card-level' | 'flagged' | 'review' | 'lot' | 'out-of-scope' | 'catalogue-gap';
export type VariantConfidence = 'proven' | 'card-level' | 'none';

export interface VariantRow {
  variantId: number;
  finish: string | null;
  printRunMarker: string | null;
  microVariant: string | null;
  stamps: string[];
}

export interface MatchDecision {
  cardId: number | null;
  variantId: number | null;
  tier: MatchTier;
  /** Kept inside the original four-value `ebay_listings.match_status` domain so the existing views and API stay valid; `tier` carries the richer answer. */
  matchStatus: 'matched' | 'unmatched' | 'ambiguous' | 'manual';
  method: string;
  confidence: number | null;
  score: number | null;
  runnerUpScore: number | null;
  flagged: boolean;
  variantConfidence: VariantConfidence;
  /** Ranked card ids, best first -- what a reviewer is choosing between. */
  candidateCardIds: number[];
  candidateVariantIds: number[];
  reason: string | null;
  /** For `catalogue-gap`, the set or set code that is missing -- the work list `ebay-match-report` prints. */
  gapSubject: string | null;
}

/**
 * Thresholds are on the raw weighted sum from score.ts, which is not
 * normalised: a well-evidenced match (number + set + printed total + species +
 * language) lands around 1.2-1.5, and a bare number coincidence around 0.35.
 * The values below were fitted against the 5,153 stored PSA-10 payloads.
 */
/** A candidate has to clear this on its own merits to be accepted without a human. */
export const AUTO_SCORE = 0.95;
/** ...and has to beat the runner-up by this much, so two equally-supported cards go to review instead of a coin flip. */
export const AUTO_MARGIN = 0.1;
/** Below AUTO_SCORE but above this, the answer is accepted and flagged rather than queued. */
export const FLAG_SCORE = 0.45;

function pickVariant(evidence: ListingEvidence, variants: VariantRow[], indexes: CatalogueIndexes): { variantId: number | null; confidence: VariantConfidence } {
  if (variants.length === 0) return { variantId: null, confidence: 'none' };
  if (variants.length === 1) return { variantId: variants[0]!.variantId, confidence: 'proven' };

  let pool = variants;
  let filtered = false;
  const narrow = (predicate: (variant: VariantRow) => boolean): void => {
    const next = pool.filter(predicate);
    if (next.length && next.length < pool.length) { pool = next; filtered = true; }
  };

  if (evidence.finishHints.length) narrow((variant) => evidence.finishHints.includes(variant.finish ?? ''));
  if (evidence.printRunHints.length) narrow((variant) => evidence.printRunHints.includes(variant.printRunMarker ?? ''));
  if (evidence.microHints.length) narrow((variant) => evidence.microHints.includes(variant.microVariant ?? ''));
  if (evidence.stampHints.length) narrow((variant) => variant.stamps.some((stamp) => evidence.stampHints.includes(stamp)));

  if (filtered && pool.length === 1) return { variantId: pool[0]!.variantId, confidence: 'proven' };

  // PSA has graded a 10 of exactly one of this card's variants. A PSA-10
  // listing cannot be any of the others.
  const graded = pool.filter((variant) => (indexes.psa10PopByVariant.get(variant.variantId) ?? 0) > 0);
  if (graded.length === 1) return { variantId: graded[0]!.variantId, confidence: 'proven' };

  return { variantId: null, confidence: 'card-level' };
}

export interface DecideInput {
  evidence: ListingEvidence;
  ranked: ScoredCandidate[];
  /** Best set from the resolver, used only to tell a catalogue gap apart from a genuine matching failure. */
  topSet: { sourceSetId: string; setId: number; score: number } | null;
  /** Set codes printed on the card ("367/SM-P") that exist in no `sets` row at all. */
  unknownSetCodes: string[];
  indexes: CatalogueIndexes;
  loadVariants: (cardId: number) => VariantRow[];
}

export function decide({ evidence, ranked, topSet, unknownSetCodes, indexes, loadVariants }: DecideInput): MatchDecision {
  const base = {
    cardId: null, variantId: null, confidence: null, score: null, runnerUpScore: null,
    flagged: false, variantConfidence: 'none' as VariantConfidence, candidateCardIds: [], candidateVariantIds: [], gapSubject: null,
  };

  if (!evidence.inScope) {
    return { ...base, tier: 'out-of-scope', matchStatus: 'unmatched', method: 'ebay-out-of-scope', reason: evidence.outOfScopeReason };
  }
  if (evidence.isLot) {
    return { ...base, tier: 'lot', matchStatus: 'unmatched', method: 'ebay-lot-excluded', reason: 'Multi-card listing cannot map to one variant' };
  }
  // 81 of 555 sets (68 of them Japanese) have no `cards` rows: tcgdex set
  // records exist but their card details were never fetched. A listing that
  // confidently resolves to one of those is a hole in the catalogue, and
  // sending it to a human who also cannot pick a card from an empty set would
  // be busywork. It is reported as its own outcome so the fix -- run the
  // tcgdex details stage for that set -- is visible.
  if (topSet && topSet.score >= SET_CONFIDENT && indexes.emptySets.has(topSet.setId)) {
    return { ...base, tier: 'catalogue-gap', matchStatus: 'unmatched', method: 'ebay-catalogue-gap', gapSubject: topSet.sourceSetId, reason: `Set ${topSet.sourceSetId} has no cards in the catalogue yet` };
  }
  // The card prints its own set code in the number ("367/SM-P", "265/S-P",
  // "098/XY-P") and that code exists in no `sets` row. The Japanese promo sets
  // are the big absentees, and they are a large share of what a "pikachu psa
  // 10" sweep returns. Nobody can match these by hand either -- the fix is to
  // ingest the set -- so they are reported rather than queued.
  // The code is printed on the card itself, so a code with no set of that
  // language in the catalogue is decisive -- even when some *other*-language
  // set happens to carry the same code. `208/SM-P` is a Japanese promo, and
  // silently matching it to the English `smp` Black Star Promos would be a
  // confident wrong answer rather than an honest gap.
  if (unknownSetCodes.length) {
    return { ...base, tier: 'catalogue-gap', matchStatus: 'unmatched', method: 'ebay-catalogue-gap', gapSubject: unknownSetCodes[0]!, reason: `Set code ${unknownSetCodes[0]} is not in the catalogue` };
  }
  // Nothing in the listing says "Pokemon" and nothing in the catalogue
  // answers it either. A "psa 10" sweep drags in graded basketball and
  // football rookies, and asking a human which Pokemon card a Giannis
  // Antetokounmpo rookie is would be absurd.
  if (!evidence.pokemonHint && (!ranked.length || ranked[0]!.score < FLAG_SCORE)) {
    return { ...base, tier: 'out-of-scope', matchStatus: 'unmatched', method: 'ebay-out-of-scope', reason: 'Nothing in this listing identifies it as a Pokemon card' };
  }
  if (!ranked.length) {
    return { ...base, tier: 'review', matchStatus: 'unmatched', method: 'ebay-multi-signal', reason: 'No catalogue card matched any signal in this listing' };
  }

  const top = ranked[0]!;
  const runnerUp = ranked[1]?.score ?? 0;
  const margin = top.score - runnerUp;
  const candidateCardIds = ranked.slice(0, 10).map((candidate) => candidate.card.cardId);

  const variants = loadVariants(top.card.cardId);
  const picked = pickVariant(evidence, variants, indexes);
  const candidateVariantIds = variants.map((variant) => variant.variantId);

  const accepted = top.score >= AUTO_SCORE && margin >= AUTO_MARGIN;
  const flagged = !accepted && top.score >= FLAG_SCORE;

  if (!accepted && !flagged) {
    return {
      ...base, candidateCardIds, candidateVariantIds,
      tier: 'review', matchStatus: ranked.length > 1 ? 'ambiguous' : 'unmatched',
      method: 'ebay-multi-signal', score: top.score, runnerUpScore: runnerUp,
      reason: margin < AUTO_MARGIN && ranked.length > 1
        ? `Top two candidates are too close (${top.score.toFixed(2)} vs ${runnerUp.toFixed(2)})`
        : `Best candidate scored only ${top.score.toFixed(2)}`,
    };
  }

  return {
    cardId: top.card.cardId,
    variantId: picked.variantId,
    tier: flagged ? 'flagged' : picked.confidence === 'card-level' ? 'card-level' : 'strong',
    matchStatus: 'matched',
    method: 'ebay-multi-signal',
    confidence: Math.min(1, top.score),
    score: top.score,
    runnerUpScore: runnerUp,
    flagged,
    variantConfidence: picked.confidence,
    candidateCardIds,
    candidateVariantIds,
    gapSubject: null,
    reason: flagged ? `Accepted below the auto threshold (${top.score.toFixed(2)}) -- worth a glance` : null,
  };
}
