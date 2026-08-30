# Curated database

For production runs, use the resumable parent pipeline documented in [`pipeline.md`](./pipeline.md). The commands below remain useful for targeted recovery and development.

The raw collectors and object store remain the acquisition layer. The
application-facing catalogue is materialized into the same SQLite database by:

```text
node src/cli/index.ts materialize
```

Run the TCGdex collector first when TCGdex observations are not present:

```text
node src/cli/index.ts run --source tcgdex
node src/cli/index.ts materialize
```

Use `--no-tcgdex` or `--no-psa` when rebuilding only one source. The PSA
materializer reads `data/psa-raw`; `data/psa-raw-test` is intentionally not
part of production materialization.

eBay listings are matched to card variants by `src/curated/ebay/` during the
same `materialize` pass; `npm run cli -- ebay-match-report` explains what it
decided and what to fix next. See [`docs/ebay-matching.md`](./ebay-matching.md).

The application should read `v_card_search`, `v_variant_search`, and
`v_variant_detail`. Raw payloads are available through `source_records`,
`source_links`, and their observation/object-store references. Unresolved PSA
matches are available through `v_open_match_reviews`. Confirmed manual links
are stored in `match_overrides` and are applied on every subsequent run.
# Staged catalogue workflow

The application catalogue is built from the set observations first; full card
details are optional hydration, not a prerequisite for search.

```text
npm run cli -- run --source tcgdex --stage index
npm run cli -- materialize --source tcgdex
npm run cli -- run --source tcgdex --stage details --priority psa
npm run psa:import
npm run cli -- materialize --source all
```

Use `--priority all` for the long background detail pass, `--scope set:base1`
for a targeted set, and `refresh --source tcgdex --stage <stage>` to requeue a
stage. Images are remote-first and cached on demand by the web server; the
images stage is optional.

TCGdex `variants_detailed` rows are complete physical issues. PSA population
and sales IDs remain separate and pair only through an explicit selection ID.
The production importer scans `data/psa-raw`; fixture data is test-only.
