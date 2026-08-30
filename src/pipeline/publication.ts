import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import type { DatabaseSync as Database } from 'node:sqlite';
import { DB_PATH, PUBLISHED_DIR, PUBLISHED_POINTER_PATH } from '../core/config/config.ts';

export interface PublicationManifest {
  generationId: string;
  pipelineRunId: string;
  createdAt: string;
  database: string;
  completeness: 'partial' | 'complete';
  incompleteReason: string | null;
  counts: { sets: number; cards: number; variants: number; psaSpecs: number; ebayListings: number };
}

export interface GenerationValidationOptions {
  completeness?: PublicationManifest['completeness'];
  incompleteReason?: string | null;
}

function counts(db: Database): PublicationManifest['counts'] {
  const row = db.prepare(`SELECT
    (SELECT COUNT(*) FROM sets) sets,
    (SELECT COUNT(*) FROM cards) cards,
    (SELECT COUNT(*) FROM variants) variants,
    (SELECT COUNT(*) FROM psa_specs) psaSpecs,
    (SELECT COUNT(*) FROM ebay_listings) ebayListings`).get() as PublicationManifest['counts'];
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value)])) as unknown as PublicationManifest['counts'];
}

export function validateAppDatabase(dbPath: string): PublicationManifest['counts'] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const integrity = db.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
    if (integrity.integrity_check !== 'ok') throw new Error(`Snapshot integrity_check failed: ${integrity.integrity_check}`);
    const foreignKeys = db.prepare('PRAGMA foreign_key_check').all();
    if (foreignKeys.length) throw new Error(`Snapshot has ${foreignKeys.length} foreign-key violation(s)`);
    const result = counts(db);
    if (result.sets === 0 || result.cards === 0 || result.variants === 0) {
      throw new Error(`Snapshot catalogue is empty (sets=${result.sets}, cards=${result.cards}, variants=${result.variants})`);
    }
    db.prepare('SELECT * FROM v_card_search LIMIT 1').get();
    db.prepare('SELECT * FROM v_variant_search LIMIT 1').get();
    db.prepare('SELECT * FROM v_variant_detail LIMIT 1').get();
    return result;
  } finally {
    db.close();
  }
}

function writePointer(manifest: PublicationManifest): void {
  mkdirSync(PUBLISHED_DIR, { recursive: true });
  const temp = `${PUBLISHED_POINTER_PATH}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(manifest, null, 2) + '\n');
  renameSync(temp, PUBLISHED_POINTER_PATH);
}

function prunePublishedSnapshots(keep = 3): void {
  const root = path.resolve(PUBLISHED_DIR);
  const files = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^app-[a-f0-9-]+\.sqlite$/.test(entry.name))
    .map((entry) => ({ path: path.join(root, entry.name), mtime: statSync(path.join(root, entry.name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const file of files.slice(keep)) {
    const resolved = path.resolve(file.path);
    if (path.dirname(resolved) !== root) throw new Error(`Refusing to prune outside ${root}`);
    rmSync(resolved);
  }
}

export async function assembleGeneration(db: Database, pipelineRunId: string): Promise<{generationId:string;candidatePath:string}> {
  mkdirSync(PUBLISHED_DIR, { recursive: true });
  const generationId = randomUUID();
  const now = new Date().toISOString();
  const candidatePath = path.join(PUBLISHED_DIR, `app-${generationId}.candidate`);
  db.prepare(`INSERT INTO publication_generations
    (generation_id,pipeline_run_id,status,snapshot_path,created_at) VALUES(?,?,'assembling',?,?)`)
    .run(generationId, pipelineRunId, candidatePath, now);
  try {
    await backup(db, candidatePath);
    return { generationId, candidatePath };
  } catch (error) {
    if (existsSync(candidatePath)) rmSync(candidatePath);
    db.prepare(`UPDATE publication_generations SET status='failed',error_message=? WHERE generation_id=?`)
      .run(error instanceof Error ? error.message : String(error), generationId);
    throw error;
  }
}

function generationForRun(db: Database, pipelineRunId: string, status: string): {generation_id:string;snapshot_path:string;created_at:string} {
  const row = db.prepare(`SELECT generation_id,snapshot_path,created_at FROM publication_generations
    WHERE pipeline_run_id=? AND status=? ORDER BY created_at DESC LIMIT 1`).get(pipelineRunId,status) as
    {generation_id:string;snapshot_path:string;created_at:string}|undefined;
  if (!row) throw new Error(`No ${status} publication generation for pipeline ${pipelineRunId}`);
  return row;
}

export function validateGeneration(
  db: Database,
  pipelineRunId: string,
  options: GenerationValidationOptions = {},
): PublicationManifest {
  const generation = generationForRun(db,pipelineRunId,'assembling');
  const snapshotCounts = validateAppDatabase(generation.snapshot_path);
  const finalPath = path.join(PUBLISHED_DIR, `app-${generation.generation_id}.sqlite`);
  renameSync(generation.snapshot_path,finalPath);
  const completeness=options.completeness??'complete';
  const manifest:PublicationManifest={generationId:generation.generation_id,pipelineRunId,createdAt:generation.created_at,
    database:finalPath,completeness,incompleteReason:completeness==='partial'?(options.incompleteReason??null):null,counts:snapshotCounts};
  db.prepare(`UPDATE publication_generations SET status='validated',snapshot_path=?,validated_at=?,manifest_json=? WHERE generation_id=?`)
    .run(finalPath,new Date().toISOString(),JSON.stringify(manifest),generation.generation_id);
  return manifest;
}

export function publishGeneration(db: Database, pipelineRunId: string): PublicationManifest {
  const generation = generationForRun(db,pipelineRunId,'validated');
  const row=db.prepare(`SELECT manifest_json FROM publication_generations WHERE generation_id=?`).get(generation.generation_id) as {manifest_json:string};
  const manifest=JSON.parse(row.manifest_json) as PublicationManifest;
  writePointer(manifest);
  const publishedAt=new Date().toISOString();
  db.prepare(`UPDATE publication_generations SET status='published',published_at=? WHERE generation_id=?`).run(publishedAt,generation.generation_id);
  db.prepare(`UPDATE publication_state SET active_generation_id=?,updated_at=? WHERE singleton_id=1`).run(generation.generation_id,publishedAt);
  prunePublishedSnapshots(3);
  return manifest;
}

/** Convenience used by focused tests and expert callers. */
export async function assembleAndPublish(db: Database,pipelineRunId:string):Promise<PublicationManifest>{
  await assembleGeneration(db,pipelineRunId);
  validateGeneration(db,pipelineRunId);
  return publishGeneration(db,pipelineRunId);
}

export function resolvePublishedDatabase(): string {
  if (!existsSync(PUBLISHED_POINTER_PATH)) return DB_PATH;
  try {
    const pointer = JSON.parse(readFileSync(PUBLISHED_POINTER_PATH, 'utf8')) as { database?: string };
    if (pointer.database && existsSync(pointer.database)) return path.resolve(pointer.database);
  } catch { /* fall back to the working DB */ }
  return DB_PATH;
}

export function resolvePublishedManifest(): PublicationManifest | null {
  if (!existsSync(PUBLISHED_POINTER_PATH)) return null;
  try {
    const manifest=JSON.parse(readFileSync(PUBLISHED_POINTER_PATH,'utf8')) as PublicationManifest;
    if (!manifest.database || !existsSync(manifest.database)) return null;
    // Generations created before incremental publication predate these fields.
    return {...manifest,completeness:manifest.completeness??'complete',incompleteReason:manifest.incompleteReason??null};
  } catch { return null; }
}
