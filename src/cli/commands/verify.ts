import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { openCliDb } from '../context.ts';
import { readObject } from '../../core/objectstore/store.ts';
import { sha256Hex } from '../../core/objectstore/hash.ts';
import { OBJECTS_DIR } from '../../core/config/config.ts';

export async function verifyCommand(_args: string[]): Promise<void> {
  const db = openCliDb();
  let problems = 0;

  // 1. Every raw_objects row's file exists on disk and re-hashes correctly.
  const objects = db.prepare('SELECT hash, storage_path FROM raw_objects').all() as {
    hash: string;
    storage_path: string;
  }[];
  for (const obj of objects) {
    try {
      const data = await readObject(obj.storage_path);
      if (sha256Hex(data) !== obj.hash) {
        console.error(`MISMATCH: ${obj.storage_path} does not hash to ${obj.hash}`);
        problems++;
      }
    } catch {
      console.error(`MISSING: ${obj.storage_path} (hash ${obj.hash})`);
      problems++;
    }
  }
  console.log(`Checked ${objects.length} raw object(s) on disk.`);

  // 2. No orphaned files under data/objects/ (excluding tmp/) without a raw_objects row.
  const known = new Set(objects.map((o) => o.storage_path.replace(/\\/g, '/')));
  const onDisk = await listFiles(OBJECTS_DIR);
  let orphans = 0;
  for (const abs of onDisk) {
    const rel = path.relative(OBJECTS_DIR, abs).replace(/\\/g, '/');
    if (rel === 'tmp' || rel.startsWith('tmp/')) continue;
    if (!known.has(rel)) {
      console.error(`ORPHAN: ${rel}`);
      orphans++;
    }
  }
  console.log(`Found ${orphans} orphaned file(s) on disk.`);
  problems += orphans;

  // 3. Leases stuck past expiry (informational -- the next run's sweep reclaims these).
  const stuck = db
    .prepare(`SELECT COUNT(*) as n FROM work_items WHERE state IN ('leased','running') AND lease_expires_at < ?`)
    .get(new Date().toISOString()) as { n: number };
  if (stuck.n > 0) {
    console.log(`NOTE: ${stuck.n} work item(s) have an expired lease -- will be reclaimed on next run.`);
  }

  // 4. Referential integrity: observations -> raw_objects / work_items.
  const badObs = db
    .prepare(
      `SELECT COUNT(*) as n FROM observations o
       LEFT JOIN raw_objects r ON o.hash = r.hash
       LEFT JOIN work_items w ON o.work_item_id = w.work_item_id
       WHERE r.hash IS NULL OR w.work_item_id IS NULL`,
    )
    .get() as { n: number };
  console.log(`Referential integrity: ${badObs.n} broken observation row(s).`);
  problems += badObs.n;

  // 5. coverage rows marked complete must carry exhaustion evidence.
  const badCoverage = db
    .prepare(`SELECT COUNT(*) as n FROM coverage WHERE status = 'complete' AND exhaustion_evidence IS NULL`)
    .get() as { n: number };
  console.log(`Coverage rows missing evidence: ${badCoverage.n}.`);
  problems += badCoverage.n;

  db.close();

  if (problems > 0) {
    console.error(`verify FAILED with ${problems} problem(s).`);
    process.exitCode = 1;
  } else {
    console.log('verify OK');
  }
}

async function listFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(full)));
    else files.push(full);
  }
  return files;
}
