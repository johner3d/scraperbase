import type { DatabaseSync } from 'node:sqlite';
import { buildEvidence, type EbayItemDetail, type ListingEvidence } from './evidence.ts';
import { buildIndexes, type CatalogueIndexes } from './lexicon.ts';
import { resolveSets, type SetCandidate } from './setResolver.ts';
import { generateCandidates } from './candidates.ts';
import { scoreAll, type ScoredCandidate } from './score.ts';
import { decide, type MatchDecision, type VariantRow } from './decide.ts';

export * from './evidence.ts';
export { buildIndexes, type CatalogueIndexes } from './lexicon.ts';
export { AUTO_SCORE, AUTO_MARGIN, FLAG_SCORE, type MatchTier, type MatchDecision } from './decide.ts';

/**
 * The one entry point `materialize.ts` calls per listing.
 *
 * Pipeline: evidence -> set -> candidate cards -> score -> decide. Each stage
 * hands the next a ranked list rather than a single answer, so an early
 * mistake costs weight instead of eliminating the truth.
 */

export interface EbayMatcher {
  indexes: CatalogueIndexes;
  match(item: EbayItemDetail): EbayMatchResult;
}

export interface EbayMatchResult {
  evidence: ListingEvidence;
  sets: SetCandidate[];
  ranked: ScoredCandidate[];
  decision: MatchDecision;
  /** Compact record of what was extracted and why the winner won, stored in `ebay_listings.signals_json`. */
  signals: Record<string, unknown>;
}

function variantLoader(db: DatabaseSync): (cardId: number) => VariantRow[] {
  const statement = db.prepare('SELECT variant_id, finish, print_run_marker, micro_variant, stamps_json FROM variants WHERE card_id = ?');
  const cache = new Map<number, VariantRow[]>();
  return (cardId) => {
    const cached = cache.get(cardId);
    if (cached) return cached;
    const rows = (statement.all(cardId) as unknown as Array<{ variant_id: number; finish: string | null; print_run_marker: string | null; micro_variant: string | null; stamps_json: string }>)
      .map((row) => ({
        variantId: row.variant_id,
        finish: row.finish,
        printRunMarker: row.print_run_marker,
        microVariant: row.micro_variant,
        stamps: JSON.parse(row.stamps_json || '[]') as string[],
      }));
    cache.set(cardId, rows);
    return rows;
  };
}

/**
 * Builds the catalogue indexes once and returns a matcher that reuses them.
 * Constructing these costs a few seconds and a few hundred MB of maps; doing
 * it per listing would make a full run take hours.
 */
export function createEbayMatcher(db: DatabaseSync, aliasFile?: string): EbayMatcher {
  const indexes = buildIndexes(db, aliasFile);
  const loadVariants = variantLoader(db);

  return {
    indexes,
    match(item: EbayItemDetail): EbayMatchResult {
      const evidence = buildEvidence(item, { knownPrefixes: indexes.numberPrefixes });
      const sets = evidence.inScope ? resolveSets(evidence, indexes) : [];
      const ranked = evidence.inScope && !evidence.isLot ? scoreAll(evidence, generateCandidates(evidence, sets, indexes), indexes) : [];
      const topSet = sets[0] ? { sourceSetId: sets[0].set.sourceSetId, setId: sets[0].set.setId, score: sets[0].score } : null;
      // A printed set code counts as known only if a set carrying it exists in
      // the listing's own language. "367/SM-P" is a Japanese promo; the
      // catalogue's `smp` is the *English* Black Star Promos, a different
      // release entirely, so matching it loosely would be wrong -- the honest
      // answer is that the Japanese set was never ingested.
      const unknownSetCodes = evidence.setCodeHints.filter((code) => {
        const key = code.toLowerCase();
        const found = [...(indexes.setsByCode.get(key) ?? []), ...(indexes.setsByLooseCode.get(key.replace(/[^a-z0-9]/g, '')) ?? [])];
        return !found.some((set) => !evidence.language || !evidence.languageSupported || set.language === evidence.language);
      });
      const decision = decide({ evidence, ranked, topSet, unknownSetCodes, indexes, loadVariants });
      return {
        evidence,
        sets,
        ranked,
        decision,
        signals: {
          numbers: evidence.numbers.slice(0, 6),
          setCodeHints: evidence.setCodeHints,
          unknownSetCodes,
          setTexts: evidence.setTexts,
          language: evidence.language,
          year: evidence.year,
          hp: evidence.hp,
          illustrator: evidence.illustrator,
          rarity: evidence.rarity,
          finishHints: evidence.finishHints,
          printRunHints: evidence.printRunHints,
          microHints: evidence.microHints,
          stampHints: evidence.stampHints,
          sets: sets.slice(0, 3).map((candidate) => ({ sourceSetId: candidate.set.sourceSetId, language: candidate.set.language, score: Number(candidate.score.toFixed(3)), reasons: candidate.reasons })),
          candidates: ranked.slice(0, 5).map((candidate) => ({
            cardId: candidate.card.cardId,
            label: `${candidate.set.sourceSetId}-${candidate.card.localId} ${candidate.card.name}`,
            score: Number(candidate.score.toFixed(3)),
            blockers: candidate.blockers,
            features: candidate.features,
          })),
          tier: decision.tier,
          gapSubject: decision.gapSubject,
          reason: decision.reason,
        },
      };
    },
  };
}
