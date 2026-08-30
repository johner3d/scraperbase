import type { DatabaseSync } from 'node:sqlite';
import { normalizePart } from '../curated/materialize.ts';
import { EBAY_MARKETPLACES, EBAY_ITEM_URL, type EbayMarketplaceKey } from '../sources/ebay/config.ts';
import { buildSearchUrl, selectLiveAuctionItems, type SearchParams } from '../sources/ebay/collectors/search.ts';
import { getEbayAccessToken } from '../sources/ebay/auth.ts';
import { fetchRaw } from '../core/http/fetchClient.ts';
import { enqueueWorkItem } from '../core/queue/scheduler.ts';
import { liveAuctionAsOfTag, searchPageScopeKey } from '../sources/ebay/scopeKeys.ts';
import { randomUUID } from 'node:crypto';

export type BuyingOption = 'auction' | 'fixed' | 'all';

export interface SearchTermRow {
  search_term_id: number;
  query_text: string;
  normalized_query: string;
  marketplace: EbayMarketplaceKey;
  buying_option: BuyingOption;
  min_bids: number;
  ending_within_hours: number | null;
  price_min: number | null;
  price_max: number | null;
  category_ids: string | null;
  refresh_interval_minutes: number;
  max_items: number;
  daily_call_budget: number | null;
  priority: number;
  enabled: 0 | 1;
  last_enqueued_at: string | null;
  last_completed_at: string | null;
  last_result_count: number | null;
  created_at: string;
  updated_at: string;
}

export interface SearchTermInput {
  query: string;
  marketplace: string;
  buyingOption?: BuyingOption;
  minBids?: number;
  endingWithinHours?: number | null;
  priceMin?: number | null;
  priceMax?: number | null;
  categoryIds?: string | null;
  refreshIntervalMinutes?: number;
  maxItems?: number;
  dailyCallBudget?: number | null;
  priority?: number;
  enabled?: boolean;
}

const MARKETPLACE_KEYS = Object.keys(EBAY_MARKETPLACES) as EbayMarketplaceKey[];

export function assertMarketplace(value: string): EbayMarketplaceKey {
  if (!MARKETPLACE_KEYS.includes(value as EbayMarketplaceKey)) {
    throw new Error(`Unknown marketplace "${value}". Known: ${MARKETPLACE_KEYS.join(', ')}`);
  }
  return value as EbayMarketplaceKey;
}

/** "20m" / "2h" / "1d" / "90" (bare = minutes) -> minutes. */
export function parseDurationMinutes(value: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*(m|min|h|hr|d|day)?s?$/i.exec(value.trim());
  if (!match) throw new Error(`Cannot parse duration "${value}" (try 20m, 2h, 1d)`);
  const n = Number(match[1]);
  const unit = (match[2] ?? 'm').toLowerCase();
  const factor = unit.startsWith('d') ? 1440 : unit.startsWith('h') ? 60 : 1;
  return Math.max(1, Math.round(n * factor));
}

/** "72h" / "3d" / "none" -> hours or null. */
export function parseEndingWithinHours(value: string): number | null {
  if (/^(none|off|0)$/i.test(value.trim())) return null;
  return Math.max(1, Math.round(parseDurationMinutes(value) / 60));
}

function rowByIdOrQuery(db: DatabaseSync, idOrQuery: string): SearchTermRow | undefined {
  if (/^\d+$/.test(idOrQuery)) {
    return db.prepare(`SELECT * FROM ebay_search_terms WHERE search_term_id=?`).get(Number(idOrQuery)) as
      SearchTermRow | undefined;
  }
  return db.prepare(`SELECT * FROM ebay_search_terms WHERE normalized_query=? ORDER BY search_term_id LIMIT 1`)
    .get(normalizePart(idOrQuery)) as SearchTermRow | undefined;
}

export function getSearchTerm(db: DatabaseSync, idOrQuery: string): SearchTermRow {
  const row = rowByIdOrQuery(db, idOrQuery);
  if (!row) throw new Error(`No search term matches "${idOrQuery}"`);
  return row;
}

export function listSearchTerms(db: DatabaseSync): SearchTermRow[] {
  return db.prepare(`SELECT * FROM ebay_search_terms ORDER BY enabled DESC, priority DESC, search_term_id`)
    .all() as unknown as SearchTermRow[];
}

export function addSearchTerm(db: DatabaseSync, input: SearchTermInput): SearchTermRow {
  const query = input.query.trim();
  if (!query) throw new Error('--query is required and must not be blank');
  const marketplace = assertMarketplace(input.marketplace);
  const buyingOption = input.buyingOption ?? 'auction';
  const now = new Date().toISOString();
  const existing = db.prepare(
    `SELECT search_term_id FROM ebay_search_terms WHERE normalized_query=? AND marketplace=? AND buying_option=?`,
  ).get(normalizePart(query), marketplace, buyingOption) as { search_term_id: number } | undefined;
  if (existing) {
    throw new Error(`A ${buyingOption} search for "${query}" on ${marketplace} already exists (id ${existing.search_term_id}). Use \`pipeline terms set\`.`);
  }
  const inserted = db.prepare(
    `INSERT INTO ebay_search_terms
       (query_text,normalized_query,marketplace,buying_option,min_bids,ending_within_hours,price_min,price_max,
        category_ids,refresh_interval_minutes,max_items,daily_call_budget,priority,enabled,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING search_term_id`,
  ).get(
    query, normalizePart(query), marketplace, buyingOption,
    input.minBids ?? (buyingOption === 'auction' ? 1 : 0),
    input.endingWithinHours === undefined ? (buyingOption === 'auction' ? 72 : null) : input.endingWithinHours,
    input.priceMin ?? null, input.priceMax ?? null, input.categoryIds ?? null,
    input.refreshIntervalMinutes ?? 30, input.maxItems ?? 500, input.dailyCallBudget ?? null,
    input.priority ?? 0, input.enabled === false ? 0 : 1, now, now,
  ) as { search_term_id: number };
  return getSearchTerm(db, String(inserted.search_term_id));
}

const SETTABLE: Record<string, string> = {
  minBids: 'min_bids',
  endingWithinHours: 'ending_within_hours',
  priceMin: 'price_min',
  priceMax: 'price_max',
  categoryIds: 'category_ids',
  refreshIntervalMinutes: 'refresh_interval_minutes',
  maxItems: 'max_items',
  dailyCallBudget: 'daily_call_budget',
  priority: 'priority',
};

export function updateSearchTerm(db: DatabaseSync, idOrQuery: string, patch: Partial<SearchTermInput>): SearchTermRow {
  const row = getSearchTerm(db, idOrQuery);
  const sets: string[] = [];
  const params: Array<string | number | null> = [];
  for (const [key, column] of Object.entries(SETTABLE)) {
    if (!(key in patch)) continue;
    sets.push(`${column}=?`);
    params.push((patch as Record<string, string | number | null | undefined>)[key] ?? null);
  }
  if (patch.buyingOption !== undefined) { sets.push('buying_option=?'); params.push(patch.buyingOption); }
  if (!sets.length) return row;
  sets.push('updated_at=?');
  params.push(new Date().toISOString(), row.search_term_id);
  db.prepare(`UPDATE ebay_search_terms SET ${sets.join(',')} WHERE search_term_id=?`).run(...params);
  return getSearchTerm(db, String(row.search_term_id));
}

export function setSearchTermEnabled(db: DatabaseSync, idOrQuery: string, enabled: boolean): SearchTermRow {
  const row = getSearchTerm(db, idOrQuery);
  db.prepare(`UPDATE ebay_search_terms SET enabled=?, updated_at=? WHERE search_term_id=?`)
    .run(enabled ? 1 : 0, new Date().toISOString(), row.search_term_id);
  return getSearchTerm(db, String(row.search_term_id));
}

export function removeSearchTerm(db: DatabaseSync, idOrQuery: string): SearchTermRow {
  const row = getSearchTerm(db, idOrQuery);
  db.prepare(`UPDATE ebay_campaigns SET search_term_id=NULL WHERE search_term_id=?`).run(row.search_term_id);
  db.prepare(`DELETE FROM ebay_search_terms WHERE search_term_id=?`).run(row.search_term_id);
  return row;
}

/** Terms whose refresh interval has elapsed, highest priority first. */
export function dueSearchTerms(db: DatabaseSync, now = new Date()): SearchTermRow[] {
  return db.prepare(
    `SELECT * FROM ebay_search_terms
     WHERE enabled=1
       AND (last_enqueued_at IS NULL
            OR datetime(last_enqueued_at) <= datetime(?, printf('-%d minutes', refresh_interval_minutes)))
     ORDER BY priority DESC, last_enqueued_at IS NOT NULL, last_enqueued_at, search_term_id`,
  ).all(now.toISOString()) as unknown as SearchTermRow[];
}

export function markTermEnqueued(db: DatabaseSync, searchTermId: number, now = new Date()): void {
  db.prepare(`UPDATE ebay_search_terms SET last_enqueued_at=?, updated_at=? WHERE search_term_id=?`)
    .run(now.toISOString(), now.toISOString(), searchTermId);
}

export function markTermCompleted(db: DatabaseSync, searchTermId: number, resultCount: number | null, now = new Date()): void {
  db.prepare(`UPDATE ebay_search_terms SET last_completed_at=?, last_result_count=?, updated_at=? WHERE search_term_id=?`)
    .run(now.toISOString(), resultCount, now.toISOString(), searchTermId);
}

/**
 * The first search page's SearchParams for a term. `auction` terms use the
 * narrow live-auction sweep (AUCTION-only, sorted soonest-ending, client-side
 * min-bid filter, server + client end-date cutoff); `fixed`/`all` do a plain
 * paged search with the term's buying-option and price filters.
 */
export function searchParamsForTerm(term: SearchTermRow, pageLimit = 200, now = new Date()): SearchParams {
  const auction = term.buying_option === 'auction';
  const endingBeforeAt = term.ending_within_hours != null
    ? new Date(now.getTime() + term.ending_within_hours * 3_600_000).toISOString()
    : undefined;
  return {
    marketplace: term.marketplace,
    query: term.query_text,
    offset: 0,
    limit: pageLimit,
    maxItems: term.max_items,
    mode: auction ? 'live_auctions' : 'all',
    buyingOption: term.buying_option,
    minBidCount: term.min_bids,
    endingBeforeAt,
    priceMin: term.price_min ?? undefined,
    priceMax: term.price_max ?? undefined,
    categoryIds: term.category_ids ?? undefined,
    searchTermId: term.search_term_id,
  };
}

/**
 * Ensure a per-refresh `ebay_campaigns` execution record for this term under
 * the supervisor run, returning its campaign_id. One campaign per
 * (term, marketplace) -- reused across refreshes so the funnel accumulates.
 */
export function ensureTermCampaign(db: DatabaseSync, supervisorRunId: string, term: SearchTermRow): string {
  const existing = db.prepare(
    `SELECT campaign_id FROM ebay_campaigns WHERE search_term_id=? AND marketplace=?`,
  ).get(term.search_term_id, term.marketplace) as { campaign_id: string } | undefined;
  if (existing) return existing.campaign_id;
  const id = randomUUID();
  db.prepare(
    `INSERT INTO ebay_campaigns
       (campaign_id,pipeline_run_id,search_term_id,query_text,normalized_query,marketplace,status,coverage_status,created_at)
     VALUES (?,?,?,?,?,?,'pending','unknown',?)`,
  ).run(id, supervisorRunId, term.search_term_id, term.query_text, term.normalized_query, term.marketplace, new Date().toISOString());
  return id;
}

/** Enqueue the first search page for a term (idempotent by scope key). */
export function seedSearchTermPage(db: DatabaseSync, term: SearchTermRow, campaignId: string, pageLimit = 200, now = new Date()): void {
  const params = searchParamsForTerm(term, pageLimit, now);
  params.campaignId = campaignId;
  params.refreshDetails = true;
  const asOf = params.endingBeforeAt ? liveAuctionAsOfTag(params.endingBeforeAt) : undefined;
  enqueueWorkItem(db, {
    source: 'ebay',
    queue: 'ebay_search',
    entityType: 'search_page',
    scopeKey: searchPageScopeKey(term.marketplace, term.query_text, 0, pageLimit, term.max_items, params.mode, asOf, params.priceMin, params.priceMax),
    params,
  });
}

export interface SearchTermPreview {
  url: string;
  httpStatus: number;
  totalReported: number;
  itemsOnFirstPage: number;
  qualifyingOnFirstPage: number;
  /** Rough item-detail calls this term would cost per refresh (1 search call + one detail per qualifying item, capped by max_items). */
  estimatedDetailCalls: number;
  estimatedTotalCalls: number;
  note: string;
}

interface SummaryBody {
  total?: number;
  itemSummaries?: Array<{ itemId?: string; bidCount?: number; itemEndDate?: string }>;
}

/**
 * Dry run: one real eBay search call, no downstream fetches, no DB writes.
 * Reports how many results the term matches and roughly how many item-detail
 * calls (the scarce quota) a refresh would spend -- so a term can be tuned
 * before it is enabled.
 */
export async function previewSearchTerm(term: SearchTermRow, now = new Date()): Promise<SearchTermPreview> {
  const params = searchParamsForTerm(term, 200, now);
  const def = EBAY_MARKETPLACES[term.marketplace];
  const url = buildSearchUrl(params);
  const token = await getEbayAccessToken();
  const res = await fetchRaw(url, {
    Authorization: `Bearer ${token}`,
    'X-EBAY-C-MARKETPLACE-ID': def.marketplaceId,
  });
  let body: SummaryBody = {};
  try { body = JSON.parse(res.body.toString('utf8')) as SummaryBody; } catch { /* leave empty */ }
  const summaries = body.itemSummaries ?? [];
  const qualifying = term.buying_option === 'auction'
    ? selectLiveAuctionItems(summaries.map((s) => ({ itemId: String(s.itemId ?? ''), bidCount: s.bidCount, itemEndDate: s.itemEndDate })),
        { minBidCount: term.min_bids, endingBeforeAt: params.endingBeforeAt }).itemIds.length
    : summaries.length;
  const total = Number(body.total ?? 0);
  const pageFraction = summaries.length > 0 ? qualifying / summaries.length : 0;
  const cap = term.max_items > 0 ? term.max_items : total;
  const estimatedDetailCalls = Math.min(cap, Math.round(total * pageFraction));
  const pages = Math.max(1, Math.ceil(Math.min(cap, total) / params.limit));
  return {
    url,
    httpStatus: res.status,
    totalReported: total,
    itemsOnFirstPage: summaries.length,
    qualifyingOnFirstPage: qualifying,
    estimatedDetailCalls,
    estimatedTotalCalls: estimatedDetailCalls + pages,
    note: res.status !== 200
      ? `eBay returned HTTP ${res.status}`
      : total > 10_000 && term.buying_option !== 'auction'
        ? 'Over eBay\'s 10,000-result window -- add a price band or use buying-option auction to narrow it'
        : `${EBAY_ITEM_URL} calls are the scarce quota (${'~'}4,500/day)`,
  };
}
