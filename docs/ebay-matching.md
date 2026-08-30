# Matching eBay listings to card variants

How a stored eBay item payload becomes a link to a row in `variants` (or an
honest statement that it cannot).

Run it with:

```text
npm run cli -- materialize --source ebay
npm run cli -- ebay-match-report
```

Code lives in [`src/curated/ebay/`](../src/curated/ebay); `materializeEbay()`
in [`src/curated/materialize.ts`](../src/curated/materialize.ts) is the only
caller.

## Why v1 did not work

The first matcher read one card number out of a listing, looked it up across
all 555 sets and 102,052 variants at once, and accepted the answer only when
exactly one variant survived *and* a card-name token overlapped. Against the
4,650 PSA-10 listings then materialized it linked **57**, leaving 2,514
ambiguous and 2,079 unmatched, and filled the review queue with 4,586 rows
nobody could act on.

Each of those failures had a specific cause, and the corpus shows all of them:

- **The set was never used.** Without it, "#25" matches dozens of cards. The
  denominator of `NNN/MMM`, the set code printed on Japanese cards (`CP6`,
  `S10a`, `SV8` — which is exactly `sets.source_set_id`), the `Set`
  item-specific and the year were all available and all ignored.
- **Only four item specifics were read.** The payloads carry ~30 useful ones,
  including `HP` (1,875 listings), `Zeichner`/illustrator (2,122),
  `Seltenheit` (3,215) and `Baujahr` (2,957) — and the catalogue already
  stores HP and illustrator for all 56,385 cards.
- **Card names cannot match Japanese cards.** Most of this corpus is Japanese
  cards described in English or German; `ピカチュウ` shares nothing with
  "Pikachu".
- **Secret rares were rejected.** `219/191` has a number above its set, which
  the old set-total filter treated as a contradiction rather than as the
  signature of a secret rare.
- **One variant was unreachable.** eBay listings almost never state holo vs
  reverse holo, so demanding a single variant guaranteed ambiguity.

## The pipeline

Each stage hands the next a *ranked list*, never a single answer, so an early
mistake costs weight instead of eliminating the truth.

### 1. Evidence — `evidence.ts`, `numbers.ts`

One payload in, everything we know about the card out: every plausible reading
of the card number (fraction, promo fraction, `#NNN`, `SWSH132`, and bare
integers as a last resort), set codes and set text, language, year, HP,
illustrator, rarity, finish/edition wording, lot and scope flags.

Three details earn their complexity:

- Letter-prefixed numbers are only accepted for prefixes the catalogue really
  uses (`swsh`, `tg`, `gg`, `dp`, …). Without that filter, seller prose reads
  as card numbers — "ein 2021" became `EIN2021` and suppressed the real one.
- Language is read from the item-specific and the title, **never** from the
  description, which is shop boilerplate in the seller's own language.
- Two distinct printed numbers in a title means a lot, even with no lot word.

### 2. Set resolution — `setResolver.ts`

Scores all 555 sets against the evidence: printed set code (from a promo
denominator or the title), exact set name, alias, token overlap, the printed
denominator against `official_cards`/`total_cards`, and the year. Pokémon TCG
Pocket sets are excluded outright — they are an app, not cardboard.

Language is **scored, not filtered**. Seller-declared language is wrong often
enough that eliminating every set of the other language on the strength of it
left some listings with nothing to match at all.

### 3. Candidates — `candidates.ts`

Four blockers, unioned: number, number inside a resolved set, card name inside
a confident set, and **species inside a confident set**. The last exists
because card names cannot cross the language barrier but the national Pokédex
id can: `attributes_json.dexId` is the same number on the Japanese card and the
English one.

### 4. Scoring — `score.ts`

A weighted sum of independent features — number, set, name overlap (including
the cross-language sibling card), species, HP, illustrator, printed total,
year, language, rarity, and whether PSA has actually graded a 10 of the card.

The sum is deliberately **not normalised to 1**. Clamping made every
well-evidenced candidate score exactly 1.00, which erased the margin between
the right card and its near-twin and pushed thousands of certain matches into
"too close to call".

### 5. Decision — `decide.ts`

| Tier | Meaning |
|---|---|
| `exact` | PSA cert lookup, or a human's `match_overrides` entry |
| `strong` | Score and margin both clear the auto-accept thresholds |
| `card-level` | The card is certain, the finish is not; `variant_id` stays null |
| `flagged` | Accepted below the auto threshold, worth a glance — **not** queued |
| `review` | Genuinely needs a human; the only tier that enters `match_reviews` |
| `catalogue-gap` | The set is identified but we have no cards for it |
| `out-of-scope` | Another game, non-card merchandise, or a language we do not carry |
| `lot` | Multi-card listing; no single variant can represent it |

`match_status` keeps its original four values so the existing views and API
stay valid; `match_tier` carries the richer answer.

## Results

From `ebay-match-report` on the current corpus (5,202 PSA-10 listings):

| Outcome | Listings | Share |
|---|---:|---:|
| strong | 1,934 | 37.2% |
| card-level | 146 | 2.8% |
| flagged | 1,032 | 19.8% |
| review | 410 | 7.9% |
| catalogue-gap | 1,131 | 21.7% |
| out-of-scope | 429 | 8.2% |
| lot | 72 | 1.4% |

**3,112 of the 3,570 matchable listings (87.2%) are matched; 410 need a human.**
2,742 of the matches name a specific variant; 366 are honest card-level answers.

31.4% of all listings cannot be matched by anyone — they are other games, lots,
or cards from sets the catalogue does not contain. Reporting those separately
is the point: they are acquisition work, not review work.

## What to do next, in priority order

1. **Ingest the missing sets.** The largest single block of unmatchable
   listings is Japanese promo sets that are absent from the catalogue
   entirely — `S-P`, `SM-P`, `XY-P`, `DP-P` — plus sets whose row exists but
   whose cards were never fetched (`S8a`, `SMP2`, `CP6`, `S10b`; 81 of 555
   sets are in that state). `ebay-match-report` prints them ranked by how many
   listings each would unlock.
2. **Run the cert stage.** 791 listings publish a PSA certification number:

   ```text
   npm run cli -- run --source psa --stage cert
   npm run cli -- materialize --source ebay
   ```

   Each resolves through `psa_specs` to an exact variant *including finish and
   1st-edition status*, which nothing else in this pipeline can establish. They
   also become the precision baseline: any listing the scored matcher answered
   differently from its own cert is a real error.
3. **Add set aliases.** `ebay-match-report` lists the set names in the review
   queue that no alias resolves; add the real ones to
   [`data/aliases/ebay-sets.json`](../data/aliases/ebay-sets.json).

## Feedback loop

Resolving a review with `setMatchOverride()` does two things: it fixes that
listing permanently, and it records the listing's set text in
`ebay_set_aliases` as a `learned` alias. Because sellers copy the same slab
label wording, one human decision usually clears a whole family of listings on
the next run.

Separately, `propagateEbayClusters()` groups listings by normalized title
(dropping the trailing serial that seller templates vary) and lets an
unresolved listing inherit a sibling's answer. Inherited matches are always
flagged — they are an inference about a *different* listing.

## Tuning

Thresholds are in `decide.ts` (`AUTO_SCORE`, `AUTO_MARGIN`, `FLAG_SCORE`) and
were fitted against the stored corpus; feature weights are in `score.ts` and
`setResolver.ts`. Every accepted match stores its score, the runner-up's score
and the full per-feature breakdown in `ebay_listings.signals_json`, so a
threshold change can be judged against real decisions rather than guessed at.
