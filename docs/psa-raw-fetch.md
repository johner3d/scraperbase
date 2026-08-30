# PSA raw fetch

> Production note: `pipeline run` now schedules population, guide, and complete-history sales enrichment through durable per-spec work items. The standalone commands in this document remain compatibility and recovery tools; see [`pipeline.md`](./pipeline.md).

Everything built so far for getting population and sales-history data out of
PSA (psacard.com) for Pokemon cards. Three layers exist side by side right now:

1. **Legacy standalone scripts** (`src/scripts/psa-fetch.ts`,
   `psa-test-fetch.ts`) -- work, already used to pull real data, but depend on
   `data/psa-pre2019-en-selection.json`, a one-time snapshot originally copied
   from a sibling project. That snapshot is a dead end: it covers 27 of ~135
   pre-2019 English releases, nothing post-2019, and (confirmed live
   2026-08-29) is missing entries even within nominally-covered releases --
   e.g. only 3 of 53 Wizards Black Star Promo cards, which is why cards like
   Surfing Pikachu (`basep-28`) had no PSA data in the UI despite PSA having
   real population history for it. **Do not extend this snapshot further** --
   use the native pipeline below instead.
2. **Native discovery + materialization** (`src/sources/psa/collectors/
   popDiscovery.ts`, `setItems.ts`, `src/curated/psaSetMatch.ts`,
   `psaCardMatch.ts`) -- fully owned by this repo, zero external dependency.
   Crawls PSA's own `/pop/tcg-cards` population-report tree to discover every
   PSA "heading" (population-report set), matches each heading to a tcgdex
   set (`psa_set_map`), then per heading calls PSA's `/Pop/GetSetItems` to get
   every card + variety + per-grade population count in one call, matched to
   a tcgdex card/variant by card number (`src/curated/psaCardMatch.ts`). Run
   via `npm run cli -- run --source psa --stage index` (discovery) then
   `--stage details` (per-heading fetch); `materialize` then does the
   matching + curated writes. Check current coverage with
   `npm run cli -- psa-coverage`.
3. **A discovery `Collector`** (`src/sources/psa/discovery.ts`, PSA's older
   `GetSetList` endpoint) -- superseded by (2)'s richer `/Pop/GetSetItems`
   (which returns population counts, variety, and a modern unified spec id in
   one call); kept around only as a reference, not wired into any CLI command.

Section 4 covers the legacy queue module. Sections 2-3 cover the legacy
scripts. See the native pipeline's own doc comments in the files listed above
for the current, supported path.

**Known gap in the native pipeline (as of 2026-08-29):** population counts
are fully native and working end-to-end. Price-guide (`researchJourney.
getPriceSummary`) and sales (`researchJourney.getSalesBySpecId`) for natively
discovered cards are not yet ported -- confirmed live that both are called
from PSA's modern `/spec/psa/{id}` page using the *same* unified spec id
`/Pop/GetSetItems` already returns, so wiring them up is a follow-up, not a
redesign. Non-English `Variety` rows within an English-mapped heading (e.g.
"Pokemon League-French" rows inside the `basep` heading) are also currently
skipped rather than cross-set-resolved -- see `isEnglishRow()` in
`src/curated/psaCardMatch.ts`.

## 1. Auth and browser profile

| File | What it does |
|---|---|
| `src/cli/commands/psa-login.ts` | The only place a human enters PSA credentials: opens a real visible browser to PSA's sign-in page and waits (up to 10 min) for the URL to leave the sign-in host. Never reads a password. |
| `src/sources/psa/browser/profile.ts` | `launchPsaProfile({ headless })` -- the one shared entry point to a persistent Chromium profile at `data/psa-browser-profile/`. Strips Playwright's `--enable-automation` flag, adds `--disable-blink-features=AutomationControlled`, and patches `navigator.webdriver` to `undefined`. Also launches a **real installed Chrome** (`C:\Program Files\Google\Chrome\Application\chrome.exe`, falling back to Edge, overridable via `PSA_BROWSER_PATH`) instead of Playwright's bundled Chromium -- see "What to look out for" below for why that matters. |
| `src/sources/psa/browser/session.ts` | `checkSignedIn(context)` -- navigates to `/pop` and reports whether PSA redirected to sign-in. `looksLikeSignInRedirect(url)` is the underlying check, reused by `psa-login`. |

Run once, interactively:

```bash
npm run cli -- psa-login
```

After that, `data/psa-browser-profile/` holds a signed-in, Cloudflare-cleared
session that every other PSA tool reuses. It's gitignored (all of `data/` is).

## 2. Fetching data: the scripts

### `psa-fetch.ts` -- the real one

```bash
npx tsx src/scripts/psa-fetch.ts [--releases=base1,base2,...] [--only=population|sales|both] [--limit=N] [--offset=N] [--since=YYYY-MM-DD] [--force]
```

To backfill every missing raw file represented by the currently matched PSA
specs in the database, run:

```bash
npm run psa:fetch-missing
```

This is resumable: existing population files and complete price-history
checkpoints are skipped, while missing or incomplete files are fetched. Use
`npm run psa:fetch-missing -- --only=population` or
`npm run psa:fetch-missing -- --only=sales` to run one phase. When a separate
sales-namespace mapping is absent, the population spec ID is used as the
sales ID, which covers the normal PSA case without dropping the price-history
backfill.

Reads `data/psa-pre2019-en-selection.json` (see section 3 -- where that file
comes from), processes it **one release at a time** ("slices"), and for each
release:

1. Fetches population + price-guide + condition-census for every card
   (`GET /CardFacts/GetChartPopulation/{specId}` + the CardFacts page's HTML
   tables), skipping any `psaSpecId` that already has an output file.
2. If any card in that release has a resolved `salesSpecId`, establishes a
   sales session (navigates to the first sales URL, waits for sign-in if
   redirected) and fetches paginated sold-listing history
   (`researchJourney.getSalesBySpecId` tRPC API, PSA-10 only, 5 rows/page,
   paginated back to `--since`, default 2 years ago).

| Flag | Meaning |
|---|---|
| `--releases=a,b,c` | Only these release prefixes (TCGdex-style, e.g. `base1`). Default: every release present in the selection file, in file order. |
| `--only=population\|sales\|both` | Default `both`. |
| `--limit=N` / `--offset=N` | Slice each release's entry list -- for pacing a run, not for safety. |
| `--since=YYYY-MM-DD` | Sales cutoff. Default: exactly 2 years before today. |
| `--force` | Refetch even if the output file already exists. |

**Output**: `data/psa-raw/<release>/population/<psaSpecId>.json` and
`data/psa-raw/<release>/sales/<salesSpecId>.json`. One file per card, each
self-contained (identity fields + fetch metadata + raw payload).

**Resumability**: a file's presence is the checkpoint, same as the sister
project's tools. Stop anytime; rerun the same command to pick up where it
left off. `--force` overrides that.

**Safety valve**: after 3 consecutive failures in a phase, the script pauses
60s before continuing (`maybeCooldown`) rather than hammering PSA through a
rate limit or re-challenge. If failures keep happening after a cooldown,
that's a signal to stop and investigate, not to let it spin for hours.

### `psa-fetch-matched` -- the targeted one

```bash
npm run cli -- psa-fetch-matched --dry-run
npm run cli -- psa-fetch-matched [--limit=N] [--force] [--max-age=DAYS] [--only=population|sales|both] [--since=YYYY-MM-DD] [--tiers=exact,strong] [--exclude-flagged] [--live-auctions] [--no-import] [--json]
```

Same fetch engine (`src/sources/psa/rawFetch.ts`, shared with `psa-fetch.ts`),
different targets: instead of a release-year slice of the whole catalogue, it
fetches only the card variants that **currently have matched eBay listings**,
deduplicated to one fetch per PSA spec no matter how many auctions point at
it. This is the on-demand companion to a matching run -- the bulk
through-2009 walk is both slow and pointed at the wrong cards, since the eBay
feed is as modern as it is vintage.

Target selection lives in `src/curated/psaTargets.ts`
(`selectEbayMatchedTargets`): `ebay_listings` joined to `psa_specs` via
`variant_id`, `match_status IN ('matched','manual')`, `GROUP BY spec_id`.

| Flag | Meaning |
|---|---|
| `--dry-run` | Print the targets and the unresolved-set work list, then exit. No browser, no run row, no writes. |
| `--limit=N` | Cap the fetch, applied after deduplication. |
| `--force` | Refetch regardless of what is already on disk. |
| `--max-age=DAYS` | Without `--force`, refetch anything saved longer ago than this. Default 7; `0` restores the old "skip if the file exists" behaviour. |
| `--tiers=` / `--exclude-flagged` / `--live-auctions` | Narrow which matched listings count. `--live-auctions` is the `/auctions` dashboard slice: trusted tier, unflagged, single card, PSA 10. |
| `--only=` / `--since=` | As `psa-fetch.ts`. |
| `--no-import` | Fetch files only, skipping the DB import + materialize. |

**Persistence**: unless `--no-import`, the files it just wrote are imported via
`psa-backfill-import.ts` and then materialized. Note that the PSA materialize
is a **full rebuild** by design (`materializePsa` opens with
`DELETE FROM psa_specs` and re-reads all of `data/psa-raw` plus the native pop
observations), so it costs the same whether the run fetched 3 specs or 300 --
for a tight fetch loop use `--no-import` and materialize once at the end.

**Coverage limit worth knowing**: a matched variant is only fetchable if it
already has a `psa_specs` population row, because the spec ID is what every
PSA endpoint is keyed by. As of 2026-08-30, 130 of 684 matched variants do;
the other 554 (concentrated in modern JP/SV sets) need
`run --source psa --stage index|details` to crawl PSA's pop-report tree and
mint their spec IDs first. They are never silently dropped -- `--dry-run`
lists them grouped by set.

**Background runs**: `.\scripts\start-psa-matched.ps1 [extra args]` launches it
detached with a PID guard (`data/psa-matched.pid`) and logs to
`data/psa-matched.log`; `.\scripts\stop-psa-fetch.ps1` stops either ingest.

### `psa-test-fetch.ts` -- the smoke test

Same mechanics, hardcoded to a small hand-picked spread of 10 Base Set
variants (`data/psa-test-selection.json`), with sales pagination capped at 5
pages (deliberately partial -- this is for proving the mechanism works, not
for real coverage). Supports `--population-only` and
`--only-spec-ids=id1,id2,...` for targeted retries. Output:
`data/psa-raw-test/`. Keep this around as a fast way to sanity-check the
pipeline (e.g. after a PSA layout change) without kicking off a multi-hour
run.

### `psa-explore.ts` -- the original diagnostic

Pre-existing (not written this session). Opens PSA's Auction Prices Realized
page with a real, headed, **completely unpatched** Chrome and waits for a
human to look -- used to confirm PSA's Cloudflare check even flags an honest,
un-stealthed real browser. Not part of any regular workflow; keep for future
Cloudflare-behavior debugging.

## 3. Where the selection files come from

Scraperbase has no catalog database of its own (deliberately -- see the
"raw-first" design in the Aug 28 commit). Matching a physical PSA
population/sales spec ID to a specific card+finish+printing is the one part
of this pipeline that needs a catalog to resolve variant ambiguity, and that
catalog only exists in the sibling project `C:\Data\clean_rewrite`
(`data/psa-population-map.json`, `data/psa-sales-map.json`, built by its own
`scripts/discover-psa-set-sources.ts` + `scripts/build-psa-population-map.ts`
+ `scripts/resolve-psa-sales-map.ts` -- not duplicated here).

`data/psa-pre2019-en-selection.json` and `data/psa-test-selection.json` are
**snapshots** pulled from those files with a one-off script (not committed --
see below), filtered to English, pre-2019-release-date entries, cross-joined
with `psa-sales-map.json` on `(sourceCardId, finish, printRunMarker,
microVariant)` to attach a `salesSpecId` where one's been resolved. Each
entry:

```json
{
  "release": "base1",
  "sourceCardId": "base1-4",
  "finish": "holo",
  "printRunMarker": "unlimited",
  "psaSpecId": 605252,
  "popSourceUrl": "https://www.psacard.com/cardfacts/pokemon/base-set/card/605252",
  "salesSpecId": 1748782,
  "salesSourceUrl": "https://www.psacard.com/spec/psa/1748782"
}
```

**If you need to regenerate or extend this selection** (e.g. once more
releases get mapped in `clean_rewrite`), re-run the filter script against
`clean_rewrite`'s current `data/psa-population-map.json` /
`data/psa-sales-map.json` -- ask for it to be rebuilt rather than hand-editing
the JSON.

### Current coverage

Of 135 pre-2019 English releases, **only 27 have PSA spec-ID mappings
resolved** in `clean_rewrite` (1276 population entries; 388 of those also
have a resolved `salesSpecId` -- base1/2/3/5, gym1/2, neo1/2/3/4, si1;
ecard1-3/ex1-11/lc have population mapped but sales IDs not resolved yet).
**108 releases have zero mapping** (Diamond & Pearl through Sun & Moon 2018,
most EX-era sets, McDonald's promos, trainer kits, etc.) -- those need
`clean_rewrite`'s discovery pipeline to run first (live `GetSetList`
crawling + variant-resolution parsing, some of which needs manual
disambiguation of ambiguous matches). That's a separate, larger task, not a
fetch -- `psa-fetch.ts` can't do anything for a release with no selection
entries.

## 4. The queue-driven module (not wired up yet)

For the eventual real collector, matching the TCGdex source's shape:

| File | Status |
|---|---|
| `src/sources/psa/config.ts` | `PSA_BASE`, `cardFactsUrl()` -- rebuilds CardFacts URLs from spec ID alone (PSA's generated slugs are sometimes malformed). |
| `src/sources/psa/scopeKeys.ts` | Key builders: `discoverySetScopeKey`, `cardIdentityScopeKey`, `populationScopeKey`, `cardFactsHtmlScopeKey`, `salesPageScopeKey`. |
| `src/sources/psa/discovery.ts` | `createPsaDiscoveryCollector(deps)` -- a `Collector` that calls `POST /cardfacts/GetSetList` through an authenticated `Page`, stores the raw JSON, and fans out one `card_identity` work item per card. `seedPsaDiscovery(db, psaSetIds)` enqueues a caller-supplied list of PSA CardFacts set IDs. |

**Missing** before this becomes real: a population/CardFacts-HTML collector
and a sales collector (the logic already exists and works in
`psa-fetch.ts` -- it needs porting into the `Collector` shape), a CLI command
registering these queues with `runQueue`, and a decision on whether
`psa-fetch.ts`'s selection-file approach or this queue's own
`GetSetList`-driven discovery is the long-term path for resolving PSA spec
IDs (they're not the same mechanism -- `GetSetList` gets you every card in a
PSA *set*, not the finish/printing variant resolution that
`clean_rewrite`'s catalog does).

## What to look out for

**Playwright's bundled Chromium gets blocked; real Chrome doesn't.** The
first full attempt at this (headless, bundled Chromium) got 403s on
population and 401s on sales even with a valid, already-signed-in session
cookie. Switching to a real installed Chrome executable (headed) fixed
population outright. This is why `profile.ts` auto-detects a real Chrome/Edge
install rather than using Playwright's default.

**Never run two instances against the same browser profile at once.**
Confirmed live during this session: a leftover Chrome process from an earlier
attempt held the `data/psa-browser-profile/` lock and the next launch failed
with "Opening in existing browser session." On Windows, killing the top-level
`npx tsx` process is not enough -- verify no process still references the
profile dir before retrying:

```powershell
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match "psa-browser-profile" } | Select-Object ProcessId, Name
```

If any remain, `Stop-Process -Id <id> -Force -ErrorAction SilentlyContinue`
each one.

**The first few requests after bootstrap can 403 even on real Chrome.** In
one run, the first 4 population requests failed with 403 and everything
after succeeded cleanly; a bare retry a minute later cleared it with no other
change. Looks like a brief warm-up/rate window right after the session is
established, not a real block -- the cooldown safety valve should absorb this
automatically in `psa-fetch.ts`, but don't be alarmed by early failures in a
fresh run.

**Sales needs its own session-establishing navigation.** The tRPC sales API
returns 401 UNAUTHORIZED unless the page has actually navigated to a
`/spec/psa/{salesSpecId}` URL first (once per run, using the first sales
entry) -- population's `GetChartPopulation` endpoint doesn't have this
requirement. Both scripts do this; a future port into a `Collector` needs to
preserve it.

**The two source URLs are not interchangeable.** Population scrapes the price
guide and condition-census tables, and only the CardFacts page
(`cardFactsUrl()` in `sources/psa/config.ts`) carries them -- a `/spec/psa/`
fetch returns HTML with neither table and silently saves empty `priceRows`
and `censusRows`. Sales is the other way round: it uses its URL only to
establish the session, and the tRPC API 401s unless the page navigated to
`/spec/psa/`. Confirmed live 2026-08-30, after the DB-derived selection path
had been building `/spec/psa/` URLs for both.

**Zero sales/price/census rows is often normal, not a failure.** Many cards
have no recorded PSA-10 sales in the lookback window, or no price-guide data
at all -- an empty result is an expected outcome, not something to retry.
