import { runQueue } from '../../core/queue/runner.ts';
import { createRateLimiter } from '../../core/http/rateLimiter.ts';
import { createEbaySearchCollector } from '../../sources/ebay/collectors/search.ts';
import { createEbayItemDetailCollector } from '../../sources/ebay/collectors/itemDetail.ts';
import { ebayQuotaState, nextEbayReset } from '../../sources/ebay/quota.ts';
import { loadEbayCredentials } from '../../sources/ebay/config.ts';
import {
  dueSearchTerms,
  ensureTermCampaign,
  markTermCompleted,
  markTermEnqueued,
  seedSearchTermPage,
} from '../searchTerms.ts';
import { markEbayItemDirty } from '../materializeDirty.ts';
import { markPublishDirty } from '../supervisorState.ts';
import { recordDeadLetter } from '../deadLetters.ts';
import type { StageTick } from './types.ts';

/** eBay item-detail calls to fetch per ingest tick (the scarce quota is ~4,500/day). */
const DETAIL_BUDGET_PER_TICK = 40;
const SEARCH_PAGE_BUDGET_PER_TICK = 12;
/** How many due terms to seed per tick -- keeps a tick short. */
const TERMS_PER_TICK = 3;

/**
 * Refresh the eBay search terms whose interval has elapsed, then fetch a
 * bounded slice of the resulting search pages + item details. Commits per item
 * via the queue. Quota exhaustion parks the stage until the next 07:00 UTC
 * reset instead of erroring.
 */
export const tickIngest: StageTick = async (db, ctx) => {
  try {
    loadEbayCredentials();
  } catch (error) {
    return { workDone: 0, note: `eBay credentials unavailable: ${(error as Error).message}`,
      nextEligibleAt: new Date(ctx.now().getTime() + 30 * 60_000).toISOString() };
  }

  const quota = ebayQuotaState(db, ctx.now());
  if (quota.paused) {
    return { workDone: 0, note: `eBay daily budget reached (${quota.used}/${quota.limit})`, nextEligibleAt: quota.resumeAfter };
  }

  const due = dueSearchTerms(db, ctx.now()).slice(0, TERMS_PER_TICK);
  for (const term of due) {
    const campaignId = ensureTermCampaign(db, ctx.pipelineRunId, term);
    seedSearchTermPage(db, term, campaignId, 200, ctx.now());
    markTermEnqueued(db, term.search_term_id, ctx.now());
    ctx.log(`ingest: seeded "${term.query_text}" (${term.marketplace}/${term.buying_option})`);
  }

  const rateLimiter = createRateLimiter({ minDelayMs: 250, jitterMs: 150 });
  const safety = { haltOnRateLimit: true as const, cooldown: { afterConsecutiveFailures: 3, cooldownMs: 60_000 } };
  let deadLettered = 0;
  let dirtied = 0;

  await runQueue(db, {
    queue: 'ebay_search', collector: createEbaySearchCollector({ rateLimiter }),
    concurrency: 3, leaseTtlMs: 300_000, runId: ctx.runId, isDraining: ctx.draining,
    maxItems: SEARCH_PAGE_BUDGET_PER_TICK, ...safety,
  });

  await runQueue(db, {
    queue: 'ebay_item_detail', collector: createEbayItemDetailCollector({ rateLimiter }),
    concurrency: 3, leaseTtlMs: 300_000, runId: ctx.runId, isDraining: ctx.draining,
    maxItems: DETAIL_BUDGET_PER_TICK, ...safety,
    onItemComplete: (result, item) => {
      if (result.final === 'succeeded') { markEbayItemDirty(db, item.scope_key); dirtied++; }
    },
  });

  // Sweep newly-exhausted item detail failures into the dead-letter.
  for (const row of db.prepare(
    `SELECT work_item_id, scope_key, last_error FROM work_items
     WHERE source='ebay' AND queue='ebay_item_detail' AND state='permanent_failed'
       AND scope_key NOT IN (SELECT scope_key FROM pipeline_dead_letters WHERE stage='ingest')`,
  ).all() as Array<{ work_item_id: string; scope_key: string; last_error: string | null }>) {
    recordDeadLetter(db, { stage: 'ingest', scopeKey: row.scope_key, workItemId: row.work_item_id,
      reason: row.last_error ?? 'eBay item detail exhausted its attempts' });
    deadLettered++;
  }

  // Mark terms complete whose campaign shows no pending search pages left.
  for (const term of due) {
    const pending = Number((db.prepare(
      `SELECT COUNT(*) n FROM work_items w JOIN ebay_campaigns c ON json_extract(w.params_json,'$.campaignId')=c.campaign_id
       WHERE c.search_term_id=? AND w.queue='ebay_search' AND w.state IN ('pending','leased','running','retryable_failed')`,
    ).get(term.search_term_id) as { n: number }).n);
    if (pending === 0) {
      const total = db.prepare(`SELECT MAX(total_reported) t FROM ebay_campaigns WHERE search_term_id=?`).get(term.search_term_id) as { t: number | null };
      markTermCompleted(db, term.search_term_id, total.t ?? null, ctx.now());
    }
  }

  if (dirtied > 0) markPublishDirty(db);

  const stillPending = Number((db.prepare(
    `SELECT COUNT(*) n FROM work_items WHERE source='ebay' AND queue IN ('ebay_search','ebay_item_detail')
       AND state IN ('pending','retryable_failed')`,
  ).get() as { n: number }).n);
  const workDone = dirtied + due.length;
  return {
    workDone,
    deadLettered,
    note: due.length
      ? `refreshed ${due.length} term(s); ${dirtied} listings fetched, ${stillPending} queued`
      : `${dirtied} listings fetched, ${stillPending} queued`,
    // If nothing is queued and no term is due, idle a while.
    nextEligibleAt: workDone === 0 && stillPending === 0
      ? new Date(ctx.now().getTime() + 5 * 60_000).toISOString()
      : undefined,
  };
};

export { nextEbayReset };
