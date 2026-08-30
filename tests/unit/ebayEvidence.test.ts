import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEvidence, isPsa10, type EbayItemDetail } from '../../src/curated/ebay/evidence.ts';
import { extractNumbers, extractLooseNumbers, numberForms } from '../../src/curated/ebay/numbers.ts';

function listing(overrides: Partial<EbayItemDetail> = {}): EbayItemDetail {
  return {
    itemId: 'v1|1|0',
    conditionId: '2750',
    conditionDescriptors: [
      { name: 'Bewertungsexperte', values: [{ content: 'Professional Sports Authenticator (PSA)' }] },
      { name: 'Bewertung', values: [{ content: '10' }] },
    ],
    ...overrides,
  };
}

test('every plausible reading of a card number is kept, not just the first', () => {
  const numbers = extractNumbers('PSA 10 Pikachu ex 132/106 Super Electric Breaker #12', 'title');
  const values = numbers.map((n) => n.value);
  assert.ok(values.includes('132'), 'the printed fraction is read');
  assert.ok(values.includes('12'), 'the hash number is read too, rather than being discarded');
  const fraction = numbers.find((n) => n.value === '132')!;
  assert.equal(fraction.printedTotal, 106, 'the denominator is captured as the set size');
  assert.ok(fraction.weight > numbers.find((n) => n.value === '12')!.weight, 'a printed fraction outranks a bare hash number');
});

test('a grade written as a fraction is never mistaken for a card number', () => {
  // "PSA 10 / OVP" and "9 / PSA" look exactly like a card number to a naive
  // pattern, and titles routinely contain both a real one and a decoy.
  const numbers = extractNumbers('Pokemon Glurak PSA 10 / OVP Deutsch 4/102', 'title');
  assert.deepEqual(numbers.filter((n) => n.printedTotal != null).map((n) => n.value), ['4']);
});

test('a promo denominator is read as a set code, which is stronger evidence than any set name', () => {
  const [number] = extractNumbers('PSA 10 Pikachu 001/SV-P Pre-Order Promo', 'title');
  assert.equal(number!.value, '001');
  assert.equal(number!.denominatorCode, 'SV-P');
  assert.equal(number!.printedTotal, null);
});

test('letter-prefixed numbers are only accepted for prefixes the catalogue actually uses', () => {
  const known = new Set(['swsh', 'tg']);
  const withoutFilter = extractNumbers('NIDOKING HOLO JAP 043 EIN2021 SWSH132', 'title').map((n) => n.value);
  assert.ok(withoutFilter.includes('EIN2021'), 'unfiltered, prose reads as a card number');
  const filtered = extractNumbers('NIDOKING HOLO JAP 043 EIN2021 SWSH132', 'title', known).map((n) => n.value);
  assert.ok(filtered.includes('SWSH132'));
  assert.ok(!filtered.includes('EIN2021'), 'a word that happens to precede a number is not a card number');
});

test('padding differences between a listing and the catalogue are reconciled, not fatal', () => {
  assert.deepEqual(numberForms('011').sort(), ['011', '11'].sort());
  assert.deepEqual(numberForms('4').sort(), ['004', '4'].sort());
  assert.ok(numberForms('TG12').includes('TG012'));
});

test('a bare integer in a title is offered only as a last resort, and never a year or a grade', () => {
  const loose = extractLooseNumbers('NIDOKING POKEMON 20TH ANN 1ST ED HOLO JAP 043 2016 PSA 10', 'title').map((n) => n.value);
  assert.ok(loose.includes('043'));
  assert.ok(!loose.includes('2016'), 'a four-digit year is not a card number');
  assert.ok(!loose.includes('10'), 'the grade sitting next to "PSA" is not a card number');
});

test('grading comes from eBay structured descriptors, with the title only as a fallback', () => {
  assert.ok(isPsa10(buildEvidence(listing()).grading));
  const fromTitle = buildEvidence({ itemId: 'v1|2|0', title: 'Charizard PSA 10 Gem Mint' }).grading;
  assert.equal(fromTitle.method, 'title-fallback');
  assert.ok(isPsa10(fromTitle));
  const notTen = buildEvidence(listing({
    conditionDescriptors: [
      { name: 'Bewertungsexperte', values: [{ content: 'PSA' }] },
      { name: 'Bewertung', values: [{ content: '9' }] },
    ],
  })).grading;
  assert.equal(isPsa10(notTen), false);
});

test('item specifics are read across marketplaces, not just the German ones', () => {
  const evidence = buildEvidence(listing({
    title: 'Pikachu PSA 10',
    localizedAspects: [
      { name: 'Gioco', value: 'Pokémon TCG' },
      { name: 'Numero della carta', value: '025' },
      { name: 'Illustratore', value: 'Mitsuhiro Arita' },
      { name: 'Anno di fabbricazione', value: '1999' },
      { name: 'HP', value: '60' },
    ],
  }));
  assert.equal(evidence.numbers[0]?.value, '025');
  assert.equal(evidence.illustrator, 'Mitsuhiro Arita');
  assert.equal(evidence.year, 1999);
  assert.equal(evidence.hp, 60);
  assert.equal(evidence.inScope, true);
});

test('the set can arrive hidden in the aspect label rather than its value', () => {
  const evidence = buildEvidence(listing({ title: 'Pikachu PSA 10', localizedAspects: [{ name: 'Set: Cp6', value: 'Ja' }] }));
  assert.ok(evidence.setTexts.includes('cp6'));
});

test('a listing language is read from the card, never from the seller’s own boilerplate', () => {
  // The description is shop text in the seller's language and says nothing
  // about the card; trusting it made English cards look German and filtered
  // the correct set out of consideration entirely.
  const evidence = buildEvidence(listing({
    title: 'HIDDEN FATES POKEMON SUN & MOON 2019 44 PSA 10',
    description: '<p>Versand aus Deutschland. Zustand: neuwertig. Deutsch.</p>',
  }));
  assert.equal(evidence.language, null);
  assert.equal(buildEvidence(listing({ title: 'Pikachu Japanese Promo PSA 10' })).language, 'ja');
});

test('another trading card game and non-card merchandise are both out of scope', () => {
  const dbs = buildEvidence(listing({ title: 'Android 17 & 18 Cell EX20-04 DBS', localizedAspects: [{ name: 'Spiel', value: 'Dragon Ball Super CG' }] }));
  assert.equal(dbs.inScope, false);
  assert.match(dbs.outOfScopeReason ?? '', /^game-aspect:/);

  const hanafuda = buildEvidence(listing({ title: 'PSA 10 Flabebe February Hanafuda Mario Pikachu Pokemon' }));
  assert.equal(hanafuda.inScope, false);
  assert.equal(hanafuda.outOfScopeReason, 'not-a-tcg-card');
});

test('a language the catalogue does not carry is reported as out of scope, not as a failed match', () => {
  const evidence = buildEvidence(listing({ title: 'Pokemon Pikachu Carta Italiana PSA 10', localizedAspects: [{ name: 'Lingua', value: 'Italiano' }] }));
  assert.equal(evidence.language, 'it');
  assert.equal(evidence.languageSupported, false);
  assert.equal(evidence.inScope, false);
});

test('a multi-card listing is detected even when the seller never uses a lot word', () => {
  // Two different printed numbers in one title is decisive on its own; this
  // exact listing slipped through as a single card before.
  const evidence = buildEvidence(listing({ title: "PSA 10 Set of 4 Pikachu 020/M-P 120/SV-P 197/SV-P 291/SV-P McDonald's 2025" }));
  assert.equal(evidence.isLot, true);
  assert.equal(buildEvidence(listing({ title: 'PSA 10 Pikachu 025/102 Base Set' })).isLot, false);
});

test('finish and edition wording is collected for choosing a variant later', () => {
  const evidence = buildEvidence(listing({ title: 'PSA 10 Charizard 1st Edition Reverse Holo Full Art 4/102' }));
  assert.ok(evidence.printRunHints.includes('first_edition'));
  assert.ok(evidence.finishHints.includes('reverse'));
  assert.ok(evidence.microHints.includes('full_art'));
});
