import { parseArgs } from 'node:util';
import { openCliDb } from '../context.ts';
import { cancelByScopePrefix } from '../../core/queue/scheduler.ts';

export async function cancelCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { scope: { type: 'string' } } });

  if (!values.scope) {
    console.error('Usage: cancel --scope <key-prefix>');
    process.exitCode = 1;
    return;
  }

  const db = openCliDb();
  const n = cancelByScopePrefix(db, values.scope as string);
  db.close();
  console.log(`Cancelled ${n} work item(s) matching scope prefix "${values.scope as string}".`);
}
