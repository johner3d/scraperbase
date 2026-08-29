import type { DatabaseSync } from 'node:sqlite';
import { enqueueWorkItem } from '../../core/queue/scheduler.ts';

export const POKEMONCARD_IMAGES_QUEUE = 'pokemoncard_images';

interface MissingCardRow {
  card_id: number;
  name: string;
  set_name: string;
  local_id: string;
  source_set_id: string;
}

/** Finds every hydrated Japanese card TCGdex has no image for and enqueues a pokemon-card.com lookup job. */
export function seedPokemonCardDiscovery(db: DatabaseSync): number {
  const rows = db
    .prepare(
      `SELECT c.card_id, c.name, s.name AS set_name, c.local_id, s.source_set_id
       FROM cards c JOIN sets s ON s.set_id = c.set_id
       WHERE s.language = 'ja' AND c.detail_status = 'hydrated' AND c.image_url IS NULL`,
    )
    .all() as unknown as MissingCardRow[];

  for (const row of rows) {
    enqueueWorkItem(db, {
      source: 'pokemoncard',
      queue: POKEMONCARD_IMAGES_QUEUE,
      entityType: 'card_image',
      scopeKey: `card:${row.card_id}`,
      params: { cardId: row.card_id, name: row.name, setName: row.set_name, localId: row.local_id, sourceSetId: row.source_set_id },
    });
  }
  return rows.length;
}
