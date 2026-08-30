import { existsSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openCliDb } from '../cli/context.ts';
import { runCommand } from '../cli/commands/run.ts';
import { DB_PATH, PSA_PROFILE_DIR } from '../core/config/config.ts';
import { materialize } from '../curated/materialize.ts';
import { selectEbayMatchedTargets } from '../curated/psaTargets.ts';
import { loadEbayCredentials, EBAY_MARKETPLACES } from '../sources/ebay/config.ts';
import { ensureCampaigns, rearmCampaign, type Campaign } from './campaigns.ts';
import { assembleGeneration, publishGeneration, validateGeneration } from './publication.ts';
import { syncPipelineGaps, validateWorkingPipeline } from './quality.ts';
import { beginStage, completeStage, completedStages, failStage, finishPipelineRun, pauseStage, retainPipelinePause } from './store.ts';
import { PIPELINE_STAGES, type PipelineConfig, type PipelineStage } from './types.ts';
import { enrichMatchedPsa } from './psaEnrichment.ts';
import { loadPsaManifest, snapshotPsaTargets, syncPsaCoverage } from './psaManifest.ts';
import { nextEbayReset } from '../sources/ebay/quota.ts';
import { ebayQuotaState } from '../sources/ebay/quota.ts';
import { OUT_DIR } from '../sources/psa/rawFetch.ts';
import { PipelinePausedError } from './pause.ts';
export { PipelinePausedError } from './pause.ts';

type StageAction=()=>Promise<unknown>|unknown;

function withDb<T>(fn:(db:ReturnType<typeof openCliDb>)=>T):T{const db=openCliDb();try{return fn(db);}finally{db.close();}}
async function withDbAsync<T>(fn:(db:ReturnType<typeof openCliDb>)=>Promise<T>):Promise<T>{const db=openCliDb();try{return await fn(db);}finally{db.close();}}

async function executeStage(id:string,stage:PipelineStage,action:StageAction):Promise<void>{
  withDb((db)=>beginStage(db,id,stage));
  console.log(`\n=== pipeline ${id} · ${stage} ===`);
  try{const summary=await action();withDb((db)=>completeStage(db,id,stage,summary??{}));}
  catch(error){
    if(error instanceof PipelinePausedError)withDb((db)=>pauseStage(db,id,stage,error.source,error.message,error.resumeAfter));
    else withDb((db)=>failStage(db,id,stage,error));
    throw error;
  }
}

function catalogueSummary(db:DatabaseSync):Record<string,unknown>{
  const rows=db.prepare(`SELECT s.language,COUNT(DISTINCT s.set_id) sets,COUNT(DISTINCT c.card_id) cards,
    COUNT(DISTINCT v.variant_id) variants FROM sets s LEFT JOIN cards c ON c.set_id=s.set_id
    LEFT JOIN variants v ON v.card_id=c.card_id WHERE s.language IN ('en','de','ja') GROUP BY s.language`).all() as unknown as
    Array<{language:string;sets:number;cards:number;variants:number}>;
  const byLanguage=Object.fromEntries(rows.map((row)=>[row.language,{sets:Number(row.sets),cards:Number(row.cards),variants:Number(row.variants)}]));
  for(const language of ['en','de','ja']){
    const current=byLanguage[language] as {cards:number;variants:number}|undefined;
    if(!current||current.cards===0||current.variants===0)throw new Error(`TCGdex catalogue for ${language} is missing or empty`);
  }
  return byLanguage;
}

function finalizeCampaign(db:DatabaseSync,campaign:Campaign):Record<string,number|string>{
  const search=db.prepare(`SELECT COUNT(*) total,SUM(state='succeeded') succeeded,
    SUM(state IN ('pending','leased','running','retryable_failed','partial')) pending,SUM(state='permanent_failed') failed
    FROM work_items WHERE source='ebay' AND queue='ebay_search' AND json_extract(params_json,'$.campaignId')=?`)
    .get(campaign.campaignId) as Record<string,number|null>;
  const details=db.prepare(`SELECT COUNT(*) total,SUM(w.state='succeeded') succeeded,
    SUM(w.state IN ('pending','leased','running','retryable_failed','partial')) pending,SUM(w.state='permanent_failed') failed
    FROM ebay_campaign_items i JOIN work_items w ON w.source='ebay' AND w.queue='ebay_item_detail'
      AND w.scope_key='item:'||i.marketplace||':'||i.item_id WHERE i.campaign_id=?`).get(campaign.campaignId) as Record<string,number|null>;
  const rateLimited=Number((db.prepare(`SELECT COUNT(*) n FROM ebay_campaign_items i
    JOIN work_items w ON w.source='ebay' AND w.queue='ebay_item_detail' AND w.scope_key='item:'||i.marketplace||':'||i.item_id
    JOIN attempts a ON a.work_item_id=w.work_item_id AND a.outcome='rate_limited'
    WHERE i.campaign_id=?`).get(campaign.campaignId) as {n:number}).n);
  const failed=Number(search.failed??0)+Number(details.failed??0),pending=Number(search.pending??0)+Number(details.pending??0);
  const complete=failed===0&&pending===0&&Number(search.total??0)>0;
  const coverage=complete?'complete':pending>0&&rateLimited>0?'quota_paused':'failed';
  db.prepare(`UPDATE ebay_campaigns SET status=?,coverage_status=?,completed_at=? WHERE campaign_id=?`)
    .run(complete?'complete':failed?'failed':'incomplete',coverage,complete?new Date().toISOString():null,campaign.campaignId);
  if(!complete){
    const row=db.prepare(`SELECT resume_after,pause_reason FROM ebay_campaigns WHERE campaign_id=?`).get(campaign.campaignId) as
      {resume_after:string|null;pause_reason:string|null};
    if(coverage==='quota_paused')throw new PipelinePausedError('ebay',row.resume_after??nextEbayReset().toISOString(),
      row.pause_reason??`Campaign ${campaign.query}/${campaign.marketplace} paused at the eBay quota`);
    throw new Error(`Campaign ${campaign.query}/${campaign.marketplace} incomplete (pending=${pending}, failed=${failed}, coverage=${coverage})`);
  }
  return {searchPages:Number(search.total??0),items:Number(details.total??0),status:'complete'};
}

async function ingestCampaigns(id:string,config:PipelineConfig):Promise<unknown>{
  const campaigns=withDb((db)=>ensureCampaigns(db,id,config.queries,config.marketplaces));
  const summaries=[];
  for(const campaign of campaigns){
    const isResume=withDb((db)=>Number((db.prepare(`SELECT COUNT(*) n FROM ebay_campaign_items WHERE campaign_id=?`)
      .get(campaign.campaignId) as {n:number}).n)>0);
    let previousItems=-1;let converged=false;let summary:Record<string,unknown>={};
    for(let pass=1;pass<=3;pass++){
      withDb((db)=>rearmCampaign(db,campaign,pass===1&&!isResume,!isResume||pass>1));
      await runCommand(['--source','ebay','--query',campaign.query,'--marketplaces',campaign.marketplace,
        '--campaign-id',campaign.campaignId,'--max-items',String(config.maxItems),'--limit',String(config.pageLimit),
        '--concurrency',String(config.concurrency),...(pass===1?[]:['--campaign-search-only'])]);
      summary=withDb((db)=>finalizeCampaign(db,campaign));
      const state=withDb((db)=>db.prepare(`SELECT total_reported,(SELECT COUNT(*) FROM ebay_campaign_items WHERE campaign_id=?) items
        FROM ebay_campaigns WHERE campaign_id=?`).get(campaign.campaignId,campaign.campaignId) as {total_reported:number;items:number});
      if(Number(state.total_reported)<=10_000||Number(state.items)===previousItems){converged=true;summary={...summary,passes:pass,converged:true};break;}
      previousItems=Number(state.items);
    }
    if(!converged)throw new Error(`Campaign ${campaign.query}/${campaign.marketplace} did not converge after 3 passes`);
    summaries.push({campaignId:campaign.campaignId,...summary});
  }
  return {campaigns:summaries};
}

async function materializeSlice(id:string,source:'ebay'|'psa'|'all'):Promise<unknown>{
  return withDbAsync((db)=>materialize(db,{
    includeTcgdex:source==='all',includePsa:source==='psa'||source==='all',includeEbay:source==='ebay'||source==='all',
    includeEcb:source==='all',pipelineRunId:id,
  }));
}

export function pipelineDryRun(config:PipelineConfig):unknown{
  if(!existsSync(DB_PATH))throw new Error(`Database does not exist at ${DB_PATH}`);
  const db=new DatabaseSync(DB_PATH,{readOnly:true});
  try{
    const targets=selectEbayMatchedTargets(db,{tiers:['exact','strong'],excludeFlagged:true});
    const pending=db.prepare(`SELECT queue,COUNT(*) n FROM work_items WHERE source='ebay'
      AND state IN ('pending','leased','running','retryable_failed','partial') GROUP BY queue`).all() as unknown as Array<{queue:string;n:number}>;
    const pendingByQueue=Object.fromEntries(pending.map((row)=>[row.queue,Number(row.n)]));
    const populationRaw=targets.selections.filter((entry)=>existsSync(path.join(OUT_DIR,entry.release,'population',`${entry.psaSpecId}.json`))).length;
    const salesRaw=targets.selections.filter((entry)=>entry.salesSpecId!=null&&existsSync(path.join(OUT_DIR,entry.release,'sales',`${entry.salesSpecId}.json`))).length;
    return{config,catalogue:catalogueSummary(db),psaTargets:{specs:targets.totalSpecs,variants:targets.variantCount,
      listings:targets.listingCount,unresolvedVariants:targets.unresolvedVariants,unresolvedSets:targets.unresolved.slice(0,25),
      raw:{population:populationRaw,sales:salesRaw,populationMissing:targets.totalSpecs-populationRaw,salesMissing:targets.totalSpecs-salesRaw}},
      ebay:{quota:ebayQuotaState(db),pendingSearchPages:pendingByQueue.ebay_search??0,pendingItemDetails:pendingByQueue.ebay_item_detail??0,
        estimatedResumeCalls:(pendingByQueue.ebay_search??0)+(pendingByQueue.ebay_item_detail??0)}};
  }
  finally{db.close();}
}

export async function executePipeline(id:string,config:PipelineConfig):Promise<void>{
  const done=withDb((db)=>completedStages(db,id));
  let deferredEbayPause:PipelinePausedError|null=null;
  const actions:Record<PipelineStage,StageAction>={
    preflight:()=>{
      loadEbayCredentials();
      for(const marketplace of config.marketplaces)if(!(marketplace in EBAY_MARKETPLACES))throw new Error(`Unknown marketplace ${marketplace}`);
      if(config.queries.some((query)=>!query.trim()))throw new Error('Queries must not be empty');
      if(!existsSync(PSA_PROFILE_DIR))throw new Error(`PSA browser profile missing at ${PSA_PROFILE_DIR}; run psa-login first`);
      return{queries:config.queries,marketplaces:config.marketplaces,psaProfile:'present'};
    },
    'catalogue-check':()=>withDb(catalogueSummary),
    'ebay-ingest':()=>ingestCampaigns(id,config),
    'ebay-match':()=>materializeSlice(id,'ebay'),
    'psa-cert':async()=>{
      const pending=withDb((db)=>Number((db.prepare(`SELECT COUNT(DISTINCT cert_number) n FROM ebay_listings
        WHERE cert_number IS NOT NULL AND TRIM(cert_number)<>'' AND match_method<>'ebay-psa-cert'`).get() as {n:number}).n));
      if(!pending)return{certs:0,skipped:true};await runCommand(['--source','psa','--stage','cert']);return{certs:pending};
    },
    'ebay-rematch':()=>materializeSlice(id,'ebay'),
    'psa-identity':async()=>{
      const before=withDb((db)=>selectEbayMatchedTargets(db,{tiers:['exact','strong'],excludeFlagged:true}));
      if(before.unresolvedVariants>0){
        await runCommand(['--source','psa','--stage','index']);await runCommand(['--source','psa','--stage','details']);
        await materializeSlice(id,'psa');
      }
      const after=withDb((db)=>selectEbayMatchedTargets(db,{tiers:['exact','strong'],excludeFlagged:true}));
      const manifest=withDb((db)=>snapshotPsaTargets(db,id,{refresh:true,ebayComplete:deferredEbayPause==null}));
      return{before:before.unresolvedVariants,after:after.unresolvedVariants,identityFetchSkipped:before.unresolvedVariants===0,
        manifest:{specs:manifest.specs,variants:manifest.variants,listings:manifest.listings,revisions:manifest.revisions,
          latestRevision:manifest.latestRevision,ebayComplete:deferredEbayPause==null}};
    },
    'psa-fetch':async()=>{
      const targets=withDb((db)=>{const existing=loadPsaManifest(db,id);return existing.revisions?existing:snapshotPsaTargets(db,id);});
      if(targets.selections.length===0)return{specs:0,skipped:true};
      const enriched=await withDbAsync((db)=>enrichMatchedPsa(db,id,targets.selections,{maxAgeDays:config.psaMaxAgeDays,salesAuditDays:config.salesAuditDays}));
      const materialized=await materializeSlice(id,'psa');
      const coverage=withDb((db)=>syncPsaCoverage(db,id));
      return{...enriched,materialized,manifest:{specs:targets.specs,variants:targets.variants,listings:targets.listings,
        revisions:targets.revisions,latestRevision:targets.latestRevision},coverage};
    },
    assemble:async()=>{
      await runCommand(['--source','ecb']);
      const materialized=await materializeSlice(id,'all');
      const gaps=withDb((db)=>syncPipelineGaps(db,id));
      const generation=await withDbAsync((db)=>assembleGeneration(db,id));
      return{materialized,gaps,...generation};
    },
    validate:()=>withDb((db)=>({
      quality:validateWorkingPipeline(db,id,{allowIncompleteCampaigns:deferredEbayPause!=null}),
      generation:validateGeneration(db,id,deferredEbayPause?{
        completeness:'partial',incompleteReason:deferredEbayPause.message,
      }:undefined),
    })),
    publish:()=>withDb((db)=>publishGeneration(db,id)),
  };
  for(const stage of PIPELINE_STAGES){
    if(done.has(stage))continue;
    try{await executeStage(id,stage,actions[stage]);}
    catch(error){
      if(stage==='ebay-ingest'&&error instanceof PipelinePausedError&&error.source==='ebay'){
        deferredEbayPause=error;
        continue;
      }
      throw error;
    }
  }
  if(deferredEbayPause){
    withDb((db)=>retainPipelinePause(db,id,'ebay-ingest',deferredEbayPause!.message));
    throw deferredEbayPause;
  }
  withDb((db)=>finishPipelineRun(db,id));
}

/**
 * Refresh PSA facts for the existing, trusted eBay match corpus without
 * touching an incomplete eBay acquisition campaign. This is deliberately a
 * separate publication run: it has no campaigns of its own and can therefore
 * publish a new app generation only after PSA fetch, validation and assembly
 * complete.
 */
export async function executeExistingPsaRefresh(id:string,config:PipelineConfig):Promise<void>{
  const skip=(stages:PipelineStage[],reason:string):void=>withDb((db)=>{
    const now=new Date().toISOString();
    for(const stage of stages)db.prepare(`UPDATE pipeline_stages SET status='skipped',ended_at=?,summary_json=?
      WHERE pipeline_run_id=? AND stage_name=?`).run(now,JSON.stringify({reason}),id,stage);
  });
  await executeStage(id,'preflight',()=>{
    if(!existsSync(PSA_PROFILE_DIR))throw new Error(`PSA browser profile missing at ${PSA_PROFILE_DIR}; run psa-login first`);
    return{scope:'existing-trusted-ebay-matches',psaProfile:'present'};
  });
  await executeStage(id,'catalogue-check',()=>withDb(catalogueSummary));
  skip(['ebay-ingest','ebay-match','psa-cert','ebay-rematch','psa-identity'],
    'PSA refresh uses the existing trusted eBay materialization; no eBay acquisition or re-matching performed');
  await executeStage(id,'psa-fetch',async()=>{
    const targets=withDb((db)=>snapshotPsaTargets(db,id));
    if(!targets.selections.length)return{specs:0,skipped:true};
    const enriched=await withDbAsync((db)=>enrichMatchedPsa(db,id,targets.selections,{maxAgeDays:config.psaMaxAgeDays,salesAuditDays:config.salesAuditDays}));
    const coverage=withDb((db)=>syncPsaCoverage(db,id));
    return{...enriched,variants:targets.variants,listings:targets.listings,coverage};
  });
  await executeStage(id,'assemble',async()=>{
    const gaps=withDb((db)=>syncPipelineGaps(db,id));
    const generation=await withDbAsync((db)=>assembleGeneration(db,id));
    return{gaps,...generation};
  });
  await executeStage(id,'validate',()=>withDb((db)=>({quality:validateWorkingPipeline(db,id),generation:validateGeneration(db,id)})));
  await executeStage(id,'publish',()=>withDb((db)=>publishGeneration(db,id)));
  withDb((db)=>finishPipelineRun(db,id));
}
