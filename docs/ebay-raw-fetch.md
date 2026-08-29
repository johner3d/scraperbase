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

**Status as of this writing: implemented, typechecked, and unit-tested, but
NOT yet verified against the live eBay API end-to-end** -- a concurrent
exclusive `pokemoncard` run held the single-writer lock (see "What to look
out for" below) and the live smoke test was still pending when this doc was
written. **Whoever picks this up next should run the smoke test in
"Verifying it works" before trusting any of this in a real acquisition run,
and update this doc's status line once it's done.**

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
   No `buyingOptions` filter -- confirmed with the user to capture **every**
   listing type (auction, fixed-price, best-offer), not just auctions,
   despite "auction fetcher" being this feature's working name. Stores the
   entire raw response verbatim (item summaries, `total`, pagination
   metadata, everything). Parses just enough to:
   - enqueue one `ebay_item_detail` work item per `itemId` found (scope key
     is marketplace/query-independent, so the same listing found by two
     different searches -- or on two marketplaces -- is only ever
     detail-fetched once), and
   - enqueue the next page (`offset += limit`) if `offset+limit < total`
     **and** still under the configured `--max-items` cap.
2. **Item detail** (`src/sources/ebay/collectors/itemDetail.ts`, queue
   `ebay_item_detail`, entity_type `item`) -- `GET /buy/browse/v1/item/<itemId>`.
   Confirmed with the user to always run (not optional) despite multiplying
   API calls roughly 1:1 with items found -- this is where the *real* raw
   data lives: full description, item specifics, seller details, shipping
   and return policy, every image rendition, condition descriptors, etc.
   Leaf node, no further fan-out.

Both collectors follow the same success/failure/`schema_drift` shape as
every other collector in this codebase (`classifyHttpStatus`, always store
the bytes even on a parse failure so nothing observed is ever lost).

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

Item-detail work items are shared across every search/marketplace (scope key
is just `item:<itemId>`), so `refresh --stage detail` resets *all* known
items regardless of which search originally found them.

## Files

| File | What it does |
|---|---|
| `src/sources/ebay/config.ts` | `EBAY_MARKETPLACES`, `EBAY_RAW_DIRS`, API base URLs, `loadEbayCredentials()`, defaults (`DEFAULT_EBAY_QUERY = "pikachu psa 10"`, `DEFAULT_EBAY_PAGE_LIMIT = 200`, `DEFAULT_EBAY_MAX_ITEMS = 1000`). |
| `src/sources/ebay/auth.ts` | `getEbayAccessToken()` -- cached OAuth2 client-credentials token. |
| `src/sources/ebay/scopeKeys.ts` | `searchPageScopeKey(marketplace, query, offset)`, `itemScopeKey(itemId)` (marketplace/query-independent by design). |
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
# Full run across all three marketplaces, default query, default caps
node src/cli/index.ts run --source ebay

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

Not yet run against the live API as of this doc. To smoke-test:

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

## What's deliberately NOT built

No parsing of item fields into structured tables, no matching to the
curated card catalogue (`source_records`/`source_links`/`assets` from
`schema_v2.sql`), no coverage-table usage (eBay's `total` can run into the
thousands and search results are inherently unstable between requests, so
"complete" coverage isn't really a meaningful state the way it is for a
static catalogue), no rate-limit tuning beyond a conservative hardcoded
default (`minDelayMs: 250, jitterMs: 150`, shared across both queues -- eBay
Browse API's actual allowance is likely much higher; this hasn't been
pushed or measured against real quota limits yet).

## What to look out for

**Single-writer exclusivity blocks concurrent sources, not just concurrent
eBay runs.** `run --source ebay` cannot start while *any* other `run` is
active (confirmed live during this build: a `pokemoncard` image-fetch run
holding ~6900 pending items blocked the first eBay smoke test). Check
`status` and the run's heartbeat recency before assuming a "running" row is
actually dead -- `createRun` only auto-cancels rows whose heartbeat is >2
minutes stale.

**`--max-items` is a hard safety cap, not a target.** eBay's `total` for
"pikachu psa 10" internationally was over 3000 in ad hoc testing; the
default cap (1000 per marketplace per query) will not capture everything.
Raise it (or drop it -- unclear if the collector currently supports
"uncapped"; check `search.ts`'s `nextOffset < params.maxItems` condition
before assuming `--max-items 0` means unlimited, it doesn't as written) once
real rate-limit headroom is confirmed.

**Item-detail fetching multiplies API calls roughly 1:1 with items found.**
A `--max-items 1000` run across three marketplaces could mean on the order
of thousands of item-detail calls on top of the search-page calls
themselves, even accounting for the cross-marketplace item-id dedup. Watch
eBay's daily Browse API call quota if running this at full scope repeatedly.

**eBay's Browse API `q` search is loose.** Ad hoc testing showed
"PSA 10 Pikachu" results including sequential-card lots, stamp boxes, and
other listings that merely *mention* Pikachu rather than being a graded
Pikachu card themselves. That's expected and fine for this raw-acquisition
phase (no filtering/matching happens here) but whoever eventually builds the
matching/cleanup layer on top of this raw data should not assume every
stored item is actually a single graded Pikachu card.
