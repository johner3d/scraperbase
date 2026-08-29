export function discoverySetScopeKey(psaSetId: string): string {
  return `discovery:set:${psaSetId}`;
}

export function cardIdentityScopeKey(psaCardId: string): string {
  return `cardidentity:${psaCardId}`;
}

export function populationScopeKey(cardFactsId: string): string {
  return `population:${cardFactsId}`;
}

export function cardFactsHtmlScopeKey(cardFactsId: string): string {
  return `cardfacts_html:${cardFactsId}`;
}

export function salesPageScopeKey(specId: string, grade: string, qualifier: string, page: number): string {
  return `sales:${specId}:grade=${grade}:qualifier=${qualifier}:page=${page}`;
}

/**
 * Aggregate sales snapshot key -- used when the raw per-page responses
 * weren't kept individually (e.g. a backfill of psa-fetch.ts's merged
 * output) and the observation covers a whole card's paginated sales pull
 * as one unit rather than one page at a time.
 */
export function salesSnapshotScopeKey(specId: string): string {
  return `sales:${specId}:snapshot`;
}
