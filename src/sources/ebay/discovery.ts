import type { DatabaseSync } from 'node:sqlite';
import { enqueueWorkItem } from '../../core/queue/scheduler.ts';
import { DEFAULT_EBAY_ENDING_WITHIN_HOURS, DEFAULT_EBAY_MIN_BID_COUNT, type EbayMarketplaceKey } from './config.ts';
import { liveAuctionAsOfTag, searchPageScopeKey } from './scopeKeys.ts';

export interface SeedEbaySearchOptions {
  marketplace: EbayMarketplaceKey;
  query: string;
  limit: number;
  maxItems: number;
  campaignId?: string;
  refreshDetails?: boolean;
}

export function seedEbaySearch(db: DatabaseSync, opts: SeedEbaySearchOptions): void {
  enqueueWorkItem(db, {
    source: 'ebay',
    queue: 'ebay_search',
    entityType: 'search_page',
    scopeKey: searchPageScopeKey(opts.marketplace, opts.query, 0, opts.limit, opts.maxItems),
    params: { marketplace: opts.marketplace, query: opts.query, offset: 0, limit: opts.limit, maxItems: opts.maxItems,
      campaignId: opts.campaignId, refreshDetails: opts.refreshDetails },
  });
}

export interface SeedEbayLiveAuctionSearchOptions {
  marketplace: EbayMarketplaceKey;
  query: string;
  limit: number;
  minBidCount?: number;
  endingWithinHours?: number;
  /** Injectable for tests; defaults to the real current time. */
  now?: Date;
}

/**
 * Seeds one search_page work item scoped to live (AUCTION, sorted
 * soonest-ending-first) listings with at least `minBidCount` bids that end
 * within `endingWithinHours` -- see createEbaySearchCollector for how that
 * filtering and the early pagination cutoff actually happen.
 *
 * A single broad query (default: "pokemon psa 10", see DEFAULT_EBAY_QUERY)
 * covers every card, not a per-set loop: live-tested 2026-08-30 that
 * restricting to AUCTION-only already brings the DE total for that query
 * down to 1,222 -- comfortably under eBay's 10,000-result window, versus
 * 53,437 for the equivalent all-buying-options search that motivated
 * per-set partitioning in the first place. Relevance filtering (is this
 * actually a Pokemon card, which variant) happens downstream against our
 * own catalogue at materialize time (src/curated/ebay/), not by narrowing the
 * search query -- eBay's keyword search is loose either way, so a tighter
 * query buys nothing there and only risks losing recall.
 *
 * `endingBeforeAt` is computed once here (not per-attempt) so retries and
 * multi-page fetches of the same sweep share a stable cutoff instead of the
 * window silently drifting forward each retry.
 */
export function seedEbayLiveAuctionSearch(db: DatabaseSync, opts: SeedEbayLiveAuctionSearchOptions): void {
  const minBidCount = opts.minBidCount ?? DEFAULT_EBAY_MIN_BID_COUNT;
  const endingWithinHours = opts.endingWithinHours ?? DEFAULT_EBAY_ENDING_WITHIN_HOURS;
  const now = opts.now ?? new Date();
  const endingBeforeAt = new Date(now.getTime() + endingWithinHours * 60 * 60 * 1000).toISOString();

  enqueueWorkItem(db, {
    source: 'ebay',
    queue: 'ebay_search',
    entityType: 'search_page',
    scopeKey: searchPageScopeKey(opts.marketplace, opts.query, 0, opts.limit, 0, 'live_auctions', liveAuctionAsOfTag(endingBeforeAt)),
    params: {
      marketplace: opts.marketplace, query: opts.query, offset: 0, limit: opts.limit, maxItems: 0,
      mode: 'live_auctions', minBidCount, endingBeforeAt,
    },
  });
}
