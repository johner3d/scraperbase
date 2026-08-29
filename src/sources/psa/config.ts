export const PSA_BASE = 'https://www.psacard.com';

/**
 * PSA's own fixed, generic CardFacts route: the specId alone determines
 * which card loads, regardless of the descriptive slug. PSA's generated
 * hrefs (e.g. from GetSetList rows) are sometimes malformed -- a missing
 * path segment -- and silently redirect to a landing page instead of
 * 404ing, so identity URLs are always rebuilt from this template rather
 * than trusted verbatim. Confirmed live against both well-formed and
 * malformed source hrefs (clean_rewrite, 2026-08-27).
 */
export function cardFactsUrl(psaSpecId: number | string): string {
  return `${PSA_BASE}/cardfacts/pokemon/base-set/card/${psaSpecId}`;
}
