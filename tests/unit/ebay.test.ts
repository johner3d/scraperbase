import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSearchUrl, requestLimit, type SearchParams } from '../../src/sources/ebay/collectors/search.ts';
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

test('the final capped page requests only the remaining number of items', () => {
  const params = { ...base, offset: 30, limit: 30, maxItems: 50 };
  assert.equal(requestLimit(params), 20);
  assert.match(buildSearchUrl(params), /limit=20/);
});

test('search configurations and marketplace item views have distinct scope keys', () => {
  assert.notEqual(
    searchPageScopeKey('de', base.query, 0, 30, 60),
    searchPageScopeKey('de', base.query, 0, 200, 0),
  );
  assert.notEqual(itemScopeKey('de', 'v1|123|0'), itemScopeKey('international', 'v1|123|0'));
});

test('EU searches retain the configured item-location filter and no buying-option filter', () => {
  const url = new URL(buildSearchUrl({ ...base, marketplace: 'eu' }));
  assert.equal(url.searchParams.get('q'), 'pikachu psa 10');
  assert.match(url.searchParams.get('filter') ?? '', /itemLocationCountry/);
  assert.doesNotMatch(url.search, /buyingOptions/);
});
