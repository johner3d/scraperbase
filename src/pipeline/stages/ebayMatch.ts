import { materialize } from '../../curated/materialize.ts';
import { clearDirty, countDirty, peekDirty } from '../materializeDirty.ts';
import { markPublishDirty } from '../supervisorState.ts';
import type { StageTick } from './types.ts';

/** eBay listings to re-materialize per tick. */
const BATCH = 60;

/**
 * Re-materialize the eBay listings whose item detail changed since the last
 * tick (dirty set filled by the ingest tick's onItemComplete). Incremental:
 * only the touched listings, no whole-table cluster propagation -- that stays
 * in the daily reconcile pass.
 */
export const tickEbayMatch: StageTick = async (db, ctx) => {
  const refs = peekDirty(db, 'ebay-item', BATCH);
  if (refs.length === 0) {
    return { workDone: 0, note: 'no changed listings', nextEligibleAt: new Date(ctx.now().getTime() + 60_000).toISOString() };
  }
  const before = ctx.now().toISOString();
  const result = await materialize(db, {
    incremental: true,
    includeTcgdex: false, includePsa: false, includeEcb: false,
    changedEbayScopeKeys: new Set(refs),
    now: before,
    pipelineRunId: ctx.pipelineRunId,
  });
  clearDirty(db, 'ebay-item', refs, before);
  markPublishDirty(db);
  const remaining = countDirty(db, 'ebay-item');
  ctx.log(`ebay-match: materialized ${result.ebayListings} listing(s), ${result.matchedEbayListings} matched (${remaining} still dirty)`);
  return {
    workDone: result.ebayListings || refs.length,
    note: `${result.ebayListings} listing(s) re-matched, ${remaining} queued`,
  };
};
