# Professional data pipeline

## Supervisor (default operating mode)

The normal way to run the pipeline is the long-lived **supervisor daemon**. It watches a
persistent list of eBay search terms and advances every downstream stage independently, a
bounded slice per tick, publishing continuously — so matched auctions and PSA data appear in
the app within a minute or two instead of after a multi-hour batch.

```text
# one-time: sign in the PSA browser profile
npm run cli -- pipeline psa-login

# manage the eBay searches (targeted = fewer wasted eBay calls)
npm run cli -- pipeline terms add --query "charizard psa 10" --marketplace de
npm run cli -- pipeline terms add --query "base set psa 10" --marketplace eu \
  --buying-option auction --min-bids 3 --ending-within 48h \
  --price-min 50 --price-max 4000 --category 183454 --refresh 20m --priority 10
npm run cli -- pipeline terms list
npm run cli -- pipeline terms test <id>        # dry run: result count + estimated item-detail calls, fetches nothing
npm run cli -- pipeline terms set <id> --min-bids 1
npm run cli -- pipeline terms enable|disable|remove <id|query>

# run it
npm run cli -- pipeline start                  # the daemon (add to start.ps1 with -Pipeline)
npm run cli -- pipeline start --stages ingest,ebay-match,psa-cert
npm run cli -- pipeline start --retry-failed   # clear all dead-letters on startup
npm run cli -- pipeline stop                   # drains in-flight work, then exits (Ctrl+C also works)
npm run cli -- pipeline tick [all|<stage>]     # one bounded pass, then exit (for Task Scheduler / debugging)

# observe
npm run cli -- pipeline status [--watch] [--json]   # stage strip + quota + per-term funnels
#   also live at /pipelines in the web UI (read-only)

# failures
npm run cli -- pipeline failures [--stage <s>]
npm run cli -- pipeline retry --stage <s> [--scope <prefix>] [--all]
npm run cli -- pipeline dead-letter resolve --stage <s> --scope <key>   # won't-fix

# force a publication now
npm run cli -- pipeline publish --now
```

Supervisor stages: `ingest -> ebay-match -> psa-cert -> psa-identity -> psa-fetch -> publish`,
plus a daily `reconcile` full rebuild that heals any incremental drift. Each stage:

- does a bounded unit of work per tick and commits per item (no batch handoff),
- backs itself off when there's nothing to do,
- sends a permanently-failed item to a **visible dead-letter** and keeps going (one bad spec
  never aborts the pipeline),
- has a watchdog so a slow stage can't block the others.

`psa-fetch` only ever targets auctions that are **still live**, soonest-closing first — ended
auctions never cost PSA quota. eBay `auction` search terms fetch an item-detail call only for
listings with real bids ending inside the window.

Only one writer at a time: `pipeline start` and the one-shot `pipeline run` below are mutually
exclusive (the loser fails fast with "Another writer is active").

## One-shot run (CI / recovery)

The original sequential run is still available for a single controlled pass:

```text
npm run cli -- pipeline run --query "pikachu psa 10" --marketplaces de
```

Repeat `--query` for more search terms. `de` is the marketplace default; `eu` and `international` are explicit. A run executes:

```text
preflight -> catalogue-check -> ebay-ingest -> ebay-match -> psa-cert
          -> ebay-rematch -> psa-identity -> psa-fetch
          -> assemble -> validate -> publish
```

The command prints its pipeline run id. A failed run keeps all raw/checkpoint work and never changes the app's published generation:

```text
npm run cli -- pipeline status --run <id> --json
npm run cli -- pipeline resume --run <id>
npm run cli -- pipeline report --run <id>
```

Use `--dry-run` for a read-only catalogue/PSA-target summary. It does not create a pipeline run or open eBay/PSA sessions.

## Trust and coverage

Only exact (PSA certificate), strong, and manually confirmed variant matches are PSA enrichment targets. Flagged, cluster-propagated, card-level, review, lot, out-of-scope, catalogue-gap, and PSA-identity-gap results remain explicit operational outcomes.

eBay query/marketplace campaigns retain their item membership. Re-runs refresh only their search lineage and discovered details. Result sets above eBay's 10,000-row window are recursively price-partitioned; partitioned campaigns repeat search-only passes until item membership converges.

PSA population and guide data refresh after seven days. Sales use a complete first backfill, seven-day incremental refresh to a known overlap, and a complete 30-day audit. These fetches run as durable queue items and still write the established `data/psa-raw` checkpoints for import compatibility.

## Manual review

```text
npm run cli -- pipeline review list --source ebay
npm run cli -- pipeline review show <review-id>
npm run cli -- pipeline review sets
npm run cli -- pipeline review resolve-set --heading <psa-heading-id> --set <tcgdex-set-id> --by <name> --note "evidence"
npm run cli -- pipeline review resolve --review <id> --variant <variant-id> --by <name> --note "evidence"
npm run cli -- pipeline review dismiss --review <id> --by <name> --note "reason"
npm run cli -- pipeline review revoke --review <id> --by <name> --note "reason"
npm run cli -- pipeline review export --source ebay
npm run cli -- pipeline review import --file decisions.json
```

Review decisions are audited in revision rows. Active compatibility overrides remain in `match_overrides`, so the existing materializer and learned set-alias feedback loop continue to work.

## Publication

The working store remains `data/db.sqlite`. Assembly creates an immutable candidate database under `data/published/`, validates integrity, foreign keys, catalogue counts, trusted-match invariants, and app views, then atomically updates `data/published/current.json`. The web server hot-swaps to the referenced generation without changing routes or screens. The most recent three published databases are retained.

If eBay reaches its daily quota, the already acquired rows continue through matching and PSA enrichment. The pipeline then publishes a validated generation marked `partial`, including the pause reason, so the app can show the newest coherent waterfall state. Resume resets eBay and all downstream stages; the eventual complete pass replaces that generation with one marked `complete`. Operational pipeline, source, and review endpoints always read the working store and therefore remain live independently of the published catalogue generation.

The old `run --source ...`, `materialize`, and `psa-fetch-matched` commands remain expert/recovery tools. The parent pipeline is the production path.
