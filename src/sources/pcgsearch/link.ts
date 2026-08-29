import type { DatabaseSync } from 'node:sqlite';
import { PCGSEARCH_IMAGES_QUEUE } from './discovery.ts';

interface LinkableRow {
  scope_key: string;
  hash: string;
  media_type: string;
  request_url: string;
  request_params_json: string | null;
}

export function linkPcgSearchAssets(db: DatabaseSync, at: string): number {
  const rows = db
    .prepare(
      `SELECT o.scope_key, o.hash, ro.media_type, a.request_url, a.request_params_json
       FROM observations o
       JOIN work_items w ON w.work_item_id = o.work_item_id
       JOIN raw_objects ro ON ro.hash = o.hash
       JOIN attempts a ON a.attempt_id = (
         SELECT attempt_id FROM attempts WHERE work_item_id = o.work_item_id AND content_hash = o.hash
         ORDER BY attempt_id DESC LIMIT 1)
       WHERE w.source = 'pcgsearch' AND w.queue = ? AND o.entity_type = 'card_image'
         AND NOT EXISTS (
           SELECT 1 FROM observations newer WHERE newer.entity_type = o.entity_type
             AND newer.scope_key = o.scope_key AND newer.observation_id > o.observation_id)`,
    )
    .all(PCGSEARCH_IMAGES_QUEUE) as unknown as LinkableRow[];

  let linked = 0;
  for (const row of rows) {
    const cardId = Number(/^card:(\d+)$/.exec(row.scope_key)?.[1]);
    if (!cardId) continue;
    const card = db.prepare(`SELECT image_url FROM cards WHERE card_id = ?`).get(cardId) as { image_url: string | null } | undefined;
    if (!card || card.image_url != null) continue;

    const matchKind = row.request_params_json ? (JSON.parse(row.request_params_json).matchKind as string | undefined) : undefined;
    const rendition = `pcgsearch:${matchKind ?? 'exact'}`;

    db.prepare(`UPDATE assets SET is_primary = 0, updated_at = ? WHERE target_type = 'card' AND target_id = ? AND url <> ?`)
      .run(at, cardId, row.request_url);
    db.prepare(
      `INSERT INTO assets (target_type, target_id, object_hash, url, rendition, media_type, is_primary, created_at, updated_at)
       VALUES ('card', ?, ?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT(target_type, target_id, url, rendition) DO UPDATE SET
         object_hash = excluded.object_hash, media_type = excluded.media_type, is_primary = 1, updated_at = excluded.updated_at`,
    ).run(cardId, row.hash, row.request_url, rendition, row.media_type, at, at);
    db.prepare(`UPDATE cards SET image_url = ?, updated_at = ? WHERE card_id = ? AND image_url IS NULL`)
      .run(row.request_url, at, cardId);
    linked++;
  }
  return linked;
}
