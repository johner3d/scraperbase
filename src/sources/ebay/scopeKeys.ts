export type EbaySearchMode = 'all' | 'live_auctions';

// `mode` is part of the key (not just `query`) so the narrower
// --live-auctions sweep never collides on scope key with the general
// "capture everything" search, even given the exact same query text -- each
// is its own independent fetch/dedup lineage. The 'all' mode keeps its
// original "buying=all" key text verbatim (rather than switching to
// "mode=all") so already-succeeded searches from before this mode existed
// are still recognized as done, not silently re-fetched and burning quota.
export function searchPageScopeKey(
  marketplace: string,
  query: string,
  offset: number,
  limit: number,
  maxItems: number,
  mode: EbaySearchMode = 'all',
  // Day (YYYY-MM-DD) the search's time window was computed against --
  // required for 'live_auctions' mode (see liveAuctionAsOfTag). Without it,
  // a work item enqueued today would still read as "succeeded" (never
  // reclaimed) on a re-run tomorrow, silently reusing yesterday's now-stale
  // `endingBeforeAt` cutoff from the original params_json instead of doing
  // a fresh, correctly-windowed search.
  asOf?: string,
): string {
  const cap = maxItems === 0 ? 'all' : String(maxItems);
  const modeTag = mode === 'all' ? 'buying=all' : `mode=${mode}`;
  const asOfTag = asOf ? `:asof=${asOf}` : '';
  return `search:${marketplace}:${query}:${modeTag}:limit=${limit}:max=${cap}:offset=${offset}${asOfTag}`;
}

/** YYYY-MM-DD from an endingBeforeAt ISO timestamp, for searchPageScopeKey's asOf. */
export function liveAuctionAsOfTag(endingBeforeAt: string): string {
  return endingBeforeAt.slice(0, 10);
}

// Query-independent but marketplace-specific: a repeated hit within one
// marketplace is deduplicated, while potentially different marketplace views
// of the same listing are each retained as raw observations.
export function itemScopeKey(marketplace: string, itemId: string): string {
  return `item:${marketplace}:${itemId}`;
}
