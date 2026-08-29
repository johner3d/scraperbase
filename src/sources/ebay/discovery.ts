import type { DatabaseSync } from 'node:sqlite';
import { enqueueWorkItem } from '../../core/queue/scheduler.ts';
import type { EbayMarketplaceKey } from './config.ts';
import { searchPageScopeKey } from './scopeKeys.ts';

export interface SeedEbaySearchOptions {
  marketplace: EbayMarketplaceKey;
  query: string;
  limit: number;
  maxItems: number;
}

export function seedEbaySearch(db: DatabaseSync, opts: SeedEbaySearchOptions): void {
  enqueueWorkItem(db, {
    source: 'ebay',
    queue: 'ebay_search',
    entityType: 'search_page',
    scopeKey: searchPageScopeKey(opts.marketplace, opts.query, 0, opts.limit, opts.maxItems),
    params: { marketplace: opts.marketplace, query: opts.query, offset: 0, limit: opts.limit, maxItems: opts.maxItems },
  });
}
