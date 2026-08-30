import { parseArgs } from 'node:util';
import { openCliDb } from '../context.ts';
import { pipelineReviewCommand } from './pipeline-review.ts';
import { pipelineTermsCommand } from './pipeline-terms.ts';
import { pipelineDeadLetterCommand, pipelineFailuresCommand, pipelineRetryCommand } from './pipeline-failures.ts';
import { pipelinePublishCommand, pipelineStartCommand, pipelineStatusCommand, pipelineStopCommand, pipelineTickCommand } from './pipeline-supervisor.ts';
import { createPipelineRun, loadPipelineRun, resumePipelineRun, stageReport } from '../../pipeline/store.ts';
import { executeExistingPsaRefresh, executePipeline, pipelineDryRun, PipelinePausedError } from '../../pipeline/orchestrator.ts';
import type { PipelineConfig } from '../../pipeline/types.ts';

function print(value:unknown,json:boolean):void{if(json)console.log(JSON.stringify(value,null,2));else console.log(JSON.stringify(value,null,2));}

function parseRun(args:string[]):{config:PipelineConfig;dryRun:boolean;json:boolean}{
  const {values}=parseArgs({args,options:{query:{type:'string',multiple:true},marketplaces:{type:'string',default:'de'},
    'max-items':{type:'string',default:'0'},limit:{type:'string',default:'200'},concurrency:{type:'string',default:'5'},
    'psa-max-age':{type:'string',default:'7'},'sales-audit-days':{type:'string',default:'30'},
    'dry-run':{type:'boolean',default:false},json:{type:'boolean',default:false}}});
  const queries=(values.query??[]).map(String).map((value)=>value.trim()).filter(Boolean);
  if(!queries.length)throw new Error('At least one --query is required');
  const marketplaces=String(values.marketplaces).split(',').map((value)=>value.trim()).filter(Boolean);
  const config:PipelineConfig={queries:[...new Set(queries)],marketplaces:[...new Set(marketplaces)],maxItems:Number(values['max-items']),
    pageLimit:Number(values.limit),concurrency:Number(values.concurrency),psaMaxAgeDays:Number(values['psa-max-age']),
    salesAuditDays:Number(values['sales-audit-days']),allSales:true};
  if(!Number.isInteger(config.maxItems)||config.maxItems<0)throw new Error('--max-items must be a non-negative integer');
  if(!Number.isInteger(config.pageLimit)||config.pageLimit<1||config.pageLimit>200)throw new Error('--limit must be 1..200');
  if(!Number.isInteger(config.concurrency)||config.concurrency<1)throw new Error('--concurrency must be positive');
  if(config.psaMaxAgeDays<0||config.salesAuditDays<=0)throw new Error('PSA age values are invalid');
  return{config,dryRun:Boolean(values['dry-run']),json:Boolean(values.json)};
}

export async function pipelineCommand(args:string[]):Promise<void>{
  const [subcommand,...rest]=args;
  if(subcommand==='review'){await pipelineReviewCommand(rest);return;}
  if(subcommand==='terms'){await pipelineTermsCommand(rest);return;}
  if(subcommand==='failures'){await pipelineFailuresCommand(rest);return;}
  if(subcommand==='retry'){await pipelineRetryCommand(rest);return;}
  if(subcommand==='dead-letter'){await pipelineDeadLetterCommand(rest);return;}
  if(subcommand==='start'){await pipelineStartCommand(rest);return;}
  if(subcommand==='stop'){await pipelineStopCommand();return;}
  if(subcommand==='tick'){await pipelineTickCommand(rest);return;}
  if(subcommand==='status'){await pipelineStatusCommand(rest);return;}
  if(subcommand==='publish'){await pipelinePublishCommand(rest);return;}
  if(subcommand==='psa-login'){const {psaLoginCommand}=await import('./psa-login.ts');await psaLoginCommand(rest);return;}
  if(subcommand==='run'){
    const parsed=parseRun(rest);if(parsed.dryRun){print(pipelineDryRun(parsed.config),parsed.json);return;}
    const db=openCliDb();const id=createPipelineRun(db,parsed.config);db.close();
    console.log(`Pipeline run: ${id}`);try{await executePipeline(id,parsed.config);print({pipelineRunId:id,status:'completed'},parsed.json);}
    catch(error){if(error instanceof PipelinePausedError){print({pipelineRunId:id,status:'paused',source:error.source,resumeAfter:error.resumeAfter,reason:error.message},parsed.json);return;}throw error;}return;
  }
  if(subcommand==='resume'){
    const {values}=parseArgs({args:rest,options:{run:{type:'string'},json:{type:'boolean',default:false}}});
    const id=String(values.run??'');if(!id)throw new Error('--run is required');const db=openCliDb();const config=resumePipelineRun(db,id);db.close();
    try{await executePipeline(id,config);print({pipelineRunId:id,status:'completed'},Boolean(values.json));}
    catch(error){if(error instanceof PipelinePausedError){print({pipelineRunId:id,status:'paused',source:error.source,resumeAfter:error.resumeAfter,reason:error.message},Boolean(values.json));return;}throw error;}return;
  }
  if(subcommand==='refresh-psa'){
    const {values}=parseArgs({args:rest,options:{'psa-max-age':{type:'string',default:'7'},'sales-audit-days':{type:'string',default:'30'},json:{type:'boolean',default:false}}});
    const config:PipelineConfig={queries:['existing trusted eBay matches'],marketplaces:[],maxItems:0,pageLimit:200,concurrency:1,
      psaMaxAgeDays:Number(values['psa-max-age']),salesAuditDays:Number(values['sales-audit-days']),allSales:true};
    if(config.psaMaxAgeDays<0||config.salesAuditDays<=0)throw new Error('PSA age values are invalid');
    const db=openCliDb();const id=createPipelineRun(db,config);db.close();
    console.log(`PSA refresh run: ${id}`);await executeExistingPsaRefresh(id,config);print({pipelineRunId:id,status:'completed'},Boolean(values.json));return;
  }
  if(subcommand==='report'){
    const {values}=parseArgs({args:rest,options:{run:{type:'string'},json:{type:'boolean',default:false}}});const db=openCliDb();
    let id=String(values.run??'');if(!id){const row=db.prepare('SELECT pipeline_run_id FROM pipeline_runs ORDER BY created_at DESC LIMIT 1').get() as {pipeline_run_id:string}|undefined;id=row?.pipeline_run_id??'';}
    if(!id){db.close();throw new Error('No pipeline runs exist');}const report=stageReport(db,id);db.close();print(report,Boolean(values.json));return;
  }
  throw new Error('Usage: pipeline <start|stop|tick|status|publish|run|resume|refresh-psa|report|review|terms|failures|retry|dead-letter>');
}
