import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { writeObject, readObject, type ObjectStoreDirs } from '../../src/core/objectstore/store.ts';
import { sha256Hex } from '../../src/core/objectstore/hash.ts';

const schemaSql = readFileSync(
  fileURLToPath(new URL('../../src/core/db/schema.sql', import.meta.url)),
  'utf8',
);

async function withTempStore(
  fn: (db: DatabaseSync, dirs: ObjectStoreDirs) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'scraperbase-objectstore-'));
  const dirs: ObjectStoreDirs = {
    objectsDir: path.join(root, 'objects'),
    objectsTmpDir: path.join(root, 'objects', 'tmp'),
  };
  const db = new DatabaseSync(':memory:');
  db.exec(schemaSql);
  try {
    await fn(db, dirs);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
}

test('writeObject stores content addressed by sha256 and is readable back', async () => {
  await withTempStore(async (db, dirs) => {
    const body = Buffer.from('{"hello":"world"}');
    const result = await writeObject(
      db,
      { source: 'tcgdex', mediaKind: 'json', mediaType: 'application/json', ext: 'json', body },
      dirs,
    );

    assert.equal(result.hash, sha256Hex(body));
    assert.equal(result.isNew, true);
    assert.equal(result.byteSize, body.byteLength);

    const readBack = await readObject(result.storagePath, dirs);
    assert.deepEqual(readBack, body);

    const row = db.prepare('SELECT * FROM raw_objects WHERE hash = ?').get(result.hash) as
      { hash: string; byte_size: number; media_type: string } | undefined;
    assert.ok(row);
    assert.equal(row!.byte_size, body.byteLength);
    assert.equal(row!.media_type, 'application/json');
  });
});

test('writeObject deduplicates identical content and never overwrites', async () => {
  await withTempStore(async (db, dirs) => {
    const body = Buffer.from('duplicate-me');
    const first = await writeObject(
      db,
      { source: 'tcgdex', mediaKind: 'json', mediaType: 'application/json', ext: 'json', body },
      dirs,
    );
    const second = await writeObject(
      db,
      { source: 'tcgdex', mediaKind: 'json', mediaType: 'application/json', ext: 'json', body },
      dirs,
    );

    assert.equal(first.isNew, true);
    assert.equal(second.isNew, false);
    assert.equal(first.hash, second.hash);
    assert.equal(first.storagePath, second.storagePath);

    const count = db.prepare('SELECT COUNT(*) as n FROM raw_objects').get() as { n: number };
    assert.equal(count.n, 1);
  });
});

test('writeObject deduplicates identical content across concurrent workers', async () => {
  await withTempStore(async (db, dirs) => {
    const body = Buffer.from('concurrent-duplicate');
    const results = await Promise.all(Array.from({ length: 12 }, () => writeObject(
      db,
      { source: 'tcgdex', mediaKind: 'image', mediaType: 'image/webp', ext: 'webp', body },
      dirs,
    )));

    assert.equal(results.filter((result) => result.isNew).length, 1);
    assert.equal(new Set(results.map((result) => result.storagePath)).size, 1);
    const count = db.prepare('SELECT COUNT(*) as n FROM raw_objects').get() as { n: number };
    assert.equal(count.n, 1);
  });
});

test('writeObject detects on-disk corruption of an existing object instead of silently overwriting', async () => {
  await withTempStore(async (db, dirs) => {
    const body = Buffer.from('original-content');
    const first = await writeObject(
      db,
      { source: 'tcgdex', mediaKind: 'json', mediaType: 'application/json', ext: 'json', body },
      dirs,
    );

    // Simulate on-disk corruption of the already-stored object.
    const absPath = path.join(dirs.objectsDir, first.storagePath);
    await writeFile(absPath, 'tampered');

    await assert.rejects(
      () =>
        writeObject(
          db,
          { source: 'tcgdex', mediaKind: 'json', mediaType: 'application/json', ext: 'json', body },
          dirs,
        ),
      /hash mismatch/,
    );
  });
});

test('writeObject lays out files under source/mediaKind/hash[0:2]/hash[2:4]/hash.ext', async () => {
  await withTempStore(async (db, dirs) => {
    const body = Buffer.from('layout-check');
    const result = await writeObject(
      db,
      { source: 'psa', mediaKind: 'html', mediaType: 'text/html', ext: 'html', body },
      dirs,
    );
    const expectedRel = path.join(
      'psa',
      'html',
      result.hash.slice(0, 2),
      result.hash.slice(2, 4),
      `${result.hash}.html`,
    );
    assert.equal(result.storagePath, expectedRel);
    // File actually exists at that path (rename succeeded, not left as .part).
    const bytes = await readFile(path.join(dirs.objectsDir, expectedRel));
    assert.deepEqual(bytes, body);
  });
});

test('writeObject honors a per-input dirs override, as runner.ts does for result.object.dirs', async () => {
  await withTempStore(async (db, defaultDirs) => {
    const altRoot = await mkdtemp(path.join(tmpdir(), 'scraperbase-objectstore-alt-'));
    const altDirs: ObjectStoreDirs = {
      objectsDir: path.join(altRoot, 'ebay-raw'),
      objectsTmpDir: path.join(altRoot, 'ebay-raw', 'tmp'),
    };
    try {
      const body = Buffer.from('{"marketplace":"de"}');
      const input = { source: 'ebay', mediaKind: 'json' as const, mediaType: 'application/json', ext: 'json', body, dirs: altDirs };

      // Mirrors processItem(): writeObject(db, result.object, result.object.dirs).
      const result = await writeObject(db, input, input.dirs);

      const bytes = await readFile(path.join(altDirs.objectsDir, result.storagePath));
      assert.deepEqual(bytes, body);
      await assert.rejects(() => readFile(path.join(defaultDirs.objectsDir, result.storagePath)));
    } finally {
      await rm(altRoot, { recursive: true, force: true });
    }
  });
});
