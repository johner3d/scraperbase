import type { Collector, CollectorOutcome } from '../../../core/queue/runner.ts';
import { workItemId, type EnqueueSpec } from '../../../core/queue/workItem.ts';
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
import { itemScopeKey, liveAuctionAsOfTag, searchPageScopeKey, type EbaySearchMode } from '../scopeKeys.ts';
import { ebayQuotaState, nextEbayReset } from '../quota.ts';

export interface SearchParams {
  marketplace: EbayMarketplaceKey;
  query: string;
  offset: number;
  limit: number;
  maxItems: number;
  /**
   * 'all' (default): the original raw-first "capture everything" search --
   * every buying option, no bid/end-date filtering.
   * 'live_auctions': --live-auctions sweep -- server-side filtered to
   * AUCTION listings only, sorted soonest-ending-first, and further
   * narrowed client-side (see createEbaySearchCollector) to items with at
   * least `minBidCount` bids whose end date falls before `endingBeforeAt`.
   * Pagination stops as soon as a page's items run past that cutoff, since
   * "soonest ending first" means every later item/page would too.
   */
  mode?: EbaySearchMode;
  minBidCount?: number;
  endingBeforeAt?: string;
  /** Professional-pipeline provenance. It never participates in matching. */
  campaignId?: string;
  priceMin?: number;
  priceMax?: number;
  refreshDetails?: boolean | number;
}

export interface SearchDeps {
  rateLimiter: RateLimiter;
}

export interface ItemSummaryBrief {
  itemId: string;
  bidCount?: number;
  itemEndDate?: string;
}

interface SearchResponseBody {
  total?: number;
  next?: string;
  itemSummaries?: ItemSummaryBrief[];
}

export interface LiveAuctionSelection {
  /** itemIds that qualify for an item-detail fetch, in page order. */
  itemIds: string[];
  /**
   * True once this page's soonest-ending-first order crossed
   * `endingBeforeAt` -- signals the caller to stop paginating, since every
   * later item (this page's remainder and every subsequent page) would be
   * past the cutoff too.
   */
  pastCutoff: boolean;
}

/**
 * Pure filtering for --live-auctions mode: keep only items with at least
 * `minBidCount` bids whose end date is before `endingBeforeAt`, using only
 * the bidCount/itemEndDate fields eBay's search response already includes
 * for free (no item-detail call needed to make this decision). Assumes the
 * caller requested `sort=endingSoonest`, so the first out-of-window item
 * ends the scan for the whole page.
 */
export function selectLiveAuctionItems(
  summaries: ItemSummaryBrief[],
  opts: { minBidCount: number; endingBeforeAt?: string },
): LiveAuctionSelection {
  const itemIds: string[] = [];
  for (const summary of summaries) {
    if (typeof summary.itemId !== 'string' || summary.itemId.length === 0) continue;
    if (opts.endingBeforeAt && summary.itemEndDate && summary.itemEndDate >= opts.endingBeforeAt) {
      return { itemIds, pastCutoff: true };
    }
    if ((summary.bidCount ?? 0) < opts.minBidCount) continue;
    itemIds.push(summary.itemId);
  }
  return { itemIds, pastCutoff: false };
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
  const liveAuctions = params.mode === 'live_auctions';
  const filters = [`buyingOptions:{${liveAuctions ? 'AUCTION' : EBAY_ALL_BUYING_OPTIONS.join('|')}}`];
  if (def.itemLocationCountries?.length) filters.push(`itemLocationCountry:{${def.itemLocationCountries.join('|')}}`);
  if (params.priceMin != null || params.priceMax != null) {
    filters.push(`price:[${(params.priceMin ?? 0).toFixed(2)}..${params.priceMax == null ? '' : params.priceMax.toFixed(2)}]`);
    filters.push(`priceCurrency:${def.currency}`);
  }
  qs.set('filter', filters.join(','));
  if (liveAuctions) qs.set('sort', 'endingSoonest');
  return `${EBAY_SEARCH_URL}?${qs.toString()}`;
}

/**
 * Fetches one page of eBay Browse API search results, stores the entire raw
 * response verbatim, fans out one item-detail work item per item found, and
 * (while under the configured cap) enqueues the next page.
 */
export function createEbaySearchCollector(deps: SearchDeps): Collector {
  return async (db, item) => {
    const params = JSON.parse(item.params_json) as SearchParams;
    const def = EBAY_MARKETPLACES[params.marketplace];
    const url = buildSearchUrl(params);
    const sourceIdentity = `ebay:${params.marketplace}`;

    const quota = ebayQuotaState(db);
    if (quota.paused) {
      if (params.campaignId) db.prepare(`UPDATE ebay_campaigns SET status='incomplete',coverage_status='quota_paused',
        resume_after=?,pause_reason=? WHERE campaign_id=?`).run(quota.resumeAfter,
          `Daily safety budget reached (${quota.used}/${quota.limit}; allowance ${quota.allowance})`,params.campaignId);
      return {outcome:'rate_limited',final:'partial',sourceIdentity,retryAfterMs:Math.max(0,Date.parse(quota.resumeAfter)-Date.now()),
        errorMessage:`eBay daily safety budget reached; resume after ${quota.resumeAfter}`};
    }

    await deps.rateLimiter();
    const token = await getEbayAccessToken();
    const res = await fetchRaw(url, {
      Authorization: `Bearer ${token}`,
      'X-EBAY-C-MARKETPLACE-ID': def.marketplaceId,
    });
    const httpClass = classifyHttpStatus(res.status);

    if (httpClass !== 'success') {
      if (params.campaignId) {
        const coverage = res.status === 429 ? 'quota_paused' : 'failed';
        db.prepare(`UPDATE ebay_campaigns SET status=?,coverage_status=?,resume_after=?,pause_reason=? WHERE campaign_id=?`)
          .run(res.status === 429 ? 'incomplete' : 'failed', coverage,
            res.status===429?nextEbayReset().toISOString():null,res.status===429?'eBay returned HTTP 429':null,params.campaignId);
      }
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

    const liveAuctions = params.mode === 'live_auctions';
    const selection = liveAuctions
      ? selectLiveAuctionItems(parsed.itemSummaries ?? [], { minBidCount: params.minBidCount ?? 0, endingBeforeAt: params.endingBeforeAt })
      : { itemIds: (parsed.itemSummaries ?? []).map((s) => s.itemId).filter((id): id is string => typeof id === 'string' && id.length > 0), pastCutoff: false };
    const pastCutoff = selection.pastCutoff;

    if (params.campaignId) {
      const now = new Date().toISOString();
      db.prepare(`UPDATE ebay_campaigns SET status='running',total_reported=MAX(COALESCE(total_reported,0),COALESCE(?,0)) WHERE campaign_id=?`)
        .run(parsed.total ?? null, params.campaignId);
      const membership = db.prepare(`INSERT INTO ebay_campaign_items
        (campaign_id,marketplace,item_id,first_seen_at,last_seen_at) VALUES(?,?,?,?,?)
        ON CONFLICT(campaign_id,marketplace,item_id) DO UPDATE SET last_seen_at=excluded.last_seen_at`);
      for (const itemId of selection.itemIds) membership.run(params.campaignId, params.marketplace, itemId, now, now);
    }

    // A live sweep is a snapshot refresh, not discovery-only. Re-arm detail
    // work that succeeded in an older sweep so bids/end state can change and
    // produce another append-only price observation. New IDs are still
    // inserted normally by enqueueNext below.
    if (liveAuctions || (params.campaignId && params.refreshDetails!==false && params.refreshDetails!==0)) {
      const now = new Date().toISOString();
      const reset = db.prepare(`UPDATE work_items SET state='pending',attempts=0,available_at=?,last_error=NULL,
        lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE work_item_id=? AND state='succeeded'`);
      for (const itemId of selection.itemIds) reset.run(now, now, workItemId('ebay','ebay_item_detail',itemScopeKey(params.marketplace,itemId)));
    }

    const enqueueNext: EnqueueSpec[] = selection.itemIds.map((itemId) => ({
      source: 'ebay',
      queue: 'ebay_item_detail',
      entityType: 'item',
      scopeKey: itemScopeKey(params.marketplace, itemId),
      params: { marketplace: params.marketplace, itemId },
    }));

    const apiNextOffset = nextOffset(parsed);
    const total = parsed.total ?? 0;
    const apiWindowIncomplete = params.maxItems === 0 && total > 10_000 && params.offset === 0;
    const underConfiguredCap = params.maxItems === 0 || (apiNextOffset !== undefined && apiNextOffset < params.maxItems);
    if (apiNextOffset !== undefined && underConfiguredCap && !pastCutoff && !apiWindowIncomplete) {
      enqueueNext.push({
        source: 'ebay',
        queue: 'ebay_search',
        entityType: 'search_page',
        scopeKey: searchPageScopeKey(
          params.marketplace, params.query, apiNextOffset, params.limit, params.maxItems, params.mode,
          params.endingBeforeAt ? liveAuctionAsOfTag(params.endingBeforeAt) : undefined,
          params.priceMin, params.priceMax,
        ),
        params: { ...params, offset: apiNextOffset },
      });
    }

    if (apiWindowIncomplete) {
      if (params.campaignId && params.mode !== 'live_auctions') {
        for (const partition of splitPricePartition(params)) {
          enqueueNext.push({
            source: 'ebay', queue: 'ebay_search', entityType: 'search_page',
            scopeKey: searchPageScopeKey(params.marketplace,params.query,0,params.limit,params.maxItems,params.mode,
              undefined,partition.priceMin,partition.priceMax),
            params: { ...params, offset: 0, ...partition },
          });
        }
        db.prepare(`UPDATE ebay_campaigns SET status='running',coverage_status='unknown' WHERE campaign_id=?`).run(params.campaignId);
        return { ...base, final: 'succeeded', enqueueNext } satisfies CollectorOutcome;
      }
      return {
        ...base,
        outcome: 'schema_drift',
        final: 'permanent_failed',
        errorMessage: `Search reports ${total} matches, above eBay's 10,000-item result window; partitioning is required for a complete import`,
        enqueueNext,
      } satisfies CollectorOutcome;
    }

    if (params.campaignId && (apiNextOffset === undefined || !underConfiguredCap || pastCutoff)) {
      db.prepare(`UPDATE ebay_campaigns SET status='complete',coverage_status='complete',completed_at=? WHERE campaign_id=?`)
        .run(new Date().toISOString(), params.campaignId);
    }

    return { ...base, final: 'succeeded', enqueueNext } satisfies CollectorOutcome;
  };
}

/** Deterministic recursive price partitioning for eBay's 10,000-result window. */
export function splitPricePartition(params: Pick<SearchParams,'priceMin'|'priceMax'>): Array<{priceMin:number;priceMax?:number}> {
  const min = params.priceMin ?? 0;
  const max = params.priceMax;
  if (max == null && min === 0) {
    const boundaries = [25,50,100,250,500,1000,2500,5000];
    const result: Array<{priceMin:number;priceMax?:number}> = [];
    let start = 0;
    for (const end of boundaries) { result.push({ priceMin: start, priceMax: end }); start = end + 0.01; }
    result.push({ priceMin: start });
    return result;
  }
  const split = max == null ? Math.max(min * 2, min + 5000) : Number(((min + max) / 2).toFixed(2));
  if (max != null && split <= min) throw new Error(`Cannot further partition price interval ${min}..${max}`);
  return [{ priceMin: min, priceMax: split }, { priceMin: split + 0.01, ...(max == null ? {} : { priceMax: max }) }];
}
