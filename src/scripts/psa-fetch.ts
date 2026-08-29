import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright';
import { launchPsaProfile } from '../sources/psa/browser/profile.ts';
import { DATA_DIR } from '../core/config/config.ts';

// Bulk PSA raw fetcher: population + sales for a curated selection of
// {psaSpecId/salesSpecId, sourceUrl} entries, grouped by release ("slice").
// Zero catalog/DB dependency -- the selection file is plain PSA identifiers,
// same spirit as the sibling clean_rewrite project's fetscha/fetch.ts and
// scripts/psa-scrape-raw.ts, which this supersedes the smoke-test version of.

const SELECTION_PATH = path.join(DATA_DIR, 'psa-pre2019-en-selection.json');
const OUT_DIR = path.join(DATA_DIR, 'psa-raw');
const SALES_PAGE_SIZE = 5; // hard server-side limit, confirmed live
const SALES_MAX_PAGES = 10_000; // real safety cap -- termination is via --since cutoff, not this
const SALES_REQUEST_DELAY_MS = 600;
const POPULATION_REQUEST_DELAY_MS = 800;
const RETRYABLE_STATUS = new Set([429, 502, 503, 504, 524]);
const MAX_RETRIES = 4;
const EVALUATE_TIMEOUT_MS = 25_000;
const BOOTSTRAP_URL = 'https://www.psacard.com/cardfacts/pokemon/base-set/card/641285';
const COOLDOWN_AFTER_CONSECUTIVE_FAILURES = 3;
const COOLDOWN_MS = 60_000;

interface Selection {
  release: string;
  sourceCardId: string;
  finish: string;
  printRunMarker: string;
  microVariant?: string;
  psaSpecId: number;
  popSourceUrl: string;
  salesSpecId: number | null;
  salesSourceUrl: string | null;
}

interface RawPriceRow {
  gradeText: string;
  mostRecentText: string;
  averageText: string;
  psaPriceText: string;
}

interface RawCensusRow {
  position: number;
  gradeLabel: string;
  pedigree: string;
}

interface RawApiSale {
  saleItemId: string;
  certNumber: string | null;
  auctionHouse: string;
  saleDate: string;
  saleType: string | null;
  salePrice: number;
  gradeValue: number | string | null;
  listingURL: string | null;
}

interface Options {
  releases: string[] | null; // null = every release present in the selection file
  only: 'population' | 'sales' | 'both';
  limit: number | null;
  offset: number;
  force: boolean;
  since: string;
}

function parseOptions(argv: readonly string[]): Options {
  let releases: string[] | null = null;
  let only: Options['only'] = 'both';
  let limit: number | null = null;
  let offset = 0;
  let force = false;
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
    else if (arg === '--force') force = true;
    else throw new Error(`Unknown option: ${arg}`);
  }

  if (limit !== null && (!Number.isSafeInteger(limit) || limit <= 0)) throw new Error('--limit must be a positive integer');
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('--offset must be a non-negative integer');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) throw new Error(`Invalid --since date: ${since}`);

  return { releases, only, limit, offset, force, since };
}

function slice<T>(list: T[], options: Options): T[] {
  const from = list.slice(options.offset);
  return options.limit === null ? from : from.slice(0, options.limit);
}

/**
 * Safety valve, not a guarantee: after 3 consecutive failures in a phase,
 * pause 60s before continuing rather than hammering PSA during a rate limit,
 * a Cloudflare re-challenge, or an outage. If failures keep happening after
 * a cooldown, that's a signal to stop and investigate, not to let it spin.
 */
async function maybeCooldown(page: Page, consecutiveFailures: number): Promise<number> {
  if (consecutiveFailures < COOLDOWN_AFTER_CONSECUTIVE_FAILURES) return consecutiveFailures;
  console.warn(`  ${consecutiveFailures} failures in a row -- cooling down for ${COOLDOWN_MS / 1000}s before continuing...`);
  await page.waitForTimeout(COOLDOWN_MS);
  return 0;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

const extractPageData = new Function(
  'cardUrl',
  `
  return (async () => {
    const res = await fetch(cardUrl);
    if (!res.ok) throw new Error("PSA card page request failed with " + res.status);
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    const tables = [...doc.querySelectorAll("table")];
    function cellText(row, i) { return (row.children[i] && row.children[i].textContent || "").trim(); }

    const priceTable = tables.find(function (t) {
      return [...t.querySelectorAll("thead th")].map(function (th) { return th.textContent.trim(); }).join("|")
        === "Grade|Most Recent Price|Average Price|PSA Price|Population|POP Higher";
    });
    const priceRows = priceTable
      ? [...priceTable.querySelectorAll("tbody tr")].map(function (row) {
          return {
            gradeText: cellText(row, 0),
            mostRecentText: cellText(row, 1),
            averageText: cellText(row, 2),
            psaPriceText: cellText(row, 3),
          };
        })
      : [];

    const censusTable = tables.find(function (t) {
      return [...t.querySelectorAll("thead th")].map(function (th) { return th.textContent.trim(); }).join("|")
        === "Pos|Grade|Thumbnail|Pedigree and History";
    });
    const censusRows = censusTable
      ? [...censusTable.querySelectorAll("tbody tr")].map(function (row) {
          return { position: Number(cellText(row, 0)), gradeLabel: cellText(row, 1), pedigree: cellText(row, 3) };
        })
      : [];

    return { html, priceRows, censusRows };
  })();
  `,
) as (cardUrl: string) => Promise<{ html: string; priceRows: RawPriceRow[]; censusRows: RawCensusRow[] }>;

async function fetchSalesPage(page: Page, specId: number, pageNumber: number): Promise<{ sales: RawApiSale[]; totalCount: number }> {
  const input = {
    json: { specId: String(specId), grade: '10', gradingType: 'ALL', qualifiers: 'NON_QUALIFIERS', pageSize: SALES_PAGE_SIZE, timeRange: 0, cursor: pageNumber, direction: 'forward' },
    meta: { values: {}, v: 1 },
  };
  const innerBase64 = Buffer.from(JSON.stringify(input)).toString('base64');
  const url = `https://www.psacard.com/api/psa/trpc/researchJourney.getSalesBySpecId?batch=1&input=${encodeURIComponent(JSON.stringify({ 0: innerBase64 }))}`;

  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) await page.waitForTimeout(2000 * 2 ** (attempt - 1));

    const { status, body } = await withTimeout(
      page.evaluate(async (u) => {
        const res = await fetch(u);
        return { status: res.status, body: await res.text() };
      }, url),
      EVALUATE_TIMEOUT_MS,
      `sales page fetch (spec ${specId}, page ${pageNumber})`,
    );

    if (status === 200) {
      const parsed = JSON.parse(body) as { result?: { data?: { json?: { sales?: RawApiSale[]; totalCount?: number } } }; error?: { json?: { message?: string } } }[];
      const entry = parsed[0];
      if (entry?.error) throw new Error(`Sales API error: ${entry.error.json?.message ?? JSON.stringify(entry.error)}`);
      const data = entry?.result?.data?.json;
      return { sales: data?.sales ?? [], totalCount: data?.totalCount ?? 0 };
    }

    lastError = new Error(`Sales API request failed with ${status}: ${body.slice(0, 300)}`);
    if (!RETRYABLE_STATUS.has(status)) throw lastError;
    console.warn(`  spec ${specId} page ${pageNumber}: ${status}, retrying (attempt ${attempt + 1}/${MAX_RETRIES})...`);
  }
  throw lastError;
}

async function fetchPopulationOne(page: Page, entry: Selection, outDir: string): Promise<void> {
  const populationRaw = await withTimeout(
    page.evaluate(async (specId) => {
      const res = await fetch(`/CardFacts/GetChartPopulation/${specId}?_=${Date.now()}`);
      if (!res.ok) throw new Error(`PSA population request failed with ${res.status}`);
      return res.text();
    }, entry.psaSpecId),
    EVALUATE_TIMEOUT_MS,
    `population fetch (spec ${entry.psaSpecId})`,
  );
  const { html, priceRows, censusRows } = await withTimeout(
    page.evaluate(extractPageData, entry.popSourceUrl),
    EVALUATE_TIMEOUT_MS,
    `page fetch (spec ${entry.psaSpecId})`,
  );
  fs.writeFileSync(
    path.join(outDir, `${entry.psaSpecId}.json`),
    JSON.stringify({ ...entry, fetchedAt: new Date().toISOString(), populationRaw, priceRows, censusRows, html }, null, 2) + '\n',
  );
  console.log(`  saved (${priceRows.length} price rows, ${censusRows.length} census rows, ${html.length} bytes of page HTML)`);
}

async function fetchSalesOne(page: Page, entry: Selection, outDir: string, cutoffIso: string): Promise<void> {
  const allSales: RawApiSale[] = [];
  let totalCount = 0;
  let pagesFetched = 0;
  let reachedCutoff = false;

  for (let pageNumber = 1; pageNumber <= SALES_MAX_PAGES; pageNumber++) {
    const { sales, totalCount: total } = await fetchSalesPage(page, entry.salesSpecId!, pageNumber);
    totalCount = total;
    pagesFetched++;
    if (sales.length === 0) {
      reachedCutoff = true;
      break;
    }
    allSales.push(...sales);
    const oldestIso = new Date(sales.at(-1)!.saleDate).toISOString().slice(0, 10);
    if (oldestIso < cutoffIso) {
      reachedCutoff = true;
      break;
    }
    await page.waitForTimeout(SALES_REQUEST_DELAY_MS);
  }

  fs.writeFileSync(
    path.join(outDir, `${entry.salesSpecId}.json`),
    JSON.stringify(
      { ...entry, fetchedAt: new Date().toISOString(), grade: '10', cutoffIso, totalCount, pagesFetched, coverageComplete: reachedCutoff, sales: allSales },
      null,
      2,
    ) + '\n',
  );
  console.log(`  saved ${allSales.length} sale row(s) across ${pagesFetched} page(s) (${totalCount} total on PSA, coverageComplete=${reachedCutoff})`);
}

async function runPopulation(page: Page, release: string, entries: Selection[], force: boolean): Promise<void> {
  const outDir = path.join(OUT_DIR, release, 'population');
  fs.mkdirSync(outDir, { recursive: true });
  let done = 0, skipped = 0, failed = 0, consecutiveFailures = 0;
  for (const entry of entries) {
    const outPath = path.join(outDir, `${entry.psaSpecId}.json`);
    if (!force && fs.existsSync(outPath)) { skipped++; continue; }
    console.log(`[pop/${release}] ${entry.sourceCardId} ${entry.finish}/${entry.printRunMarker} (spec ${entry.psaSpecId})...`);
    try {
      await fetchPopulationOne(page, entry, outDir);
      done++;
      consecutiveFailures = 0;
    } catch (error) {
      failed++;
      consecutiveFailures++;
      console.error(`  FAILED: ${error instanceof Error ? error.message : String(error)}`);
    }
    await page.waitForTimeout(POPULATION_REQUEST_DELAY_MS);
    consecutiveFailures = await maybeCooldown(page, consecutiveFailures);
  }
  console.log(`[pop/${release}] done. fetched=${done} skipped=${skipped} failed=${failed}`);
}

async function runSales(page: Page, release: string, entries: Selection[], force: boolean, cutoffIso: string): Promise<void> {
  const withSalesId = entries.filter((e): e is Selection & { salesSpecId: number; salesSourceUrl: string } => e.salesSpecId !== null);
  if (withSalesId.length === 0) {
    console.log(`[sales/${release}] no entries have a resolved salesSpecId yet -- skipping (${entries.length} population-only)`);
    return;
  }
  const outDir = path.join(OUT_DIR, release, 'sales');
  fs.mkdirSync(outDir, { recursive: true });

  const firstUrl = withSalesId[0].salesSourceUrl;
  console.log(`[sales/${release}] establishing session via ${firstUrl}...`);
  await page.goto(firstUrl, { waitUntil: 'networkidle', timeout: 60_000 });
  if (page.url().includes('collectors.com/signin')) {
    console.log('  redirected to sign-in -- waiting up to 10 minutes for manual sign-in...');
    await page.waitForURL((url) => url.hostname === 'www.psacard.com', { timeout: 600_000 });
  }
  await page.waitForTimeout(1500);

  let done = 0, skipped = 0, failed = 0, consecutiveFailures = 0;
  for (const entry of withSalesId) {
    const outPath = path.join(outDir, `${entry.salesSpecId}.json`);
    if (!force && fs.existsSync(outPath)) { skipped++; continue; }
    console.log(`[sales/${release}] ${entry.sourceCardId} ${entry.finish}/${entry.printRunMarker} (spec ${entry.salesSpecId})...`);
    try {
      await fetchSalesOne(page, entry, outDir, cutoffIso);
      done++;
      consecutiveFailures = 0;
    } catch (error) {
      failed++;
      consecutiveFailures++;
      console.error(`  FAILED: ${error instanceof Error ? error.message : String(error)}`);
    }
    await page.waitForTimeout(SALES_REQUEST_DELAY_MS * 2);
    consecutiveFailures = await maybeCooldown(page, consecutiveFailures);
  }
  console.log(`[sales/${release}] done. fetched=${done} skipped=${skipped} failed=${failed}`);
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const all = JSON.parse(fs.readFileSync(SELECTION_PATH, 'utf8')) as Selection[];
  const releaseOrder = options.releases ?? [...new Set(all.map((e) => e.release))];

  const context = await launchPsaProfile({ headless: false });
  const page = await context.newPage();
  try {
    console.log(`Bootstrapping session via ${BOOTSTRAP_URL}...`);
    await page.goto(BOOTSTRAP_URL, { waitUntil: 'domcontentloaded', timeout: 180_000 });

    for (const release of releaseOrder) {
      const entries = slice(all.filter((e) => e.release === release), options);
      if (entries.length === 0) continue;
      console.log(`\n=== ${release}: ${entries.length} entrie(s) ===`);
      if (options.only !== 'sales') await runPopulation(page, release, entries, options.force);
      if (options.only !== 'population') await runSales(page, release, entries, options.force, options.since);
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
