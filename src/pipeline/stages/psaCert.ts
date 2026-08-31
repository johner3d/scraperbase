import { runQueue } from '../../core/queue/runner.ts';
import { createRateLimiter } from '../../core/http/rateLimiter.ts';
import { createPsaCertCollector } from '../../sources/psa/collectors/cert.ts';
import { seedPsaCertLookups } from '../../sources/psa/collectors/cert.ts';
import { markEbayItemDirty } from '../materializeDirty.ts';
import { recordDeadLetter } from '../deadLetters.ts';
import { withPsaPage } from './psaBrowser.ts';
import type { StageTick } from './types.ts';

const CERTS_PER_TICK = 25;

function pendingCertCount(db: Parameters<StageTick>[0]): number {
  return Number((db.prepare(
    `SELECT COUNT(*) n FROM work_items WHERE source='psa' AND queue='psa_cert' AND state IN ('pending','retryable_failed')`,
  ).get() as { n: number }).n);
}

/** Resolve PSA cert numbers found on eBay listings back to the spec PSA graded. */
export const tickPsaCert: StageTick = async (db, ctx) => {
  seedPsaCertLookups(db, 5000, true);
  if (pendingCertCount(db) === 0) {
    return { workDone: 0, note: 'no cert lookups pending', nextEligibleAt: new Date(ctx.now().getTime() + 3 * 60_000).toISOString() };
  }

  const rateLimiter = createRateLimiter({ minDelayMs: 600, jitterMs: 300 });
  let done = 0;
  const outcome = await withPsaPage('https://www.psacard.com/cert', async (page) => {
    await runQueue(db, {
      queue: 'psa_cert', collector: createPsaCertCollector({ page, getPage: async () => page, rateLimiter }),
      concurrency: 1, leaseTtlMs: 300_000, runId: ctx.runId, isDraining: ctx.draining,
      maxItems: CERTS_PER_TICK, haltOnRateLimit: true,
      cooldown: { afterConsecutiveFailures: 3, cooldownMs: 60_000 },
      onItemComplete: (result) => { if (result.final === 'succeeded') done++; },
    });
  });
  if (!outcome.ok) return { workDone: 0, pause: outcome.pause, note: outcome.pause.reason };

  // Re-materialize listings that carry a cert but haven't been upgraded to the
  // exact cert match yet -- the cert->spec map now has more entries.
  let requeued = 0;
  for (const row of db.prepare(
    `SELECT sr.namespace, sr.source_key FROM ebay_listings e
     JOIN source_records sr ON sr.source_record_id=e.source_record_id
     WHERE e.cert_number IS NOT NULL AND TRIM(e.cert_number)<>'' AND COALESCE(e.match_method,'')<>'ebay-psa-cert'`,
  ).all() as Array<{ namespace: string; source_key: string }>) {
    markEbayItemDirty(db, `item:${row.namespace}:${row.source_key}`);
    requeued++;
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

  ctx.log(`psa-cert: resolved ${done} cert(s); re-queued ${requeued} listing(s) for rematch`);
  return { workDone: done, deadLettered, note: `${done} cert(s) resolved, ${pendingCertCount(db)} pending` };
};
