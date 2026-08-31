import { runQueue } from '../../core/queue/runner.ts';
import { workItemId } from '../../core/queue/workItem.ts';
import { materialize } from '../../curated/materialize.ts';
import {
  indexSalesCheckpoints,
  installStopHandlers,
} from '../../sources/psa/rawFetch.ts';
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
import { loadPsaManifest, syncPsaCoverage } from '../psaManifest.ts';
import { markPsaSpecDirty } from '../materializeDirty.ts';
import { markPublishDirty } from '../supervisorState.ts';
import { recordDeadLetter } from '../deadLetters.ts';
import { withPsaPage } from './psaBrowser.ts';
import { LIVE_AUCTION_WINDOW_HOURS } from '../../curated/ebay/liveAuctionScope.ts';
import type { StageTick } from './types.ts';

const SPECS_PER_TICK = 8;
const PSA_MAX_AGE_DAYS = Number(process.env.SCRAPERBASE_PSA_MAX_AGE_DAYS) || 7;
const SALES_AUDIT_DAYS = Number(process.env.SCRAPERBASE_SALES_AUDIT_DAYS) || 30;
const IDLE_MINUTES = 5;
/** How long a `no_data` phase rests before we try the fetch again (PSA may have since published a guide). */
const NO_DATA_RETRY_MINUTES = 90;

/**
 * Fetch PSA population + price + sales facts for the most urgent live targets
 * (soonest-closing auction first), one small batch per tick, importing and
 * re-materializing just those specs so they surface in the UI within a tick or
 * two of matching. Ended auctions are never fetched.
 */
export const tickPsaFetch: StageTick = async (db, ctx) => {
  const idle = { nextEligibleAt: new Date(ctx.now().getTime() + IDLE_MINUTES * 60_000).toISOString() };

  // Specs whose target has a listing still in the live auction view (>=1 bid,
  // ending inside the window) and whose coverage is not yet complete: never
  // fetched (`pending`/`raw_missing`/`identity_missing`), or last fetched
  // without a result long enough ago to be worth another try (`no_data`).
  // Ordered by soonest auction close; specs with an open dead-letter skipped.
  // The live-listing check mirrors liveAuctionListingClause -- defence in depth
  // over the already-scoped target manifest.
  const urgent = db.prepare(
    `SELECT DISTINCT t.population_spec_id AS spec, MIN(lp.item_end_date) AS soonest
     FROM pipeline_psa_coverage cov
     JOIN pipeline_psa_targets t ON t.pipeline_psa_target_id=cov.pipeline_psa_target_id
     JOIN pipeline_psa_target_listings tl ON tl.pipeline_psa_target_id=t.pipeline_psa_target_id
     JOIN ebay_listings e ON e.ebay_listing_id=tl.ebay_listing_id
     JOIN v_ebay_listing_latest_price lp ON lp.ebay_listing_id=e.ebay_listing_id
     WHERE t.pipeline_run_id=?
       AND (cov.status IN ('pending','raw_missing','identity_missing')
            OR (cov.status='no_data'
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

  if (urgent.length === 0) {
    return { workDone: 0, note: 'no live PSA targets pending', ...idle };
  }

  const specIds = new Set(urgent.map((r) => String(r.spec)));
  const selections = loadPsaManifest(db, ctx.pipelineRunId).selections.filter((s) => specIds.has(String(s.psaSpecId)));
  if (selections.length === 0) return { workDone: 0, note: 'targets not in manifest yet', ...idle };

  // Every urgent spec is here because its coverage is incomplete, so force a
  // real re-fetch of exactly these specs rather than trusting a possibly-stale
  // or wrong-source cached file. `force` also skips the global stale-repend
  // sweep, which would otherwise drag the whole historical enrichment backlog
  // back into the queue ahead of the live targets.
  seedPsaEnrichment(db, selections, PSA_MAX_AGE_DAYS, SALES_AUDIT_DAYS, { force: true });
  indexSalesCheckpoints();
  installStopHandlers();

  const outcome = await withPsaPage('https://www.psacard.com/pop', async (page) => {
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
  });
  if (!outcome.ok) return { workDone: 0, pause: outcome.pause, note: outcome.pause.reason };

  // Genuine rate-limit pause vs. a spec that simply exhausted its attempts.
  let deadLettered = 0;
  const ids = selections.flatMap((s) => [
    workItemId('psa', POP_QUEUE, psaEnrichmentScope('population', s.psaSpecId)),
    ...(s.salesSpecId == null ? [] : [workItemId('psa', SALES_QUEUE, psaEnrichmentScope('sales', s.salesSpecId))]),
  ]);
  const stuck = db.prepare(
    `SELECT work_item_id, queue, scope_key, state, last_error FROM work_items
     WHERE work_item_id IN (${ids.map(() => '?').join(',')}) AND state='permanent_failed'`,
  ).all(...ids) as Array<{ work_item_id: string; queue: string; scope_key: string; state: string; last_error: string | null }>;
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

  ctx.log(`psa-fetch: ${selections.length} spec(s), ${imported} file(s) imported${deadLettered ? `, ${deadLettered} dead-lettered` : ''}`);
  return { workDone: selections.length, deadLettered, note: `${selections.length} live spec(s) enriched` };
};
