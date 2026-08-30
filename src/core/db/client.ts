import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SCHEMA_VERSION = 7;
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
  db.exec('PRAGMA busy_timeout = 10000');
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
  let version = row.user_version;
  if (version < 1) {
    db.exec(readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
    db.exec('PRAGMA user_version = 1');
    version = 1;
  }
  if (version < 2) {
    db.exec(readFileSync(path.join(__dirname, 'schema_v2.sql'), 'utf8'));
    db.exec('PRAGMA user_version = 2');
    version = 2;
  }
  if (version < 3) {
    db.exec(readFileSync(path.join(__dirname, 'schema_v3.sql'), 'utf8'));
    db.exec('PRAGMA user_version = 3');
    version = 3;
  }
  if (version < 4) {
    db.exec(readFileSync(path.join(__dirname, 'schema_v4.sql'), 'utf8'));
    db.exec('PRAGMA user_version = 4');
    version = 4;
  }
  if (version < 5) {
    db.exec(readFileSync(path.join(__dirname, 'schema_v5.sql'), 'utf8'));
    db.exec('PRAGMA user_version = 5');
    version = 5;
  }
  if (version < 6) {
    db.exec(readFileSync(path.join(__dirname, 'schema_v6.sql'), 'utf8'));
    db.exec('PRAGMA user_version = 6');
    version = 6;
  }
  if (version < 7) {
    db.exec(readFileSync(path.join(__dirname, 'schema_v7.sql'), 'utf8'));
    db.exec('PRAGMA user_version = 7');
  }
}
