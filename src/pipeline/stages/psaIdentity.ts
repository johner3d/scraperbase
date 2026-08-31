import { runQueue } from '../../core/queue/runner.ts';
import { createRateLimiter } from '../../core/http/rateLimiter.ts';
import { createPsaPopDiscoveryCollector, seedPsaPopDiscovery } from '../../sources/psa/collectors/popDiscovery.ts';
import { createPsaSetItemsCollector } from '../../sources/psa/collectors/setItems.ts';
import { materialize } from '../../curated/materialize.ts';
import { selectEbayMatchedTargets } from '../../curated/psaTargets.ts';
import { snapshotPsaTargets, syncPsaCoverage } from '../psaManifest.ts';
import { markPublishDirty } from '../supervisorState.ts';
import { withPsaPage } from './psaBrowser.ts';
import type { StageTick } from './types.ts';

const DISCOVERY_ITEMS_PER_TICK = 20;
const SET_ITEMS_PER_TICK = 15;
/** Identity work is expensive and rarely urgent -- don't hammer it. */
const IDLE_MINUTES = 15;
const PSA_TARGET_CAP = 500;

/**
 * Fill the eBay->PSA identity gap: when trusted matched listings point at a
 * variant with no PSA population spec, crawl PSA's own pop-report tree to mint
 * the spec ids, then freeze the (live-only) target manifest.
 */
export const tickPsaIdentity: StageTick = async (db, ctx) => {
  const idle = () => ({ nextEligibleAt: new Date(ctx.now().getTime() + IDLE_MINUTES * 60_000).toISOString() });
  const before = selectEbayMatchedTargets(db, { liveAuctionsOnly: true });

  if (before.unresolvedVariants === 0) {
    const manifest = snapshotPsaTargets(db, ctx.pipelineRunId, { refresh: true, liveAuctionsOnly: true, cap: PSA_TARGET_CAP, ebayComplete: true });
    return { workDone: 0, note: `identity complete; ${manifest.specs} live target spec(s)`, ...idle() };
  }

  const rateLimiter = createRateLimiter({ minDelayMs: 600, jitterMs: 300 });
  const cooldown = { afterConsecutiveFailures: 3, cooldownMs: 60_000 };
  const outcome = await withPsaPage('https://www.psacard.com/pop/tcg-cards/156940', async (page) => {
    seedPsaPopDiscovery(db);
    await runQueue(db, {
      queue: 'psa_pop_discovery', collector: createPsaPopDiscoveryCollector({ page, rateLimiter }),
      concurrency: 1, leaseTtlMs: 300_000, runId: ctx.runId, isDraining: ctx.draining,
      maxItems: DISCOVERY_ITEMS_PER_TICK, haltOnRateLimit: true, cooldown,
    });
    await runQueue(db, {
      queue: 'psa_pop_set_items', collector: createPsaSetItemsCollector({ page, rateLimiter }),
      concurrency: 1, leaseTtlMs: 300_000, runId: ctx.runId, isDraining: ctx.draining,
      maxItems: SET_ITEMS_PER_TICK, haltOnRateLimit: true, cooldown,
    });
  });
  if (!outcome.ok) return { workDone: 0, pause: outcome.pause, note: outcome.pause.reason };

  await materialize(db, { includeTcgdex: false, includePsa: true, includeEbay: false, includeEcb: false, pipelineRunId: ctx.pipelineRunId });
  const after = selectEbayMatchedTargets(db, { liveAuctionsOnly: true });
  const resolved = Math.max(0, before.unresolvedVariants - after.unresolvedVariants);
  const manifest = snapshotPsaTargets(db, ctx.pipelineRunId, { refresh: true, liveAuctionsOnly: true, cap: PSA_TARGET_CAP, ebayComplete: true });
  syncPsaCoverage(db, ctx.pipelineRunId);
  if (resolved > 0) markPublishDirty(db);
  ctx.log(`psa-identity: resolved ${resolved} variant(s); ${after.unresolvedVariants} still unresolved; ${manifest.specs} live targets`);
  return {
    workDone: resolved,
    note: `${resolved} identities resolved, ${after.unresolvedVariants} pending`,
    nextEligibleAt: after.unresolvedVariants === 0 ? idle().nextEligibleAt : undefined,
  };
};
