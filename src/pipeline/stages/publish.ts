import { assembleGeneration, publishGeneration, validateGeneration } from '../publication.ts';
import { syncPipelineGaps } from '../quality.ts';
import { clearPublishDirty, getSupervisorState } from '../supervisorState.ts';
import type { StageTick } from './types.ts';

const MIN_PUBLISH_INTERVAL_MS = Number(process.env.SCRAPERBASE_MIN_PUBLISH_INTERVAL_MS) || 120_000;
/** Publish immediately (ignore the debounce) if a live target auction closes within this. */
const URGENT_CLOSE_MS = 6 * 3_600_000;

/**
 * Debounced incremental publication: when a stage has written user-visible rows
 * (publish_dirty) and enough time has passed since the last generation, snapshot
 * the working DB, validate it, and swap the published pointer -- so matched
 * auctions and PSA facts reach the UI within a couple of minutes, marked
 * "partial" while the supervisor keeps working.
 */
export const tickPublish: StageTick = async (db, ctx) => {
  const state = getSupervisorState(db);
  if (!state.publish_dirty) {
    return { workDone: 0, note: 'nothing to publish', nextEligibleAt: new Date(ctx.now().getTime() + 60_000).toISOString() };
  }

  const sinceLast = state.last_publish_at ? ctx.now().getTime() - Date.parse(state.last_publish_at) : Infinity;
  const urgent = Number((db.prepare(
    `SELECT COUNT(*) n FROM pipeline_psa_target_listings tl
     JOIN ebay_listings e ON e.ebay_listing_id=tl.ebay_listing_id
     JOIN v_ebay_listing_latest_price lp ON lp.ebay_listing_id=e.ebay_listing_id
     WHERE lp.item_end_date BETWEEN datetime('now') AND datetime('now', ?)`,
  ).get(`+${Math.round(URGENT_CLOSE_MS / 1000)} seconds`) as { n: number }).n) > 0;

  if (sinceLast < MIN_PUBLISH_INTERVAL_MS && !urgent) {
    return { workDone: 0, note: `debouncing (${Math.round(sinceLast / 1000)}s since last)`,
      nextEligibleAt: new Date(Date.parse(state.last_publish_at!) + MIN_PUBLISH_INTERVAL_MS).toISOString() };
  }

  syncPipelineGaps(db, ctx.pipelineRunId);
  await assembleGeneration(db, ctx.pipelineRunId);
  const manifest = validateGeneration(db, ctx.pipelineRunId, {
    completeness: 'partial',
    incompleteReason: 'Live pipeline running -- data fills in continuously.',
  });
  publishGeneration(db, ctx.pipelineRunId);
  const publishedAt = new Date().toISOString();
  clearPublishDirty(db, publishedAt);
  ctx.log(`publish: generation ${manifest.generationId} (${manifest.counts.ebayListings} listings, ${manifest.counts.psaSpecs} specs)`);
  return { workDone: 1, note: `published ${manifest.counts.ebayListings} listings${urgent ? ' (urgent close)' : ''}` };
};
