import { runCommand } from './commands/run.ts';
import { resumeCommand } from './commands/resume.ts';
import { statusCommand } from './commands/status.ts';
import { failuresCommand } from './commands/failures.ts';
import { retryFailedCommand } from './commands/retry-failed.ts';
import { refreshCommand } from './commands/refresh.ts';
import { cancelCommand } from './commands/cancel.ts';
import { verifyCommand } from './commands/verify.ts';
import { reportCommand } from './commands/report.ts';
import { psaLoginCommand } from './commands/psa-login.ts';
import { materializeCommand } from './commands/materialize.ts';
import { psaCoverageCommand } from './commands/psa-coverage.ts';

const COMMANDS: Record<string, (args: string[]) => Promise<void>> = {
  run: runCommand,
  resume: resumeCommand,
  status: statusCommand,
  failures: failuresCommand,
  'retry-failed': retryFailedCommand,
  refresh: refreshCommand,
  cancel: cancelCommand,
  verify: verifyCommand,
  report: reportCommand,
  'psa-login': psaLoginCommand,
  materialize: materializeCommand,
  'psa-coverage': psaCoverageCommand,
};

const [, , command, ...rest] = process.argv;

if (!command || !(command in COMMANDS)) {
  console.error(`Usage: node src/cli/index.ts <${Object.keys(COMMANDS).join('|')}> [options]`);
  process.exit(1);
}

await COMMANDS[command]!(rest);
