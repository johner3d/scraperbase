import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import type { DatabaseSync } from 'node:sqlite';
import { openCliDb } from '../context.ts';
import { setMatchOverride } from '../../curated/materialize.ts';
import { resolvePsaSetMap } from '../../curated/psaSetMatch.ts';

interface ReviewAction { reviewId:number;action:'resolve'|'dismiss'|'revoke';variantId?:number;reviewer:string;note:string }

function requireText(value:unknown,name:string):string{const text=String(value??'').trim();if(!text)throw new Error(`${name} is required`);return text;}

function applyAction(db:DatabaseSync,action:ReviewAction):void{
  const review=db.prepare(`SELECT mr.*,sr.source FROM match_reviews mr JOIN source_records sr ON sr.source_record_id=mr.source_record_id
    WHERE mr.match_review_id=?`).get(action.reviewId) as Record<string,unknown>|undefined;
  if(!review)throw new Error(`Review ${action.reviewId} does not exist`);
  const now=new Date().toISOString();
  if(action.action==='resolve'){
    if(!Number.isSafeInteger(action.variantId)||Number(action.variantId)<=0)throw new Error('A positive variantId is required');
    const variant=db.prepare('SELECT variant_id FROM variants WHERE variant_id=?').get(action.variantId!);
    if(!variant)throw new Error(`Variant ${action.variantId} does not exist`);
    setMatchOverride(db,Number(review.source_record_id),'variant',action.variantId!,action.note,now);
    db.prepare(`UPDATE match_reviews SET status='resolved',resolved_at=?,resolved_by=?,resolution_note=?,
      resolution_target_type='variant',resolution_target_id=? WHERE match_review_id=?`)
      .run(now,action.reviewer,action.note,String(action.variantId),action.reviewId);
    db.prepare(`INSERT INTO match_override_revisions
      (source_record_id,target_type,target_id,action,reviewer,note,created_at) VALUES(?,'variant',?,'activate',?,?,?)`)
      .run(Number(review.source_record_id),String(action.variantId),action.reviewer,action.note,now);
  }else if(action.action==='dismiss'){
    db.prepare(`UPDATE match_reviews SET status='dismissed',resolved_at=?,resolved_by=?,resolution_note=? WHERE match_review_id=?`)
      .run(now,action.reviewer,action.note,action.reviewId);
    db.prepare(`INSERT INTO match_override_revisions
      (source_record_id,target_type,target_id,action,reviewer,note,created_at) VALUES(?,'variant',NULL,'dismiss',?,?,?)`)
      .run(Number(review.source_record_id),action.reviewer,action.note,now);
  }else{
    db.prepare(`UPDATE match_overrides SET active=0 WHERE source_record_id=?`).run(Number(review.source_record_id));
    db.prepare(`INSERT INTO match_override_revisions
      (source_record_id,target_type,target_id,action,reviewer,note,created_at) VALUES(?,'variant',NULL,'revoke',?,?,?)`)
      .run(Number(review.source_record_id),action.reviewer,action.note,now);
  }
}

export async function pipelineReviewCommand(args:string[]):Promise<void>{
  const [subcommand,...rest]=args;
  const db=openCliDb();
  try{
    if(subcommand==='sets'){
      const rows=db.prepare(`SELECT psa_heading_id headingId,psa_heading_name headingName,psa_heading_year headingYear,
        source_set_id sourceSetId,language,match_status status,match_method method,notes FROM psa_set_map
        WHERE match_status IN ('ambiguous','unmatched') ORDER BY psa_heading_name`).all();
      console.log(JSON.stringify(rows,null,2));return;
    }
    if(subcommand==='resolve-set'){
      const {values}=parseArgs({args:rest,options:{heading:{type:'string'},set:{type:'string'},by:{type:'string',default:os.userInfo().username},note:{type:'string'}}});
      const heading=Number(values.heading),sourceSetId=requireText(values.set,'--set'),reviewer=requireText(values.by,'--by'),note=requireText(values.note,'--note');
      if(!Number.isSafeInteger(heading)||heading<=0)throw new Error('--heading must be positive');
      if(!db.prepare('SELECT 1 FROM psa_set_map WHERE psa_heading_id=?').get(heading))throw new Error(`PSA heading ${heading} does not exist`);
      if(!db.prepare('SELECT 1 FROM sets WHERE source_set_id=?').get(sourceSetId))throw new Error(`TCGdex set ${sourceSetId} does not exist`);
      resolvePsaSetMap(db,heading,sourceSetId,`${note} (by ${reviewer})`);
      db.prepare(`INSERT INTO match_override_revisions(source_record_id,target_type,target_id,action,reviewer,note,created_at)
        VALUES(NULL,'set',?,'activate',?,?,?)`).run(sourceSetId,reviewer,note,new Date().toISOString());
      console.log(JSON.stringify({ok:true,headingId:heading,sourceSetId,reviewer,note}));return;
    }
    if(subcommand==='list'||subcommand==='export'){
      const {values}=parseArgs({args:rest,options:{source:{type:'string'},status:{type:'string',default:'open'},limit:{type:'string',default:'200'},json:{type:'boolean',default:false}}});
      const clauses=['mr.status=?'];const params:Array<string|number>=[String(values.status)];
      if(values.source){clauses.push('sr.source=?');params.push(String(values.source));}
      params.push(Number(values.limit));
      const rows=db.prepare(`SELECT mr.match_review_id reviewId,mr.status,mr.target_type targetType,mr.reason,mr.candidates_json candidates,
        sr.source,sr.namespace,sr.source_key sourceKey,el.title,el.match_tier matchTier,el.signals_json signals
        FROM match_reviews mr JOIN source_records sr ON sr.source_record_id=mr.source_record_id
        LEFT JOIN ebay_listings el ON el.source_record_id=mr.source_record_id WHERE ${clauses.join(' AND ')}
        ORDER BY mr.created_at LIMIT ?`).all(...params);
      console.log(JSON.stringify(rows,null,2));return;
    }
    if(subcommand==='show'){
      const id=Number(rest[0]);if(!Number.isSafeInteger(id))throw new Error('Usage: pipeline review show <review-id>');
      const row=db.prepare(`SELECT mr.*,sr.source,sr.namespace,sr.source_key,el.title,el.signals_json FROM match_reviews mr
        JOIN source_records sr ON sr.source_record_id=mr.source_record_id LEFT JOIN ebay_listings el ON el.source_record_id=mr.source_record_id
        WHERE mr.match_review_id=?`).get(id);if(!row)throw new Error(`Review ${id} does not exist`);console.log(JSON.stringify(row,null,2));return;
    }
    if(subcommand==='import'){
      const {values}=parseArgs({args:rest,options:{file:{type:'string'}}});const file=requireText(values.file,'--file');
      const actions=JSON.parse(readFileSync(file,'utf8')) as ReviewAction[];for(const action of actions)applyAction(db,action);
      console.log(JSON.stringify({imported:actions.length}));return;
    }
    if(['resolve','dismiss','revoke'].includes(subcommand??'')){
      const {values}=parseArgs({args:rest,options:{review:{type:'string'},variant:{type:'string'},by:{type:'string',default:os.userInfo().username},note:{type:'string'}}});
      const action:ReviewAction={reviewId:Number(values.review),action:subcommand as ReviewAction['action'],
        variantId:values.variant?Number(values.variant):undefined,reviewer:requireText(values.by,'--by'),note:requireText(values.note,'--note')};
      applyAction(db,action);console.log(JSON.stringify({ok:true,...action}));return;
    }
    throw new Error('Usage: pipeline review <list|show|sets|resolve|resolve-set|dismiss|revoke|export|import>');
  }finally{db.close();}
}
