import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSearchUrl, nextOffset, requestLimit, selectLiveAuctionItems, type SearchParams } from '../../src/sources/ebay/collectors/search.ts';
import { itemScopeKey, liveAuctionAsOfTag, searchPageScopeKey } from '../../src/sources/ebay/scopeKeys.ts';

const base: SearchParams = {
  marketplace: 'de',
  query: 'pikachu psa 10',
  offset: 0,
  limit: 200,
  maxItems: 0,
};

test('an eBay max-items value of zero is uncapped', () => {
  assert.equal(requestLimit(base), 200);
  assert.match(buildSearchUrl(base), /limit=200/);
  assert.match(searchPageScopeKey('de', base.query, 0, 200, 0), /max=all/);
});

test('a cap smaller than one page reduces the request limit', () => {
  const params = { ...base, limit: 30, maxItems: 5 };
  assert.equal(requestLimit(params), 5);
  assert.match(buildSearchUrl(params), /limit=5/);
});

test('search configurations and marketplace item views have distinct scope keys', () => {
  assert.notEqual(
    searchPageScopeKey('de', base.query, 0, 30, 60),
    searchPageScopeKey('de', base.query, 0, 200, 0),
  );
  assert.notEqual(itemScopeKey('de', 'v1|123|0'), itemScopeKey('international', 'v1|123|0'));
});

test('pagination follows the API next link rather than the approximate total', () => {
  assert.equal(nextOffset({ total: 99_999, next: 'https://api.ebay.com/example?limit=200&offset=200' }), 200);
  assert.equal(nextOffset({ total: 99_999 }), undefined);
  assert.equal(nextOffset({ next: 'not a URL' }), undefined);
});

test('searches explicitly include every buying option, plus the EU location filter when requested', () => {
  const deUrl = new URL(buildSearchUrl(base));
  assert.match(deUrl.searchParams.get('filter') ?? '', /buyingOptions:\{AUCTION\|FIXED_PRICE\|BEST_OFFER\|CLASSIFIED_AD\}/);
  const url = new URL(buildSearchUrl({ ...base, marketplace: 'eu' }));
  assert.equal(url.searchParams.get('q'), 'pikachu psa 10');
  assert.match(url.searchParams.get('filter') ?? '', /itemLocationCountry/);
  assert.match(url.searchParams.get('filter') ?? '', /buyingOptions/);
});

test('--live-auctions mode filters the search to AUCTION only, sorted soonest-ending, with no location filter change', () => {
  const url = new URL(buildSearchUrl({ ...base, mode: 'live_auctions' }));
  assert.equal(url.searchParams.get('filter'), 'buyingOptions:{AUCTION}');
  assert.equal(url.searchParams.get('sort'), 'endingSoonest');
});

test('the default "all" mode never sets sort (unaffected by the live-auctions addition)', () => {
  const url = new URL(buildSearchUrl(base));
  assert.equal(url.searchParams.get('sort'), null);
});

test('live-auctions and all-buying-options searches never collide on scope key, even with identical query text', () => {
  assert.notEqual(
    searchPageScopeKey('de', 'pokemon base set psa 10', 0, 200, 0, 'all'),
    searchPageScopeKey('de', 'pokemon base set psa 10', 0, 200, 0, 'live_auctions'),
  );
  // Backward compatibility: an omitted mode still produces the exact scope
  // key format used before --live-auctions existed, so previously-succeeded
  // 'all' mode searches are recognized as done rather than re-fetched.
  assert.equal(
    searchPageScopeKey('de', 'pikachu psa 10', 0, 200, 0),
    searchPageScopeKey('de', 'pikachu psa 10', 0, 200, 0, 'all'),
  );
  assert.match(searchPageScopeKey('de', 'pikachu psa 10', 0, 200, 0), /buying=all/);
});

test('selectLiveAuctionItems: keeps only items with enough bids that end before the cutoff, and reports the cutoff crossing', () => {
  const cutoff = '2026-09-02T00:00:00.000Z';
  const summaries = [
    { itemId: 'a', bidCount: 3, itemEndDate: '2026-08-31T00:00:00.000Z' }, // ends soon, has bids -- keep
    { itemId: 'b', bidCount: 0, itemEndDate: '2026-08-31T12:00:00.000Z' }, // no bids -- drop
    { itemId: 'c', bidCount: 1, itemEndDate: '2026-09-01T00:00:00.000Z' }, // exactly under cutoff, 1 bid -- keep
    { itemId: 'd', bidCount: 5, itemEndDate: '2026-09-05T00:00:00.000Z' }, // past cutoff -- stop here
    { itemId: 'e', bidCount: 9, itemEndDate: '2026-09-06T00:00:00.000Z' }, // never reached
  ];
  const result = selectLiveAuctionItems(summaries, { minBidCount: 1, endingBeforeAt: cutoff });
  assert.deepEqual(result.itemIds, ['a', 'c']);
  assert.equal(result.pastCutoff, true);
});

test('selectLiveAuctionItems: with no cutoff configured, only the bid-count filter applies', () => {
  const summaries = [
    { itemId: 'a', bidCount: 0 },
    { itemId: 'b', bidCount: 2 },
  ];
  const result = selectLiveAuctionItems(summaries, { minBidCount: 1 });
  assert.deepEqual(result.itemIds, ['b']);
  assert.equal(result.pastCutoff, false);
});

test('a live-auction search re-run on a later day gets a distinct scope key, not silently reusing a stale cutoff', () => {
  const day1 = searchPageScopeKey('de', 'pokemon psa 10', 0, 200, 0, 'live_auctions', liveAuctionAsOfTag('2026-08-30T12:00:00.000Z'));
  const day2 = searchPageScopeKey('de', 'pokemon psa 10', 0, 200, 0, 'live_auctions', liveAuctionAsOfTag('2026-08-31T12:00:00.000Z'));
  assert.notEqual(day1, day2);
  // Same day (even a different hour) is still the same key -- idempotent
  // within one day's window, only a genuinely new day forces a fresh fetch.
  const day1Again = searchPageScopeKey('de', 'pokemon psa 10', 0, 200, 0, 'live_auctions', liveAuctionAsOfTag('2026-08-30T23:00:00.000Z'));
  assert.equal(day1, day1Again);
});

test('selectLiveAuctionItems: minBidCount of 0 (the "all" mode default) keeps everything, ignoring missing itemIds', () => {
  const summaries = [{ itemId: 'a', bidCount: 0 }, { itemId: '' }, { itemId: 'b' }];
  const result = selectLiveAuctionItems(summaries, { minBidCount: 0 });
  assert.deepEqual(result.itemIds, ['a', 'b']);
});
