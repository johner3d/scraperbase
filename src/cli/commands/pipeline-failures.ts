import { parseArgs } from 'node:util';
import { openCliDb } from '../context.ts';
import { listDeadLetters, resolveDeadLetter, retryDeadLetters } from '../../pipeline/deadLetters.ts';

function out(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

/** `pipeline failures [--stage s] [--json]` -- dead-letters + retryable_failed work items. */
export async function pipelineFailuresCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: {
    stage: { type: 'string' }, json: { type: 'boolean', default: false }, all: { type: 'boolean', default: false },
  } });
  const db = openCliDb();
  try {
    const deadLetters = listDeadLetters(db, { stage: values.stage as string | undefined, includeResolved: Boolean(values.all) });
    const retryable = db.prepare(
      `SELECT source, queue, scope_key, attempts, max_attempts, last_error, updated_at
       FROM work_items WHERE state='retryable_failed' ${values.stage ? 'AND queue IN (SELECT value FROM json_each(?))' : ''}
       ORDER BY updated_at DESC LIMIT 100`,
    ).all(...(values.stage ? [JSON.stringify(queuesForStage(values.stage as string))] : [])) as unknown[];
    if (values.json) { out({ deadLetters, retryable }); return; }
    if (!deadLetters.length && !retryable.length) { console.log('No failures.'); return; }
    if (deadLetters.length) {
      console.log(`Dead-letters (${deadLetters.length}) -- cleared by: pipeline retry --stage <s> [--scope <prefix>]`);
      for (const d of deadLetters) {
        console.log(`  [${d.stage}] ${d.scope_key}${d.resolved_at ? ' (resolved)' : ''}\n      ${d.reason}  · last seen ${d.last_seen_at}`);
      }
    }
    if (retryable.length) {
      console.log(`\nRetryable-failed work items (${retryable.length}, will retry on their own after backoff):`);
      for (const r of retryable as Array<Record<string, unknown>>) {
        console.log(`  [${r.queue}] ${r.scope_key}  attempt ${r.attempts}/${r.max_attempts}  ${r.last_error ?? ''}`);
      }
    }
  } finally {
    db.close();
  }
}

/** `pipeline retry [--stage s] [--scope prefix] [--all]` -- re-pend failed work behind dead-letters. */
export async function pipelineRetryCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: {
    stage: { type: 'string' }, scope: { type: 'string' }, all: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
  } });
  if (!values.stage && !values.all) throw new Error('Pass --stage <name> or --all');
  const db = openCliDb();
  try {
    const result = retryDeadLetters(db, {
      stage: values.stage as string | undefined,
      scopePrefix: values.scope as string | undefined,
      all: Boolean(values.all),
    });
    if (values.json) out(result);
    else console.log(`Re-pended ${result.reset} work item(s); cleared ${result.cleared} dead-letter row(s).`);
  } finally {
    db.close();
  }
}

/** `pipeline dead-letter resolve --stage s --scope key` -- mark won't-fix without retrying. */
export async function pipelineDeadLetterCommand(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  if (subcommand !== 'resolve') throw new Error('Usage: pipeline dead-letter resolve --stage <s> --scope <key>');
  const { values } = parseArgs({ args: rest, options: { stage: { type: 'string' }, scope: { type: 'string' } } });
  if (!values.stage || !values.scope) throw new Error('--stage and --scope are both required');
  const db = openCliDb();
  try {
    const n = resolveDeadLetter(db, values.stage as string, values.scope as string);
    console.log(n ? `Resolved dead-letter ${values.stage}/${values.scope}.` : 'No matching open dead-letter.');
  } finally {
    db.close();
  }
}

function queuesForStage(stage: string): string[] {
  return ({
    ingest: ['ebay_search', 'ebay_item_detail'],
    psa: ['psa_cert', 'psa_pop_discovery', 'psa_pop_set_items', 'psa_enrichment_population', 'psa_enrichment_sales'],
    'psa-cert': ['psa_cert'],
    'psa-identity': ['psa_pop_discovery', 'psa_pop_set_items'],
    'psa-fetch': ['psa_enrichment_population', 'psa_enrichment_sales'],
  } as Record<string, string[]>)[stage] ?? [];
}
