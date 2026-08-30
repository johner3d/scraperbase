import { parseArgs } from 'node:util';
import { openCliDb } from '../context.ts';
import { DATA_DIR } from '../../core/config/config.ts';
import { createRun, finishRun } from '../../core/queue/run.ts';
import { logEvent } from '../../core/events/eventLog.ts';
import { materialize } from '../../curated/materialize.ts';

export async function materializeCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      'psa-dir': { type: 'string' },
      'no-tcgdex': { type: 'boolean', default: false },
      'no-psa': { type: 'boolean', default: false },
      'no-ebay': { type: 'boolean', default: false },
      'no-ecb': { type: 'boolean', default: false },
      source: { type: 'string', default: 'all' },
    },
  });

  const psaDir = values['psa-dir'] as string | undefined;
  const source = String(values.source);
  if (!['tcgdex', 'psa', 'ebay', 'ecb', 'all'].includes(source)) throw new Error(`Invalid --source ${source}`);
  const includeTcgdex = !values['no-tcgdex'] && (source === 'all' || source === 'tcgdex');
  const includePsa = !values['no-psa'] && (source === 'all' || source === 'psa');
  const includeEbay = !values['no-ebay'] && (source === 'all' || source === 'ebay');
  const includeEcb = !values['no-ecb'] && (source === 'all' || source === 'ecb');
  const db = openCliDb();
  const runId = createRun(db, 'materialize', {
    psaDir: psaDir ?? `${DATA_DIR}/psa-raw`,
    includeTcgdex,
    includePsa,
    includeEbay,
    includeEcb,
  }, true);
  logEvent(db, { runId, level: 'info', category: 'materialization', message: 'Curated materialization started' });

  try {
    const result = await materialize(db, {
      psaDir,
      includeTcgdex,
      includePsa,
      includeEbay,
      includeEcb,
    });
    finishRun(db, runId, 'completed');
    console.log(JSON.stringify({ runId, ...result }, null, 2));
  } catch (error) {
    finishRun(db, runId, 'failed');
    logEvent(db, {
      runId,
      level: 'error',
      category: 'materialization',
      message: `Curated materialization failed: ${error instanceof Error ? error.message : String(error)}`,
    });
    throw error;
  } finally {
    db.close();
  }
}
