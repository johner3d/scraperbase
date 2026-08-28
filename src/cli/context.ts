import { mkdirSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '../core/db/client.ts';
import { DATA_DIR, DB_PATH } from '../core/config/config.ts';

export function openCliDb(): DatabaseSync {
  mkdirSync(DATA_DIR, { recursive: true });
  return openDb(DB_PATH);
}
