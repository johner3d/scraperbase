import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright';
import { launchPsaProfile } from '../sources/psa/browser/profile.ts';
import { DATA_DIR } from '../core/config/config.ts';

// Smoke test: fetch real PSA population + sales data for a small, hand-picked
// spread of Base Set (base1) variants -- proves the raw-fetch mechanics work
// end to end before building the real queue-driven collectors. Logic mirrors
// the already-proven fetscha/fetch.ts in the sibling clean_rewrite project;
// only the output location and (much smaller) sales page cap differ.

const SELECTION_PATH = path.join(DATA_DIR, 'psa-test-selection.json');
const OUT_DIR = path.join(DATA_DIR, 'psa-raw-test');
const TARGET_GRADE = '10';
const SALES_PAGE_SIZE = 5;
const SALES_MAX_PAGES = 5; // capped hard for this smoke test -- not a full history pull
const SALES_REQUEST_DELAY_MS = 600;
const RETRYABLE_STATUS = new Set([429, 502, 503, 504, 524]);
const MAX_RETRIES = 4;
const EVALUATE_TIMEOUT_MS = 25_000;
const BOOTSTRAP_URL = 'https://www.psacard.com/cardfacts/pokemon/base-set/card/641285';
const COOLDOWN_AFTER_CONSECUTIVE_FAILURES = 3;
const COOLDOWN_MS = 60_000;

interface Selection {
  sourceCardId: string;
  finish: string;
  printRunMarker: string;
  microVariant?: string;
  psaSpecId: number;
  popSourceUrl: string;
  salesSpecId: number;
  salesSourceUrl: string;
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
    json: { specId: String(specId), grade: TARGET_GRADE, gradingType: 'ALL', qualifiers: 'NON_QUALIFIERS', pageSize: SALES_PAGE_SIZE, timeRange: 0, cursor: pageNumber, direction: 'forward' },
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
  const outPath = path.join(outDir, `${entry.psaSpecId}.json`);
  console.log(`[pop] ${entry.sourceCardId} ${entry.finish}/${entry.printRunMarker} (spec ${entry.psaSpecId})...`);
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
    outPath,
    JSON.stringify(
      { ...entry, fetchedAt: new Date().toISOString(), populationRaw, priceRows, censusRows, html },
      null,
      2,
    ) + '\n',
  );
  console.log(`  saved (${priceRows.length} price rows, ${censusRows.length} census rows, ${html.length} bytes of page HTML)`);
}

async function fetchSalesOne(page: Page, entry: Selection, outDir: string, cutoffIso: string): Promise<void> {
  const outPath = path.join(outDir, `${entry.salesSpecId}.json`);
  console.log(`[sales] ${entry.sourceCardId} ${entry.finish}/${entry.printRunMarker} (spec ${entry.salesSpecId})...`);
  const allSales: RawApiSale[] = [];
  let totalCount = 0;
  let pagesFetched = 0;
  let reachedCutoff = false;

  for (let pageNumber = 1; pageNumber <= SALES_MAX_PAGES; pageNumber++) {
    const { sales, totalCount: total } = await fetchSalesPage(page, entry.salesSpecId, pageNumber);
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
    outPath,
    JSON.stringify(
      { ...entry, fetchedAt: new Date().toISOString(), grade: TARGET_GRADE, cutoffIso, totalCount, pagesFetched, coverageComplete: reachedCutoff, sales: allSales },
      null,
      2,
    ) + '\n',
  );
  console.log(`  saved ${allSales.length} sale row(s) across ${pagesFetched} page(s) (${totalCount} total on PSA, coverageComplete=${reachedCutoff})`);
}

async function main(): Promise<void> {
  let selection = JSON.parse(fs.readFileSync(SELECTION_PATH, 'utf8')) as Selection[];
  const onlyIds = process.argv.find((a) => a.startsWith('--only-spec-ids='))?.slice('--only-spec-ids='.length).split(',').map(Number);
  if (onlyIds) selection = selection.filter((entry) => onlyIds.includes(entry.psaSpecId));
  const populationOnly = process.argv.includes('--population-only');
  const popOutDir = path.join(OUT_DIR, 'population');
  const salesOutDir = path.join(OUT_DIR, 'sales');
  fs.mkdirSync(popOutDir, { recursive: true });
  fs.mkdirSync(salesOutDir, { recursive: true });

  const cutoff = new Date();
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 2);
  const cutoffIso = cutoff.toISOString().slice(0, 10);

  const context = await launchPsaProfile({ headless: false });
  const page = await context.newPage();
  try {
    console.log(`Bootstrapping session via ${BOOTSTRAP_URL}...`);
    await page.goto(BOOTSTRAP_URL, { waitUntil: 'domcontentloaded', timeout: 180_000 });

    let popConsecutiveFailures = 0;
    for (const entry of selection) {
      try {
        await fetchPopulationOne(page, entry, popOutDir);
        popConsecutiveFailures = 0;
      } catch (error) {
        popConsecutiveFailures++;
        console.error(`  FAILED (population): ${error instanceof Error ? error.message : String(error)}`);
      }
      await page.waitForTimeout(800);
      popConsecutiveFailures = await maybeCooldown(page, popConsecutiveFailures);
    }

    if (populationOnly) return;

    const firstSalesUrl = selection[0]!.salesSourceUrl;
    console.log(`Establishing sales session via ${firstSalesUrl}...`);
    await page.goto(firstSalesUrl, { waitUntil: 'networkidle', timeout: 60_000 });
    if (page.url().includes('collectors.com/signin')) {
      console.log('  Redirected to sign-in -- waiting up to 10 minutes for manual sign-in...');
      await page.waitForURL((url) => url.hostname === 'www.psacard.com', { timeout: 600_000 });
    }
    await page.waitForTimeout(1500);

    let salesConsecutiveFailures = 0;
    for (const entry of selection) {
      try {
        await fetchSalesOne(page, entry, salesOutDir, cutoffIso);
        salesConsecutiveFailures = 0;
      } catch (error) {
        salesConsecutiveFailures++;
        console.error(`  FAILED (sales): ${error instanceof Error ? error.message : String(error)}`);
      }
      await page.waitForTimeout(SALES_REQUEST_DELAY_MS * 2);
      salesConsecutiveFailures = await maybeCooldown(page, salesConsecutiveFailures);
    }
  } finally {
    await context.close();
  }
  console.log(`Done. Raw data written under ${OUT_DIR}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
