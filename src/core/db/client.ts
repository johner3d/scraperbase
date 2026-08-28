import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SCHEMA_VERSION = 1;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Opens (creating if needed) the durable SQLite store, applies WAL mode and
 * foreign-key enforcement (both connection-scoped, so set on every open),
 * and brings the schema up to SCHEMA_VERSION if it isn't already.
 */
export function openDb(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

/** Runs `fn` inside a BEGIN IMMEDIATE/COMMIT block, rolling back on any throw. */
export function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function migrate(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  if (row.user_version >= SCHEMA_VERSION) return;
  const schemaSql = readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schemaSql);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}
