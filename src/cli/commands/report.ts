import { parseArgs } from 'node:util';
import { openCliDb } from '../context.ts';
import { getCounters } from '../../core/progress/metrics.ts';

interface RunRow {
  run_id: string;
  status: string;
  created_at: string;
  started_at: string;
  ended_at: string | null;
  cli_command: string;
  config_json: string;
}

export async function reportCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { json: { type: 'boolean', default: false }, run: { type: 'string' } },
  });

  const db = openCliDb();
  const run = (
    values.run
      ? db.prepare('SELECT * FROM runs WHERE run_id = ?').get(values.run as string)
      : db.prepare('SELECT * FROM runs ORDER BY created_at DESC LIMIT 1').get()
  ) as RunRow | undefined;

  if (!run) {
    console.log('No runs yet.');
    db.close();
    return;
  }

  const counters = getCounters(db, run.run_id);
  const config=JSON.parse((run as RunRow).config_json) as {source?:string;stage?:string};
  const stateCounts = (config.source
    ? db.prepare('SELECT state, COUNT(*) as n FROM work_items WHERE source=? GROUP BY state').all(config.source)
    : db.prepare('SELECT state, COUNT(*) as n FROM work_items GROUP BY state').all()) as unknown as {
    state: string;
    n: number;
  }[];
  const workItemStates = Object.fromEntries(stateCounts.map((s) => [s.state, s.n]));
  const recentEvents = db
    .prepare('SELECT ts, level, category, message FROM events WHERE run_id = ? ORDER BY event_id DESC LIMIT 20')
    .all(run.run_id);

  db.close();

  if (values.json) {
    console.log(JSON.stringify({ run, counters, workItemStates, recentEvents }, null, 2));
    return;
  }

  console.log(`Run ${run.run_id} (${run.status})`);
  console.log(`  command: ${run.cli_command}`);
  console.log(`  started: ${run.started_at}${run.ended_at ? `  ended: ${run.ended_at}` : ''}`);
  console.log('Counters:');
  for (const [k, v] of Object.entries(counters)) console.log(`  ${k}: ${v}`);
  console.log('Work item states:');
  for (const [k, v] of Object.entries(workItemStates)) console.log(`  ${k}: ${v}`);
}
