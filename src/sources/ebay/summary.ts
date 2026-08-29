import type { DatabaseSync } from 'node:sqlite';

interface OutcomeRow {
  source_identity: string;
  outcome: string;
  n: number;
  bytes: number | null;
}

interface NewObjectRow {
  source_identity: string;
  n: number;
  bytes: number | null;
}

/** Prints a short "what did this run actually fetch" summary straight from attempts/observations -- no separate reporting layer needed for raw acquisition. */
export function printEbayRunSummary(db: DatabaseSync, runId: string): void {
  const byOutcome = db
    .prepare(
      `SELECT a.source_identity, a.outcome, COUNT(*) as n, SUM(a.byte_size) as bytes
       FROM attempts a
       JOIN work_items w ON w.work_item_id = a.work_item_id
       WHERE a.run_id = ? AND w.source = 'ebay'
       GROUP BY a.source_identity, a.outcome
       ORDER BY a.source_identity, a.outcome`,
    )
    .all(runId) as unknown as OutcomeRow[];

  const newObjects = db
    .prepare(
      `SELECT a.source_identity, COUNT(*) as n, SUM(a.byte_size) as bytes
       FROM attempts a
       JOIN work_items w ON w.work_item_id = a.work_item_id
       JOIN observations o ON o.attempt_id = a.attempt_id
       WHERE a.run_id = ? AND w.source = 'ebay' AND o.is_first_observation_of_hash = 1
       GROUP BY a.source_identity`,
    )
    .all(runId) as unknown as NewObjectRow[];

  if (byOutcome.length === 0) {
    console.log('eBay run: no attempts recorded.');
    return;
  }

  console.log('eBay raw fetch summary:');
  const marketplaces = [...new Set(byOutcome.map((r) => r.source_identity))];
  for (const marketplace of marketplaces) {
    const rows = byOutcome.filter((r) => r.source_identity === marketplace);
    const totalAttempts = rows.reduce((sum, r) => sum + r.n, 0);
    const totalBytes = rows.reduce((sum, r) => sum + (r.bytes ?? 0), 0);
    const outcomeStr = rows.map((r) => `${r.outcome}=${r.n}`).join('  ');
    const fresh = newObjects.find((r) => r.source_identity === marketplace);
    console.log(
      `  ${marketplace}: ${totalAttempts} attempt(s), ${(totalBytes / 1024).toFixed(1)} KB fetched  [${outcomeStr}]` +
        (fresh ? `  new_content=${fresh.n} (${((fresh.bytes ?? 0) / 1024).toFixed(1)} KB)` : '  new_content=0'),
    );
  }
}
