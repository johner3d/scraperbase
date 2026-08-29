export function searchPageScopeKey(
  marketplace: string,
  query: string,
  offset: number,
  limit: number,
  maxItems: number,
): string {
  const cap = maxItems === 0 ? 'all' : String(maxItems);
  return `search:${marketplace}:${query}:limit=${limit}:max=${cap}:offset=${offset}`;
}

// Query-independent but marketplace-specific: a repeated hit within one
// marketplace is deduplicated, while potentially different marketplace views
// of the same listing are each retained as raw observations.
export function itemScopeKey(marketplace: string, itemId: string): string {
  return `item:${marketplace}:${itemId}`;
}
