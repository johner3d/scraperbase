import type { DatabaseSync } from 'node:sqlite';
import { ebayQuotaState } from '../sources/ebay/quota.ts';
import { listDeadLetters } from './deadLetters.ts';
import { getSupervisorState } from './supervisorState.ts';
import { readStageStatus, throughputPerMinute } from './stageState.ts';
import type { StageStatusView, SupervisorStatusView, TermFunnelView } from '../web/types.ts';

export type { StageStatusView, SupervisorStatusView, TermFunnelView };

const STAGE_QUEUES: Record<string, string[]> = {
  ingest: ['ebay_search', 'ebay_item_detail'],
  'psa-cert': ['psa_cert'],
  'psa-identity': ['psa_pop_discovery', 'psa_pop_set_items'],
  'psa-fetch': ['psa_enrichment_population', 'psa_enrichment_sales'],
};

function queueCounts(db: DatabaseSync, queues: string[]): { pending: number; inFlight: number; retryable: number; permanentFailed: number } {
  if (!queues.length) return { pending: 0, inFlight: 0, retryable: 0, permanentFailed: 0 };
  const ph = queues.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT state, COUNT(*) n FROM work_items WHERE queue IN (${ph}) GROUP BY state`,
  ).all(...queues) as Array<{ state: string; n: number }>;
  const by = Object.fromEntries(rows.map((r) => [r.state, Number(r.n)]));
  return {
    pending: by.pending ?? 0,
    inFlight: (by.leased ?? 0) + (by.running ?? 0),
    retryable: by.retryable_failed ?? 0,
    permanentFailed: by.permanent_failed ?? 0,
  };
}

export function supervisorStatus(db: DatabaseSync): SupervisorStatusView {
  const state = getSupervisorState(db);
  const running = Boolean(
    state.run_id &&
    db.prepare(`SELECT 1 FROM runs WHERE run_id=? AND status='running'`).get(state.run_id),
  );

  const stages: StageStatusView[] = readStageStatus(db).map((row) => {
    const counts = queueCounts(db, STAGE_QUEUES[row.stage] ?? []);
    return {
      stage: row.stage,
      state: row.state,
      queueDepth: counts.pending,
      inFlight: counts.inFlight,
      retryable: counts.retryable,
      permanentFailed: counts.permanentFailed,
      doneTotal: row.items_done_total,
      deadLetterOpen: row.dead_letter_open,
      throughputPerMin: throughputPerMinute(row),
      lastActivityAt: row.last_activity_at,
      nextEligibleAt: row.next_eligible_at,
      note: row.note,
      autoEnabled: row.auto_enabled === 1,
      runRequestedAt: row.run_requested_at,
    };
  });

  const activeStages = (() => {
    if (!state.run_id) return null;
    const run = db.prepare(`SELECT config_json FROM runs WHERE run_id=?`).get(state.run_id) as { config_json: string } | undefined;
    try {
      const cfg = run ? JSON.parse(run.config_json) as { stages?: unknown } : {};
      return Array.isArray(cfg.stages) && cfg.stages.length ? cfg.stages.map(String) : null;
    } catch { return null; }
  })();

  const terms: TermFunnelView[] = (db.prepare(`SELECT * FROM ebay_search_terms ORDER BY enabled DESC, priority DESC, search_term_id`)
    .all() as Array<Record<string, unknown>>).map((t) => {
    const id = Number(t.search_term_id);
    const found = Number((db.prepare(
      `SELECT COUNT(*) n FROM ebay_campaign_items ci JOIN ebay_campaigns c ON c.campaign_id=ci.campaign_id WHERE c.search_term_id=?`,
    ).get(id) as { n: number }).n);
    const funnelRow = db.prepare(
      `SELECT
         SUM(CASE WHEN e.ebay_listing_id IS NOT NULL THEN 1 ELSE 0 END) detailed,
         SUM(CASE WHEN e.match_tier IN ('exact','strong') AND e.flagged=0 THEN 1 ELSE 0 END) matched
       FROM ebay_campaign_items ci
       JOIN ebay_campaigns c ON c.campaign_id=ci.campaign_id
       LEFT JOIN ebay_listings e ON e.marketplace=ci.marketplace AND e.item_id=ci.item_id
       WHERE c.search_term_id=?`,
    ).get(id) as { detailed: number | null; matched: number | null };
    const psa = db.prepare(
      `SELECT
         COUNT(DISTINCT CASE WHEN lp.item_end_date > datetime('now') THEN tl.pipeline_psa_target_id END) targeted,
         COUNT(DISTINCT CASE WHEN cov_p.status='processed' THEN tl.pipeline_psa_target_id END) population,
         COUNT(DISTINCT CASE WHEN cov_g.status='processed' THEN tl.pipeline_psa_target_id END) guide,
         COUNT(DISTINCT CASE WHEN cov_s.status='processed' THEN tl.pipeline_psa_target_id END) sales
       FROM ebay_campaign_items ci
       JOIN ebay_campaigns c ON c.campaign_id=ci.campaign_id
       JOIN ebay_listings e ON e.marketplace=ci.marketplace AND e.item_id=ci.item_id
       JOIN pipeline_psa_target_listings tl ON tl.ebay_listing_id=e.ebay_listing_id
       LEFT JOIN v_ebay_listing_latest_price lp ON lp.ebay_listing_id=e.ebay_listing_id
       LEFT JOIN pipeline_psa_coverage cov_p ON cov_p.pipeline_psa_target_id=tl.pipeline_psa_target_id AND cov_p.phase='population'
       LEFT JOIN pipeline_psa_coverage cov_g ON cov_g.pipeline_psa_target_id=tl.pipeline_psa_target_id AND cov_g.phase='guide'
       LEFT JOIN pipeline_psa_coverage cov_s ON cov_s.pipeline_psa_target_id=tl.pipeline_psa_target_id AND cov_s.phase='sales'
       WHERE c.search_term_id=?`,
    ).get(id) as { targeted: number; population: number; guide: number; sales: number };
    return {
      searchTermId: id,
      query: String(t.query_text),
      marketplace: String(t.marketplace),
      buyingOption: String(t.buying_option),
      enabled: Boolean(t.enabled),
      lastCompletedAt: (t.last_completed_at as string | null) ?? null,
      lastResultCount: (t.last_result_count as number | null) ?? null,
      funnel: {
        found,
        detailed: Number(funnelRow.detailed ?? 0),
        matched: Number(funnelRow.matched ?? 0),
        psaTargetedLive: Number(psa.targeted ?? 0),
        population: Number(psa.population ?? 0),
        guide: Number(psa.guide ?? 0),
        sales: Number(psa.sales ?? 0),
      },
    };
  });

  const deadLetters = listDeadLetters(db).map((d) => ({
    stage: d.stage, scopeKey: d.scope_key, reason: d.reason, lastSeenAt: d.last_seen_at,
  }));

  // Only the supervisor's own pauses -- legacy `pipeline run` pauses belong to
  // their own runs and shouldn't clutter the live dashboard.
  const activePauses = state.pipeline_run_id
    ? (db.prepare(
        `SELECT stage_name, source, reason, resume_after FROM pipeline_pauses
         WHERE resolved_at IS NULL AND pipeline_run_id=? ORDER BY created_at DESC`,
      ).all(state.pipeline_run_id) as Array<{ stage_name: string; source: string; reason: string; resume_after: string | null }>).map((p) => ({
        stage: p.stage_name, source: p.source, reason: p.reason, resumeAfter: p.resume_after,
      }))
    : [];

  return {
    running,
    runId: state.run_id,
    startedAt: state.started_at,
    publishDirty: Boolean(state.publish_dirty),
    lastPublishAt: state.last_publish_at,
    quota: ebayQuotaState(db),
    stages,
    activeStages,
    terms,
    deadLetters,
    activePauses,
  };
}
