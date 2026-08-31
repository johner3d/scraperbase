import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SCHEMA_VERSION = 18;
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
  // Generous so a short CLI write (e.g. `pipeline stage …`) waits out a
  // daemon tick's transaction instead of erroring with "database is locked".
  db.exec('PRAGMA busy_timeout = 30000');
  migrate(db);
  return db;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
}

/**
 * Retry `fn` while SQLite reports the database is locked. The daemon's daily
 * full `materialize` holds one long write transaction; a control-plane CLI write
 * (e.g. `pipeline stage …`) needs to wait it out rather than error.
 */
export function retryOnBusy<T>(fn: () => T, opts: { attempts?: number; delayMs?: number; onWait?: (attempt: number) => void } = {}): T {
  const attempts = opts.attempts ?? 6;
  const delayMs = opts.delayMs ?? 3000;
  for (let i = 1; ; i++) {
    try {
      return fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (i >= attempts || !/database is locked|SQLITE_BUSY/i.test(msg)) throw err;
      opts.onWait?.(i);
      sleepSync(delayMs);
    }
  }
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
    version = 7;
  }
  if (version < 8) {
    db.exec(readFileSync(path.join(__dirname, 'schema_v8.sql'), 'utf8'));
    db.exec('PRAGMA user_version = 8');
    version = 8;
  }
  if (version < 9) {
    db.exec(readFileSync(path.join(__dirname, 'schema_v9.sql'), 'utf8'));
    db.exec('PRAGMA user_version = 9');
    version = 9;
  }
  if (version < 10) {
    db.exec(readFileSync(path.join(__dirname, 'schema_v10.sql'), 'utf8'));
    db.exec('PRAGMA user_version = 10');
    version = 10;
  }
  if (version < 11) {
    db.exec(readFileSync(path.join(__dirname, 'schema_v11.sql'), 'utf8'));
    db.exec('PRAGMA user_version = 11');
    version = 11;
  }
  if (version < 12) {
    db.exec(readFileSync(path.join(__dirname, 'schema_v12.sql'), 'utf8'));
    db.exec('PRAGMA user_version = 12');
    version = 12;
  }
  if (version < 13) {
    db.exec(readFileSync(path.join(__dirname, 'schema_v13.sql'), 'utf8'));
    db.exec('PRAGMA user_version = 13');
    version = 13;
  }
  if (version < 14) {
    db.exec(readFileSync(path.join(__dirname, 'schema_v14.sql'), 'utf8'));
    db.exec('PRAGMA user_version = 14');
    version = 14;
  }
  if (version < 15) {
    db.exec(readFileSync(path.join(__dirname, 'schema_v15.sql'), 'utf8'));
    db.exec('PRAGMA user_version = 15');
    version = 15;
  }
  if (version < 16) {
    db.exec(readFileSync(path.join(__dirname, 'schema_v16.sql'), 'utf8'));
    db.exec('PRAGMA user_version = 16');
    version = 16;
  }
  if (version < 17) {
    db.exec(readFileSync(path.join(__dirname, 'schema_v17.sql'), 'utf8'));
    db.exec('PRAGMA user_version = 17');
    version = 17;
  }
  if (version < 18) {
    db.exec(readFileSync(path.join(__dirname, 'schema_v18.sql'), 'utf8'));
    db.exec('PRAGMA user_version = 18');
  }
}
