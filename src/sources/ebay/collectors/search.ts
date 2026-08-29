import type { Collector, CollectorOutcome } from '../../../core/queue/runner.ts';
import type { EnqueueSpec } from '../../../core/queue/workItem.ts';
import { classifyHttpStatus, fetchRaw } from '../../../core/http/fetchClient.ts';
import type { RateLimiter } from '../../../core/http/rateLimiter.ts';
import { getEbayAccessToken } from '../auth.ts';
import {
  EBAY_ALL_BUYING_OPTIONS,
  EBAY_MARKETPLACES,
  EBAY_RAW_DIRS,
  EBAY_SEARCH_URL,
  type EbayMarketplaceKey,
} from '../config.ts';
import { itemScopeKey, searchPageScopeKey } from '../scopeKeys.ts';

export interface SearchParams {
  marketplace: EbayMarketplaceKey;
  query: string;
  offset: number;
  limit: number;
  maxItems: number;
}

export interface SearchDeps {
  rateLimiter: RateLimiter;
}

interface ItemSummaryBrief {
  itemId: string;
}

interface SearchResponseBody {
  total?: number;
  next?: string;
  itemSummaries?: ItemSummaryBrief[];
}

export function requestLimit(params: SearchParams): number {
  return params.maxItems === 0 ? params.limit : Math.min(params.limit, params.maxItems);
}

export function nextOffset(response: SearchResponseBody): number | undefined {
  if (!response.next) return undefined;
  try {
    const value = Number(new URL(response.next).searchParams.get('offset'));
    return Number.isInteger(value) && value >= 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

export function buildSearchUrl(params: SearchParams): string {
  const def = EBAY_MARKETPLACES[params.marketplace];
  const qs = new URLSearchParams({
    q: params.query,
    limit: String(requestLimit(params)),
    offset: String(params.offset),
  });
  const filters = [`buyingOptions:{${EBAY_ALL_BUYING_OPTIONS.join('|')}}`];
  if (def.itemLocationCountries?.length) filters.push(`itemLocationCountry:{${def.itemLocationCountries.join('|')}}`);
  qs.set('filter', filters.join(','));
  return `${EBAY_SEARCH_URL}?${qs.toString()}`;
}

/**
 * Fetches one page of eBay Browse API search results, stores the entire raw
 * response verbatim, fans out one item-detail work item per item found, and
 * (while under the configured cap) enqueues the next page.
 */
export function createEbaySearchCollector(deps: SearchDeps): Collector {
  return async (_db, item) => {
    const params = JSON.parse(item.params_json) as SearchParams;
    const def = EBAY_MARKETPLACES[params.marketplace];
    const url = buildSearchUrl(params);
    const sourceIdentity = `ebay:${params.marketplace}`;

    await deps.rateLimiter();
    const token = await getEbayAccessToken();
    const res = await fetchRaw(url, {
      Authorization: `Bearer ${token}`,
      'X-EBAY-C-MARKETPLACE-ID': def.marketplaceId,
    });
    const httpClass = classifyHttpStatus(res.status);

    if (httpClass !== 'success') {
      return {
        outcome: 'failure',
        final: httpClass === 'permanent' ? 'permanent_failed' : 'retryable_failed',
        sourceIdentity,
        httpStatus: res.status,
        requestMethod: 'GET',
        requestUrl: url,
        requestParams: params,
        responseHeaders: res.headers,
        byteSize: res.body.byteLength,
        durationMs: res.durationMs,
        errorMessage: `HTTP ${res.status} fetching search page (offset=${params.offset})`,
        object: res.body.byteLength > 0 ? {
          source: 'ebay',
          mediaKind: 'json' as const,
          mediaType: res.headers['content-type'] ?? 'application/json',
          ext: 'json',
          body: res.body,
          dirs: EBAY_RAW_DIRS,
        } : undefined,
      };
    }

    const base = {
      outcome: 'success' as const,
      sourceIdentity,
      httpStatus: res.status,
      requestMethod: 'GET',
      requestUrl: url,
      requestParams: params,
      responseHeaders: res.headers,
      durationMs: res.durationMs,
      object: {
        source: 'ebay',
        mediaKind: 'json' as const,
        mediaType: 'application/json',
        ext: 'json',
        body: res.body,
        dirs: EBAY_RAW_DIRS,
      },
    };

    let parsed: SearchResponseBody;
    try {
      parsed = JSON.parse(res.body.toString('utf8')) as SearchResponseBody;
    } catch (err) {
      return {
        ...base,
        outcome: 'schema_drift',
        final: 'permanent_failed',
        errorMessage: `Failed to parse search response JSON (offset=${params.offset}): ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const enqueueNext: EnqueueSpec[] = [];
    for (const summary of parsed.itemSummaries ?? []) {
      if (typeof summary.itemId !== 'string' || summary.itemId.length === 0) continue;
      enqueueNext.push({
        source: 'ebay',
        queue: 'ebay_item_detail',
        entityType: 'item',
        scopeKey: itemScopeKey(params.marketplace, summary.itemId),
        params: { marketplace: params.marketplace, itemId: summary.itemId },
      });
    }

    const apiNextOffset = nextOffset(parsed);
    const total = parsed.total ?? 0;
    const underConfiguredCap = params.maxItems === 0 || (apiNextOffset !== undefined && apiNextOffset < params.maxItems);
    if (apiNextOffset !== undefined && underConfiguredCap) {
      enqueueNext.push({
        source: 'ebay',
        queue: 'ebay_search',
        entityType: 'search_page',
        scopeKey: searchPageScopeKey(params.marketplace, params.query, apiNextOffset, params.limit, params.maxItems),
        params: { ...params, offset: apiNextOffset },
      });
    }

    const apiWindowIncomplete = params.maxItems === 0 && total > 10_000 && params.offset === 0;
    if (apiWindowIncomplete) {
      return {
        ...base,
        outcome: 'schema_drift',
        final: 'permanent_failed',
        errorMessage: `Search reports ${total} matches, above eBay's 10,000-item result window; partitioning is required for a complete import`,
        enqueueNext,
      } satisfies CollectorOutcome;
    }

    return { ...base, final: 'succeeded', enqueueNext } satisfies CollectorOutcome;
  };
}
