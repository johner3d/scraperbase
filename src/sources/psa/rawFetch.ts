import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright';
import { DATA_DIR } from '../../core/config/config.ts';

// The PSA raw-fetch engine: population + sales (price history) for a list of
// {psaSpecId/salesSpecId, sourceUrl} entries, grouped by release ("slice").
// Extracted verbatim from src/scripts/psa-fetch.ts so that script and the
// `psa-fetch-matched` CLI command share one browser/retry/checkpoint path
// rather than forking it. Deliberately zero DB dependency -- the slow, flaky
// browser part writes plain files, and psa-backfill-import.ts is the separate,
// fast, freely-repeatable step that catches the DB up to what is on disk.

export const OUT_DIR = path.join(DATA_DIR, 'psa-raw');
export const STOP_FILE = path.join(DATA_DIR, 'psa-fetch.stop');

/**
 * The persistent PSA browser profile is no longer signed in (a navigation
 * landed on a sign-in / collectors.com page). Thrown instead of blocking up to
 * ten minutes for an interactive login that never comes in an unattended run.
 * Pipeline stages catch it and convert it into a pause resolved by
 * `npm run cli -- pipeline psa-login`.
 */
export class PsaSessionExpiredError extends Error {
  constructor(message = 'PSA session expired -- run: npm run cli -- pipeline psa-login') {
    super(message);
    this.name = 'PsaSessionExpiredError';
  }
}

/** True when a navigation ended up on an auth wall rather than psacard.com content. */
export function isPsaSignInUrl(url: string): boolean {
  return /collectors\.com\/(signin|login)|psacard\.com\/(signin|login)|\/account\/login/i.test(url);
}
export const BOOTSTRAP_URL = 'https://www.psacard.com/cardfacts/pokemon/base-set/card/641285';
const SALES_PAGE_SIZE = 5; // hard server-side limit, confirmed live
// Real cap now, not a theoretical one: 400 pages x 5 rows = 2,000 sales, well
// past what any price chart needs. Combined with the per-spec wall-clock budget
// below it stops a single long-history spec from eating a whole fetch window.
// Termination is normally the `--since` / cutoffIso cutoff; this and the budget
// are the backstops. A spec that hits either saves a resumable (coverageComplete
// = false) checkpoint and is continued on the next pass.
const SALES_MAX_PAGES = 400;
const SALES_DEFAULT_SPEC_BUDGET_MS = 90_000; // wall-clock ceiling for one spec's sales walk
const SALES_REQUEST_DELAY_MS = 600;
const POPULATION_REQUEST_DELAY_MS = 800;
const RETRYABLE_STATUS = new Set([429, 502, 503, 504, 524]);
const MAX_RETRIES = 4;
const EVALUATE_TIMEOUT_MS = 25_000;
const COOLDOWN_AFTER_CONSECUTIVE_FAILURES = 3;
const COOLDOWN_MS = 60_000;

export interface Selection {
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

export interface RawPriceRow {
  gradeText: string;
  mostRecentText: string;
  averageText: string;
  psaPriceText: string;
}

export interface RawCensusRow {
  position: number;
  gradeLabel: string;
  pedigree: string;
}

export interface RawApiSale {
  saleItemId: string;
  certNumber: string | null;
  auctionHouse: string;
  saleDate: string;
  saleType: string | null;
  salePrice: number;
  gradeValue: number | string | null;
  listingURL: string | null;
}

/** Per-phase outcome, so callers can print completion stats rather than only logging. */
export interface PhaseStats {
  fetched: number;
  skipped: number;
  failed: number;
  /** Paths of the files this phase wrote, for a targeted follow-up import. */
  written: string[];
  /** At least one request was rejected by PSA's upstream rate limit. */
  rateLimited?: boolean;
}

export interface FetchOptions {
  force: boolean;
  /** When set, a saved payload older than this is re-fetched even without force. */
  maxAgeMs?: number | null;
  now?: number;
}

let stopRequested = false;
const salesCheckpointPaths = new Map<string, string[]>();

export function shouldStop(): boolean {
  if (!stopRequested && fs.existsSync(STOP_FILE)) {
    stopRequested = true;
    console.warn(`\nStop marker detected at ${STOP_FILE}; saving the current page checkpoint, then stopping...`);
  }
  return stopRequested;
}

export function requestStop(reason: string): void {
  if (stopRequested) return;
  stopRequested = true;
  console.warn(`\nReceived ${reason}; saving the current page checkpoint, then stopping...`);
}

/** SIGINT/SIGTERM both stop after the current sales page has been checkpointed. */
export function installStopHandlers(): void {
  process.once('SIGINT', () => requestStop('SIGINT'));
  process.once('SIGTERM', () => requestStop('SIGTERM'));
}

export function atomicWriteJson(filePath: string, value: unknown): void {
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tempPath, filePath);
}

export function indexSalesCheckpoints(): void {
  salesCheckpointPaths.clear();
  if (!fs.existsSync(OUT_DIR)) return;
  for (const release of fs.readdirSync(OUT_DIR, { withFileTypes: true })) {
    if (!release.isDirectory()) continue;
    const salesDir = path.join(OUT_DIR, release.name, 'sales');
    if (!fs.existsSync(salesDir)) continue;
    for (const file of fs.readdirSync(salesDir)) {
      const match = /^(\d+)\.json$/.exec(file);
      if (!match) continue;
      const paths = salesCheckpointPaths.get(match[1]!) ?? [];
      paths.push(path.join(salesDir, file));
      salesCheckpointPaths.set(match[1]!, paths);
    }
  }
}

interface SavedSalesCheckpoint {
  fetchedAt?: string;
  cutoffIso?: string | null;
  coverageComplete?: boolean;
  coverageEvidence?: 'source_exhausted' | 'user_cutoff' | 'known_overlap' | 'page_cap_reached' | 'time_budget';
  lastFullAuditAt?: string;
  sales?: RawApiSale[];
  totalCount?: number;
  pagesFetched?: number;
}

export function bestSalesCheckpoint(specId: number, preferredPath: string, cutoffIso: string | null): { path: string; saved: SavedSalesCheckpoint } | null {
  const candidates = [preferredPath, ...(salesCheckpointPaths.get(String(specId)) ?? []).filter((p) => p !== preferredPath)];
  let best: { path: string; saved: SavedSalesCheckpoint } | null = null;
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const saved = JSON.parse(fs.readFileSync(candidate, 'utf8')) as SavedSalesCheckpoint;
      if ((saved.cutoffIso ?? null) !== cutoffIso) continue;
      if (!best || Boolean(saved.coverageComplete) > Boolean(best.saved.coverageComplete)
        || (Boolean(saved.coverageComplete) === Boolean(best.saved.coverageComplete)
          && (saved.pagesFetched ?? 0) > (best.saved.pagesFetched ?? 0))) {
        best = { path: candidate, saved };
      }
    } catch { /* ignore invalid checkpoints */ }
  }
  return best;
}

/**
 * Freshness of an already-saved payload. The `fetchedAt` inside the file is
 * the truth rather than the file mtime (a sales checkpoint is rewritten after
 * every page); an unreadable or undated file counts as stale, so it is
 * re-fetched rather than silently kept.
 */
export function isFresh(fetchedAt: string | undefined, maxAgeMs: number | null | undefined, now: number): boolean {
  if (maxAgeMs == null) return true;
  if (!fetchedAt) return false;
  const at = Date.parse(fetchedAt);
  return Number.isFinite(at) && now - at < maxAgeMs;
}

function savedFetchedAt(filePath: string): string | undefined {
  try {
    return (JSON.parse(fs.readFileSync(filePath, 'utf8')) as { fetchedAt?: string }).fetchedAt;
  } catch {
    return undefined;
  }
}

/**
 * Safety valve, not a guarantee: after 3 consecutive failures in a phase,
 * pause 60s before continuing rather than hammering PSA during a rate limit,
 * a Cloudflare re-challenge, or an outage. If failures keep happening after
 * a cooldown, that's a signal to stop and investigate, not to let it spin.
 */
async function maybeCooldown(page: Page, consecutiveFailures: number): Promise<number> {
  if (consecutiveFailures < COOLDOWN_AFTER_CONSECUTIVE_FAILURES) return consecutiveFailures;
  console.warn(`  rate-limit pause: ${consecutiveFailures} failures in a row -- cooling down for ${COOLDOWN_MS / 1000}s before continuing...`);
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

async function fetchPopulationOne(page: Page, entry: Selection, outDir: string): Promise<string> {
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
  const outPath = path.join(outDir, `${entry.psaSpecId}.json`);
  atomicWriteJson(outPath, {
    ...entry, fetchedAt: new Date().toISOString(), populationRaw, priceRows, censusRows, html,
  });
  console.log(`  saved (${priceRows.length} price rows, ${censusRows.length} census rows, ${html.length} bytes of page HTML)`);
  return outPath;
}

function saleIdentity(sale:RawApiSale):string{
  return sale.saleItemId || [sale.certNumber,sale.auctionHouse,sale.saleDate,sale.salePrice].join('|');
}

async function fetchSalesOne(page: Page, entry: Selection, outDir: string, options: {
  cutoffIso: string | null; auditMaxAgeMs?: number; now?: number; budgetMs?: number;
}): Promise<string> {
  const outPath = path.join(outDir, `${entry.salesSpecId}.json`);
  const cutoffIso=options.cutoffIso;
  const deadline = Date.now() + (options.budgetMs ?? SALES_DEFAULT_SPEC_BUDGET_MS);
  let allSales: RawApiSale[] = [];
  let totalCount = 0;
  let pagesFetched = 0;
  let reachedCutoff = false;
  let coverageEvidence:SavedSalesCheckpoint['coverageEvidence'];
  let lastFullAuditAt:string|undefined;

  const checkpoint = bestSalesCheckpoint(entry.salesSpecId!, outPath, cutoffIso);
  const now=options.now??Date.now();
  const fullHistory=cutoffIso==null;
  const lastAudit=checkpoint?.saved.lastFullAuditAt?Date.parse(checkpoint.saved.lastFullAuditAt):Number.NaN;
  const auditDue=fullHistory&&(!checkpoint?.saved.coverageComplete||!Number.isFinite(lastAudit)
    || now-lastAudit>=(options.auditMaxAgeMs??30*86_400_000));
  const incremental=fullHistory&&Boolean(checkpoint?.saved.coverageComplete)&&!auditDue;
  const knownSales=checkpoint?.saved.sales??[];
  const knownIds=new Set(knownSales.map(saleIdentity));
  let overlapPages=0;
  if (checkpoint && !checkpoint.saved.coverageComplete) {
    allSales = checkpoint.saved.sales ?? [];
    totalCount = checkpoint.saved.totalCount ?? 0;
    pagesFetched = checkpoint.saved.pagesFetched ?? 0;
    if (pagesFetched > 0) console.log(`  resuming after page ${pagesFetched} (${allSales.length} saved sale rows from ${checkpoint.path})`);
  }

  for (let pageNumber = pagesFetched + 1; pageNumber <= SALES_MAX_PAGES; pageNumber++) {
    const { sales, totalCount: total } = await fetchSalesPage(page, entry.salesSpecId!, pageNumber);
    totalCount = total;
    pagesFetched++;
    if (sales.length === 0) {
      reachedCutoff = true;
      coverageEvidence='source_exhausted';
      break;
    }
    if(incremental){
      const allKnown=sales.every((sale)=>knownIds.has(saleIdentity(sale)));
      overlapPages=allKnown?overlapPages+1:0;
      allSales.push(...sales.filter((sale)=>!knownIds.has(saleIdentity(sale))));
      if(overlapPages>=2){reachedCutoff=true;coverageEvidence='known_overlap';}
    }else{
      allSales.push(...sales);
    }
    const oldestIso = new Date(sales.at(-1)!.saleDate).toISOString().slice(0, 10);
    if (cutoffIso!=null&&oldestIso < cutoffIso) {
      reachedCutoff = true;
      coverageEvidence='user_cutoff';
    }
    const merged=incremental?[...allSales,...knownSales]:allSales;
    const deduped=[...new Map(merged.map((sale)=>[saleIdentity(sale),sale])).values()];
    atomicWriteJson(outPath, {
      ...entry, fetchedAt: new Date().toISOString(), grade: '10', cutoffIso,
      totalCount, pagesFetched, coverageComplete: reachedCutoff,coverageEvidence,
      lastFullAuditAt:!incremental&&fullHistory?new Date(now).toISOString():checkpoint?.saved.lastFullAuditAt,
      sales:deduped,
    });
    if (reachedCutoff || shouldStop()) break;
    if (Date.now() >= deadline) {
      coverageEvidence = 'time_budget';
      console.log(`  sales walk hit its ${Math.round((options.budgetMs ?? SALES_DEFAULT_SPEC_BUDGET_MS) / 1000)}s budget after ${pagesFetched} page(s) -- checkpoint saved, will resume`);
      break;
    }
    await page.waitForTimeout(SALES_REQUEST_DELAY_MS);
  }

  if(!reachedCutoff&&pagesFetched>=SALES_MAX_PAGES)coverageEvidence='page_cap_reached';
  const merged=incremental?[...allSales,...knownSales]:allSales;
  allSales=[...new Map(merged.map((sale)=>[saleIdentity(sale),sale])).values()];
  if(!incremental&&fullHistory)lastFullAuditAt=new Date(now).toISOString(); else lastFullAuditAt=checkpoint?.saved.lastFullAuditAt;

  atomicWriteJson(outPath, {
    ...entry, fetchedAt: new Date().toISOString(), grade: '10', cutoffIso,
    totalCount, pagesFetched, coverageComplete: reachedCutoff,coverageEvidence,lastFullAuditAt,sales:allSales,
  });
  const knownPaths = salesCheckpointPaths.get(String(entry.salesSpecId)) ?? [];
  if (!knownPaths.includes(outPath)) knownPaths.push(outPath);
  salesCheckpointPaths.set(String(entry.salesSpecId), knownPaths);
  console.log(`  saved ${allSales.length} sale row(s) across ${pagesFetched} page(s) (${totalCount} total on PSA, coverageComplete=${reachedCutoff})`);
  return outPath;
}

export async function runPopulation(page: Page, release: string, entries: Selection[], options: FetchOptions): Promise<PhaseStats> {
  const outDir = path.join(OUT_DIR, release, 'population');
  fs.mkdirSync(outDir, { recursive: true });
  const now = options.now ?? Date.now();
  const stats: PhaseStats = { fetched: 0, skipped: 0, failed: 0, written: [] };
  let consecutiveFailures = 0;
  for (const entry of entries) {
    if (shouldStop()) break;
    const outPath = path.join(outDir, `${entry.psaSpecId}.json`);
    if (!options.force && fs.existsSync(outPath) && isFresh(savedFetchedAt(outPath), options.maxAgeMs, now)) {
      stats.skipped++;
      continue;
    }
    console.log(`[pop/${release}] ${entry.sourceCardId} ${entry.finish}/${entry.printRunMarker} (spec ${entry.psaSpecId})...`);
    try {
      stats.written.push(await fetchPopulationOne(page, entry, outDir));
      stats.fetched++;
      consecutiveFailures = 0;
    } catch (error) {
      stats.failed++;
      if(/\b429\b|rate.?limit/i.test(error instanceof Error?error.message:String(error)))stats.rateLimited=true;
      consecutiveFailures++;
      console.error(`  FAILED: ${error instanceof Error ? error.message : String(error)}`);
    }
    await page.waitForTimeout(POPULATION_REQUEST_DELAY_MS);
    consecutiveFailures = await maybeCooldown(page, consecutiveFailures);
  }
  console.log(`[pop/${release}] done. fetched=${stats.fetched} skipped=${stats.skipped} failed=${stats.failed}`);
  return stats;
}

export async function runSales(page: Page, release: string, entries: Selection[], options: FetchOptions & {
  cutoffIso: string | null; auditMaxAgeMs?: number; salesBudgetMs?: number;
}): Promise<PhaseStats> {
  const stats: PhaseStats = { fetched: 0, skipped: 0, failed: 0, written: [] };
  const withSalesId = entries.filter((e): e is Selection & { salesSpecId: number; salesSourceUrl: string } => e.salesSpecId !== null);
  if (withSalesId.length === 0) {
    console.log(`[sales/${release}] no entries have a resolved salesSpecId yet -- skipping (${entries.length} population-only)`);
    return stats;
  }
  const outDir = path.join(OUT_DIR, release, 'sales');
  fs.mkdirSync(outDir, { recursive: true });
  const now = options.now ?? Date.now();

  const firstUrl = withSalesId[0].salesSourceUrl;
  console.log(`[sales/${release}] establishing session via ${firstUrl}...`);
  await page.goto(firstUrl, { waitUntil: 'networkidle', timeout: 60_000 });
  if (isPsaSignInUrl(page.url())) {
    throw new PsaSessionExpiredError();
  }
  await page.waitForTimeout(1500);

  let consecutiveFailures = 0;
  for (const entry of withSalesId) {
    if (shouldStop()) break;
    const outPath = path.join(outDir, `${entry.salesSpecId}.json`);
    if (!options.force) {
      const checkpoint = bestSalesCheckpoint(entry.salesSpecId, outPath, options.cutoffIso);
      if (checkpoint?.saved.coverageComplete && isFresh(checkpoint.saved.fetchedAt, options.maxAgeMs, now)) {
        stats.skipped++;
        continue;
      }
    }
    console.log(`[sales/${release}] ${entry.sourceCardId} ${entry.finish}/${entry.printRunMarker} (spec ${entry.salesSpecId})...`);
    try {
      stats.written.push(await fetchSalesOne(page, entry, outDir, {
        cutoffIso:options.cutoffIso,auditMaxAgeMs:options.auditMaxAgeMs,now:options.now,budgetMs:options.salesBudgetMs,
      }));
      stats.fetched++;
      consecutiveFailures = 0;
    } catch (error) {
      stats.failed++;
      if(/\b429\b|rate.?limit/i.test(error instanceof Error?error.message:String(error)))stats.rateLimited=true;
      consecutiveFailures++;
      console.error(`  FAILED: ${error instanceof Error ? error.message : String(error)}`);
    }
    await page.waitForTimeout(SALES_REQUEST_DELAY_MS * 2);
    consecutiveFailures = await maybeCooldown(page, consecutiveFailures);
  }
  console.log(`[sales/${release}] done. fetched=${stats.fetched} skipped=${stats.skipped} failed=${stats.failed}`);
  return stats;
}
