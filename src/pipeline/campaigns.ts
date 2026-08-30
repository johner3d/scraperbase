import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { normalizePart } from '../curated/materialize.ts';

export interface Campaign {
  campaignId: string;
  query: string;
  marketplace: string;
}

export function ensureCampaigns(db: DatabaseSync, pipelineRunId: string, queries: string[], marketplaces: string[]): Campaign[] {
  const now = new Date().toISOString();
  const insert = db.prepare(`INSERT OR IGNORE INTO ebay_campaigns
    (campaign_id,pipeline_run_id,query_text,normalized_query,marketplace,status,coverage_status,created_at)
    VALUES(?,?,?,?,?,'pending','unknown',?)`);
  for (const query of queries) {
    for (const marketplace of marketplaces) {
      insert.run(randomUUID(), pipelineRunId, query, normalizePart(query), marketplace, now);
    }
  }
  return db.prepare(`SELECT campaign_id campaignId,query_text query,marketplace FROM ebay_campaigns
    WHERE pipeline_run_id=? ORDER BY query_text,marketplace`).all(pipelineRunId) as unknown as Campaign[];
}

/** Re-arms only search pages belonging to this query/marketplace campaign. */
export function rearmCampaign(db: DatabaseSync, campaign: Campaign,refreshDetails=true,refreshSearch=true): number {
  const now = new Date().toISOString();
  db.prepare(`UPDATE ebay_campaigns SET status='running',coverage_status='unknown',completed_at=NULL WHERE campaign_id=?`)
    .run(campaign.campaignId);
  if(!refreshSearch)return 0;
  const result = db.prepare(`UPDATE work_items SET state='pending',attempts=0,available_at=?,last_error=NULL,
      lease_owner=NULL,lease_expires_at=NULL,updated_at=?,params_json=json_set(params_json,'$.campaignId',?,'$.refreshDetails',?)
    WHERE source='ebay' AND queue='ebay_search'
      AND json_extract(params_json,'$.query')=? AND json_extract(params_json,'$.marketplace')=?
      AND state IN ('succeeded','permanent_failed','cancelled')`)
    .run(now, now, campaign.campaignId,refreshDetails?1:0, campaign.query, campaign.marketplace);
  return Number(result.changes);
}
