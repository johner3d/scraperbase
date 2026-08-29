import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { OBJECTS_DIR, OBJECTS_TMP_DIR } from '../config/config.ts';
import { sha256Hex } from './hash.ts';

export type MediaKind = 'json' | 'html' | 'image';

export interface WriteObjectInput {
  source: string;       // 'tcgdex' | 'psa'
  mediaKind: MediaKind;
  mediaType: string;    // e.g. 'application/json', 'image/webp'
  ext: string;           // e.g. 'json', 'html', 'webp'
  body: Buffer;
}

export interface WriteObjectResult {
  hash: string;
  isNew: boolean;
  storagePath: string;  // relative to the objects dir
  byteSize: number;
}

export interface ObjectStoreDirs {
  objectsDir: string;
  objectsTmpDir: string;
}

const DEFAULT_DIRS: ObjectStoreDirs = { objectsDir: OBJECTS_DIR, objectsTmpDir: OBJECTS_TMP_DIR };

const RENAME_RETRY_DELAYS_MS = [50, 100, 250, 500, 1000];

/**
 * Content-addressed atomic write: stage to a temp file on the same volume,
 * hash it, then either discard it (content already stored -- dedup) or
 * rename it into place. Never overwrites an existing object.
 *
 * Callers are responsible for inserting the corresponding `observations` row
 * (this function only touches `raw_objects`, and only on first write of a
 * given hash) inside the same logical unit of work.
 *
 * `dirs` defaults to the project's real `data/objects` location; tests pass
 * an isolated temp directory instead so they never touch real data.
 */
export async function writeObject(
  db: DatabaseSync,
  input: WriteObjectInput,
  dirs: ObjectStoreDirs = DEFAULT_DIRS,
): Promise<WriteObjectResult> {
  await mkdir(dirs.objectsTmpDir, { recursive: true });

  const tmpPath = path.join(dirs.objectsTmpDir, `${randomUUID()}.part`);
  await writeFile(tmpPath, input.body);
  const hash = sha256Hex(input.body);
  const byteSize = input.body.byteLength;

  const relDir = path.join(input.source, input.mediaKind, hash.slice(0, 2), hash.slice(2, 4));
  const relPath = path.join(relDir, `${hash}.${input.ext}`);
  const absPath = path.join(dirs.objectsDir, relPath);

  const existing = db
    .prepare('SELECT hash, storage_path FROM raw_objects WHERE hash = ?')
    .get(hash) as { hash: string; storage_path: string } | undefined;

  if (existing) {
    await verifyExistingOrThrow(path.join(dirs.objectsDir, existing.storage_path), hash);
    await rm(tmpPath, { force: true });
    return { hash, isNew: false, storagePath: existing.storage_path, byteSize };
  }

  await mkdir(path.join(dirs.objectsDir, relDir), { recursive: true });
  await renameWithRetry(tmpPath, absPath);

  const inserted = db.prepare(
    `INSERT OR IGNORE INTO raw_objects (hash, media_type, byte_size, first_seen_at, storage_path, compression)
     VALUES (?, ?, ?, ?, ?, NULL)`,
  ).run(hash, input.mediaType, byteSize, new Date().toISOString(), relPath);

  if (inserted.changes === 0) {
    const winner = db.prepare('SELECT storage_path FROM raw_objects WHERE hash = ?').get(hash) as
      | { storage_path: string }
      | undefined;
    if (!winner) throw new Error(`Object store race for ${hash} completed without a canonical row`);
    const winnerPath = path.join(dirs.objectsDir, winner.storage_path);
    await verifyExistingOrThrow(winnerPath, hash);
    if (winner.storage_path !== relPath) await rm(absPath, { force: true });
    return { hash, isNew: false, storagePath: winner.storage_path, byteSize };
  }

  return { hash, isNew: true, storagePath: relPath, byteSize };
}

export async function readObject(storagePath: string, dirs: ObjectStoreDirs = DEFAULT_DIRS): Promise<Buffer> {
  return readFile(path.join(dirs.objectsDir, storagePath));
}

async function verifyExistingOrThrow(absPath: string, expectedHash: string): Promise<void> {
  const data = await readFile(absPath);
  const actual = sha256Hex(data);
  if (actual !== expectedHash) {
    throw new Error(
      `Object store integrity error: ${absPath} hash mismatch (expected ${expectedHash}, got ${actual})`,
    );
  }
}

async function renameWithRetry(src: string, dest: string): Promise<void> {
  let lastErr: unknown;
  for (let i = 0; i < RENAME_RETRY_DELAYS_MS.length + 1; i++) {
    if (i > 0) await sleep(RENAME_RETRY_DELAYS_MS[i - 1]!);
    try {
      await rename(src, dest);
      return;
    } catch (err) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException).code;
      // Another worker may have atomically placed the same content first.
      // The caller verifies the canonical hash after the database insert race.
      if (code === 'EEXIST') {
        await rm(src, { force: true });
        return;
      }
      // Transient Windows AV/indexer locks show up as EPERM/EBUSY; anything
      // else (e.g. ENOENT) is a real bug, so fail fast.
      if (code !== 'EPERM' && code !== 'EBUSY') throw err;
    }
  }
  throw lastErr;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
