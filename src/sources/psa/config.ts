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

/**
 * PSA's population-report tree groups every trading card game under one
 * umbrella category, "TCG Cards" -- confirmed live 2026-08-29. It is not
 * Pokemon-specific; discovery crawls it and filters headings by name. The
 * same categoryID is also a required (but not otherwise meaningful) param
 * on /Pop/GetSetItems for any heading within the tree.
 */
export const POP_ROOT_CATEGORY_ID = '156940';
export const POP_ROOT_URL = `${PSA_BASE}/pop/tcg-cards/${POP_ROOT_CATEGORY_ID}`;

export function popSetItemsEndpoint(): string {
  return `${PSA_BASE}/Pop/GetSetItems`;
}
