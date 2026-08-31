import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { openCliDb } from '../context.ts';
import { retryOnBusy } from '../../core/db/client.ts';
import { runOneTick, runSupervisor, requestSupervisorStop, STOP_FILE } from '../../pipeline/supervisor.ts';
import { supervisorStatus } from '../../pipeline/supervisorStatus.ts';
import { assembleGeneration, publishGeneration, validateGeneration } from '../../pipeline/publication.ts';
import { syncPipelineGaps } from '../../pipeline/quality.ts';
import { ensureSupervisorPipelineRun, clearPublishDirty, getSupervisorState } from '../../pipeline/supervisorState.ts';
import { resetPipelineToLiveAuctions } from '../../pipeline/reset.ts';
import { assertSupervisorStage, requestStageRun, setStageAuto } from '../../pipeline/stageControl.ts';
import { SUPERVISOR_STAGES, type SupervisorStage } from '../../pipeline/stages/types.ts';
import { materialize } from '../../curated/materialize.ts';

function parseStages(value: string | undefined): SupervisorStage[] | undefined {
  if (!value) return undefined;
  const wanted = value.split(',').map((s) => s.trim()).filter(Boolean);
  const bad = wanted.filter((s) => !(SUPERVISOR_STAGES as readonly string[]).includes(s));
  if (bad.length) throw new Error(`Unknown stage(s): ${bad.join(', ')}. Known: ${SUPERVISOR_STAGES.join(', ')}`);
  return wanted as SupervisorStage[];
}

/** `pipeline start [--stages a,b] [--retry-failed]` -- the long-running daemon. */
export async function pipelineStartCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: {
    stages: { type: 'string' }, 'retry-failed': { type: 'boolean', default: false },
    'loop-floor-ms': { type: 'string' },
  } });
  await runSupervisor(null, {
    stages: parseStages(values.stages as string | undefined),
    retryFailed: Boolean(values['retry-failed']),
    loopFloorMs: values['loop-floor-ms'] ? Number(values['loop-floor-ms']) : undefined,
  });
}

/**
 * `pipeline reset [--marketplace de] [--query "pikachu psa 10"] [--refresh 30] [--dry-run] [--yes]`
 * -- narrow the pipeline to the live-auction view: disable non-auction terms,
 * keep one auction term, drop the PSA target manifest, cancel outstanding
 * discovery/enrichment work, clear dead-letters. Raw data and the published
 * site are untouched.
 */
export async function pipelineResetCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: {
    marketplace: { type: 'string', default: 'de' },
    query: { type: 'string', default: 'pikachu psa 10' },
    refresh: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    yes: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
  } });
  const dryRun = Boolean(values['dry-run']);
  const db = openCliDb();
  try {
    if (getSupervisorState(db).run_id || existsSync(STOP_FILE)) {
      throw new Error('The supervisor looks like it is running. Run `pipeline stop` and wait for it to exit first.');
    }
    if (!dryRun && !values.yes) {
      const preview = resetPipelineToLiveAuctions(db, {
        marketplace: String(values.marketplace), query: String(values.query),
        refreshIntervalMinutes: values.refresh ? Number(values.refresh) : undefined, dryRun: true,
      });
      console.log(JSON.stringify(preview, null, 2));
      console.log('\nThis will apply the changes above. Re-run with --yes to proceed (or --dry-run to keep inspecting).');
      return;
    }
    const summary = resetPipelineToLiveAuctions(db, {
      marketplace: String(values.marketplace), query: String(values.query),
      refreshIntervalMinutes: values.refresh ? Number(values.refresh) : undefined, dryRun,
    });
    console.log(JSON.stringify(summary, null, 2));
    if (!dryRun) console.log('\nDone. Start the narrowed pipeline with: pipeline start');
  } finally {
    db.close();
  }
}

/** `pipeline stop` -- writes the stop file; the daemon drains and exits. */
export async function pipelineStopCommand(): Promise<void> {
  requestSupervisorStop();
  console.log('Stop requested. The supervisor will drain in-flight work and exit.');
}

/** `pipeline tick [all|<stage>]` -- one bounded pass, then exit. */
export async function pipelineTickCommand(args: string[]): Promise<void> {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: { json: { type: 'boolean', default: false } } });
  const target = positionals[0] ?? 'all';
  if (target !== 'all' && !(SUPERVISOR_STAGES as readonly string[]).includes(target)) {
    throw new Error(`Usage: pipeline tick [all|${SUPERVISOR_STAGES.join('|')}]`);
  }
  await runOneTick(target as SupervisorStage | 'all');
  const db = openCliDb();
  try { console.log(JSON.stringify(supervisorStatus(db).stages, null, 2)); } finally { db.close(); }
}

/**
 * `pipeline stage <list | enable <s> | disable <s> | run <s> [--drain]>`
 * -- park a stage off the supervisor's auto loop, or poke it on demand, without
 * restarting the daemon.
 */
export async function pipelineStageCommand(args: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args, allowPositionals: true,
    options: { drain: { type: 'boolean', default: false }, json: { type: 'boolean', default: false } },
  });
  const [sub, stageArg] = positionals;
  const db = openCliDb();
  try {
    if (!sub || sub === 'list') {
      const status = supervisorStatus(db);
      if (values.json) { console.log(JSON.stringify(status.stages, null, 2)); return; }
      console.log(`supervisor: ${status.running ? 'RUNNING' : 'stopped'}\n`);
      console.log('stage         auto    state        note');
      for (const s of status.stages) {
        const auto = s.runRequestedAt ? 'RUN…' : s.autoEnabled ? 'auto' : 'MANUAL';
        console.log(`${s.stage.padEnd(13)} ${auto.padEnd(7)} ${s.state.padEnd(12)} ${s.note ?? ''}`);
      }
      return;
    }
    const onWait = (n: number) => console.log(`  supervisor is mid-transaction, waiting… (${n})`);
    if (sub === 'enable' || sub === 'disable') {
      const stage = assertSupervisorStage(stageArg ?? '');
      retryOnBusy(() => setStageAuto(db, stage, sub === 'enable'), { onWait });
      console.log(`${sub}d auto-run for stage '${stage}'.`);
      return;
    }
    if (sub === 'run') {
      const stage = assertSupervisorStage(stageArg ?? '');
      retryOnBusy(() => requestStageRun(db, stage, Boolean(values.drain)), { onWait });
      const status = supervisorStatus(db);
      const inActiveSet = status.activeStages == null || status.activeStages.includes(stage);
      console.log(`Requested a${values.drain ? ' drain' : ' one-shot'} run of stage '${stage}'.`);
      if (status.running && inActiveSet) {
        console.log("The running supervisor will run it once the loop next reaches this stage (after any in-progress stage tick finishes).");
      } else if (status.running && !inActiveSet) {
        console.log(`WARNING: the supervisor was started with --stages that excludes '${stage}', so it will not run. Restart with '${stage}' included.`);
      } else {
        console.log(`The supervisor is not running. Start it (\`pipeline start\`) or run one pass now: \`pipeline tick ${stage}\`.`);
      }
      return;
    }
    throw new Error('Usage: pipeline stage <list | enable <stage> | disable <stage> | run <stage> [--drain]>');
  } finally {
    db.close();
  }
}

function fmtAgo(iso: string | null): string {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
}

/** `pipeline status [--watch] [--json]`. */
export async function pipelineStatusCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: {
    run: { type: 'string' }, watch: { type: 'boolean', default: false }, json: { type: 'boolean', default: false },
  } });
  if (values.run) {
    // Delegate to the legacy per-run report.
    const { stageReport } = await import('../../pipeline/store.ts');
    const db = openCliDb();
    try { console.log(JSON.stringify(stageReport(db, values.run as string), null, 2)); } finally { db.close(); }
    return;
  }
  const render = (): void => {
    const db = openCliDb();
    try {
      const status = supervisorStatus(db);
      if (values.json) { console.log(JSON.stringify(status, null, 2)); return; }
      if (values.watch) process.stdout.write('\x1b[2J\x1b[H');
      console.log(`supervisor: ${status.running ? 'RUNNING' : 'stopped'}${status.runId ? ` (${status.runId})` : ''}  ·  publish ${status.publishDirty ? 'dirty' : 'clean'} (last ${fmtAgo(status.lastPublishAt)})`);
      console.log(`eBay quota: ${status.quota.used}/${status.quota.limit} used  ·  resets ${status.quota.resumeAfter}`);
      console.log('\nstage         auto    state        queue  inflight  done   dead  thru/min  last activity   note');
      for (const s of status.stages) {
        const auto = s.runRequestedAt ? 'RUN…' : s.autoEnabled ? 'auto' : 'MANUAL';
        console.log(
          `${s.stage.padEnd(13)} ${auto.padEnd(7)} ${s.state.padEnd(12)} ${String(s.queueDepth).padStart(5)} ${String(s.inFlight).padStart(9)} ${String(s.doneTotal).padStart(6)} ${String(s.deadLetterOpen).padStart(5)} ${String(s.throughputPerMin).padStart(9)}  ${fmtAgo(s.lastActivityAt).padEnd(14)} ${s.note ?? ''}`,
        );
      }
      const parked = status.stages.filter((s) => !s.autoEnabled).map((s) => s.stage);
      if (parked.length) console.log(`\nparked (manual only): ${parked.join(', ')}  --  poke with: pipeline stage run <stage> [--drain]`);
      if (status.activePauses.length) {
        console.log('\nPAUSED:');
        for (const p of status.activePauses) console.log(`  [${p.stage}] ${p.reason}`);
      }
      if (status.terms.length) {
        console.log('\nsearch term funnels (found -> detailed -> matched -> psa-live -> pop/guide/sales):');
        for (const t of status.terms) {
          const f = t.funnel;
          console.log(`  ${t.enabled ? 'on ' : 'off'} "${t.query}" ${t.marketplace}/${t.buyingOption}: ${f.found} -> ${f.detailed} -> ${f.matched} -> ${f.psaTargetedLive} -> ${f.population}/${f.guide}/${f.sales}`);
        }
      }
      if (status.deadLetters.length) {
        console.log(`\ndead-letters (${status.deadLetters.length}) -- clear with: pipeline retry --stage <s>`);
        for (const d of status.deadLetters.slice(0, 20)) console.log(`  [${d.stage}] ${d.scopeKey}  ${d.reason}`);
      }
    } finally {
      db.close();
    }
  };
  render();
  if (values.watch) {
    // eslint-disable-next-line no-constant-condition
    while (true) { await new Promise((r) => setTimeout(r, 2000)); render(); }
  }
}

/** `pipeline publish --now` -- force one incremental materialize + publish. */
export async function pipelinePublishCommand(args: string[]): Promise<void> {
  parseArgs({ args, options: { now: { type: 'boolean', default: false } } });
  const db = openCliDb();
  try {
    const pipelineRunId = ensureSupervisorPipelineRun(db);
    const at = new Date().toISOString();
    await materialize(db, { includeTcgdex: false, includePsa: true, includeEbay: true, includeEcb: true, now: at, pipelineRunId });
    syncPipelineGaps(db, pipelineRunId);
    await assembleGeneration(db, pipelineRunId);
    const manifest = validateGeneration(db, pipelineRunId, { completeness: 'partial', incompleteReason: 'Manual publish.' });
    publishGeneration(db, pipelineRunId);
    clearPublishDirty(db, new Date().toISOString());
    console.log(`Published generation ${manifest.generationId}: ${manifest.counts.ebayListings} listings, ${manifest.counts.psaSpecs} PSA specs.`);
  } finally {
    db.close();
  }
}
