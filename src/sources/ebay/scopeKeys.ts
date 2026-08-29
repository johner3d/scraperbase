export function searchPageScopeKey(marketplace: string, query: string, offset: number): string {
  return `search:${marketplace}:${query}:offset=${offset}`;
}

// Deliberately marketplace/query-independent: the same eBay item found by
// two different searches (or the same search on two marketplaces) is only
// ever detail-fetched once.
export function itemScopeKey(itemId: string): string {
  return `item:${itemId}`;
}
