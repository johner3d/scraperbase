import type { DatabaseSync } from 'node:sqlite';
import type { Page } from 'playwright';
import { runQueue } from '../../core/queue/runner.ts';
import { workItemId } from '../../core/queue/workItem.ts';
import { materialize } from '../../curated/materialize.ts';
import { selectEbayMatchedTargets } from '../../curated/psaTargets.ts';
import { LIVE_AUCTION_WINDOW_HOURS } from '../../curated/ebay/liveAuctionScope.ts';
import { createPsaCertCollector, seedPsaCertLookups } from '../../sources/psa/collectors/cert.ts';
import { createPsaPopDiscoveryCollector, seedPsaPopDiscovery } from '../../sources/psa/collectors/popDiscovery.ts';
import { createPsaSetItemsCollector } from '../../sources/psa/collectors/setItems.ts';
import { psaRateLimiter } from '../../sources/psa/psaRateLimiter.ts';
import { indexSalesCheckpoints, installStopHandlers } from '../../sources/psa/rawFetch.ts';
import { importPopulationFile, importSalesFile, linkPopulationToSales } from '../../scripts/psa-backfill-import.ts';
import {
  POP_QUEUE,
  SALES_QUEUE,
  psaEnrichmentScope,
  psaPopulationCollector,
  psaSalesCollector,
  psaTargetFiles,
  seedPsaEnrichment,
} from '../psaEnrichment.ts';
import { loadPsaManifest, snapshotPsaTargets, syncPsaCoverage } from '../psaManifest.ts';
import { markEbayItemDirty, markPsaSpecDirty } from '../materializeDirty.ts';
import { markPublishDirty } from '../supervisorState.ts';
import { recordDeadLetter } from '../deadLetters.ts';
import { notePsaSuccess, psaCircuitOpen, tripPsaCircuit } from '../psaCircuit.ts';
import {
  closePsaBrowser, ensureOnPsa, getPsaPage, psaProfilePresent,
  PsaCloudflareError, PSA_CLOUDFLARE_PAUSE, PSA_SESSION_PAUSE,
} from './psaBrowser.ts';
import { PsaSessionExpiredError } from '../../sources/psa/rawFetch.ts';
import type { StageContext, StageTick } from './types.ts';

/** Per-tick batch caps -- small so a `psa` tick yields the loop back to publish
 *  in seconds, not minutes. The warm shared browser makes frequent small ticks
 *  cheap. */
const SPECS_PER_TICK = 3;
const CERTS_PER_TICK = 10;
const DISCOVERY_ITEMS_PER_TICK = 8;
const SET_ITEMS_PER_TICK = 6;

/** Soft wall-clock budget for one whole psa tick (fetch + cert + identity). */
const PSA_TICK_BUDGET_MS = 150_000;
/** Don't even start an identity crawl with less than this left in the budget. */
const IDENTITY_MIN_HEADROOM_MS = 30_000;

const PSA_MAX_AGE_DAYS = Number(process.env.SCRAPERBASE_PSA_MAX_AGE_DAYS) || 7;
const SALES_AUDIT_DAYS = Number(process.env.SCRAPERBASE_SALES_AUDIT_DAYS) || 30;
const IDLE_MINUTES = 5;
const NO_DATA_RETRY_MINUTES = 90;
const POP_URL = 'https://www.psacard.com/pop';

/** Cert/discovery seeds are non-trivial scans -- don't re-run them every tick. */
const SEED_THROTTLE_MS = 5 * 60_000;
/** Keep the live target manifest current so newly-matched auctions become
 *  fetch targets even on ticks where the identity crawl doesn't run. */
const MANIFEST_REFRESH_MS = 3 * 60_000;
/** Even on busy ticks, let the identity crawl run this often -- it is the only
 *  source of new PSA headings, and heading coverage is what decides whether a
 *  live auction can become a fetch target at all. */
const IDENTITY_MIN_INTERVAL_MS = 30 * 60_000;
let lastCertSeedAt = 0;
let lastDiscoverySeedAt = 0;
let lastManifestRefreshAt = 0;
let lastIdentityRunAt = 0;
let daemonInitDone = false;

const RATE_LIMIT_RE = /429|rate.?limit/i;

function daemonInit(): void {
  if (daemonInitDone) return;
  daemonInitDone = true;
  indexSalesCheckpoints();
  installStopHandlers();
}

/** True when a work item in `queues` failed on a rate-limit since `sinceIso`. */
function sawRateLimit(db: DatabaseSync, queues: string[], sinceIso: string): boolean {
  const ph = queues.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT last_error FROM work_items
     WHERE queue IN (${ph}) AND state IN ('partial','retryable_failed','pending','leased')
       AND updated_at >= ? AND last_error IS NOT NULL`,
  ).all(...queues, sinceIso) as Array<{ last_error: string | null }>;
  return rows.some((r) => RATE_LIMIT_RE.test(r.last_error ?? ''));
}

function pendingCertCount(db: DatabaseSync): number {
  return Number((db.prepare(
    `SELECT COUNT(*) n FROM work_items WHERE source='psa' AND queue='psa_cert'
       AND state IN ('pending','retryable_failed')`,
  ).get() as { n: number }).n);
}

/**
 * A live listing carrying a cert that still isn't cert-matched and whose lookup
 * is either never-seeded or was cancelled by a prior `pipeline reset` -- both
 * are worth a (re-)seed. Cheap EXISTS-ish probe.
 */
function hasUnseededCerts(db: DatabaseSync): boolean {
  return Boolean(db.prepare(
    `SELECT 1 FROM ebay_listings e
     WHERE e.cert_number IS NOT NULL AND TRIM(e.cert_number) <> ''
       AND COALESCE(e.match_method,'') <> 'ebay-psa-cert'
       AND NOT EXISTS (SELECT 1 FROM work_items w WHERE w.queue='psa_cert'
         AND w.scope_key = 'cert:' || TRIM(e.cert_number)
         AND w.state NOT IN ('cancelled'))
     LIMIT 1`,
  ).get());
}

interface SliceResult { workDone: number; deadLettered: number; rateLimited: boolean; }

/** psa-fetch: population + price + sales for the soonest-closing live targets. */
async function runFetchSlice(db: DatabaseSync, ctx: StageContext, page: Page): Promise<SliceResult> {
  const startedIso = ctx.now().toISOString();
  const urgent = db.prepare(
    `SELECT DISTINCT t.population_spec_id AS spec, MIN(lp.item_end_date) AS soonest
     FROM pipeline_psa_coverage cov
     JOIN pipeline_psa_targets t ON t.pipeline_psa_target_id=cov.pipeline_psa_target_id
     JOIN pipeline_psa_target_listings tl ON tl.pipeline_psa_target_id=t.pipeline_psa_target_id
     JOIN ebay_listings e ON e.ebay_listing_id=tl.ebay_listing_id
     JOIN v_ebay_listing_latest_price lp ON lp.ebay_listing_id=e.ebay_listing_id
     WHERE t.pipeline_run_id=?
       AND (cov.status IN ('pending','raw_missing','identity_missing')
            OR (cov.status IN ('no_data','raw_present','failed')
                AND cov.updated_at < datetime('now', printf('-%d minutes', CAST(? AS INTEGER)))))
       AND datetime(lp.item_end_date) > datetime('now','+15 minutes')
       AND datetime(lp.item_end_date) <= datetime('now', printf('+%d hours', CAST(? AS INTEGER)))
       AND COALESCE(lp.bid_count,0) >= 1
       AND NOT EXISTS (SELECT 1 FROM pipeline_dead_letters d
         WHERE d.stage='psa-fetch' AND d.resolved_at IS NULL
           AND d.scope_key IN ('enrichment:population:spec='||t.population_spec_id,
                                'enrichment:sales:spec='||COALESCE(t.sales_spec_id,t.population_spec_id)))
     GROUP BY t.population_spec_id
     ORDER BY soonest ASC
     LIMIT ?`,
  ).all(ctx.pipelineRunId, NO_DATA_RETRY_MINUTES, LIVE_AUCTION_WINDOW_HOURS, SPECS_PER_TICK) as Array<{ spec: string; soonest: string }>;

  if (urgent.length === 0) return { workDone: 0, deadLettered: 0, rateLimited: false };

  const specIds = new Set(urgent.map((r) => String(r.spec)));
  const selections = loadPsaManifest(db, ctx.pipelineRunId).selections.filter((s) => specIds.has(String(s.psaSpecId)));
  if (selections.length === 0) return { workDone: 0, deadLettered: 0, rateLimited: false };

  seedPsaEnrichment(db, selections, PSA_MAX_AGE_DAYS, SALES_AUDIT_DAYS, { force: true });

  await runQueue(db, {
    queue: POP_QUEUE, collector: psaPopulationCollector(page), concurrency: 1, leaseTtlMs: 300_000,
    runId: ctx.runId, isDraining: ctx.draining, maxItems: SPECS_PER_TICK,
    haltOnRateLimit: true, cooldown: { afterConsecutiveFailures: 3, cooldownMs: 60_000 },
  });
  await runQueue(db, {
    queue: SALES_QUEUE, collector: psaSalesCollector(page), concurrency: 1, leaseTtlMs: 300_000,
    runId: ctx.runId, isDraining: ctx.draining, maxItems: SPECS_PER_TICK,
    haltOnRateLimit: true, cooldown: { afterConsecutiveFailures: 3, cooldownMs: 60_000 },
  });

  const rateLimited = sawRateLimit(db, [POP_QUEUE, SALES_QUEUE], startedIso);

  let deadLettered = 0;
  const ids = selections.flatMap((s) => [
    workItemId('psa', POP_QUEUE, psaEnrichmentScope('population', s.psaSpecId)),
    ...(s.salesSpecId == null ? [] : [workItemId('psa', SALES_QUEUE, psaEnrichmentScope('sales', s.salesSpecId))]),
  ]);
  const stuck = db.prepare(
    `SELECT work_item_id, queue, scope_key, last_error FROM work_items
     WHERE work_item_id IN (${ids.map(() => '?').join(',')}) AND state='permanent_failed'`,
  ).all(...ids) as Array<{ work_item_id: string; queue: string; scope_key: string; last_error: string | null }>;
  for (const row of stuck) {
    recordDeadLetter(db, { stage: 'psa-fetch', scopeKey: row.scope_key, workItemId: row.work_item_id,
      reason: row.last_error ?? 'PSA enrichment work item exhausted its attempts', detail: { queue: row.queue } });
    deadLettered++;
  }

  let imported = 0;
  for (const file of psaTargetFiles(selections, 'population')) if (await importPopulationFile(db, file, ctx.runId) === 'imported') imported++;
  for (const file of psaTargetFiles(selections, 'sales')) if (await importSalesFile(db, file, ctx.runId) === 'imported') imported++;
  linkPopulationToSales(db);
  for (const s of selections) { markPsaSpecDirty(db, s.psaSpecId); if (s.salesSpecId != null) markPsaSpecDirty(db, s.salesSpecId); }

  await materialize(db, {
    incremental: true, includeTcgdex: false, includeEbay: false, includeEcb: false,
    changedPsaSpecIds: specIds, pipelineRunId: ctx.pipelineRunId,
  });
  syncPsaCoverage(db, ctx.pipelineRunId);
  markPublishDirty(db);

  ctx.log(`psa/fetch: ${selections.length} spec(s), ${imported} file(s) imported${deadLettered ? `, ${deadLettered} dead-lettered` : ''}`);
  return { workDone: selections.length, deadLettered, rateLimited };
}

/** psa-cert: resolve PSA cert numbers on live listings back to their spec. */
async function runCertSlice(db: DatabaseSync, ctx: StageContext, page: Page): Promise<SliceResult> {
  const startedIso = ctx.now().toISOString();
  const now = ctx.now().getTime();
  if (pendingCertCount(db) === 0) {
    if (now - lastCertSeedAt >= SEED_THROTTLE_MS && hasUnseededCerts(db)) {
      seedPsaCertLookups(db, 5000, true);
      lastCertSeedAt = now;
    }
    if (pendingCertCount(db) === 0) return { workDone: 0, deadLettered: 0, rateLimited: false };
  }

  const resolvedCerts = new Set<string>();
  await runQueue(db, {
    queue: 'psa_cert',
    collector: createPsaCertCollector({ page, getPage: async () => getPsaPage(), rateLimiter: psaRateLimiter }),
    concurrency: 1, leaseTtlMs: 300_000, runId: ctx.runId, isDraining: ctx.draining,
    maxItems: CERTS_PER_TICK, haltOnRateLimit: true,
    cooldown: { afterConsecutiveFailures: 3, cooldownMs: 60_000 },
    onItemComplete: (result, item) => {
      if (result.final === 'succeeded' && item.scope_key.startsWith('cert:')) {
        resolvedCerts.add(item.scope_key.slice('cert:'.length));
      }
    },
  });

  const rateLimited = sawRateLimit(db, ['psa_cert'], startedIso);

  // Re-materialize only the listings a cert resolved THIS tick can affect -- not
  // every cert-bearing listing in the table.
  let requeued = 0;
  if (resolvedCerts.size > 0) {
    const certList = [...resolvedCerts];
    const ph = certList.map(() => '?').join(',');
    for (const row of db.prepare(
      `SELECT sr.namespace, sr.source_key FROM ebay_listings e
       JOIN source_records sr ON sr.source_record_id=e.source_record_id
       WHERE TRIM(e.cert_number) IN (${ph}) AND COALESCE(e.match_method,'') <> 'ebay-psa-cert'`,
    ).all(...certList) as Array<{ namespace: string; source_key: string }>) {
      markEbayItemDirty(db, `item:${row.namespace}:${row.source_key}`);
      requeued++;
    }
  }

  let deadLettered = 0;
  for (const row of db.prepare(
    `SELECT work_item_id, scope_key, last_error FROM work_items
     WHERE source='psa' AND queue='psa_cert' AND state='permanent_failed'
       AND scope_key NOT IN (SELECT scope_key FROM pipeline_dead_letters WHERE stage='psa-cert')`,
  ).all() as Array<{ work_item_id: string; scope_key: string; last_error: string | null }>) {
    recordDeadLetter(db, { stage: 'psa-cert', scopeKey: row.scope_key, workItemId: row.work_item_id,
      reason: row.last_error ?? 'PSA cert lookup exhausted its attempts' });
    deadLettered++;
  }

  if (resolvedCerts.size || requeued) {
    ctx.log(`psa/cert: resolved ${resolvedCerts.size} cert(s); re-queued ${requeued} listing(s)`);
  }
  return { workDone: resolvedCerts.size, deadLettered, rateLimited };
}

function pendingIdentityWork(db: DatabaseSync): number {
  return Number((db.prepare(
    `SELECT COUNT(*) n FROM work_items
     WHERE queue IN ('psa_pop_discovery','psa_pop_set_items') AND state IN ('pending','retryable_failed')`,
  ).get() as { n: number }).n);
}

/** psa-identity: crawl PSA's pop tree to mint specs for unresolved live variants. */
async function runIdentitySlice(db: DatabaseSync, ctx: StageContext, page: Page): Promise<SliceResult> {
  const startedIso = ctx.now().toISOString();
  const now = ctx.now().getTime();
  const before = selectEbayMatchedTargets(db, { liveAuctionsOnly: true });
  if (before.unresolvedVariants === 0) return { workDone: 0, deadLettered: 0, rateLimited: false };

  // Re-seed the crawl root at most once per throttle window; if that produced no
  // pending work (the whole tree is already crawled) there is nothing to do --
  // skip the expensive full PSA materialize.
  if (now - lastDiscoverySeedAt >= SEED_THROTTLE_MS) {
    seedPsaPopDiscovery(db);
    lastDiscoverySeedAt = now;
  }
  if (pendingIdentityWork(db) === 0) return { workDone: 0, deadLettered: 0, rateLimited: false };
  const cooldown = { afterConsecutiveFailures: 3, cooldownMs: 60_000 };
  await runQueue(db, {
    queue: 'psa_pop_discovery', collector: createPsaPopDiscoveryCollector({ page, rateLimiter: psaRateLimiter }),
    concurrency: 1, leaseTtlMs: 300_000, runId: ctx.runId, isDraining: ctx.draining,
    maxItems: DISCOVERY_ITEMS_PER_TICK, haltOnRateLimit: true, cooldown,
  });
  await runQueue(db, {
    queue: 'psa_pop_set_items', collector: createPsaSetItemsCollector({ page, rateLimiter: psaRateLimiter }),
    concurrency: 1, leaseTtlMs: 300_000, runId: ctx.runId, isDraining: ctx.draining,
    maxItems: SET_ITEMS_PER_TICK, haltOnRateLimit: true, cooldown,
  });

  const rateLimited = sawRateLimit(db, ['psa_pop_discovery', 'psa_pop_set_items'], startedIso);

  await materialize(db, { includeTcgdex: false, includePsa: true, includeEbay: false, includeEcb: false, pipelineRunId: ctx.pipelineRunId });
  const after = selectEbayMatchedTargets(db, { liveAuctionsOnly: true });
  const resolved = Math.max(0, before.unresolvedVariants - after.unresolvedVariants);
  if (resolved > 0) {
    snapshotPsaTargets(db, ctx.pipelineRunId, { refresh: true, liveAuctionsOnly: true, cap: 500, ebayComplete: true });
    syncPsaCoverage(db, ctx.pipelineRunId);
    markPublishDirty(db);
  }
  ctx.log(`psa/identity: resolved ${resolved} variant(s); ${after.unresolvedVariants} still unresolved`);
  return { workDone: resolved, deadLettered: 0, rateLimited };
}

/**
 * The single PSA supervisor stage. One warm browser, one shared rate budget and
 * circuit-breaker, one bounded tick. Spends the budget fetch-first (the numbers
 * users see), then cert lookups, then -- only with headroom left and nothing
 * more urgent moving -- the expensive identity crawl.
 */
export const tickPsa: StageTick = async (db, ctx) => {
  const idleAt = new Date(ctx.now().getTime() + IDLE_MINUTES * 60_000).toISOString();

  // Ahead of the circuit and profile guards on purpose: target discovery is pure
  // local SQL over what ebay-match already produced, so a rate-limited or
  // signed-out PSA session must not also freeze the manifest. Otherwise a
  // blocked session leaves newly-matched auctions invisible until the daily
  // reconcile, and the stage comes back to find nothing to do.
  if (ctx.now().getTime() - lastManifestRefreshAt >= MANIFEST_REFRESH_MS) {
    lastManifestRefreshAt = ctx.now().getTime();
    snapshotPsaTargets(db, ctx.pipelineRunId, { refresh: true, liveAuctionsOnly: true, cap: 500, ebayComplete: true });
    syncPsaCoverage(db, ctx.pipelineRunId);
  }

  const circuit = psaCircuitOpen(db, ctx.pipelineRunId);
  if (circuit.open) return { workDone: 0, note: circuit.reason, nextEligibleAt: circuit.until ?? idleAt };

  if (!psaProfilePresent()) return { workDone: 0, pause: PSA_SESSION_PAUSE, note: PSA_SESSION_PAUSE.reason };
  daemonInit();

  const deadline = ctx.now().getTime() + PSA_TICK_BUDGET_MS;
  let done = 0;
  let deadLettered = 0;
  let rateLimited = false;

  try {
    const page = await getPsaPage();
    await ensureOnPsa(page, POP_URL);

    if (ctx.now().getTime() < deadline) {
      const r = await runFetchSlice(db, ctx, page);
      done += r.workDone; deadLettered += r.deadLettered; rateLimited ||= r.rateLimited;
    }
    if (!rateLimited && ctx.now().getTime() < deadline) {
      const r = await runCertSlice(db, ctx, page);
      done += r.workDone; deadLettered += r.deadLettered; rateLimited ||= r.rateLimited;
    }
    // Not `done === 0`: the identity crawl is the only thing that widens PSA
    // heading coverage, and gating it on a completely quiet tick meant it
    // effectively never ran while fetch or cert had anything at all to do.
    // Idle ticks still run it immediately; busy ones let it through periodically.
    const identityDue = done === 0 || ctx.now().getTime() - lastIdentityRunAt >= IDENTITY_MIN_INTERVAL_MS;
    if (!rateLimited && identityDue && ctx.now().getTime() < deadline - IDENTITY_MIN_HEADROOM_MS) {
      lastIdentityRunAt = ctx.now().getTime();
      const r = await runIdentitySlice(db, ctx, page);
      done += r.workDone; deadLettered += r.deadLettered; rateLimited ||= r.rateLimited;
    }
  } catch (error) {
    if (error instanceof PsaSessionExpiredError) {
      await closePsaBrowser();
      return { workDone: done, pause: PSA_SESSION_PAUSE, note: PSA_SESSION_PAUSE.reason };
    }
    if (error instanceof PsaCloudflareError) {
      await closePsaBrowser();
      return { workDone: done, pause: PSA_CLOUDFLARE_PAUSE, note: PSA_CLOUDFLARE_PAUSE.reason };
    }
    throw error;
  }

  if (rateLimited) {
    const circuitNow = tripPsaCircuit(db, ctx.pipelineRunId, 'fetch/cert/identity');
    // workDone:0 so the stage reads as backing-off, not "working"; anything the
    // slices resolved before the 429 is already committed.
    return { workDone: 0, deadLettered, note: circuitNow.reason, nextEligibleAt: circuitNow.until ?? idleAt };
  }

  notePsaSuccess(db, ctx.pipelineRunId);
  if (done === 0) return { workDone: 0, note: 'no PSA work pending', nextEligibleAt: idleAt };
  return { workDone: done, deadLettered, note: `${done} PSA unit(s) advanced` };
};
