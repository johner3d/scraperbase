import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { openCliDb } from '../cli/context.ts';
import { withTransaction } from '../core/db/client.ts';
import { createRun, finishRun } from '../core/queue/run.ts';
import { enqueueWorkItem, markSucceeded } from '../core/queue/scheduler.ts';
import { workItemId } from '../core/queue/workItem.ts';
import { writeObject } from '../core/objectstore/store.ts';
import { bumpCounter } from '../core/progress/metrics.ts';
import { DATA_DIR } from '../core/config/config.ts';
import { cardFactsHtmlScopeKey, populationScopeKey, salesSnapshotScopeKey } from '../sources/psa/scopeKeys.ts';

// One-off (rerunnable) importer: brings the flat JSON files written by
// psa-fetch.ts / psa-test-fetch.ts into the real object store + SQLite
// pipeline, so `status`/`report` and direct SQL queries can see them. Those
// scripts write plain files with zero DB dependency by design (so the slow,
// flaky browser part never risks a DB write failing mid-run); this is the
// separate, fast, freely-repeatable step that catches the DB up to whatever
// is on disk. Safe to run again later as more releases finish -- work items
// already 'succeeded' are skipped, so only new files get imported.

const SCAN_DIRS = [path.join(DATA_DIR, 'psa-raw')];

interface PopulationFile {
  release?: string;
  sourceCardId: string;
  finish: string;
  printRunMarker: string;
  microVariant?: string;
  psaSpecId: number;
  popSourceUrl: string;
  fetchedAt: string;
  populationRaw: string;
  html: string;
}

interface SalesFile {
  release?: string;
  sourceCardId: string;
  finish: string;
  printRunMarker: string;
  microVariant?: string;
  salesSpecId: number;
  salesSourceUrl: string;
  fetchedAt: string;
  grade: string;
  cutoffIso: string | null;
  totalCount: number;
  pagesFetched: number;
  coverageComplete: boolean;
  coverageEvidence?: string;
}

function entityKey(e: { sourceCardId: string; finish: string; printRunMarker: string; microVariant?: string }): string {
  return `${e.sourceCardId}|${e.finish}|${e.printRunMarker}|${e.microVariant ?? ''}`;
}

function hasObservationHash(db: DatabaseSync, id: string, hash: string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM observations WHERE work_item_id=? AND hash=? LIMIT 1`).get(id, hash));
}

function insertAttemptAndObservation(
  db: DatabaseSync,
  args: {
    workItemId: string;
    runId: string;
    fetchedAt: string;
    requestUrl: string;
    entityType: string;
    scopeKey: string;
    hash: string;
    byteSize: number;
    isNewObject: boolean;
  },
): void {
  const attempt = db
    .prepare(
      `INSERT INTO attempts (work_item_id, run_id, started_at, finished_at, outcome, http_status,
         request_method, request_url, byte_size, content_hash, source_identity)
       VALUES (?, ?, ?, ?, 'success', 200, 'GET', ?, ?, ?, 'psa:backfill-import')
       RETURNING attempt_id`,
    )
    .get(args.workItemId, args.runId, args.fetchedAt, args.fetchedAt, args.requestUrl, args.byteSize, args.hash) as {
    attempt_id: number;
  };
  db.prepare(
    `INSERT INTO observations (attempt_id, work_item_id, hash, observed_at, entity_type, scope_key, is_first_observation_of_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(attempt.attempt_id, args.workItemId, args.hash, args.fetchedAt, args.entityType, args.scopeKey, args.isNewObject ? 1 : 0);
}

export async function importPopulationFile(db: DatabaseSync, filePath: string, runId: string): Promise<'imported' | 'skipped'> {
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8')) as PopulationFile;
  const specId = String(data.psaSpecId);
  const popScopeKey = populationScopeKey(specId);
  const htmlScopeKey = cardFactsHtmlScopeKey(specId);
  const popWorkItemId = workItemId('psa', 'psa_population', popScopeKey);
  const popWritten = await writeObject(db, {
    source: 'psa',
    mediaKind: 'json',
    mediaType: 'application/json',
    ext: 'json',
    body: Buffer.from(data.populationRaw, 'utf8'),
  });
  const htmlWritten = await writeObject(db, {
    source: 'psa',
    mediaKind: 'html',
    mediaType: 'text/html',
    ext: 'html',
    body: Buffer.from(data.html, 'utf8'),
  });
  const htmlWorkItemId = workItemId('psa', 'psa_cardfacts_html', htmlScopeKey);
  const popChanged = !hasObservationHash(db, popWorkItemId, popWritten.hash);
  const htmlChanged = !hasObservationHash(db, htmlWorkItemId, htmlWritten.hash);
  if (!popChanged && !htmlChanged) return 'skipped';

  withTransaction(db, () => {
    enqueueWorkItem(db, {
      source: 'psa',
      queue: 'psa_population',
      entityType: 'population',
      scopeKey: popScopeKey,
      params: { psaSpecId: data.psaSpecId, sourceCardId: data.sourceCardId, finish: data.finish, printRunMarker: data.printRunMarker, microVariant: data.microVariant },
    });
    enqueueWorkItem(db, {
      source: 'psa',
      queue: 'psa_cardfacts_html',
      entityType: 'cardfacts_html',
      scopeKey: htmlScopeKey,
      params: { psaSpecId: data.psaSpecId, sourceUrl: data.popSourceUrl },
    });

    if (popChanged) insertAttemptAndObservation(db, {
      workItemId: popWorkItemId,
      runId,
      fetchedAt: data.fetchedAt,
      requestUrl: `https://www.psacard.com/CardFacts/GetChartPopulation/${specId}`,
      entityType: 'population',
      scopeKey: popScopeKey,
      hash: popWritten.hash,
      byteSize: popWritten.byteSize,
      isNewObject: popWritten.isNew,
    });
    if (popChanged) markSucceeded(db, popWorkItemId);

    if (htmlChanged) insertAttemptAndObservation(db, {
      workItemId: htmlWorkItemId,
      runId,
      fetchedAt: data.fetchedAt,
      requestUrl: data.popSourceUrl,
      entityType: 'cardfacts_html',
      scopeKey: htmlScopeKey,
      hash: htmlWritten.hash,
      byteSize: htmlWritten.byteSize,
      isNewObject: htmlWritten.isNew,
    });
    if (htmlChanged) markSucceeded(db, htmlWorkItemId);

    db.prepare(
      `INSERT OR IGNORE INTO psa_identity_map (namespace, source_id, entity_key, discovered_at) VALUES ('population', ?, ?, ?)`,
    ).run(specId, entityKey(data), data.fetchedAt);

    const changed = Number(popChanged) + Number(htmlChanged);
    bumpCounter(db, runId, 'requests_total', changed);
    bumpCounter(db, runId, 'requests_success', changed);
    bumpCounter(db, runId, 'bytes_total', (popChanged ? popWritten.byteSize : 0) + (htmlChanged ? htmlWritten.byteSize : 0));
  });
  return 'imported';
}

export async function importSalesFile(db: DatabaseSync, filePath: string, runId: string): Promise<'imported' | 'skipped'> {
  const raw = fs.readFileSync(filePath);
  const data = JSON.parse(raw.toString('utf8')) as SalesFile;
  const specId = String(data.salesSpecId);
  const scopeKey = salesSnapshotScopeKey(specId);
  const salesWorkItemId = workItemId('psa', 'psa_sales', scopeKey);
  const written = await writeObject(db, { source: 'psa', mediaKind: 'json', mediaType: 'application/json', ext: 'json', body: raw });
  if (hasObservationHash(db, salesWorkItemId, written.hash)) return 'skipped';

  withTransaction(db, () => {
    enqueueWorkItem(db, {
      source: 'psa',
      queue: 'psa_sales',
      entityType: 'sales_snapshot',
      scopeKey,
      params: { salesSpecId: data.salesSpecId, sourceCardId: data.sourceCardId, finish: data.finish, printRunMarker: data.printRunMarker, microVariant: data.microVariant, grade: data.grade, cutoffIso: data.cutoffIso },
    });

    insertAttemptAndObservation(db, {
      workItemId: salesWorkItemId,
      runId,
      fetchedAt: data.fetchedAt,
      requestUrl: data.salesSourceUrl,
      entityType: 'sales_snapshot',
      scopeKey,
      hash: written.hash,
      byteSize: written.byteSize,
      isNewObject: written.isNew,
    });
    markSucceeded(db, salesWorkItemId);

    db.prepare(
      `INSERT OR IGNORE INTO psa_identity_map (namespace, source_id, entity_key, discovered_at) VALUES ('sales', ?, ?, ?)`,
    ).run(specId, entityKey(data), data.fetchedAt);

    db.prepare(
      `INSERT OR IGNORE INTO coverage (coverage_id, source, entity_type, scope_key, status, last_page_completed, exhaustion_evidence, updated_at)
       VALUES (?, 'psa', 'sales_snapshot', ?, ?, ?, ?, ?)`,
    ).run(
      scopeKey,
      scopeKey,
      data.coverageComplete ? 'complete' : 'cutoff',
      data.pagesFetched,
      data.coverageEvidence ?? (data.coverageComplete ? (data.cutoffIso==null?'source_exhausted':'user_cutoff') : 'page_cap_reached'),
      data.fetchedAt,
    );

    bumpCounter(db, runId, 'requests_total');
    bumpCounter(db, runId, 'requests_success');
    bumpCounter(db, runId, 'bytes_total', written.byteSize);
  });
  return 'imported';
}

/** Cross-references the two separate PSA ID namespaces via matching (sourceCardId, finish, printRunMarker, microVariant). */
export function linkPopulationToSales(db: DatabaseSync): number {
  const explicit: Array<{ populationId: string; salesId: string }> = [];
  for (const baseDir of SCAN_DIRS) {
    if (!fs.existsSync(baseDir)) continue;
    for (const release of fs.readdirSync(baseDir, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
      const dir = path.join(baseDir, release.name, 'population');
      if (!fs.existsSync(dir)) continue;
      for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.json'))) {
        const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as PopulationFile & { salesSpecId?: number | null };
        if (data.salesSpecId != null) explicit.push({ populationId: String(data.psaSpecId), salesId: String(data.salesSpecId) });
      }
    }
  }
  let linked = 0;
  const now = new Date().toISOString();
  for (const pair of explicit) {
    const exists = db
      .prepare(`SELECT 1 FROM relationships WHERE from_type = 'psa_population_spec' AND from_key = ? AND to_type = 'psa_sales_spec' AND to_key = ?`)
      .get(pair.populationId, pair.salesId);
    if (exists) continue;
    db.prepare(
      `INSERT INTO relationships (from_type, from_key, to_type, to_key, relationship_type, confidence, source_of_truth, created_at)
       VALUES ('psa_population_spec', ?, 'psa_sales_spec', ?, 'psa_population_sales_link', 1.0, 'clean_rewrite_selection_snapshot', ?)`,
    ).run(pair.populationId, pair.salesId, now);
    linked++;
  }
  return linked;
}

async function main(): Promise<void> {
  const db = openCliDb();
  const runId = createRun(db, 'psa-backfill-import', { scanDirs: SCAN_DIRS }, true);

  let popImported = 0, popSkipped = 0, salesImported = 0, salesSkipped = 0;
  try {
    for (const baseDir of SCAN_DIRS) {
      if (!fs.existsSync(baseDir)) continue;
      const releases = fs.readdirSync(baseDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
      for (const release of releases) {
        const popDir = path.join(baseDir, release, 'population');
        if (fs.existsSync(popDir)) {
          for (const f of fs.readdirSync(popDir).filter((f) => f.endsWith('.json'))) {
            const result = await importPopulationFile(db, path.join(popDir, f), runId);
            if (result === 'imported') popImported++; else popSkipped++;
          }
        }
        const salesDir = path.join(baseDir, release, 'sales');
        if (fs.existsSync(salesDir)) {
          for (const f of fs.readdirSync(salesDir).filter((f) => f.endsWith('.json'))) {
            const result = await importSalesFile(db, path.join(salesDir, f), runId);
            if (result === 'imported') salesImported++; else salesSkipped++;
          }
        }
      }
    }

    const linked = linkPopulationToSales(db);
    finishRun(db, runId, 'completed');
    console.log(
      `Imported: population ${popImported} (skipped ${popSkipped}), sales ${salesImported} (skipped ${salesSkipped}), ` +
        `${linked} new population<->sales relationship(s) linked.`,
    );
  } catch (err) {
    finishRun(db, runId, 'failed');
    throw err;
  } finally {
    db.close();
  }
}

// Importable: `psa-fetch-matched` reuses importPopulationFile/importSalesFile
// to import just the files it fetched, so main() must not fire on import.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
