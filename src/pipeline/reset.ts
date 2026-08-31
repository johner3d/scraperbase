import type { DatabaseSync } from 'node:sqlite';
import { normalizePart } from '../curated/materialize.ts';
import {
  addSearchTerm,
  assertMarketplace,
  setSearchTermEnabled,
  updateSearchTerm,
  type SearchTermRow,
} from './searchTerms.ts';
import { ensureSupervisorPipelineRun } from './supervisorState.ts';

/** Work queues cleared by a reset -- everything that fans out from discovery. */
export const RESET_QUEUES = [
  'ebay_search',
  'ebay_item_detail',
  'psa_enrichment_population',
  'psa_enrichment_sales',
  'psa_pop_discovery',
  'psa_pop_set_items',
  'psa_cert',
] as const;

const CANCELLABLE_STATES = ['pending', 'retryable_failed', 'leased', 'running', 'partial'];

export interface PipelineResetOptions {
  marketplace: string;
  query: string;
  /** Minutes between live-auction sweeps for the kept term. */
  refreshIntervalMinutes?: number;
  /** Compute what would change and roll back without writing. */
  dryRun?: boolean;
}

export interface PipelineResetSummary {
  dryRun: boolean;
  pipelineRunId: string;
  termsDisabled: number;
  auctionTerm: { searchTermId: number; query: string; marketplace: string; created: boolean };
  psaTargetsDeleted: number;
  psaManifestRevisionsDeleted: number;
  workItemsCancelled: Record<string, number>;
  deadLettersResolved: number;
  pausesResolved: number;
  stageCountersReset: number;
}

/**
 * Clears the pipeline of everything outside the live-auction view: disables
 * every non-auction search term, keeps (or creates) one enabled auction term
 * for `query`/`marketplace`, drops the frozen PSA target manifest, cancels
 * outstanding discovery/enrichment work, and resolves open dead-letters and
 * pauses. Raw scraped data, the catalogue, `psa_specs`, materialized tables and
 * the published site are left untouched -- the narrowed pipeline rebuilds its
 * target set on the next `pipeline start`.
 */
export function resetPipelineToLiveAuctions(db: DatabaseSync, opts: PipelineResetOptions): PipelineResetSummary {
  const marketplace = assertMarketplace(opts.marketplace);
  const query = opts.query.trim();
  if (!query) throw new Error('query is required');
  const now = new Date().toISOString();

  db.exec('BEGIN IMMEDIATE');
  try {
    const pipelineRunId = ensureSupervisorPipelineRun(db);

    // 1. Search terms: disable every non-auction term; ensure one enabled
    //    auction term with live-view knobs, armed to fire immediately.
    const termsDisabled = Number(db.prepare(
      `UPDATE ebay_search_terms SET enabled=0, updated_at=? WHERE buying_option<>'auction' AND enabled=1`,
    ).run(now, ).changes);

    const existing = db.prepare(
      `SELECT * FROM ebay_search_terms WHERE normalized_query=? AND marketplace=? AND buying_option='auction'`,
    ).get(normalizePart(query), marketplace) as SearchTermRow | undefined;
    let searchTermId: number;
    let created = false;
    if (existing) {
      searchTermId = existing.search_term_id;
      updateSearchTerm(db, String(searchTermId), {
        minBids: 1, endingWithinHours: 72,
        refreshIntervalMinutes: opts.refreshIntervalMinutes ?? existing.refresh_interval_minutes,
      });
      setSearchTermEnabled(db, String(searchTermId), true);
    } else {
      created = true;
      searchTermId = addSearchTerm(db, {
        query, marketplace, buyingOption: 'auction', minBids: 1, endingWithinHours: 72,
        refreshIntervalMinutes: opts.refreshIntervalMinutes ?? 30, enabled: true,
      }).search_term_id;
    }
    db.prepare(`UPDATE ebay_search_terms SET last_enqueued_at=NULL, updated_at=? WHERE search_term_id=?`)
      .run(now, searchTermId);

    // 2. PSA target manifest -- cascades to _target_listings and _coverage.
    const psaTargetsDeleted = Number(db.prepare(
      `DELETE FROM pipeline_psa_targets WHERE pipeline_run_id=?`,
    ).run(pipelineRunId).changes);
    const psaManifestRevisionsDeleted = Number(db.prepare(
      `DELETE FROM pipeline_psa_manifest_revisions WHERE pipeline_run_id=?`,
    ).run(pipelineRunId).changes);

    // 3. Outstanding discovery/enrichment work. `succeeded` rows are kept (the
    //    item-detail re-arm cache and history).
    const workItemsCancelled: Record<string, number> = {};
    const cancel = db.prepare(
      `UPDATE work_items SET state='cancelled', updated_at=?, lease_owner=NULL, lease_expires_at=NULL
       WHERE queue=? AND state IN (${CANCELLABLE_STATES.map(() => '?').join(',')})`,
    );
    for (const queue of RESET_QUEUES) {
      const n = Number(cancel.run(now, queue, ...CANCELLABLE_STATES).changes);
      if (n > 0) workItemsCancelled[queue] = n;
    }

    // 4-5. Open dead-letters and pauses.
    const deadLettersResolved = Number(db.prepare(
      `UPDATE pipeline_dead_letters SET resolved_at=? WHERE resolved_at IS NULL`,
    ).run(now).changes);
    const pausesResolved = Number(db.prepare(
      `UPDATE pipeline_pauses SET resolved_at=? WHERE pipeline_run_id=? AND resolved_at IS NULL`,
    ).run(now, pipelineRunId).changes);

    // 6. Stage funnel counters.
    const stageCountersReset = Number(db.prepare(
      `UPDATE pipeline_stage_status SET items_done_total=0, items_done_window=0, window_started_at=NULL,
         dead_letter_open=0, next_eligible_at=NULL, note=NULL, state='idle'`,
    ).run().changes);

    const summary: PipelineResetSummary = {
      dryRun: Boolean(opts.dryRun),
      pipelineRunId,
      termsDisabled,
      auctionTerm: { searchTermId, query, marketplace, created },
      psaTargetsDeleted,
      psaManifestRevisionsDeleted,
      workItemsCancelled,
      deadLettersResolved,
      pausesResolved,
      stageCountersReset,
    };

    if (opts.dryRun) db.exec('ROLLBACK');
    else db.exec('COMMIT');
    return summary;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
