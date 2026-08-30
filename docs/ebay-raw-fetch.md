# eBay raw fetch

A raw-first fetcher for eBay Pokemon-card listings, built the same way
`src/sources/tcgdex/` and (partially) `src/sources/psa/` are: a `Collector`
plugged into the shared durable queue (`src/core/queue/`), storing whatever
the API returns byte-for-byte, with **no parsing into structured fields, no
matching to the curated card catalogue, and no dedup logic beyond what the
object store already does for free.** That's deliberate, per the user's
explicit instruction -- this is acquisition only. See
`docs/psa-raw-fetch.md` for the sibling PSA effort and its own notes on the
raw-first philosophy.

**Status: live smoke-verified against the production eBay API on 2026-08-29.**
The DE smoke fetched one search page plus five item-detail records (6/6 HTTP
200, 84,531 raw bytes). EU and international one-result probes also succeeded.
The subsequent default-view DE run completed with 25 search pages, 4,691 unique
observed item IDs, and 4,711/4,711 successful calls (4,686 new details plus
the 25 pages; the five smoke details were reused), totaling 77,891,316 bytes.
An official-doc audit then confirmed that eBay's default view omits live
auction-only listings after a bid. Search requests now explicitly OR all four
buying options (`AUCTION`, `FIXED_PRICE`, `BEST_OFFER`, `CLASSIFIED_AD`) and
use new `buying=all` scope keys. The corrected DE pages returned 4,976 rows
(4,925 unique within that moving pass), including 150 rows advertising an
`AUCTION` option and 284 IDs not seen in the default-view pass. It stored all
25 pages and 245 additional item details before the daily quota closed; 39
detail items remain durably pending for the 2026-08-30 07:00 UTC reset. The
completed default-view pass remains valid raw history rather than being
overwritten.
International is not yet completeness-capable: its live result count was
47,596, while eBay exposes at most 10,000 items from one search result set.
The collector marks that condition as an explicit failure instead of silently
claiming a complete import; category/price partitioning is still required.

## Why this exists

Ad hoc `curl` searches (via the OAuth creds in `ibbi/.env`) against eBay's
Browse API for "PSA 10 Pikachu" turned up useful signal (current bids,
listing counts, seller info, per-marketplace price spread). The user wants
this made repeatable and durable: search Pokemon PSA 10 cards (starting with
one term, `"pikachu psa 10"`) across three marketplace scopes, store
*everything* the API gives back, and be able to re-run the search later to
pick up new/changed listings **without losing prior snapshots** and
**without redundant writes when nothing changed.**

## Auth

`src/sources/ebay/auth.ts` -- `getEbayAccessToken()` does an OAuth2
client-credentials grant against `POST /identity/v1/oauth2/token`
(`scope=https://api.ebay.com/oauth/api_scope`), caches the bearer token
in-process (module-level variable, refetched ~60s before `expires_in`
lapses). Not persisted to disk, not stored as a raw object -- it's a
credential, not listing data.

Credentials come from `src/sources/ebay/config.ts` ->
`loadEbayCredentials()`: checks `process.env.EBAY_APP_ID` /
`EBAY_CERT_ID` first, then falls back to parsing `ibbi/.env`
(`C:\Data\scraperbase\ibbi\.env`, project-root-relative, gitignored) with a
trivial hand-rolled `KEY=VALUE` line parser -- **no dotenv dependency**, and
this codebase otherwise never auto-loads a `.env` file (the only other
precedent, `PSA_BROWSER_PATH`, is read straight from `process.env`). The
`ibbi/.env` fallback is a deliberate, confirmed-with-the-user exception,
purely because that file already existed with working production
credentials (`EBAY_APP_ID`, `EBAY_DEV_ID` (unused), `EBAY_CERT_ID`) before
this tool was built. If `ibbi/.env` ever moves or is removed, either export
`EBAY_APP_ID`/`EBAY_CERT_ID` yourself or update `EBAY_ENV_FILE` in
`config.ts`.

## Marketplace scopes

Three named scopes, confirmed with the user, defined in
`EBAY_MARKETPLACES` (`src/sources/ebay/config.ts`):

| Key | `X-EBAY-C-MARKETPLACE-ID` | `itemLocationCountry` filter |
|---|---|---|
| `de` | `EBAY_DE` | none -- everything visible on ebay.de |
| `eu` | `EBAY_DE` | `DE,AT,FR,IT,ES,NL,BE,PL,SE,DK,IE,PT,CZ,FI,LU` |
| `international` | `EBAY_US` | none -- broadest reach, ebay.com (US) site |

These aren't real eBay "sites" beyond DE/US -- `eu` is the DE site narrowed
by seller/item location, which is how the ad hoc EU search was originally
done (see chat history: gave 149 matches vs. 69 for DE-only, vs. 3194
unfiltered on the US site, all for the same query).

## What gets fetched

Two-stage pipeline, mirroring `src/sources/tcgdex/discovery.ts` +
`collectors/catalogue.ts` (set -> card fan-out):

1. **Search pages** (`src/sources/ebay/collectors/search.ts`, queue
   `ebay_search`, entity_type `search_page`) --
   `GET /buy/browse/v1/item_summary/search?q=<query>&limit=<limit>&offset=<offset>[&filter=itemLocationCountry:{...}]`.
   An explicit OR filter includes all four documented buying options
   (`AUCTION`, `FIXED_PRICE`, `BEST_OFFER`, `CLASSIFIED_AD`), because eBay's
   unfiltered default omits live auction-only listings after a bid. Stores the
   entire raw response verbatim (item summaries, `total`, pagination
   metadata, everything). Parses just enough to:
   - enqueue one `ebay_item_detail` work item per `itemId` found (scope keys
     are query-independent but marketplace-specific, preserving potentially
     different marketplace views while deduplicating repeat hits within a
     marketplace), and
   - enqueue the offset from eBay's `next` link, rather than trusting `total`
     for pagination, while still respecting an explicit `--max-items` cap.
2. **Item detail** (`src/sources/ebay/collectors/itemDetail.ts`, queue
   `ebay_item_detail`, entity_type `item`) -- `GET /buy/browse/v1/item/<itemId>`.
   Confirmed with the user to always run (not optional) despite multiplying
   API calls roughly 1:1 with items found -- this is where the *real* raw
   data lives: full description, item specifics, seller details, shipping
   and return policy, every image rendition, condition descriptors, etc.
   Leaf node, no further fan-out.

Both collectors follow the same success/failure/`schema_drift` shape as
every other collector in this codebase (`classifyHttpStatus`). Successful,
schema-drift, and non-2xx response bodies are all stored, so API error payloads
are retained too. A live attempt to use eBay's quota-efficient 20-item
`getItems` endpoint returned HTTP 403 for this App ID, and a token request for
the required `buy.item.bulk` scope was rejected as `invalid_scope`; production
discovery therefore continues to use permitted one-item calls.
The failed bulk probe remains in the append-only attempt/observation history,
but its invalid work item is cancelled and `refresh` deliberately leaves
cancelled work alone.

## Where it's stored, and why that's also the history mechanism

**`data/ebay-raw/`** -- a literal, explicit ask from the user (separate from
the shared `data/objects/` tree every other source uses), but wired through
the *exact same* content-addressed object store
(`src/core/objectstore/store.ts`) via a small addition:
`WriteObjectInput.dirs?: ObjectStoreDirs`, read by `processItem()` in
`src/core/queue/runner.ts` (`writeObject(db, result.object,
result.object.dirs)`). When a collector's output object sets
`dirs: EBAY_RAW_DIRS`, it lands under `data/ebay-raw/ebay/json/<hash[0:2]>/<hash[2:4]>/<hash>.json`
instead of `data/objects/ebay/json/...`. Every other source leaves `dirs`
unset and is unaffected (the parameter defaults to the shared dirs inside
`writeObject`).

**This is also, deliberately, the entire "update but keep history, skip
redundant writes" mechanism** -- nothing bespoke was built for it:

- Content is hashed (SHA-256). Identical bytes on a re-fetch dedup to the
  same file on disk -- **no new file is written, no wasted work** -- but a
  fresh row is still appended to `attempts` (every physical fetch, success
  or fail) and `observations` (append-only: "at time T, this `scope_key`
  observed this content hash").
- Different bytes on a re-fetch (e.g. `currentBidPrice` moved, a new bid
  landed, `bidCount` changed) get a **new** file plus new `attempts` /
  `observations` rows, while the *old* file is never deleted or
  overwritten. Walking `observations` for one `scope_key` over time gives
  you the full history of that search page or that item's price movement.
- No new schema tables were needed -- `work_items` / `attempts` /
  `raw_objects` / `observations` are fully generic and eBay just uses
  `source='ebay'`.

Because eBay listings genuinely change between runs (prices, bid counts),
expect most re-fetches to produce *new* content, not `unchanged` -- unlike a
mostly-static catalogue source like TCGdex.

## Re-running a search ("search again")

The durable queue is "do this job once" by default (`work_items` unique key
is `(source, queue, scope_key)`; a `succeeded` item won't be re-claimed).
"Search again" is: reset the relevant `ebay_search` / `ebay_item_detail`
work items back to `pending`, then `run` again. `src/cli/commands/refresh.ts`
already does exactly this generically (it's the same command tcgdex uses)
-- it just needed a small per-source queue-name map added
(`ebayQueues = { search: ['ebay_search'], detail: ['ebay_item_detail'], all: [...] }`,
selected when `--source ebay`).

```bash
node src/cli/index.ts refresh --source ebay --stage all
node src/cli/index.ts run --source ebay --marketplaces de,eu,international --query "pikachu psa 10"
```

Item-detail work items are shared across searches within a marketplace (scope
key is `item:<marketplace>:<itemId>`). `refresh --stage detail` resets *all*
known item observations across marketplaces regardless of which search found
them.

## Files

| File | What it does |
|---|---|
| `src/sources/ebay/config.ts` | `EBAY_MARKETPLACES`, `EBAY_RAW_DIRS`, API base URLs, `loadEbayCredentials()`, defaults (`DEFAULT_EBAY_QUERY = "pikachu psa 10"`, `DEFAULT_EBAY_PAGE_LIMIT = 200`, `DEFAULT_EBAY_MAX_ITEMS = 0`, meaning uncapped). |
| `src/sources/ebay/auth.ts` | `getEbayAccessToken()` -- cached OAuth2 client-credentials token. |
| `src/sources/ebay/scopeKeys.ts` | Search keys include marketplace, query, page size, cap, and offset; item keys include marketplace and item ID. This keeps smoke/full configurations separate and preserves marketplace-specific observations. |
| `src/sources/ebay/discovery.ts` | `seedEbaySearch(db, { marketplace, query, limit, maxItems })` -- enqueues the offset-0 search page. |
| `src/sources/ebay/collectors/search.ts` | `createEbaySearchCollector(deps)` -- fetches one search page, fans out item-detail jobs + the next page. |
| `src/sources/ebay/collectors/itemDetail.ts` | `createEbayItemDetailCollector(deps)` -- fetches one item's full detail record. |
| `src/sources/ebay/summary.ts` | `printEbayRunSummary(db, runId)` -- prints per-marketplace attempt/outcome/byte counts at the end of a `run`, straight from `attempts`/`observations` (no separate reporting layer). |
| `src/cli/commands/run.ts` | `--source ebay` branch: flags `--query`, `--marketplaces` (comma list), `--max-items`, `--limit`; loops marketplaces, seeds + drains both queues, prints the summary. |
| `src/cli/commands/refresh.ts` | `--source ebay --stage search\|detail\|all` resets matching work items to `pending` for re-fetch. |
| `src/core/http/fetchClient.ts` | `fetchRaw(url, headers = {})` -- gained an optional headers param (needed for the bearer token + marketplace ID header; every other call site is unaffected by the default). |
| `src/core/objectstore/store.ts` | `WriteObjectInput.dirs?: ObjectStoreDirs` -- lets a collector redirect where its object is stored. |
| `src/core/queue/runner.ts` | `processItem()` now passes `result.object.dirs` through to `writeObject()`. |

## Usage

```bash
# Uncapped DE run (the safe default and the live-verified scope)
node src/cli/index.ts run --source ebay

# Other scopes must be named explicitly; budget each into its own quota window
node src/cli/index.ts run --source ebay --marketplaces eu --query "pikachu psa 10"

# One marketplace, small cap, tighter concurrency (for testing/inspection)
node src/cli/index.ts run --source ebay --marketplaces de --query "pikachu psa 10" --max-items 60 --limit 30 --concurrency 3

# Progress / outcome breakdown for the current or a specific run
node src/cli/index.ts status
node src/cli/index.ts status --run <run-id>

# Re-fetch everything already succeeded (keeps history, dedups unchanged content)
node src/cli/index.ts refresh --source ebay --stage all
node src/cli/index.ts run --source ebay
```

`run --source ebay` is subject to the same single-writer exclusivity as
every other `run` invocation (`src/core/queue/run.ts` -- `createRun(...,
exclusive=true)`): only one `run` command can be active across *any* source
at a time. If another run is genuinely active (recent heartbeat), wait for
it or `cancel` it explicitly -- don't assume a `status`-reported "running"
run is stale without checking its heartbeat recency first.

## Verifying it works

The following smoke test was run successfully against the live API on
2026-08-29:

```bash
npm run typecheck
node --test tests/unit/objectstore.test.ts   # includes a dirs-override test
node src/cli/index.ts run --source ebay --marketplaces de --query "pikachu psa 10" --max-items 60 --limit 30 --concurrency 3
node src/cli/index.ts status
```

Confirm: `data/ebay-raw/ebay/json/...` gets populated, the printed summary
line shows sane `success`/`new_content` counts, and `status` shows the
`ebay_search`/`ebay_item_detail` work items reaching `succeeded`. Then
immediately re-run the same `run` command (no `refresh` first -- everything
should already be `succeeded` and not re-claimed) to confirm it's a no-op;
then `refresh --source ebay --stage all` + re-`run` to confirm history
accumulates (`observations` grows, `raw_objects` only grows for content that
actually changed).

## Matching PSA-10 listings to curated card variants

A second, separate pipeline stage now maps this raw data to the curated
catalogue: `src/curated/ebayMatch.ts` (extraction/matching logic) and
`materializeEbay()` in `src/curated/materialize.ts` (orchestration), wired
into `node src/cli/index.ts materialize --source ebay`. New tables
`ebay_listings` and `ebay_listing_price_observations`
(`src/core/db/schema_v6.sql`) hold one row per matched/reviewed listing and
an append-only price-observation history per listing (asking/bid price, not
confirmed sold price -- the Browse API doesn't expose that). See
`v_ebay_psa10_price_comparison` for the variant-level rollup against our own
`psa_price_current`/`psa_population_current`.

v1 scope only ingests grader=PSA, grade=10 (the schema itself is generic).
Matching prefers eBay's structured `conditionDescriptors`/`localizedAspects`
over the free-text title, and requires a corroborating card-name token
(length >= 3, excluding generic TCG jargon like "vmax"/"psa"/"promo") before
auto-matching on card number alone -- a bare number match with no
corroboration goes to `match_reviews` instead of being guessed at, because
card numbers repeat constantly across this catalogue's ~56k cards. Daily
re-scrapes are additive and idempotent: rerun `run --source ebay` then
`materialize --source ebay`.

## What's deliberately NOT built

No category/price partition coverage layer yet for
queries above eBay's 10,000-result window. Search pages move while they are
being read, so exhaustive discovery will also need repeat-pass convergence
based on newly observed item IDs. Request spacing remains conservative
(`minDelayMs: 250, jitterMs: 150`, shared across both queues); the measured
constraint for this App ID is the 5,000-call daily quota, not a burst limit.

## What to look out for

**Single-writer exclusivity blocks concurrent sources, not just concurrent
eBay runs.** `run --source ebay` cannot start while *any* other `run` is
active (confirmed live during this build: a `pokemoncard` image-fetch run
holding ~6900 pending items blocked the first eBay smoke test). Check
`status` and the run's heartbeat recency before assuming a "running" row is
actually dead -- `createRun` only auto-cancels rows whose heartbeat is >2
minutes stale.

**`--max-items 0` means uncapped and is the default.** A positive value is an
explicit smoke-test/safety cap. If it spans more than one page it must be a
multiple of `--limit`, because eBay requires each offset to be a multiple of
the page limit. Search work scope keys include the limit and cap, so a capped
smoke test cannot prevent a later uncapped seed from running.

**One eBay search result set cannot expose more than 10,000 items.** The live
international probe reported 47,596 matches for this one term. The collector
records the root page and marks it `schema_drift`/`permanent_failed` with a
clear message when an uncapped query exceeds that window. Do not call a run
"complete" until category/price partitioning has been implemented and its
union/dedup coverage verified.

**Item-detail fetching multiplies API calls roughly 1:1 with items found.**
The production App ID reported a 5,000-call daily `buy.browse` limit via
Developer Analytics on 2026-08-29. The corrected all-buying-options DE pass
used the remaining allowance; 26 HTTP 429 bodies were retained and their work
was requeued, leaving 39 DE details pending for the next reset. The separate
5,000-call bulk pool cannot currently be used because `getItems` returned HTTP 403
"Insufficient permissions". Complete acquisition therefore has to resume
across quota reset windows (or the App ID needs bulk access / a higher limit).

**Search `total` is approximate and the result set moves during pagination.**
The DE headline count was about 4,814, but 25 live pages yielded 4,691 unique
item IDs because listings can shift and repeat while offset pages are being
read. Nothing returned by the API was filtered out: every page is stored and
every unique observed ID gets detail work. An iterative refresh/convergence
pass is still needed if "everything" means exhaustive discovery rather than
"retain everything eBay returned in this pass."

**eBay's Browse API `q` search is loose.** Ad hoc testing showed
"PSA 10 Pikachu" results including sequential-card lots, stamp boxes, and
other listings that merely *mention* Pikachu rather than being a graded
Pikachu card themselves. That's expected and fine for this raw-acquisition
phase (no filtering/matching happens here) but whoever eventually builds the
matching/cleanup layer on top of this raw data should not assume every
stored item is actually a single graded Pikachu card.
