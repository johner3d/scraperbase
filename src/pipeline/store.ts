import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { PIPELINE_STAGES, type PipelineConfig, type PipelineStage } from './types.ts';

interface PipelineRow {
  pipeline_run_id: string;
  status: string;
  config_json: string;
  active_stage: string | null;
}

export function createPipelineRun(db: DatabaseSync, config: PipelineConfig): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`INSERT INTO pipeline_runs
      (pipeline_run_id,created_at,started_at,status,config_json)
      VALUES(?,?,?,'running',?)`).run(id, now, now, JSON.stringify(config));
    const insert = db.prepare(`INSERT INTO pipeline_stages
      (pipeline_run_id,stage_name,stage_order,status) VALUES(?,?,?,'pending')`);
    PIPELINE_STAGES.forEach((stage, index) => insert.run(id, stage, index));
    db.exec('COMMIT');
    return id;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function loadPipelineRun(db: DatabaseSync, id: string): { status: string; config: PipelineConfig } {
  const row = db.prepare(`SELECT pipeline_run_id,status,config_json,active_stage FROM pipeline_runs WHERE pipeline_run_id=?`)
    .get(id) as PipelineRow | undefined;
  if (!row) throw new Error(`Pipeline run ${id} does not exist`);
  return { status: row.status, config: JSON.parse(row.config_json) as PipelineConfig };
}

export function resumePipelineRun(db: DatabaseSync, id: string): PipelineConfig {
  const loaded = loadPipelineRun(db, id);
  const now = new Date().toISOString();
  const ebayPause=db.prepare(`SELECT 1 present FROM pipeline_pauses WHERE pipeline_run_id=?
    AND source='ebay' AND resolved_at IS NULL LIMIT 1`).get(id);
  db.prepare(`UPDATE pipeline_runs SET status='running',ended_at=NULL,error_message=NULL WHERE pipeline_run_id=?`).run(id);
  if(ebayPause){
    const ebayOrder=PIPELINE_STAGES.indexOf('ebay-ingest');
    db.prepare(`UPDATE pipeline_stages SET status='pending',started_at=NULL,ended_at=NULL,summary_json=NULL,error_message=NULL
      WHERE pipeline_run_id=? AND stage_order>=?`).run(id,ebayOrder);
  }else{
    db.prepare(`UPDATE pipeline_stages SET status='pending',started_at=NULL,ended_at=NULL,error_message=NULL
      WHERE pipeline_run_id=? AND status IN ('running','failed')`).run(id);
  }
  db.prepare(`UPDATE pipeline_runs SET started_at=COALESCE(started_at,?) WHERE pipeline_run_id=?`).run(now, id);
  db.prepare(`UPDATE pipeline_pauses SET resolved_at=? WHERE pipeline_run_id=? AND resolved_at IS NULL`).run(now,id);
  return loaded.config;
}

export function retainPipelinePause(db:DatabaseSync,id:string,stage:PipelineStage,reason:string):void{
  const now=new Date().toISOString();
  db.prepare(`UPDATE pipeline_runs SET status='failed',active_stage=?,ended_at=?,error_message=? WHERE pipeline_run_id=?`)
    .run(stage,now,`Paused: ${reason}`,id);
}

export function beginStage(db: DatabaseSync, id: string, stage: PipelineStage): void {
  const now = new Date().toISOString();
  db.prepare(`UPDATE pipeline_runs SET active_stage=?,status='running',error_message=NULL WHERE pipeline_run_id=?`).run(stage, id);
  db.prepare(`UPDATE pipeline_stages SET status='running',attempts=attempts+1,started_at=?,ended_at=NULL,error_message=NULL
    WHERE pipeline_run_id=? AND stage_name=?`).run(now, id, stage);
}

export function completeStage(db: DatabaseSync, id: string, stage: PipelineStage, summary: unknown = {}): void {
  db.prepare(`UPDATE pipeline_stages SET status='completed',ended_at=?,summary_json=?,error_message=NULL
    WHERE pipeline_run_id=? AND stage_name=?`).run(new Date().toISOString(), JSON.stringify(summary), id, stage);
}

export function failStage(db: DatabaseSync, id: string, stage: PipelineStage, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const now = new Date().toISOString();
  db.prepare(`UPDATE pipeline_stages SET status='failed',ended_at=?,error_message=? WHERE pipeline_run_id=? AND stage_name=?`)
    .run(now, message, id, stage);
  db.prepare(`UPDATE pipeline_runs SET status='failed',active_stage=?,ended_at=?,error_message=? WHERE pipeline_run_id=?`)
    .run(stage, now, message, id);
}

export function pauseStage(db: DatabaseSync,id:string,stage:PipelineStage,source:string,reason:string,resumeAfter:string|null):void{
  const now=new Date().toISOString();
  db.prepare(`INSERT INTO pipeline_pauses(pipeline_run_id,stage_name,source,reason,resume_after,created_at)
    VALUES(?,?,?,?,?,?)`).run(id,stage,source,reason,resumeAfter,now);
  // v10's status checks predate resumable pauses. Keep the physical rows in
  // their compatible failed state and expose the active pause as the public
  // status until migration can remove those legacy checks safely.
  db.prepare(`UPDATE pipeline_stages SET status='failed',ended_at=?,error_message=? WHERE pipeline_run_id=? AND stage_name=?`)
    .run(now,`Paused: ${reason}`,id,stage);
  db.prepare(`UPDATE pipeline_runs SET status='failed',active_stage=?,ended_at=?,error_message=? WHERE pipeline_run_id=?`)
    .run(stage,now,`Paused: ${reason}`,id);
}

export function finishPipelineRun(db: DatabaseSync, id: string): void {
  const now = new Date().toISOString();
  db.prepare(`UPDATE pipeline_runs SET status='completed',active_stage=NULL,ended_at=?,error_message=NULL WHERE pipeline_run_id=?`)
    .run(now, id);
}

export function completedStages(db: DatabaseSync, id: string): Set<string> {
  const rows = db.prepare(`SELECT stage_name FROM pipeline_stages WHERE pipeline_run_id=? AND status IN ('completed','skipped')`)
    .all(id) as unknown as Array<{ stage_name: string }>;
  return new Set(rows.map((row) => row.stage_name));
}

export function stageReport(db: DatabaseSync, id: string): unknown {
  const run = db.prepare(`SELECT * FROM pipeline_runs WHERE pipeline_run_id=?`).get(id);
  if (!run) throw new Error(`Pipeline run ${id} does not exist`);
  const stages = db.prepare(`SELECT * FROM pipeline_stages WHERE pipeline_run_id=? ORDER BY stage_order`).all(id);
  const gaps = db.prepare(`SELECT gap_type,COUNT(*) n FROM pipeline_gaps WHERE pipeline_run_id=? GROUP BY gap_type ORDER BY gap_type`).all(id);
  const campaigns = db.prepare(`SELECT campaign_id,query_text,marketplace,status,coverage_status,total_reported,
    (SELECT COUNT(*) FROM ebay_campaign_items i WHERE i.campaign_id=c.campaign_id) item_count
    FROM ebay_campaigns c WHERE pipeline_run_id=? ORDER BY query_text,marketplace`).all(id);
  const pause=db.prepare(`SELECT source,reason,resume_after,created_at FROM pipeline_pauses
    WHERE pipeline_run_id=? AND resolved_at IS NULL ORDER BY created_at DESC LIMIT 1`).get(id);
  const physicalStatus=String((run as Record<string,unknown>).status??'');
  return { run:pause?{...(run as Record<string,unknown>),effective_status:physicalStatus==='running'?'running':'paused'}:run,
    stages, campaigns, gaps, pause:pause??null };
}
