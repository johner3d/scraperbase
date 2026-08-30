import type { DatabaseSync } from 'node:sqlite';

export const EBAY_DAILY_CALL_ALLOWANCE = 5_000;
export const EBAY_DAILY_SAFETY_LIMIT = 4_500;

function resetAt(now = new Date()): Date {
  const reset = new Date(now);
  reset.setUTCHours(7,0,0,0);
  if (now < reset) reset.setUTCDate(reset.getUTCDate()-1);
  return reset;
}

export function nextEbayReset(now = new Date()): Date {
  const next = resetAt(now);
  next.setUTCDate(next.getUTCDate()+1);
  return next;
}

export function ebayQuotaState(db: DatabaseSync, now = new Date()): {
  used: number; limit: number; allowance: number; resumeAfter: string; paused: boolean;
} {
  const used = Number((db.prepare(`SELECT COUNT(*) n FROM attempts a JOIN work_items w ON w.work_item_id=a.work_item_id
    WHERE w.source='ebay' AND a.http_status IS NOT NULL AND a.finished_at>=?`).get(resetAt(now).toISOString()) as {n:number}).n);
  return { used, limit:EBAY_DAILY_SAFETY_LIMIT, allowance:EBAY_DAILY_CALL_ALLOWANCE,
    resumeAfter:nextEbayReset(now).toISOString(), paused:used>=EBAY_DAILY_SAFETY_LIMIT };
}
