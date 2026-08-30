import type { DatabaseSync } from 'node:sqlite';
import { selectEbayMatchedTargets } from '../curated/psaTargets.ts';

export function syncPipelineGaps(db:DatabaseSync,pipelineRunId:string):Record<string,number>{
  db.prepare('DELETE FROM pipeline_gaps WHERE pipeline_run_id=?').run(pipelineRunId);
  const at=new Date().toISOString();
  const rows=db.prepare(`SELECT source_record_id,match_tier,title,signals_json FROM ebay_listings
    WHERE match_tier IN ('catalogue-gap','card-level','flagged','review','out-of-scope','lot')`).all() as unknown as
    Array<{source_record_id:number;match_tier:string;title:string;signals_json:string}>;
  const insert=db.prepare(`INSERT OR IGNORE INTO pipeline_gaps
    (pipeline_run_id,gap_type,source_record_id,subject,detail_json,created_at) VALUES(?,?,?,?,?,?)`);
  for(const row of rows)insert.run(pipelineRunId,row.match_tier,row.source_record_id,row.title,row.signals_json||'{}',at);
  const targets=selectEbayMatchedTargets(db,{tiers:['exact','strong'],excludeFlagged:true});
  for(const gap of targets.unresolved)insert.run(pipelineRunId,'psa-identity-gap',null,gap.sourceSetId,JSON.stringify(gap),at);
  const counts=db.prepare(`SELECT gap_type,COUNT(*) n FROM pipeline_gaps WHERE pipeline_run_id=? GROUP BY gap_type`).all(pipelineRunId) as unknown as Array<{gap_type:string;n:number}>;
  return Object.fromEntries(counts.map((row)=>[row.gap_type,Number(row.n)]));
}

export function validateWorkingPipeline(
  db:DatabaseSync,
  pipelineRunId:string,
  options:{allowIncompleteCampaigns?:boolean}={},
):Record<string,unknown>{
  const campaignFailures=Number((db.prepare(`SELECT COUNT(*) n FROM ebay_campaigns
    WHERE pipeline_run_id=? AND (status<>'complete' OR coverage_status<>'complete')`).get(pipelineRunId) as {n:number}).n);
  if(campaignFailures&&!options.allowIncompleteCampaigns)throw new Error(`${campaignFailures} eBay campaign(s) are not complete`);
  const unprovenTrusted=Number((db.prepare(`SELECT COUNT(*) n FROM ebay_listings WHERE match_tier IN ('exact','strong')
    AND (variant_id IS NULL OR flagged=1 OR match_method='ebay-cluster-propagate')`).get() as {n:number}).n);
  if(unprovenTrusted)throw new Error(`${unprovenTrusted} trusted eBay match(es) do not have a proven variant`);
  const uncategorized=Number((db.prepare(`SELECT COUNT(*) n FROM ebay_listings WHERE match_tier IS NULL`).get() as {n:number}).n);
  if(uncategorized)throw new Error(`${uncategorized} eBay listing(s) have no match tier`);
  const broken=db.prepare('PRAGMA foreign_key_check').all();
  if(broken.length)throw new Error(`${broken.length} foreign-key violation(s) in working database`);
  const gaps=syncPipelineGaps(db,pipelineRunId);
  const targets=selectEbayMatchedTargets(db,{tiers:['exact','strong'],excludeFlagged:true});
  return {campaigns:campaignFailures?'partial':'complete',incompleteCampaigns:campaignFailures,
    trustedSpecs:targets.totalSpecs,unresolvedPsaVariants:targets.unresolvedVariants,gaps};
}
