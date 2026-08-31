import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { OUT_DIR, type Selection } from '../sources/psa/rawFetch.ts';
import { cardFactsUrl, PSA_BASE } from '../sources/psa/config.ts';
import { liveAuctionListingClause } from '../curated/ebay/liveAuctionScope.ts';

export interface PsaManifestSummary {
  targets: number;
  specs: number;
  variants: number;
  listings: number;
  revisions: number;
  latestRevision: number;
  selections: Selection[];
}

interface TargetRow {
  pipeline_psa_target_id: number;
  population_spec_id: string;
  sales_spec_id: string | null;
  variant_id: number;
  source_set_id: string;
  source_card_id: string;
  finish: string;
  print_run_marker: string;
  micro_variant: string | null;
  manifest_revision: number;
}

function rows(db: DatabaseSync, pipelineRunId: string): TargetRow[] {
  return db.prepare(`SELECT * FROM pipeline_psa_targets WHERE pipeline_run_id=?
    ORDER BY source_set_id,source_card_id,population_spec_id,variant_id`).all(pipelineRunId) as unknown as TargetRow[];
}

function summary(db: DatabaseSync, pipelineRunId: string): PsaManifestSummary {
  const targetRows = rows(db, pipelineRunId);
  const seen = new Set<string>();
  const selections: Selection[] = [];
  for (const row of targetRows) {
    if (seen.has(row.population_spec_id)) continue;
    seen.add(row.population_spec_id);
    const psaSpecId = Number(row.population_spec_id);
    const salesSpecId = row.sales_spec_id == null ? null : Number(row.sales_spec_id);
    selections.push({
      release: row.source_set_id,
      sourceCardId: row.source_card_id,
      finish: row.finish,
      printRunMarker: row.print_run_marker,
      microVariant: row.micro_variant ?? undefined,
      psaSpecId,
      popSourceUrl: cardFactsUrl(psaSpecId),
      salesSpecId,
      salesSourceUrl: salesSpecId == null ? null : `${PSA_BASE}/spec/psa/${salesSpecId}`,
    });
  }
  const counts = db.prepare(`SELECT COUNT(DISTINCT t.variant_id) variants,
      COUNT(DISTINCT l.ebay_listing_id) listings
    FROM pipeline_psa_targets t LEFT JOIN pipeline_psa_target_listings l
      ON l.pipeline_psa_target_id=t.pipeline_psa_target_id
    WHERE t.pipeline_run_id=?`).get(pipelineRunId) as { variants: number; listings: number };
  const revision = db.prepare(`SELECT COUNT(*) revisions,COALESCE(MAX(manifest_revision),0) latest_revision
    FROM pipeline_psa_manifest_revisions WHERE pipeline_run_id=?`).get(pipelineRunId) as
    {revisions:number;latest_revision:number};
  return { targets: targetRows.length, specs: selections.length, variants: Number(counts.variants),
    listings: Number(counts.listings), revisions:Number(revision.revisions),latestRevision:Number(revision.latest_revision),selections };
}

/**
 * Freezes the trusted eBay -> PSA identity set for a run. Repeated calls are
 * reads, so a resume can never silently switch to a newly materialized set of
 * specs halfway through acquisition.
 */
export function snapshotPsaTargets(db: DatabaseSync, pipelineRunId: string,
  options:{refresh?:boolean;ebayComplete?:boolean;activeOnly?:boolean;liveAuctionsOnly?:boolean;activeMarginMinutes?:number;cap?:number|null}={}): PsaManifestSummary {
  if (rows(db, pipelineRunId).length && !options.refresh) return summary(db, pipelineRunId);
  const now = new Date().toISOString();
  const latest=db.prepare(`SELECT COALESCE(MAX(manifest_revision),0) revision FROM pipeline_psa_manifest_revisions
    WHERE pipeline_run_id=?`).get(pipelineRunId) as {revision:number};
  const revision=Number(latest.revision)+1;
  const margin = Number.isFinite(options.activeMarginMinutes) ? Number(options.activeMarginMinutes) : 30;
  const cap = options.cap == null ? null : Math.max(1, Math.trunc(options.cap));
  // liveAuctionsOnly: targets are exactly the /auctions dashboard set (see
  // liveAuctionListingClause). activeOnly: the looser legacy gate -- any spec
  // still backed by one not-yet-ended matched listing. Both order soonest-close
  // first so a `cap` keeps the urgent specs.
  const live = Boolean(options.liveAuctionsOnly);
  const liveClause = live ? liveAuctionListingClause('e', 'lp', { marginMinutes: margin }) : null;
  const legacyActive = options.activeOnly && !live;
  const listingWhere = liveClause
    ? liveClause.sql
    : `e.variant_id IS NOT NULL AND e.match_status IN ('matched','manual')
       AND e.match_tier IN ('exact','strong') AND e.flagged=0
       AND (e.match_method IS NULL OR e.match_method<>'ebay-cluster-propagate')
       ${legacyActive ? `AND datetime(lp.item_end_date) > datetime('now', printf('+%d minutes', CAST(? AS INTEGER)))` : ''}`;
  const priceJoin = liveClause ? liveClause.join
    : `LEFT JOIN v_ebay_listing_latest_price lp ON lp.ebay_listing_id=e.ebay_listing_id`;
  const candidateParams: number[] = [];
  if (liveClause) candidateParams.push(...liveClause.params);
  else if (legacyActive) candidateParams.push(margin);
  if (cap != null) candidateParams.push(cap);
  const candidates = db.prepare(`SELECT ps.spec_id population_spec_id,ps.spec_id sales_spec_id,
      v.variant_id,s.source_set_id,s.source_set_id||'-'||c.local_id source_card_id,
      COALESCE(v.finish,'unknown') finish,COALESCE(v.print_run_marker,'unknown') print_run_marker,v.micro_variant,
      MIN(CASE WHEN datetime(lp.item_end_date) > datetime('now') THEN lp.item_end_date END) next_future_end
    FROM ebay_listings e
    JOIN variants v ON v.variant_id=e.variant_id
    JOIN cards c ON c.card_id=v.card_id
    JOIN sets s ON s.set_id=c.set_id
    JOIN psa_specs ps ON ps.variant_id=v.variant_id AND ps.namespace='population'
      AND ps.match_status IN ('matched','manual')
    ${priceJoin}
    WHERE ${listingWhere}
    GROUP BY ps.spec_id,v.variant_id
    ORDER BY (next_future_end IS NULL) ASC, next_future_end ASC,
      s.release_date,s.source_set_id,c.local_sort_key,ps.spec_id,v.variant_id
    ${cap != null ? 'LIMIT ?' : ''}`).all(...candidateParams) as unknown as Array<{
      population_spec_id:string;sales_spec_id:string;variant_id:number;source_set_id:string;source_card_id:string;
      finish:string;print_run_marker:string;micro_variant:string|null;next_future_end:string|null;
    }>;
  const existingTarget=db.prepare(`SELECT pipeline_psa_target_id FROM pipeline_psa_targets
    WHERE pipeline_run_id=? AND population_spec_id=? AND variant_id=?`);
  const insert = db.prepare(`INSERT INTO pipeline_psa_targets
    (pipeline_run_id,population_spec_id,sales_spec_id,variant_id,source_set_id,source_card_id,
     finish,print_run_marker,micro_variant,created_at,manifest_revision) VALUES(?,?,?,?,?,?,?,?,?,?,?) RETURNING pipeline_psa_target_id`);
  const listingQuery = liveClause
    ? db.prepare(`SELECT e.ebay_listing_id FROM ebay_listings e ${liveClause.join}
        WHERE e.variant_id=? AND ${liveClause.sql}`)
    : db.prepare(`SELECT ebay_listing_id FROM ebay_listings WHERE variant_id=?
        AND match_status IN ('matched','manual') AND match_tier IN ('exact','strong') AND flagged=0
        AND (match_method IS NULL OR match_method<>'ebay-cluster-propagate')`);
  const listingParams = liveClause ? liveClause.params : [];
  const insertListing = db.prepare(`INSERT OR IGNORE INTO pipeline_psa_target_listings
    (pipeline_psa_target_id,ebay_listing_id) VALUES(?,?)`);
  const insertCoverage = db.prepare(`INSERT INTO pipeline_psa_coverage
    (pipeline_psa_target_id,phase,status,updated_at) VALUES(?,?,'pending',?)`);
  db.exec('BEGIN IMMEDIATE');
  try {
    let newTargets=0;
    for (const candidate of candidates) {
      let result=existingTarget.get(pipelineRunId,candidate.population_spec_id,candidate.variant_id) as
        {pipeline_psa_target_id:number}|undefined;
      if(!result){
        result = insert.get(pipelineRunId,candidate.population_spec_id,candidate.sales_spec_id,candidate.variant_id,
          candidate.source_set_id,candidate.source_card_id,candidate.finish,candidate.print_run_marker,candidate.micro_variant,now,revision) as
          { pipeline_psa_target_id:number };
        newTargets++;
        for (const phase of ['population','guide','sales']) insertCoverage.run(result.pipeline_psa_target_id,phase,now);
      }
      for (const listing of listingQuery.all(candidate.variant_id, ...listingParams) as unknown as Array<{ebay_listing_id:number}>) {
        insertListing.run(result.pipeline_psa_target_id, listing.ebay_listing_id);
      }
    }
    const listingCount=Number((db.prepare(`SELECT COUNT(DISTINCT l.ebay_listing_id) n FROM pipeline_psa_targets t
      JOIN pipeline_psa_target_listings l ON l.pipeline_psa_target_id=t.pipeline_psa_target_id
      WHERE t.pipeline_run_id=?`).get(pipelineRunId) as {n:number}).n);
    db.prepare(`INSERT INTO pipeline_psa_manifest_revisions
      (pipeline_run_id,manifest_revision,ebay_complete,new_target_count,listing_count,created_at)
      VALUES(?,?,?,?,?,?)`).run(pipelineRunId,revision,options.ebayComplete?1:0,newTargets,listingCount,now);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  syncPsaCoverage(db, pipelineRunId);
  return summary(db, pipelineRunId);
}

function fileFor(row: TargetRow, phase: 'population'|'sales'): string {
  const id = phase === 'population' ? row.population_spec_id : row.sales_spec_id;
  return id == null ? '' : path.join(OUT_DIR,row.source_set_id,phase,`${id}.json`);
}

function workState(db: DatabaseSync, phase: 'population'|'sales', specId: string|null): {state:string;last_error:string|null}|undefined {
  if (specId == null) return undefined;
  return db.prepare(`SELECT state,last_error FROM work_items WHERE source='psa' AND queue=?
    AND scope_key=?`).get(`psa_enrichment_${phase}`,`enrichment:${phase}:spec=${specId}`) as
    {state:string;last_error:string|null}|undefined;
}

export function syncPsaCoverage(db: DatabaseSync, pipelineRunId: string): Record<string,number> {
  const update = db.prepare(`UPDATE pipeline_psa_coverage SET status=?,row_count=?,source_record_id=?,detail_json=?,updated_at=?
    WHERE pipeline_psa_target_id=? AND phase=?`);
  const now = new Date().toISOString();
  for (const target of rows(db,pipelineRunId)) {
    const pop = db.prepare(`SELECT psa_spec_pk,source_record_id FROM psa_specs WHERE namespace='population'
      AND spec_id=? AND variant_id=? AND match_status IN ('matched','manual') ORDER BY psa_spec_pk DESC LIMIT 1`)
      .get(target.population_spec_id,target.variant_id) as {psa_spec_pk:number;source_record_id:number|null}|undefined;
    const sales = target.sales_spec_id == null ? undefined : db.prepare(`SELECT psa_spec_pk,source_record_id FROM psa_specs WHERE namespace='sales'
      AND spec_id=? AND variant_id=? AND match_status IN ('matched','manual') ORDER BY psa_spec_pk DESC LIMIT 1`)
      .get(target.sales_spec_id,target.variant_id) as {psa_spec_pk:number;source_record_id:number|null}|undefined;
    const populationRows = pop ? Number((db.prepare(`SELECT COUNT(*) n FROM psa_population_current WHERE population_spec_pk=?`)
      .get(pop.psa_spec_pk) as {n:number}).n) : 0;
    const guideRows = pop ? Number((db.prepare(`SELECT COUNT(*) n FROM psa_price_current WHERE population_spec_pk=?`)
      .get(pop.psa_spec_pk) as {n:number}).n) : 0;
    const salesRows = sales ? Number((db.prepare(`SELECT COUNT(*) n FROM psa_sales WHERE sales_spec_pk=?`)
      .get(sales.psa_spec_pk) as {n:number}).n) : 0;
    const popRaw = fs.existsSync(fileFor(target,'population'));
    const salesRaw = fs.existsSync(fileFor(target,'sales'));
    const popWork = workState(db,'population',target.population_spec_id);
    const salesWork = workState(db,'sales',target.sales_spec_id);
    const status = (phase:'population'|'guide'|'sales',count:number,raw:boolean,work?:{state:string;last_error:string|null}):string => {
      if (count > 0) return 'processed';
      if (raw) return phase === 'population' ? 'raw_present' : 'no_data';
      if (work?.state === 'permanent_failed') return 'failed';
      if (/429|rate.?limit/i.test(work?.last_error ?? '')) return 'rate_limited';
      if (work && ['pending','leased','running','retryable_failed','partial'].includes(work.state)) return 'pending';
      return 'raw_missing';
    };
    update.run(status('population',populationRows,popRaw,popWork),populationRows,pop?.source_record_id??null,
      JSON.stringify({rawFile:popRaw,workState:popWork?.state??null}),now,target.pipeline_psa_target_id,'population');
    update.run(status('guide',guideRows,popRaw,popWork),guideRows,pop?.source_record_id??null,
      JSON.stringify({rawFile:popRaw,workState:popWork?.state??null}),now,target.pipeline_psa_target_id,'guide');
    update.run(status('sales',salesRows,salesRaw,salesWork),salesRows,sales?.source_record_id??null,
      JSON.stringify({rawFile:salesRaw,workState:salesWork?.state??null}),now,target.pipeline_psa_target_id,'sales');
  }
  const counts = db.prepare(`SELECT phase||':'||status key,COUNT(*) n FROM pipeline_psa_coverage c
    JOIN pipeline_psa_targets t ON t.pipeline_psa_target_id=c.pipeline_psa_target_id
    WHERE t.pipeline_run_id=? GROUP BY phase,status`).all(pipelineRunId) as unknown as Array<{key:string;n:number}>;
  return Object.fromEntries(counts.map((row)=>[row.key,Number(row.n)]));
}

export function loadPsaManifest(db: DatabaseSync, pipelineRunId: string): PsaManifestSummary {
  return summary(db, pipelineRunId);
}
