import type { Collector } from '../../../core/queue/runner.ts';
import { classifyHttpStatus, fetchRaw } from '../../../core/http/fetchClient.ts';
import type { RateLimiter } from '../../../core/http/rateLimiter.ts';
import { getEbayAccessToken } from '../auth.ts';
import { EBAY_MARKETPLACES, EBAY_RAW_DIRS, EBAY_ITEM_URL, type EbayMarketplaceKey } from '../config.ts';
import { ebayQuotaState } from '../quota.ts';

export interface ItemDetailParams {
  marketplace: EbayMarketplaceKey;
  itemId: string;
}

export interface ItemDetailDeps {
  rateLimiter: RateLimiter;
}

/**
 * Fetches the full raw item-detail record for one eBay listing (description,
 * item specifics, seller, shipping/return policy, all image renditions,
 * etc.) -- the richest raw record per listing. Leaf node: no further fan-out.
 */
export function createEbayItemDetailCollector(deps: ItemDetailDeps): Collector {
  return async (db, item) => {
    const params = JSON.parse(item.params_json) as ItemDetailParams;
    const def = EBAY_MARKETPLACES[params.marketplace];
    const url = `${EBAY_ITEM_URL}/${encodeURIComponent(params.itemId)}`;
    const sourceIdentity = `ebay:${params.marketplace}`;

    const quota = ebayQuotaState(db);
    if (quota.paused) return {outcome:'rate_limited',final:'partial',sourceIdentity,
      retryAfterMs:Math.max(0,Date.parse(quota.resumeAfter)-Date.now()),
      errorMessage:`eBay daily safety budget reached; resume after ${quota.resumeAfter}`};

    await deps.rateLimiter();
    const token = await getEbayAccessToken();
    const res = await fetchRaw(url, {
      Authorization: `Bearer ${token}`,
      'X-EBAY-C-MARKETPLACE-ID': def.marketplaceId,
    });
    const httpClass = classifyHttpStatus(res.status);

    if (httpClass !== 'success') {
      return {
        outcome: res.status === 429 ? 'rate_limited' : 'failure',
        final: res.status === 429 ? 'partial' : httpClass === 'permanent' ? 'permanent_failed' : 'retryable_failed',
        sourceIdentity,
        httpStatus: res.status,
        requestMethod: 'GET',
        requestUrl: url,
        requestParams: params,
        responseHeaders: res.headers,
        byteSize: res.body.byteLength,
        durationMs: res.durationMs,
        errorMessage: `HTTP ${res.status} fetching item ${params.itemId}`,
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

    return {
      outcome: 'success',
      final: 'succeeded',
      sourceIdentity,
      httpStatus: res.status,
      requestMethod: 'GET',
      requestUrl: url,
      requestParams: params,
      responseHeaders: res.headers,
      durationMs: res.durationMs,
      object: {
        source: 'ebay',
        mediaKind: 'json',
        mediaType: 'application/json',
        ext: 'json',
        body: res.body,
        dirs: EBAY_RAW_DIRS,
      },
    };
  };
}
