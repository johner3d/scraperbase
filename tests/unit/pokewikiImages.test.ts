import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPokewikiCardPageTitle, parsePokewikiCardImage, pokewikiFileNameCandidates } from '../../src/sources/pokewiki/images.ts';

test('builds the exact German PokéWiki card page title', () => {
  assert.equal(buildPokewikiCardPageTitle('Dratini', 'Grundset', '26'), 'Dratini (Grundset 26)');
});

test('extracts the scan declared by a card infobox', () => {
  const text = `{{Karte Infobox\n|name=Dratini\n|bild=Dratini (Grundset 26).jpg\n|illus=Ken Sugimori\n}}`;
  assert.equal(parsePokewikiCardImage(text), 'Dratini (Grundset 26).jpg');
});

test('does not accept an arbitrary page image', () => {
  assert.equal(parsePokewikiCardImage('|bild=Not a card.jpg'), null);
});

test('includes exact image filenames and the legacy Nidoran gender spelling', () => {
  const candidates = pokewikiFileNameCandidates('Nidoran M', 'Grundset', '55');
  assert.ok(candidates.includes('Nidoran M (Grundset 55).jpg'));
  assert.ok(candidates.includes('Nidoran♂ (Grundset 55).jpg'));
});
