import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Page } from 'playwright';
import type { Collector } from '../core/queue/runner.ts';
import { runQueue } from '../core/queue/runner.ts';
import { enqueueWorkItem } from '../core/queue/scheduler.ts';
import { createRun, finishRun } from '../core/queue/run.ts';
import { workItemId } from '../core/queue/workItem.ts';
import { launchPsaProfile } from '../sources/psa/browser/profile.ts';
import { OUT_DIR, bestSalesCheckpoint, indexSalesCheckpoints, installStopHandlers, runPopulation, runSales, shouldStop, type Selection } from '../sources/psa/rawFetch.ts';
import { importPopulationFile, importSalesFile, linkPopulationToSales } from '../scripts/psa-backfill-import.ts';
import { materialize } from '../curated/materialize.ts';
import { PipelinePausedError } from './pause.ts';
import { recordDeadLetter } from './deadLetters.ts';

export const POP_QUEUE='psa_enrichment_population';
export const SALES_QUEUE='psa_enrichment_sales';
const DAY_MS=86_400_000;

interface Params { selection:Selection; maxAgeDays:number; salesAuditDays:number }

export function psaEnrichmentScope(phase:'population'|'sales',specId:number):string{return `enrichment:${phase}:spec=${specId}`;}
const scope=psaEnrichmentScope;

export function seedPsaEnrichment(db:DatabaseSync,selections:Selection[],maxAgeDays:number,salesAuditDays:number):void{
  const now=new Date().toISOString();const staleBefore=new Date(Date.now()-maxAgeDays*DAY_MS).toISOString();
  for(const selection of selections){
    const params:Params={selection,maxAgeDays,salesAuditDays};
    enqueueWorkItem(db,{source:'psa',queue:POP_QUEUE,entityType:'population_snapshot',scopeKey:scope('population',selection.psaSpecId),params});
    db.prepare('UPDATE work_items SET params_json=? WHERE work_item_id=?').run(JSON.stringify(params),workItemId('psa',POP_QUEUE,scope('population',selection.psaSpecId)));
    if(selection.salesSpecId!=null){
      enqueueWorkItem(db,{source:'psa',queue:SALES_QUEUE,entityType:'sales_snapshot',scopeKey:scope('sales',selection.salesSpecId),params});
      db.prepare('UPDATE work_items SET params_json=? WHERE work_item_id=?').run(JSON.stringify(params),workItemId('psa',SALES_QUEUE,scope('sales',selection.salesSpecId)));
    }
  }
  db.prepare(`UPDATE work_items SET state='pending',attempts=0,available_at=?,last_error=NULL,lease_owner=NULL,lease_expires_at=NULL,updated_at=?
    WHERE source='psa' AND queue IN (?,?) AND state='succeeded' AND updated_at<?`).run(now,now,POP_QUEUE,SALES_QUEUE,staleBefore);
}

const seed=seedPsaEnrichment;

export function psaPopulationCollector(page:Page):Collector{return populationCollector(page);}
export function psaSalesCollector(page:Page):Collector{return salesCollector(page);}
export function psaTargetFiles(selections:Selection[],kind:'population'|'sales'):string[]{return targetFiles(selections,kind);}

function populationCollector(page:Page):Collector{
  return async(_db,item)=>{
    const {selection,maxAgeDays}=JSON.parse(item.params_json) as Params;
    const expected=path.join(OUT_DIR,selection.release,'population',`${selection.psaSpecId}.json`);
    if(shouldStop()&&!fs.existsSync(expected))return{outcome:'failure',final:'partial',sourceIdentity:'psa:enrichment',
      errorMessage:'PSA fetch paused before population acquisition'};
    const stats=await runPopulation(page,selection.release,[selection],{force:false,maxAgeMs:maxAgeDays*DAY_MS});
    if(stats.failed)return{outcome:stats.rateLimited?'rate_limited':'failure',final:stats.rateLimited?'partial':'retryable_failed',
      sourceIdentity:'psa:enrichment',httpStatus:stats.rateLimited?429:undefined,retryAfterMs:stats.rateLimited?60_000:undefined,
      errorMessage:`Population fetch failed for ${selection.psaSpecId}${stats.rateLimited?' (rate limited)':''}`};
    const file=stats.written[0]??(fs.existsSync(expected)?expected:undefined);
    if(!file)return{outcome:'failure',final:'partial',sourceIdentity:'psa:enrichment',errorMessage:`Population ${selection.psaSpecId} produced no durable checkpoint`};
    return{outcome:'success',final:'succeeded',sourceIdentity:'psa:enrichment',requestMethod:'GET',requestUrl:selection.popSourceUrl,
      object:{source:'psa',mediaKind:'json',mediaType:'application/json',ext:'json',body:fs.readFileSync(file)}};
  };
}

function salesCollector(page:Page):Collector{
  return async(_db,item)=>{
    const {selection,maxAgeDays,salesAuditDays}=JSON.parse(item.params_json) as Params;
    const expected=path.join(OUT_DIR,selection.release,'sales',`${selection.salesSpecId}.json`);
    if(shouldStop()&&!fs.existsSync(expected))return{outcome:'failure',final:'partial',sourceIdentity:'psa:enrichment',
      errorMessage:'PSA fetch paused before sales acquisition'};
    // cutoffIso stays null so the cheap incremental/overlap path is preserved;
    // the per-spec wall-clock budget + lowered page cap in runSales are what
    // stop a single long-history spec from stalling the whole enrichment queue.
    const stats=await runSales(page,selection.release,[selection],{force:false,maxAgeMs:maxAgeDays*DAY_MS,cutoffIso:null,auditMaxAgeMs:salesAuditDays*DAY_MS,salesBudgetMs:90_000});
    if(stats.failed)return{outcome:stats.rateLimited?'rate_limited':'failure',final:stats.rateLimited?'partial':'retryable_failed',
      sourceIdentity:'psa:enrichment',httpStatus:stats.rateLimited?429:undefined,retryAfterMs:stats.rateLimited?60_000:undefined,
      errorMessage:`Sales fetch failed for ${selection.salesSpecId}${stats.rateLimited?' (rate limited)':''}`};
    const file=stats.written[0]??(selection.salesSpecId==null?undefined:
      bestSalesCheckpoint(selection.salesSpecId,expected,null)?.path);
    if(!file)return{outcome:'failure',final:'partial',sourceIdentity:'psa:enrichment',errorMessage:`Sales ${selection.salesSpecId} produced no durable checkpoint`};
    return{outcome:'success',final:'succeeded',sourceIdentity:'psa:enrichment',requestMethod:'GET',requestUrl:selection.salesSourceUrl??undefined,
      object:{source:'psa',mediaKind:'json',mediaType:'application/json',ext:'json',body:fs.readFileSync(file)}};
  };
}

function targetFiles(selections:Selection[],kind:'population'|'sales'):string[]{
  return selections.flatMap((selection)=>{
    const id=kind==='population'?selection.psaSpecId:selection.salesSpecId;
    if(id==null)return[];const file=path.join(OUT_DIR,selection.release,kind,`${id}.json`);
    if(fs.existsSync(file))return[file];
    return kind==='sales'?(bestSalesCheckpoint(Number(id),file,null)?.path?[bestSalesCheckpoint(Number(id),file,null)!.path]:[]):[];
  });
}

export async function enrichMatchedPsa(db:DatabaseSync,pipelineRunId:string,selections:Selection[],options:{maxAgeDays:number;salesAuditDays:number}):Promise<Record<string,unknown>>{
  if(!selections.length)return{specs:0};
  seed(db,selections,options.maxAgeDays,options.salesAuditDays);indexSalesCheckpoints();installStopHandlers();
  const runId=createRun(db,'pipeline psa enrichment',{pipelineRunId,specs:selections.length},true);
  const context=await launchPsaProfile({headless:false});const page=await context.newPage();
  try{
    await page.goto('https://www.psacard.com/pop',{waitUntil:'domcontentloaded',timeout:180_000});
    await runQueue(db,{queue:POP_QUEUE,collector:populationCollector(page),concurrency:1,leaseTtlMs:300_000,runId,isDraining:()=>false,
      haltOnRateLimit:true,cooldown:{afterConsecutiveFailures:3,cooldownMs:60_000}});
    await runQueue(db,{queue:SALES_QUEUE,collector:salesCollector(page),concurrency:1,leaseTtlMs:300_000,runId,isDraining:()=>false,
      haltOnRateLimit:true,cooldown:{afterConsecutiveFailures:3,cooldownMs:60_000}});
    const targetIds=selections.flatMap((selection)=>[
      workItemId('psa',POP_QUEUE,scope('population',selection.psaSpecId)),
      ...(selection.salesSpecId==null?[]:[workItemId('psa',SALES_QUEUE,scope('sales',selection.salesSpecId))]),
    ]);
    // A genuine rate-limit pause still stops the run and is retained as a
    // pause the operator resumes. Anything else -- a spec that exhausted its
    // attempts -- goes to the visible dead-letter and the run keeps going,
    // importing every spec that did succeed.
    const stuck=targetIds.length?db.prepare(`SELECT work_item_id,queue,scope_key,state,last_error FROM work_items
      WHERE work_item_id IN (${targetIds.map(()=>'?').join(',')}) AND state<>'succeeded'`).all(...targetIds) as unknown as
      Array<{work_item_id:string;queue:string;scope_key:string;state:string;last_error:string|null}>:[];
    const paused=stuck.filter((row)=>['partial','pending','retryable_failed'].includes(row.state)
      && /rate limit|paused|429/i.test(row.last_error ?? ''));
    if(paused.length){
      throw new PipelinePausedError('psa',null,`${paused.length} PSA enrichment target(s) remain durably paused`);
    }
    for(const row of stuck.filter((r)=>r.state==='permanent_failed')){
      recordDeadLetter(db,{stage:'psa-fetch',scopeKey:row.scope_key,workItemId:row.work_item_id,
        reason:row.last_error ?? 'PSA enrichment work item exhausted its attempts',
        detail:{queue:row.queue}});
    }
    let imported=0;
    for(const file of targetFiles(selections,'population'))if(await importPopulationFile(db,file,runId)==='imported')imported++;
    for(const file of targetFiles(selections,'sales'))if(await importSalesFile(db,file,runId)==='imported')imported++;
    linkPopulationToSales(db);
    const result=await materialize(db,{includeTcgdex:false,includeEbay:false,includeEcb:false,pipelineRunId});
    finishRun(db,runId,'completed');return{specs:selections.length,imported,materialized:result};
  }catch(error){finishRun(db,runId,'failed');throw error;}finally{await context.close();}
}
