import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { openDb } from '../../src/core/db/client.ts';
import { PIPELINE_STAGES, type PipelineConfig } from '../../src/pipeline/types.ts';
import { beginStage, completeStage, completedStages, createPipelineRun, failStage, loadPipelineRun, pauseStage, resumePipelineRun, retainPipelinePause, stageReport } from '../../src/pipeline/store.ts';
import { ensureCampaigns } from '../../src/pipeline/campaigns.ts';
import { validateWorkingPipeline } from '../../src/pipeline/quality.ts';

const config:PipelineConfig={queries:['pikachu psa 10','charizard psa 10'],marketplaces:['de'],maxItems:0,pageLimit:200,
  concurrency:5,psaMaxAgeDays:7,salesAuditDays:30,allSales:true};

test('pipeline runs persist immutable config and resume only incomplete stages',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'scraperbase-pipeline-'));const db=openDb(path.join(root,'db.sqlite'));
  try{
    const id=createPipelineRun(db,config);assert.deepEqual(loadPipelineRun(db,id).config,config);
    const stages=db.prepare('SELECT stage_name,status FROM pipeline_stages WHERE pipeline_run_id=? ORDER BY stage_order').all(id) as Array<{stage_name:string;status:string}>;
    assert.deepEqual(stages.map((row)=>row.stage_name),PIPELINE_STAGES);assert.ok(stages.every((row)=>row.status==='pending'));
    beginStage(db,id,'preflight');completeStage(db,id,'preflight',{ok:true});beginStage(db,id,'catalogue-check');
    failStage(db,id,'catalogue-check',new Error('catalogue unavailable'));
    const resumed=resumePipelineRun(db,id);assert.deepEqual(resumed,config);
    assert.deepEqual([...completedStages(db,id)],['preflight']);
    const failed=db.prepare(`SELECT status,attempts FROM pipeline_stages WHERE pipeline_run_id=? AND stage_name='catalogue-check'`).get(id) as {status:string;attempts:number};
    assert.equal(failed.status,'pending');assert.equal(failed.attempts,1);
  }finally{db.close();await rm(root,{recursive:true,force:true});}
});

test('quota pauses are exposed as paused and resolved by resume',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'scraperbase-pipeline-pause-'));const db=openDb(path.join(root,'db.sqlite'));
  try{
    const id=createPipelineRun(db,config);beginStage(db,id,'ebay-ingest');
    pauseStage(db,id,'ebay-ingest','ebay','daily quota','2026-08-31T07:00:00.000Z');
    beginStage(db,id,'ebay-match');
    const processing=stageReport(db,id) as {run:{effective_status:string};pause:{source:string}};
    assert.equal(processing.run.effective_status,'running');assert.equal(processing.pause.source,'ebay');
    completeStage(db,id,'ebay-match',{partialSnapshot:true});
    beginStage(db,id,'psa-fetch');completeStage(db,id,'psa-fetch',{partialSnapshot:true});
    retainPipelinePause(db,id,'ebay-ingest','daily quota');
    const report=stageReport(db,id) as {run:{effective_status:string};pause:{source:string}};
    assert.equal(report.run.effective_status,'paused');assert.equal(report.pause.source,'ebay');
    resumePipelineRun(db,id);
    const active=Number((db.prepare(`SELECT COUNT(*) n FROM pipeline_pauses WHERE pipeline_run_id=? AND resolved_at IS NULL`).get(id) as {n:number}).n);
    assert.equal(active,0);
    const reset=db.prepare(`SELECT stage_name,status FROM pipeline_stages WHERE pipeline_run_id=? AND stage_order>=2
      ORDER BY stage_order`).all(id) as unknown as Array<{stage_name:string;status:string}>;
    assert.ok(reset.every((row)=>row.status==='pending'),JSON.stringify(reset));
  }finally{db.close();await rm(root,{recursive:true,force:true});}
});

test('partial validation keeps invariants while allowing quota-paused campaign coverage',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'scraperbase-pipeline-partial-'));const db=openDb(path.join(root,'db.sqlite'));
  try{
    const id=createPipelineRun(db,config);
    ensureCampaigns(db,id,['pikachu psa 10'],['de']);
    assert.throws(()=>validateWorkingPipeline(db,id),/not complete/);
    const result=validateWorkingPipeline(db,id,{allowIncompleteCampaigns:true});
    assert.equal(result.campaigns,'partial');
    assert.equal(result.incompleteCampaigns,1);
  }finally{db.close();await rm(root,{recursive:true,force:true});}
});
