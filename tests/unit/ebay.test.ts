import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSearchUrl, nextOffset, requestLimit, type SearchParams } from '../../src/sources/ebay/collectors/search.ts';
import { itemScopeKey, searchPageScopeKey } from '../../src/sources/ebay/scopeKeys.ts';

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
