import { openDb } from '../core/db/client.ts';
import { DB_PATH } from '../core/config/config.ts';
import { createRun, finishRun } from '../core/queue/run.ts';
import { runQueue } from '../core/queue/runner.ts';
import { createRateLimiter } from '../core/http/rateLimiter.ts';
import {
  POKEWIKI_IMAGE_QUEUE,
  POKEWIKI_FILE_METADATA_QUEUE,
  POKEWIKI_METADATA_QUEUE,
  createPokewikiFileMetadataCollector,
  createPokewikiImageCollector,
  createPokewikiMetadataCollector,
  materializePokewikiImages,
  seedMissingGermanPokewikiImages,
  seedMissingGermanPokewikiFiles,
} from '../sources/pokewiki/images.ts';

const db = openDb(DB_PATH);
const runId = createRun(db, 'pokewiki-image-backfill', { source: 'pokewiki', language: 'de' }, true);
let draining = false;
const stop = (): void => { draining = true };
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

try {
  const seeded = seedMissingGermanPokewikiImages(db);
  console.log(`Seeded ${seeded.cards} missing German cards in ${seeded.batches} PokéWiki metadata batches.`);
  const metadataLimiter = createRateLimiter({ minDelayMs: 250, jitterMs: 50 });
  await runQueue(db, {
    queue: POKEWIKI_METADATA_QUEUE,
    collector: createPokewikiMetadataCollector({ rateLimiter: metadataLimiter }),
    concurrency: 2,
    leaseTtlMs: 300_000,
    runId,
    isDraining: () => draining,
  });
  const discovered = db.prepare(`SELECT COUNT(*) n FROM work_items WHERE source='pokewiki' AND queue=?`).get(POKEWIKI_IMAGE_QUEUE) as { n: number };
  console.log(`Discovered ${discovered.n} exact PokéWiki card images.`);
  const imageLimiter = createRateLimiter({ minDelayMs: 100, jitterMs: 30 });
  await runQueue(db, {
    queue: POKEWIKI_IMAGE_QUEUE,
    collector: createPokewikiImageCollector({ rateLimiter: imageLimiter }),
    concurrency: 6,
    leaseTtlMs: 300_000,
    runId,
    isDraining: () => draining,
  });
  const materializedFromPages = materializePokewikiImages(db);
  const fileSeeded = seedMissingGermanPokewikiFiles(db);
  console.log(`Seeded ${fileSeeded.cards} unresolved cards in ${fileSeeded.batches} exact-file metadata batches.`);
  await runQueue(db, {
    queue: POKEWIKI_FILE_METADATA_QUEUE,
    collector: createPokewikiFileMetadataCollector({ rateLimiter: metadataLimiter }),
    concurrency: 2,
    leaseTtlMs: 300_000,
    runId,
    isDraining: () => draining,
  });
  const fileDiscovered = db.prepare(`SELECT COUNT(*) n FROM work_items WHERE source='pokewiki' AND queue=?`).get(POKEWIKI_IMAGE_QUEUE) as { n: number };
  console.log(`Discovered ${fileDiscovered.n} PokéWiki images after exact-file fallback.`);
  await runQueue(db, {
    queue: POKEWIKI_IMAGE_QUEUE,
    collector: createPokewikiImageCollector({ rateLimiter: imageLimiter }),
    concurrency: 6,
    leaseTtlMs: 300_000,
    runId,
    isDraining: () => draining,
  });
  const materialized = materializePokewikiImages(db);
  const remaining = db.prepare(`SELECT COUNT(*) n FROM cards c JOIN sets s ON s.set_id=c.set_id
    WHERE s.language='de' AND NOT EXISTS(
      SELECT 1 FROM assets a WHERE a.target_type='card' AND a.target_id=c.card_id AND a.object_hash IS NOT NULL)`).get() as { n: number };
  finishRun(db, runId, draining ? 'cancelled' : 'completed');
  console.log(JSON.stringify({ runId, seeded, discoveredFromPages: discovered.n, materializedFromPages,
    fileSeeded, discoveredAfterFileFallback: fileDiscovered.n, materialized, remaining: remaining.n }, null, 2));
} catch (error) {
  finishRun(db, runId, 'failed');
  throw error;
} finally {
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
  db.close();
}
