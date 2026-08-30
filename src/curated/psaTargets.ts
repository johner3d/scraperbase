import type { DatabaseSync } from 'node:sqlite';
import type { Selection } from '../sources/psa/rawFetch.ts';
import { cardFactsUrl, PSA_BASE } from '../sources/psa/config.ts';

/**
 * PSA fetch targets derived from the eBay match table.
 *
 * The bulk fetcher (src/scripts/psa-fetch.ts --from-db) enumerates every
 * population spec in the catalogue and is filtered only by release year, which
 * is both slow and pointed at the wrong cards -- the listings we actually
 * price are modern as often as vintage. This selects the opposite slice: the
 * card variants that currently have matched eBay listings attached, one entry
 * per PSA spec no matter how many auctions point at it.
 *
 * A matched variant is only fetchable if it already has a `psa_specs`
 * population row, because the PSA spec ID is what every PSA endpoint is keyed
 * by. Variants without one are not silently dropped -- they come back in
 * `unresolved`, grouped by set, because the fix for them is a different
 * pipeline (`run --source psa --stage index|details`, which crawls PSA's own
 * pop-report tree and mints the spec IDs).
 */

export interface MatchedTargetOptions {
  /** Restrict tiers. Undefined applies the production precision-first policy. */
  tiers?: readonly string[];
  /** Drop listings the matcher accepted but flagged for a human glance. */
  excludeFlagged?: boolean;
  /** The /auctions dashboard slice: trusted tiers, PSA 10, single cards. */
  liveAuctionsOnly?: boolean;
  /** Cap applied to the deduplicated, ordered spec list. */
  limit?: number | null;
}

export interface UnresolvedSet {
  sourceSetId: string;
  releaseDate: string | null;
  variants: number;
}

export interface MatchedTargets {
  /** One entry per PSA spec, ordered by release date then card. */
  selections: Selection[];
  /** Matched eBay listings behind those specs. */
  listingCount: number;
  /** Distinct variants behind those specs. */
  variantCount: number;
  /** Specs before `limit` was applied. */
  totalSpecs: number;
  /** Matched variants with no PSA spec to fetch, grouped by set. */
  unresolved: UnresolvedSet[];
  /** Total variants across `unresolved`. */
  unresolvedVariants: number;
}

interface SpecRow {
  release: string;
  sourceCardId: string;
  finish: string;
  printRunMarker: string;
  microVariant: string | null;
  specId: string;
  listings: number;
  variantId: number;
}

/**
 * Shared by both halves of the query so the fetchable set and the unresolved
 * set are always complements of one another rather than two drifting filters.
 */
function listingClauses(options: MatchedTargetOptions): { sql: string; params: string[] } {
  const clauses = [`e.variant_id IS NOT NULL`, `e.match_status IN ('matched', 'manual')`];
  const params: string[] = [];
  const tiers = options.liveAuctionsOnly ? ['exact', 'strong'] : (options.tiers ?? ['exact', 'strong']);
  if (tiers && tiers.length > 0) {
    clauses.push(`e.match_tier IN (${tiers.map(() => '?').join(', ')})`);
    params.push(...tiers);
  }
  // Flagged and cluster-propagated matches are never production targets.
  clauses.push(`e.flagged = 0`, `(e.match_method IS NULL OR e.match_method <> 'ebay-cluster-propagate')`);
  if (options.liveAuctionsOnly) clauses.push(`e.is_lot = 0`, `e.grade_value = 10`);
  return { sql: clauses.join(' AND '), params };
}

export function selectEbayMatchedTargets(db: DatabaseSync, options: MatchedTargetOptions = {}): MatchedTargets {
  const { sql: where, params } = listingClauses(options);

  // GROUP BY ps.spec_id is the deduplication: 2,746 matched listings collapse
  // to one fetch per spec. COUNT(DISTINCT ...) reports what is behind them.
  //
  // nextFutureEnd picks out specs still backed by a live auction (item_end_date
  // in the future) and, among those, the one ending soonest. The ORDER BY puts
  // every such spec ahead of specs whose matched listings have all already
  // ended -- PSA facts are only useful to a listing while it is still sellable,
  // so a fetch budget must drain toward what's about to close, never toward
  // auctions that are already history.
  const rows = db.prepare(`
    SELECT s.source_set_id AS release, s.source_set_id || '-' || c.local_id AS sourceCardId,
      COALESCE(v.finish, 'unknown') AS finish,
      COALESCE(v.print_run_marker, 'unknown') AS printRunMarker,
      v.micro_variant AS microVariant, ps.spec_id AS specId,
      v.variant_id AS variantId,
      COUNT(DISTINCT e.ebay_listing_id) AS listings,
      MIN(CASE WHEN lp.item_end_date > datetime('now') THEN lp.item_end_date END) AS nextFutureEnd
    FROM ebay_listings e
    JOIN psa_specs ps ON ps.variant_id = e.variant_id AND ps.namespace = 'population'
    JOIN variants v ON v.variant_id = ps.variant_id
    JOIN cards c ON c.card_id = v.card_id
    JOIN sets s ON s.set_id = c.set_id
    LEFT JOIN v_ebay_listing_latest_price lp ON lp.ebay_listing_id = e.ebay_listing_id
    WHERE ${where}
    GROUP BY ps.spec_id
    ORDER BY (nextFutureEnd IS NULL) ASC, nextFutureEnd ASC, s.release_date, s.source_set_id, c.local_sort_key, ps.spec_id
  `).all(...params) as unknown as SpecRow[];

  const unresolvedRows = db.prepare(`
    SELECT s.source_set_id AS sourceSetId, s.release_date AS releaseDate,
      COUNT(DISTINCT e.variant_id) AS variants
    FROM ebay_listings e
    JOIN variants v ON v.variant_id = e.variant_id
    JOIN cards c ON c.card_id = v.card_id
    JOIN sets s ON s.set_id = c.set_id
    WHERE ${where}
      AND NOT EXISTS (
        SELECT 1 FROM psa_specs ps WHERE ps.variant_id = e.variant_id AND ps.namespace = 'population'
      )
    GROUP BY s.source_set_id
    ORDER BY variants DESC, s.source_set_id
  `).all(...params) as unknown as UnresolvedSet[];

  const limited = options.limit == null ? rows : rows.slice(0, options.limit);
  const selections: Selection[] = limited.map((row) => {
    const specId = Number(row.specId);
    return {
      release: row.release,
      sourceCardId: row.sourceCardId,
      finish: row.finish,
      printRunMarker: row.printRunMarker,
      microVariant: row.microVariant ?? undefined,
      psaSpecId: specId,
      // The two URLs are not interchangeable. Population scrapes the price
      // guide and condition-census tables, which only the CardFacts page
      // carries -- confirmed live 2026-08-30, a /spec/psa/ fetch returns HTML
      // with neither table and saves empty priceRows/censusRows. Sales uses
      // its URL only to establish the session the tRPC API requires, and that
      // API 401s unless the page navigated to /spec/psa/ (docs/psa-raw-fetch.md).
      popSourceUrl: cardFactsUrl(specId),
      salesSpecId: specId,
      salesSourceUrl: `${PSA_BASE}/spec/psa/${specId}`,
    };
  });

  // Counted over the entries actually being fetched, so --limit reports the
  // coverage of this run rather than of the unlimited target list. Counted by
  // a separate DISTINCT query rather than by summing the per-spec counts: one
  // variant can carry more than one population spec, and a listing behind it
  // must not be counted once per spec.
  const variantIds = [...new Set(limited.map((row) => row.variantId))];
  const variantCount = variantIds.length;
  const listingCount = variantIds.length === 0 ? 0 : Number((db.prepare(`
    SELECT COUNT(DISTINCT e.ebay_listing_id) AS n FROM ebay_listings e
    WHERE ${where} AND e.variant_id IN (${variantIds.map(() => '?').join(', ')})
  `).get(...params, ...variantIds) as { n: number }).n);

  return {
    selections,
    listingCount,
    variantCount,
    totalSpecs: rows.length,
    unresolved: unresolvedRows.map((row) => ({ ...row, variants: Number(row.variants) })),
    unresolvedVariants: unresolvedRows.reduce((sum, row) => sum + Number(row.variants), 0),
  };
}
