import { parseArgs } from 'node:util';
import { openCliDb } from '../context.ts';

export async function refreshCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: {
    source: { type: 'string', default: 'tcgdex' },
    stage: { type: 'string', default: 'index' },
    scope: { type: 'string' },
  }});
  const tcgdexQueues: Record<string, string[]> = { index: ['tcgdex_discovery', 'catalogue_json'], details: ['catalogue_json'], images: ['images'], all: ['tcgdex_discovery', 'catalogue_json', 'images'] };
  const ebayQueues: Record<string, string[]> = { search: ['ebay_search'], detail: ['ebay_item_detail'], all: ['ebay_search', 'ebay_item_detail'] };
  const queues = values.source === 'ebay' ? ebayQueues : tcgdexQueues;
  const selected = queues[String(values.stage)];
  if (!selected) throw new Error(`Invalid --stage ${values.stage}`);
  const db = openCliDb();
  try {
    const clauses = [`source=?`, `queue IN (${selected.map(() => '?').join(',')})`, `state <> 'cancelled'`];
    const params: Array<string> = [String(values.source), ...selected];
    if (values.stage === 'index') clauses.push(`entity_type IN ('lang_set_list','set')`);
    if (values.stage === 'details') clauses.push(`entity_type='card'`);
    if (values.scope) { clauses.push('scope_key LIKE ?'); params.push(`%${String(values.scope).replace(/^set:/, '')}%`); }
    const now = new Date().toISOString();
    const result = db.prepare(`UPDATE work_items SET state='pending',attempts=0,available_at=?,last_error=NULL,
      lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE ${clauses.join(' AND ')}`).run(now,now,...params);
    console.log(`Requeued ${result.changes} ${values.source}/${values.stage} work item(s).`);
  } finally { db.close(); }
}
