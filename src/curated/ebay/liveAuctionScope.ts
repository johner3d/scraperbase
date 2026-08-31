import { DEFAULT_EBAY_ENDING_WITHIN_HOURS } from '../../sources/ebay/config.ts';

/**
 * The single SQL definition of "a listing a user sees in the /auctions live
 * auction view". It is the mirror of the JS-side dashboard filter in
 * src/web/api.ts (`auctionRows` + `activeAuctions`): trusted match, PSA 10,
 * single card, not flagged/lot, an AUCTION listing with at least one bid, still
 * active, and ending within the live window. Keep the two in step.
 *
 * The pipeline uses this to scope every PSA fetch (identity, cert, population,
 * price guide, sales) to exactly that set, so the scarce PSA browser-scraping
 * budget is only ever spent on cards that are actually on screen.
 */

/** Hours ahead of now an auction may close and still count as "live". */
export const LIVE_AUCTION_WINDOW_HOURS =
  Number(process.env.SCRAPERBASE_LIVE_AUCTION_WINDOW_HOURS) || DEFAULT_EBAY_ENDING_WITHIN_HOURS;

/**
 * Grace minutes added to "now" for the lower bound: a spec fetched now is still
 * useful to a listing closing a few minutes later, and it hedges a slightly
 * stale `item_end_date`. Matches the historic `activeMarginMinutes` default.
 */
export const LIVE_AUCTION_MARGIN_MINUTES = 30;

export interface LiveAuctionClauseOptions {
  marginMinutes?: number;
  windowHours?: number;
}

export interface LiveAuctionClause {
  /** `JOIN v_ebay_listing_latest_price <lp> ON ...` -- place right after `FROM ebay_listings <e>`. */
  join: string;
  /** Boolean WHERE fragment (no leading AND/WHERE). */
  sql: string;
  /** Positional params for `sql`, in order: [marginMinutes, windowHours]. */
  params: number[];
}

/**
 * @param e   alias bound to `ebay_listings`
 * @param lp  alias to bind to `v_ebay_listing_latest_price` (added by `join`)
 */
export function liveAuctionListingClause(
  e = 'e',
  lp = 'lp',
  opts: LiveAuctionClauseOptions = {},
): LiveAuctionClause {
  const margin = opts.marginMinutes ?? LIVE_AUCTION_MARGIN_MINUTES;
  const hours = opts.windowHours ?? LIVE_AUCTION_WINDOW_HOURS;
  return {
    join: `JOIN v_ebay_listing_latest_price ${lp} ON ${lp}.ebay_listing_id = ${e}.ebay_listing_id`,
    sql: `${e}.variant_id IS NOT NULL
      AND ${e}.grade_value = 10 AND ${e}.is_lot = 0 AND ${e}.flagged = 0
      AND ${e}.match_status IN ('matched','manual')
      AND ${e}.match_tier IN ('exact','strong')
      AND (${e}.match_method IS NULL OR ${e}.match_method <> 'ebay-cluster-propagate')
      AND ${lp}.buying_options_json LIKE '%AUCTION%'
      AND COALESCE(${lp}.bid_count, 0) >= 1
      -- datetime() both sides: item_end_date is stored ISO ("...T..Z"), which
      -- string-compares wrong against SQLite's "YYYY-MM-DD HH:MM:SS" on the same day.
      AND datetime(${lp}.item_end_date) > datetime('now', printf('+%d minutes', CAST(? AS INTEGER)))
      AND datetime(${lp}.item_end_date) <= datetime('now', printf('+%d hours', CAST(? AS INTEGER)))`,
    params: [margin, hours],
  };
}
