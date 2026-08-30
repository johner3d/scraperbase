# Professional data pipeline

The production workflow is a durable parent run over the existing raw collectors and curated materializer:

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
