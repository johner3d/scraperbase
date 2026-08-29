import type { DatabaseSync } from 'node:sqlite';
import { enqueueWorkItem } from '../../core/queue/scheduler.ts';

export const PCGSEARCH_IMAGES_QUEUE = 'pcgsearch_images';

// Only PCG Search's covered vintage sets -- see match.ts's SET_CONFIG.
const COVERED_SET_IDS = ['PMCG1', 'PMCG2', 'PMCG3', 'PMCG4', 'PMCG5', 'PMCG6', 'neo1', 'neo2', 'neo3', 'neo4', 'VS1', 'web1', 'E1'];

interface MissingCardRow {
  card_id: number;
  local_id: string;
  source_set_id: string;
}

export function seedPcgSearchDiscovery(db: DatabaseSync): number {
  const placeholders = COVERED_SET_IDS.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT c.card_id, c.local_id, s.source_set_id
       FROM cards c JOIN sets s ON s.set_id = c.set_id
       WHERE s.language = 'ja' AND c.detail_status = 'hydrated' AND c.image_url IS NULL
         AND s.source_set_id IN (${placeholders})`,
    )
    .all(...COVERED_SET_IDS) as unknown as MissingCardRow[];

  for (const row of rows) {
    enqueueWorkItem(db, {
      source: 'pcgsearch',
      queue: PCGSEARCH_IMAGES_QUEUE,
      entityType: 'card_image',
      scopeKey: `card:${row.card_id}`,
      params: { cardId: row.card_id, localId: row.local_id, sourceSetId: row.source_set_id },
    });
  }
  return rows.length;
}
