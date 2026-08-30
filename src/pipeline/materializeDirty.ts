import type { DatabaseSync } from 'node:sqlite';

export type DirtyKind = 'ebay-item' | 'psa-spec';

/** Mark a unit of work for the next incremental materialize tick. Idempotent. */
export function markDirty(db: DatabaseSync, kind: DirtyKind, ref: string): void {
  db.prepare(
    `INSERT INTO materialize_dirty (kind, ref, marked_at) VALUES (?,?,?)
     ON CONFLICT(kind, ref) DO UPDATE SET marked_at=excluded.marked_at`,
  ).run(kind, ref, new Date().toISOString());
}

export function markEbayItemDirty(db: DatabaseSync, scopeKey: string): void {
  if (scopeKey.startsWith('item:')) markDirty(db, 'ebay-item', scopeKey);
}

export function markPsaSpecDirty(db: DatabaseSync, specId: string | number): void {
  markDirty(db, 'psa-spec', String(specId));
}

/** Peek at up to `limit` pending refs of a kind without removing them. */
export function peekDirty(db: DatabaseSync, kind: DirtyKind, limit: number): string[] {
  return (db.prepare(`SELECT ref FROM materialize_dirty WHERE kind=? ORDER BY marked_at LIMIT ?`)
    .all(kind, limit) as unknown as Array<{ ref: string }>).map((r) => r.ref);
}

export function countDirty(db: DatabaseSync, kind: DirtyKind): number {
  return Number((db.prepare(`SELECT COUNT(*) n FROM materialize_dirty WHERE kind=?`).get(kind) as { n: number }).n);
}

/** Remove refs once they've been materialized. Refs marked again since the peek stay (marked_at moved forward). */
export function clearDirty(db: DatabaseSync, kind: DirtyKind, refs: string[], before: string): void {
  if (!refs.length) return;
  const ph = refs.map(() => '?').join(',');
  db.prepare(`DELETE FROM materialize_dirty WHERE kind=? AND ref IN (${ph}) AND marked_at<=?`)
    .run(kind, ...refs, before);
}
