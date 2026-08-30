import { parseArgs } from 'node:util';
import { openCliDb } from '../context.ts';
import {
  addSearchTerm,
  dueSearchTerms,
  getSearchTerm,
  listSearchTerms,
  parseDurationMinutes,
  parseEndingWithinHours,
  previewSearchTerm,
  removeSearchTerm,
  setSearchTermEnabled,
  updateSearchTerm,
  type BuyingOption,
  type SearchTermInput,
  type SearchTermRow,
} from '../../pipeline/searchTerms.ts';

const TERM_OPTIONS = {
  query: { type: 'string' },
  marketplace: { type: 'string' },
  'marketplaces': { type: 'string' }, // alias, first value wins
  'buying-option': { type: 'string' },
  'min-bids': { type: 'string' },
  'ending-within': { type: 'string' },
  'price-min': { type: 'string' },
  'price-max': { type: 'string' },
  category: { type: 'string' },
  refresh: { type: 'string' },
  'max-items': { type: 'string' },
  'daily-budget': { type: 'string' },
  priority: { type: 'string' },
  disabled: { type: 'boolean', default: false },
  json: { type: 'boolean', default: false },
} as const;

function num(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${label} must be a number`);
  return n;
}

function buyingOption(value: string | undefined): BuyingOption | undefined {
  if (value === undefined) return undefined;
  if (value !== 'auction' && value !== 'fixed' && value !== 'all') {
    throw new Error(`--buying-option must be auction | fixed | all`);
  }
  return value;
}

function patchFromValues(values: Record<string, unknown>): Partial<SearchTermInput> {
  const patch: Partial<SearchTermInput> = {};
  if (values['buying-option'] !== undefined) patch.buyingOption = buyingOption(values['buying-option'] as string);
  if (values['min-bids'] !== undefined) patch.minBids = num(values['min-bids'] as string, '--min-bids');
  if (values['ending-within'] !== undefined) patch.endingWithinHours = parseEndingWithinHours(values['ending-within'] as string);
  if (values['price-min'] !== undefined) patch.priceMin = num(values['price-min'] as string, '--price-min') ?? null;
  if (values['price-max'] !== undefined) patch.priceMax = num(values['price-max'] as string, '--price-max') ?? null;
  if (values.category !== undefined) patch.categoryIds = String(values.category) || null;
  if (values.refresh !== undefined) patch.refreshIntervalMinutes = parseDurationMinutes(values.refresh as string);
  if (values['max-items'] !== undefined) patch.maxItems = num(values['max-items'] as string, '--max-items');
  if (values['daily-budget'] !== undefined) patch.dailyCallBudget = num(values['daily-budget'] as string, '--daily-budget') ?? null;
  if (values.priority !== undefined) patch.priority = num(values.priority as string, '--priority');
  return patch;
}

function render(term: SearchTermRow): Record<string, unknown> {
  return {
    id: term.search_term_id,
    query: term.query_text,
    marketplace: term.marketplace,
    buyingOption: term.buying_option,
    minBids: term.min_bids,
    endingWithinHours: term.ending_within_hours,
    priceBand: [term.price_min, term.price_max],
    categoryIds: term.category_ids,
    refreshMinutes: term.refresh_interval_minutes,
    maxItems: term.max_items,
    dailyCallBudget: term.daily_call_budget,
    priority: term.priority,
    enabled: Boolean(term.enabled),
    lastEnqueuedAt: term.last_enqueued_at,
    lastCompletedAt: term.last_completed_at,
    lastResultCount: term.last_result_count,
  };
}

function out(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

export async function pipelineTermsCommand(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  const db = openCliDb();
  try {
    if (subcommand === 'add') {
      const { values } = parseArgs({ args: rest, options: TERM_OPTIONS });
      const marketplace = String(values.marketplace ?? (values.marketplaces as string | undefined)?.split(',')[0] ?? 'de').trim();
      if (!values.query) throw new Error('--query is required');
      const input: SearchTermInput = {
        query: String(values.query),
        marketplace,
        buyingOption: buyingOption(values['buying-option'] as string),
        minBids: num(values['min-bids'] as string, '--min-bids'),
        endingWithinHours: values['ending-within'] !== undefined
          ? parseEndingWithinHours(values['ending-within'] as string) : undefined,
        priceMin: num(values['price-min'] as string, '--price-min') ?? null,
        priceMax: num(values['price-max'] as string, '--price-max') ?? null,
        categoryIds: values.category !== undefined ? String(values.category) : null,
        refreshIntervalMinutes: values.refresh !== undefined ? parseDurationMinutes(values.refresh as string) : undefined,
        maxItems: num(values['max-items'] as string, '--max-items'),
        dailyCallBudget: num(values['daily-budget'] as string, '--daily-budget') ?? null,
        priority: num(values.priority as string, '--priority'),
        enabled: !values.disabled,
      };
      const term = addSearchTerm(db, input);
      if (values.json) out(render(term)); else console.log(`Added search term ${term.search_term_id}: ${term.query_text} (${term.marketplace}, ${term.buying_option})`);
      return;
    }

    if (subcommand === 'list') {
      const { values } = parseArgs({ args: rest, options: { json: { type: 'boolean', default: false } } });
      const terms = listSearchTerms(db).map(render);
      if (values.json) { out(terms); return; }
      if (!terms.length) { console.log('No search terms. Add one with: pipeline terms add --query "..." --marketplace de'); return; }
      for (const t of terms) {
        console.log(`[${t.enabled ? 'on ' : 'off'}] #${t.id} "${t.query}" ${t.marketplace}/${t.buyingOption} `
          + `min-bids=${t.minBids} ending<=${t.endingWithinHours ?? '-'}h price=${(t.priceBand as unknown[]).join('..')} `
          + `refresh=${t.refreshMinutes}m max=${t.maxItems} budget=${t.dailyCallBudget ?? '-'} `
          + `last=${t.lastCompletedAt ?? 'never'} (${t.lastResultCount ?? '?'} results)`);
      }
      return;
    }

    if (subcommand === 'show') {
      const term = getSearchTerm(db, requireTarget(rest));
      out(render(term));
      return;
    }

    if (subcommand === 'set') {
      const target = requireTarget(rest);
      const { values } = parseArgs({ args: rest.slice(1), options: TERM_OPTIONS });
      const term = updateSearchTerm(db, target, patchFromValues(values));
      out(render(term));
      return;
    }

    if (subcommand === 'enable' || subcommand === 'disable') {
      const term = setSearchTermEnabled(db, requireTarget(rest), subcommand === 'enable');
      console.log(`${subcommand}d search term ${term.search_term_id}: ${term.query_text}`);
      return;
    }

    if (subcommand === 'remove') {
      const term = removeSearchTerm(db, requireTarget(rest));
      console.log(`Removed search term ${term.search_term_id}: ${term.query_text}`);
      return;
    }

    if (subcommand === 'due') {
      out(dueSearchTerms(db).map(render));
      return;
    }

    if (subcommand === 'test') {
      const { values, positionals } = parseArgs({ args: rest, options: TERM_OPTIONS, allowPositionals: true });
      let term: SearchTermRow;
      if (positionals.length) {
        term = getSearchTerm(db, positionals[0]!);
      } else {
        // Ephemeral term from flags -- not persisted.
        term = {
          search_term_id: 0,
          query_text: String(values.query ?? ''),
          normalized_query: '',
          marketplace: String(values.marketplace ?? 'de') as SearchTermRow['marketplace'],
          buying_option: (buyingOption(values['buying-option'] as string) ?? 'auction'),
          min_bids: num(values['min-bids'] as string, '--min-bids') ?? 1,
          ending_within_hours: values['ending-within'] !== undefined ? parseEndingWithinHours(values['ending-within'] as string) : 72,
          price_min: num(values['price-min'] as string, '--price-min') ?? null,
          price_max: num(values['price-max'] as string, '--price-max') ?? null,
          category_ids: values.category !== undefined ? String(values.category) : null,
          refresh_interval_minutes: 30,
          max_items: num(values['max-items'] as string, '--max-items') ?? 500,
          daily_call_budget: null,
          priority: 0,
          enabled: 1,
          last_enqueued_at: null,
          last_completed_at: null,
          last_result_count: null,
          created_at: '',
          updated_at: '',
        };
        if (!term.query_text) throw new Error('Pass a term id/query as a positional, or --query with flags');
      }
      const preview = await previewSearchTerm(term);
      out(preview);
      return;
    }

    throw new Error('Usage: pipeline terms <add|list|show|set|enable|disable|remove|due|test>');
  } finally {
    db.close();
  }
}

function requireTarget(rest: string[]): string {
  const target = rest.find((a) => !a.startsWith('-'));
  if (!target) throw new Error('Pass a search-term id or exact query string');
  return target;
}
