import { materialize } from '../../curated/materialize.ts';
import { snapshotPsaTargets, syncPsaCoverage } from '../psaManifest.ts';
import { markPublishDirty } from '../supervisorState.ts';
import { peekDirty, clearDirty } from '../materializeDirty.ts';
import type { StageTick } from './types.ts';

const RECONCILE_INTERVAL_MS = Number(process.env.SCRAPERBASE_RECONCILE_INTERVAL_MS) || 24 * 3_600_000;
const PSA_TARGET_CAP = 500;

/**
 * Once a day: a full rebuild to heal any drift the incremental ticks left
 * behind -- stale review rows, whole-table cluster propagation, PSA native
 * identity, ECB rate. Also re-freezes the live PSA target manifest.
 */
export const tickReconcile: StageTick = async (db, ctx) => {
  const at = ctx.now().toISOString();
  const result = await materialize(db, { includeTcgdex: true, includePsa: true, includeEbay: true, includeEcb: true, now: at, pipelineRunId: ctx.pipelineRunId });
  // Everything just got rebuilt, so the incremental dirty sets are stale.
  clearDirty(db, 'ebay-item', peekDirty(db, 'ebay-item', 100_000), at);
  clearDirty(db, 'psa-spec', peekDirty(db, 'psa-spec', 100_000), at);
  const manifest = snapshotPsaTargets(db, ctx.pipelineRunId, { refresh: true, activeOnly: true, cap: PSA_TARGET_CAP, ebayComplete: true });
  syncPsaCoverage(db, ctx.pipelineRunId);
  markPublishDirty(db);
  ctx.log(`reconcile: full rebuild (${result.ebayListings} listings, ${result.psaSpecs} specs, ${manifest.specs} live targets)`);
  return {
    workDone: 1,
    note: `full rebuild: ${result.ebayListings} listings, ${result.matchedEbayListings} matched`,
    nextEligibleAt: new Date(ctx.now().getTime() + RECONCILE_INTERVAL_MS).toISOString(),
  };
};
