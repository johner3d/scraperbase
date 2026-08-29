import { parseArgs } from 'node:util';
import { openCliDb } from '../context.ts';
import { getCounters } from '../../core/progress/metrics.ts';

interface RunRow {
  run_id: string;
  status: string;
  started_at: string;
  ended_at: string | null;
  config_json: string;
}

export async function statusCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      watch: { type: 'boolean', default: false },
      run: { type: 'string' },
    },
  });

  const db = openCliDb();

  const render = (): void => {
    const run = (
      values.run
        ? db.prepare('SELECT run_id, status, started_at, ended_at, config_json FROM runs WHERE run_id = ?').get(values.run as string)
        : db.prepare('SELECT run_id, status, started_at, ended_at, config_json FROM runs ORDER BY created_at DESC LIMIT 1').get()
    ) as RunRow | undefined;

    if (values.watch) console.clear();

    if (!run) {
      console.log('No runs yet.');
      return;
    }

    const counters = getCounters(db, run.run_id);
    const config=JSON.parse(run.config_json) as {source?:string;stage?:string};
    const stateCounts = (config.source
      ? db.prepare('SELECT state, COUNT(*) as n FROM work_items WHERE source=? GROUP BY state').all(config.source)
      : db.prepare('SELECT state, COUNT(*) as n FROM work_items GROUP BY state').all()) as unknown as {
      state: string;
      n: number;
    }[];

    console.log(
      `Run ${run.run_id}  ${run.status}  started ${run.started_at}${run.ended_at ? `  ended ${run.ended_at}` : ''}`,
    );
    console.log(
      'acquisition  ' +
        (Object.keys(counters).length ? Object.entries(counters).map(([k, v]) => `${k}=${v}`).join('  ') : '(none yet)'),
    );
    console.log(`work items${config.source?` (${config.source}${config.stage?`/${config.stage}`:''})`:''}   ` + stateCounts.map((s) => `${s.state}=${s.n}`).join('  '));
  };

  if (values.watch) {
    render();
    await new Promise<void>((resolve) => {
      const interval = setInterval(render, 1000);
      const stop = () => {
        clearInterval(interval);
        resolve();
      };
      process.once('SIGINT', stop);
    });
  } else {
    render();
  }

  db.close();
}
