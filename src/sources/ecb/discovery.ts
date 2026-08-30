import type { DatabaseSync } from 'node:sqlite';
import { enqueueWorkItem } from '../../core/queue/scheduler.ts';
import { workItemId } from '../../core/queue/workItem.ts';
import { ECB_DAILY_SCOPE_KEY, ECB_RATES_QUEUE } from './config.ts';

export function seedEcbRates(db: DatabaseSync): void {
  enqueueWorkItem(db, {
    source: 'ecb', queue: ECB_RATES_QUEUE, entityType: 'fx_rates',
    scopeKey: ECB_DAILY_SCOPE_KEY, params: {},
  });
  const now=new Date().toISOString();
  db.prepare(`UPDATE work_items SET state='pending',attempts=0,available_at=?,last_error=NULL,lease_owner=NULL,lease_expires_at=NULL,updated_at=?
    WHERE work_item_id=? AND state='succeeded'`).run(now,now,workItemId('ecb',ECB_RATES_QUEUE,ECB_DAILY_SCOPE_KEY));
}
