import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { launchPsaProfile } from '../sources/psa/browser/profile.ts';
import { DATA_DIR, DB_PATH } from '../core/config/config.ts';
import { cardFactsUrl, PSA_BASE } from '../sources/psa/config.ts';
import {
  BOOTSTRAP_URL, OUT_DIR, indexSalesCheckpoints, installStopHandlers, runPopulation, runSales, shouldStop,
  type Selection,
} from '../sources/psa/rawFetch.ts';

// Bulk PSA raw fetcher: population + sales for a curated selection of
// {psaSpecId/salesSpecId, sourceUrl} entries, grouped by release ("slice").
// Zero catalog/DB dependency in the fetch path -- the selection file is plain
// PSA identifiers. The browser/retry/checkpoint engine lives in
// src/sources/psa/rawFetch.ts and is shared with the `psa-fetch-matched` CLI
// command, which targets the specs behind matched eBay auctions instead of a
// release-year slice.

const SELECTION_PATH = path.join(DATA_DIR, 'psa-pre2019-en-selection.json');

interface Options {
  releases: string[] | null; // null = every release present in the selection file
  only: 'population' | 'sales' | 'both';
  limit: number | null;
  offset: number;
  force: boolean;
  since: string;
  fromDb: boolean;
  throughYear: number | null;
}

function parseOptions(argv: readonly string[]): Options {
  let releases: string[] | null = null;
  let only: Options['only'] = 'both';
  let limit: number | null = null;
  let offset = 0;
  let force = false;
  let fromDb = false;
  let throughYear: number | null = null;
  const cutoff = new Date();
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 2);
  let since = cutoff.toISOString().slice(0, 10);

  for (const arg of argv) {
    if (arg.startsWith('--releases=')) releases = arg.slice('--releases='.length).split(',').filter(Boolean);
    else if (arg.startsWith('--only=')) {
      const value = arg.slice('--only='.length);
      if (value !== 'population' && value !== 'sales' && value !== 'both') throw new Error(`--only must be population, sales, or both (got ${value})`);
      only = value;
    } else if (arg.startsWith('--limit=')) limit = Number(arg.slice('--limit='.length));
    else if (arg.startsWith('--offset=')) offset = Number(arg.slice('--offset='.length));
    else if (arg.startsWith('--since=')) since = arg.slice('--since='.length);
    else if (arg === '--from-db') fromDb = true;
    else if (arg.startsWith('--through-year=')) throughYear = Number(arg.slice('--through-year='.length));
    else if (arg === '--force') force = true;
    else throw new Error(`Unknown option: ${arg}`);
  }

  if (limit !== null && (!Number.isSafeInteger(limit) || limit <= 0)) throw new Error('--limit must be a positive integer');
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('--offset must be a non-negative integer');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) throw new Error(`Invalid --since date: ${since}`);
  if (throughYear !== null && (!Number.isSafeInteger(throughYear) || throughYear < 1996 || throughYear > 2100)) {
    throw new Error('--through-year must be an integer from 1996 to 2100');
  }
  if (throughYear !== null && !fromDb) throw new Error('--through-year requires --from-db');

  return { releases, only, limit, offset, force, since, fromDb, throughYear };
}

function selectionsFromDb(options: Options): Selection[] {
  const db = new DatabaseSync(DB_PATH);
  try {
    const clauses = [
      `ps.namespace = 'population'`,
      `ps.match_status IN ('matched', 'manual')`,
      `s.language = 'en'`,
      `s.series <> 'Pokémon TCG Pocket'`,
    ];
    const params: Array<string> = [];
    if (options.throughYear !== null) {
      clauses.push('s.release_date < ?');
      params.push(`${options.throughYear + 1}-01-01`);
    }
    const rows = db.prepare(`
      SELECT s.source_set_id AS release, s.source_set_id || '-' || c.local_id AS sourceCardId,
        COALESCE(v.finish, 'unknown') AS finish,
        COALESCE(v.print_run_marker, 'unknown') AS printRunMarker,
        v.micro_variant AS microVariant, ps.spec_id AS specId,
        // Most PSA cards use the same ID for population and sales. Older
        // imported data may not yet have a separate sales-namespace row, so
        // keep those cards in the price-history backfill instead of silently
        // dropping them. If alternate sales IDs exist, prefer the explicit
        // mapping (the historical selection snapshot may contain one).
        COALESCE(MAX(ss.spec_id), ps.spec_id) AS salesSpecId
      FROM psa_specs ps
      LEFT JOIN psa_specs ss ON ss.variant_id = ps.variant_id
        AND ss.namespace = 'sales' AND ss.match_status IN ('matched', 'manual')
      JOIN variants v ON v.variant_id = ps.variant_id
      JOIN cards c ON c.card_id = v.card_id
      JOIN sets s ON s.set_id = c.set_id
      WHERE ${clauses.join(' AND ')}
      GROUP BY ps.spec_id
      ORDER BY s.release_date, s.source_set_id, c.local_sort_key, ps.spec_id
    `).all(...params) as unknown as Array<{
      release: string; sourceCardId: string; finish: string; printRunMarker: string;
      microVariant: string | null; specId: string; salesSpecId: string | null;
    }>;
    return rows.map((row) => {
      const specId = Number(row.specId);
      return {
        release: row.release,
        sourceCardId: row.sourceCardId,
        finish: row.finish,
        printRunMarker: row.printRunMarker,
        microVariant: row.microVariant ?? undefined,
        psaSpecId: specId,
        // CardFacts for population, /spec/psa/ for the sales session -- they
        // are not interchangeable. See the note in curated/psaTargets.ts.
        popSourceUrl: cardFactsUrl(specId),
        salesSpecId: row.salesSpecId == null ? null : Number(row.salesSpecId),
        salesSourceUrl: row.salesSpecId == null ? null : `${PSA_BASE}/spec/psa/${row.salesSpecId}`,
      };
    });
  } finally {
    db.close();
  }
}

function slice<T>(list: T[], options: Options): T[] {
  const from = list.slice(options.offset);
  return options.limit === null ? from : from.slice(0, options.limit);
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const all = options.fromDb
    ? selectionsFromDb(options)
    : JSON.parse(fs.readFileSync(SELECTION_PATH, 'utf8')) as Selection[];
  const releaseOrder = options.releases ?? [...new Set(all.map((e) => e.release))];
  indexSalesCheckpoints();
  installStopHandlers();

  const context = await launchPsaProfile({ headless: false });
  const page = await context.newPage();
  try {
    console.log(`Bootstrapping session via ${BOOTSTRAP_URL}...`);
    await page.goto(BOOTSTRAP_URL, { waitUntil: 'domcontentloaded', timeout: 180_000 });

    for (const release of releaseOrder) {
      if (shouldStop()) break;
      const entries = slice(all.filter((e) => e.release === release), options);
      if (entries.length === 0) continue;
      console.log(`\n=== ${release}: ${entries.length} entrie(s) ===`);
      if (options.only !== 'sales') await runPopulation(page, release, entries, { force: options.force });
      if (options.only !== 'population') await runSales(page, release, entries, { force: options.force, cutoffIso: options.since });
    }
  } finally {
    await context.close();
  }
  console.log(`\nDone. Raw data written under ${OUT_DIR}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
