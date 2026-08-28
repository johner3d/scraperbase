import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCardImageRenditionUrls, buildSetAssetRenditionUrls } from '../../src/sources/tcgdex/config.ts';

// Regression coverage for a real bug caught during the Phase 2 pilot run:
// card images have a quality tier (high/low) in their URL, but set
// logos/symbols do not -- applying the card-image builder to a logo/symbol
// URL produced 404s against the live API.

test('buildCardImageRenditionUrls uses the {base}/{quality}.{ext} shape', () => {
  const { downloaded, all } = buildCardImageRenditionUrls('https://assets.tcgdex.net/en/base/base1/4');
  assert.equal(downloaded, 'https://assets.tcgdex.net/en/base/base1/4/high.webp');
  assert.equal(all['high.webp'], 'https://assets.tcgdex.net/en/base/base1/4/high.webp');
  assert.equal(all['low.png'], 'https://assets.tcgdex.net/en/base/base1/4/low.png');
  assert.equal(Object.keys(all).length, 6); // 2 qualities x 3 formats
});

test('buildSetAssetRenditionUrls uses the {base}.{ext} shape with no quality tier', () => {
  const { downloaded, all } = buildSetAssetRenditionUrls('https://assets.tcgdex.net/en/neo/si1/logo');
  assert.equal(downloaded, 'https://assets.tcgdex.net/en/neo/si1/logo.webp');
  assert.equal(all.png, 'https://assets.tcgdex.net/en/neo/si1/logo.png');
  assert.equal(Object.keys(all).length, 3); // 3 formats, no quality dimension
  for (const url of Object.values(all)) {
    assert.ok(!url.includes('/high.') && !url.includes('/low.'), `unexpected quality segment in ${url}`);
  }
});
