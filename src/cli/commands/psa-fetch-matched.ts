import { parseArgs } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import { openCliDb } from '../context.ts';
import { createRun, finishRun } from '../../core/queue/run.ts';
import { logEvent } from '../../core/events/eventLog.ts';
import { launchPsaProfile } from '../../sources/psa/browser/profile.ts';
import {
  BOOTSTRAP_URL, OUT_DIR, indexSalesCheckpoints, installStopHandlers, runPopulation, runSales, shouldStop,
  type PhaseStats, type Selection,
} from '../../sources/psa/rawFetch.ts';
import { selectEbayMatchedTargets, type MatchedTargets } from '../../curated/psaTargets.ts';
import { importPopulationFile, importSalesFile, linkPopulationToSales } from '../../scripts/psa-backfill-import.ts';
import { materialize } from '../../curated/materialize.ts';

/**
 * Targeted PSA fetch: population + price history for exactly the card variants
 * that currently have matched eBay auctions, and nothing else.
 *
 * The bulk path (`scripts/start-psa-through-2009.ps1` -> psa-fetch.ts) walks
 * every pre-2010 spec in the catalogue, which is slow and misses the modern
 * cards the eBay feed is full of. This walks the other way round: eBay matches
 * first, deduplicated to one fetch per PSA spec.
 *
 * Note on --no-import: the PSA materialize step is a full rebuild by design
 * (materializePsa opens with DELETE FROM psa_specs and re-reads the whole
 * data/psa-raw tree plus the native pop observations), so it costs the same
 * whether this run fetched 3 specs or 300. For a tight fetch loop, pass
 * --no-import and materialize once at the end.
 */

const DAY_MS = 86_400_000;

interface Options {
  dryRun: boolean;
  limit: number | null;
  force: boolean;
  maxAgeMs: number | null;
  only: 'population' | 'sales' | 'both';
  since: string;
  tiers: string[] | undefined;
  excludeFlagged: boolean;
  liveAuctions: boolean;
  noImport: boolean;
  json: boolean;
}

function parseOptions(args: string[]): Options {
  const { values } = parseArgs({
    args,
    options: {
      'dry-run': { type: 'boolean', default: false },
      limit: { type: 'string' },
      force: { type: 'boolean', default: false },
      'max-age': { type: 'string', default: '7' },
      only: { type: 'string', default: 'both' },
      since: { type: 'string' },
      tiers: { type: 'string' },
      'exclude-flagged': { type: 'boolean', default: false },
      'live-auctions': { type: 'boolean', default: false },
      'no-import': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
    },
  });

  const only = String(values.only);
  if (only !== 'population' && only !== 'sales' && only !== 'both') {
    throw new Error(`--only must be population, sales, or both (got ${only})`);
  }

  let limit: number | null = null;
  if (values.limit != null) {
    limit = Number(values.limit);
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('--limit must be a positive integer');
  }

  const maxAgeDays = Number(values['max-age']);
  if (!Number.isFinite(maxAgeDays) || maxAgeDays < 0) throw new Error('--max-age must be a non-negative number of days');

  const cutoff = new Date();
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 2);
  const since = values.since != null ? String(values.since) : cutoff.toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) throw new Error(`Invalid --since date: ${since}`);

  const tiers = values.tiers != null ? String(values.tiers).split(',').map((t) => t.trim()).filter(Boolean) : undefined;

  return {
    dryRun: Boolean(values['dry-run']),
    limit,
    force: Boolean(values.force),
    // 0 disables the freshness check entirely (skip anything already on disk).
    maxAgeMs: maxAgeDays === 0 ? null : maxAgeDays * DAY_MS,
    only,
    since,
    tiers,
    excludeFlagged: Boolean(values['exclude-flagged']),
    liveAuctions: Boolean(values['live-auctions']),
    noImport: Boolean(values['no-import']),
    json: Boolean(values.json),
  };
}

function groupByRelease(selections: Selection[]): Map<string, Selection[]> {
  const groups = new Map<string, Selection[]>();
  for (const entry of selections) {
    const group = groups.get(entry.release) ?? [];
    group.push(entry);
    groups.set(entry.release, group);
  }
  return groups;
}

function printTargets(targets: MatchedTargets, options: Options): void {
  console.log(`Found ${targets.selections.length} unique PSA spec(s) across ${targets.variantCount} variant(s) and ${targets.listingCount} matched eBay listing(s).`);
  if (options.limit != null && targets.totalSpecs > targets.selections.length) {
    console.log(`  (--limit=${options.limit} applied; ${targets.totalSpecs} spec(s) match the filter in total)`);
  }
  console.log('');
  for (const entry of targets.selections) {
    console.log(`  ${entry.release.padEnd(10)} ${entry.sourceCardId.padEnd(18)} ${`${entry.finish}/${entry.printRunMarker}`.padEnd(28)} spec ${entry.psaSpecId}`);
  }
  if (targets.unresolved.length === 0) return;
  console.log('');
  console.log(`${targets.unresolvedVariants} matched variant(s) have no PSA spec yet and cannot be fetched. By set:`);
  for (const row of targets.unresolved.slice(0, 25)) {
    console.log(`  ${String(row.variants).padStart(5)}  ${String(row.sourceSetId).padEnd(12)} ${row.releaseDate ?? ''}`);
  }
  if (targets.unresolved.length > 25) console.log(`  ... and ${targets.unresolved.length - 25} more set(s)`);
  console.log('');
  console.log('  Mint their spec IDs with PSA\'s own pop-report crawl, then re-run this command:');
  console.log('    npm run cli -- run --source psa --stage index');
  console.log('    npm run cli -- run --source psa --stage details');
}

async function importFetched(db: DatabaseSync, runId: string, population: string[], sales: string[]): Promise<{ imported: number; skipped: number }> {
  let imported = 0, skipped = 0;
  for (const file of population) {
    if (await importPopulationFile(db, file, runId) === 'imported') imported++; else skipped++;
  }
  for (const file of sales) {
    if (await importSalesFile(db, file, runId) === 'imported') imported++; else skipped++;
  }
  linkPopulationToSales(db);
  return { imported, skipped };
}

export async function psaFetchMatchedCommand(args: string[]): Promise<void> {
  const options = parseOptions(args);
  const db = openCliDb();
  const startedAt = Date.now();

  const targets = selectEbayMatchedTargets(db, {
    tiers: options.tiers,
    excludeFlagged: options.excludeFlagged,
    liveAuctionsOnly: options.liveAuctions,
    limit: options.limit,
  });

  if (options.dryRun) {
    // No run row and no browser: a dry run must be free and side-effect free.
    if (options.json) {
      console.log(JSON.stringify({
        specs: targets.selections.length, totalSpecs: targets.totalSpecs, variants: targets.variantCount,
        listings: targets.listingCount, unresolvedVariants: targets.unresolvedVariants,
        selections: targets.selections, unresolved: targets.unresolved,
      }, null, 2));
    } else {
      printTargets(targets, options);
    }
    db.close();
    return;
  }

  const runId = createRun(db, 'psa-fetch-matched', {
    only: options.only, limit: options.limit, force: options.force, since: options.since,
    tiers: options.tiers, liveAuctions: options.liveAuctions, specs: targets.selections.length,
  }, true);
  logEvent(db, {
    runId, level: 'info', category: 'collection',
    message: `Targeted PSA fetch: ${targets.selections.length} spec(s) across ${targets.variantCount} variant(s) and ${targets.listingCount} matched eBay listing(s); ${targets.unresolvedVariants} matched variant(s) have no PSA spec`,
  });

  const pop: PhaseStats = { fetched: 0, skipped: 0, failed: 0, written: [] };
  const sales: PhaseStats = { fetched: 0, skipped: 0, failed: 0, written: [] };
  const add = (into: PhaseStats, from: PhaseStats): void => {
    into.fetched += from.fetched; into.skipped += from.skipped; into.failed += from.failed;
    into.written.push(...from.written);
  };

  try {
    console.log(`Found ${targets.selections.length} unique PSA spec(s) across ${targets.variantCount} variant(s) and ${targets.listingCount} matched eBay listing(s).`);
    if (targets.unresolvedVariants > 0) {
      console.log(`${targets.unresolvedVariants} matched variant(s) have no PSA spec and are skipped -- run with --dry-run to see them by set.`);
    }
    if (targets.selections.length === 0) {
      console.log('Nothing to fetch.');
      finishRun(db, runId, 'completed');
      return;
    }

    indexSalesCheckpoints();
    installStopHandlers();
    const fetchOptions = { force: options.force, maxAgeMs: options.force ? null : options.maxAgeMs };

    const context = await launchPsaProfile({ headless: false });
    const page = await context.newPage();
    try {
      console.log(`Bootstrapping session via ${BOOTSTRAP_URL}...`);
      await page.goto(BOOTSTRAP_URL, { waitUntil: 'domcontentloaded', timeout: 180_000 });

      const groups = groupByRelease(targets.selections);
      let batch = 0;
      for (const [release, entries] of groups) {
        if (shouldStop()) break;
        batch++;
        console.log(`\n=== [${batch}/${groups.size}] ${release}: ${entries.length} spec(s) ===`);
        if (options.only !== 'sales') add(pop, await runPopulation(page, release, entries, fetchOptions));
        if (options.only !== 'population') add(sales, await runSales(page, release, entries, { ...fetchOptions, cutoffIso: options.since }));
      }
    } finally {
      await context.close();
    }

    let importResult = { imported: 0, skipped: 0 };
    let materialized: Awaited<ReturnType<typeof materialize>> | null = null;
    if (!options.noImport && (pop.written.length > 0 || sales.written.length > 0)) {
      console.log(`\nImporting ${pop.written.length + sales.written.length} fetched file(s) into the database...`);
      importResult = await importFetched(db, runId, pop.written, sales.written);
      console.log('Materializing PSA curated tables (full rebuild -- see --no-import)...');
      materialized = await materialize(db, { includeTcgdex: false, includeEbay: false, includeEcb: false });
    }

    finishRun(db, runId, shouldStop() ? 'cancelled' : 'completed');

    const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
    if (options.json) {
      console.log(JSON.stringify({
        runId, specs: targets.selections.length, variants: targets.variantCount, listings: targets.listingCount,
        unresolvedVariants: targets.unresolvedVariants, population: pop, sales, import: importResult,
        materialized, elapsedSec,
      }, null, 2));
      return;
    }

    console.log('');
    console.log(`Done in ${elapsedSec}s. Raw data under ${OUT_DIR}`);
    console.log(`  population  fetched=${pop.fetched} skipped=${pop.skipped} failed=${pop.failed}`);
    console.log(`  sales       fetched=${sales.fetched} skipped=${sales.skipped} failed=${sales.failed}`);
    if (!options.noImport) {
      console.log(`  imported    ${importResult.imported} file(s) (${importResult.skipped} unchanged)`);
      if (materialized) {
        console.log(`  materialized population rows=${materialized.populationRows} price rows=${materialized.priceRows} census rows=${materialized.censusRows} sales rows=${materialized.salesRows}`);
      }
    } else {
      console.log('  import      skipped (--no-import); run `npm run psa:import` then `npm run cli -- materialize --source psa`');
    }
    if (targets.unresolvedVariants > 0) {
      console.log(`  unresolved  ${targets.unresolvedVariants} matched variant(s) across ${targets.unresolved.length} set(s) still need PSA spec IDs`);
    }
  } catch (error) {
    finishRun(db, runId, 'failed');
    logEvent(db, {
      runId, level: 'error', category: 'collection',
      message: `Targeted PSA fetch failed: ${error instanceof Error ? error.message : String(error)}`,
    });
    throw error;
  } finally {
    db.close();
  }
}
