import { parseArgs } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { openCliDb } from '../context.ts';
import { createRun, finishRun } from '../../core/queue/run.ts';
import { runQueue } from '../../core/queue/runner.ts';
import { logEvent } from '../../core/events/eventLog.ts';
import { createRateLimiter } from '../../core/http/rateLimiter.ts';
import {
  createSyntheticCollector,
  enqueueSyntheticItems,
  SYNTHETIC_QUEUE,
} from '../../sources/synthetic/echoSource.ts';
import { createTcgdexDiscoveryCollector, seedDiscovery } from '../../sources/tcgdex/discovery.ts';
import { createTcgdexCatalogueCollector } from '../../sources/tcgdex/collectors/catalogue.ts';
import { createTcgdexImageCollector } from '../../sources/tcgdex/collectors/images.ts';
import { DEFAULT_TCGDEX_LANGUAGES } from '../../sources/tcgdex/config.ts';
import { POKEMONCARD_IMAGES_QUEUE, seedPokemonCardDiscovery } from '../../sources/pokemoncard/discovery.ts';
import { createPokemonCardImageCollector } from '../../sources/pokemoncard/collectors/images.ts';
import { linkPokemonCardAssets } from '../../sources/pokemoncard/link.ts';
import { PCGSEARCH_IMAGES_QUEUE, seedPcgSearchDiscovery } from '../../sources/pcgsearch/discovery.ts';
import { createPcgSearchImageCollector } from '../../sources/pcgsearch/collectors/images.ts';
import { linkPcgSearchAssets } from '../../sources/pcgsearch/link.ts';
import { DATA_DIR } from '../../core/config/config.ts';
import { seedEbayLiveAuctionSearch, seedEbaySearch } from '../../sources/ebay/discovery.ts';
import { createEbaySearchCollector } from '../../sources/ebay/collectors/search.ts';
import { createEbayItemDetailCollector } from '../../sources/ebay/collectors/itemDetail.ts';
import {
  DEFAULT_EBAY_ENDING_WITHIN_HOURS,
  DEFAULT_EBAY_LIVE_AUCTION_QUERY,
  DEFAULT_EBAY_MAX_ITEMS,
  DEFAULT_EBAY_MIN_BID_COUNT,
  DEFAULT_EBAY_PAGE_LIMIT,
  DEFAULT_EBAY_QUERY,
  EBAY_MARKETPLACES,
  type EbayMarketplaceKey,
} from '../../sources/ebay/config.ts';
import { printEbayRunSummary } from '../../sources/ebay/summary.ts';
import { launchPsaProfile } from '../../sources/psa/browser/profile.ts';
import { createPsaPopDiscoveryCollector, seedPsaPopDiscovery } from '../../sources/psa/collectors/popDiscovery.ts';
import { createPsaSetItemsCollector } from '../../sources/psa/collectors/setItems.ts';
import { createPsaCertCollector, seedPsaCertLookups } from '../../sources/psa/collectors/cert.ts';
import { seedEcbRates } from '../../sources/ecb/discovery.ts';
import { createEcbRatesCollector } from '../../sources/ecb/collector.ts';
import { ECB_RATES_QUEUE } from '../../sources/ecb/config.ts';
import { materialize } from '../../curated/materialize.ts';

export type AcquisitionStage = 'index' | 'details' | 'images' | 'cert' | 'all';
export type DetailPriority = 'psa' | 'all';

export interface RunCliOptions {
  source: string;
  concurrency: number;
  leaseTtlMs: number;
  syntheticCount: number;
  syntheticDelayMs: number;
  scope?: string;
  lang: string;
  stage: AcquisitionStage;
  priority: DetailPriority;
}

function prioritizePsaCards(db: ReturnType<typeof openCliDb>): number {
  const selectionPath = path.join(DATA_DIR, 'psa-pre2019-en-selection.json');
  if (!fs.existsSync(selectionPath)) return 0;
  const rows = JSON.parse(fs.readFileSync(selectionPath, 'utf8')) as Array<{ sourceCardId?: string }>;
  const update = db.prepare(`UPDATE work_items SET priority=100,updated_at=?
    WHERE source='tcgdex' AND queue='catalogue_json' AND entity_type='card' AND scope_key=?`);
  const now = new Date().toISOString();
  let changed = 0;
  for (const sourceCardId of new Set(rows.map((row) => row.sourceCardId).filter((value): value is string => Boolean(value)))) {
    changed += Number(update.run(now, `en:card:${sourceCardId}`).changes);
  }
  return changed;
}

export async function runCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      source: { type: 'string', default: 'synthetic' },
      concurrency: { type: 'string', default: '5' },
      count: { type: 'string', default: '20' },
      'lease-ttl-ms': { type: 'string', default: '300000' },
      'synthetic-delay-ms': { type: 'string', default: '20' },
      scope: { type: 'string' },
      lang: { type: 'string', default: DEFAULT_TCGDEX_LANGUAGES.join(',') },
      stage: { type: 'string', default: 'index' },
      priority: { type: 'string', default: 'psa' },
      // No static default: which query applies depends on --live-auctions
      // (see below) -- 'pokemon psa 10' there, 'pikachu psa 10' otherwise.
      query: { type: 'string' },
      // DE is the only currently live-verified complete scope. EU needs a
      // separate quota window; international also needs >10k partitioning.
      marketplaces: { type: 'string', default: 'de' },
      'max-items': { type: 'string', default: String(DEFAULT_EBAY_MAX_ITEMS) },
      limit: { type: 'string', default: String(DEFAULT_EBAY_PAGE_LIMIT) },
      'live-auctions': { type: 'boolean', default: false },
      'min-bids': { type: 'string', default: String(DEFAULT_EBAY_MIN_BID_COUNT) },
      'ending-within-hours': { type: 'string', default: String(DEFAULT_EBAY_ENDING_WITHIN_HOURS) },
      // Internal provenance id used by `pipeline run`; harmless for expert commands.
      'campaign-id': { type: 'string' },
      'campaign-search-only': { type: 'boolean', default: false },
    },
  });

  const opts: RunCliOptions = {
    source: values.source as string,
    concurrency: Number(values.concurrency),
    leaseTtlMs: Number(values['lease-ttl-ms']),
    syntheticCount: Number(values.count),
    syntheticDelayMs: Number(values['synthetic-delay-ms']),
    scope: values.scope as string | undefined,
    lang: values.lang as string,
    stage: values.stage as AcquisitionStage,
    priority: values.priority as DetailPriority,
  };
  if (!['index', 'details', 'images', 'cert', 'all'].includes(opts.stage)) throw new Error(`Invalid --stage ${opts.stage}`);
  if (!['psa', 'all'].includes(opts.priority)) throw new Error(`Invalid --priority ${opts.priority}`);

  const db = openCliDb();
  const runId = createRun(db, `run --source ${opts.source}`, opts, true);
  logEvent(db, {
    runId,
    level: 'info',
    category: 'system',
    message: `Run started (source=${opts.source}, concurrency=${opts.concurrency})`,
  });

  let draining = false;
  const onSignal = (signal: string) => {
    if (draining) return;
    draining = true;
    logEvent(db, { runId, level: 'warn', category: 'system', message: `Received ${signal}, draining...` });
    console.error(`\nReceived ${signal} -- finishing in-flight work, then stopping (no new work claimed)...`);
  };
  const sigintHandler = () => onSignal('SIGINT');
  const sigtermHandler = () => onSignal('SIGTERM');
  process.once('SIGINT', sigintHandler);
  process.once('SIGTERM', sigtermHandler);

  try {
    if (opts.source === 'synthetic') {
      const existing = db.prepare(`SELECT COUNT(*) as n FROM work_items WHERE source='synthetic'`).get() as {
        n: number;
      };
      if (existing.n === 0) enqueueSyntheticItems(db, opts.syntheticCount);
      await runQueue(db, {
        queue: SYNTHETIC_QUEUE,
        collector: createSyntheticCollector({ delayMs: opts.syntheticDelayMs }),
        concurrency: opts.concurrency,
        leaseTtlMs: opts.leaseTtlMs,
        runId,
        isDraining: () => draining,
      });
    } else if (opts.source === 'tcgdex') {
      const langs = opts.lang.split(',').map((s) => s.trim()).filter(Boolean);
      const setFilter = opts.scope?.startsWith('set:') ? opts.scope.slice('set:'.length) : undefined;
      const rateLimiter = createRateLimiter({ minDelayMs: 50, jitterMs: 20 });

      if (opts.stage === 'index' || opts.stage === 'all') {
        seedDiscovery(db, langs);
        await runQueue(db, {
          queue: 'tcgdex_discovery', collector: createTcgdexDiscoveryCollector({ rateLimiter, setFilter }),
          concurrency: opts.concurrency, leaseTtlMs: opts.leaseTtlMs, runId, isDraining: () => draining,
        });
        await runQueue(db, {
          queue: 'catalogue_json', collector: createTcgdexCatalogueCollector({ rateLimiter }), entityTypes: ['set'],
          scopeContains: setFilter ? `:set:${setFilter}` : undefined,
          concurrency: opts.concurrency, leaseTtlMs: opts.leaseTtlMs, runId, isDraining: () => draining,
        });
      }
      if (opts.stage === 'details' || opts.stage === 'all') {
        if (opts.priority === 'psa') prioritizePsaCards(db);
        await runQueue(db, {
          queue: 'catalogue_json', collector: createTcgdexCatalogueCollector({ rateLimiter }), entityTypes: ['card'],
          minimumPriority: opts.priority === 'psa' ? 100 : undefined,
          scopeContains: setFilter ? `:card:${setFilter}-` : undefined,
          concurrency: opts.concurrency, leaseTtlMs: opts.leaseTtlMs, runId, isDraining: () => draining,
        });
      }
      if (opts.stage === 'images' || opts.stage === 'all') {
        await runQueue(db, {
          queue: 'images', collector: createTcgdexImageCollector({ rateLimiter }),
          scopeContains: setFilter ? setFilter : undefined,
          concurrency: opts.concurrency, leaseTtlMs: opts.leaseTtlMs, runId, isDraining: () => draining,
        });
      }
    } else if (opts.source === 'pokemoncard') {
      if (opts.stage === 'images' || opts.stage === 'all') {
        const rateLimiter = createRateLimiter({ minDelayMs: 500, jitterMs: 250 });
        seedPokemonCardDiscovery(db);
        await runQueue(db, {
          queue: POKEMONCARD_IMAGES_QUEUE, collector: createPokemonCardImageCollector({ rateLimiter }),
          concurrency: opts.concurrency, leaseTtlMs: opts.leaseTtlMs, runId, isDraining: () => draining,
        });
        const linked = linkPokemonCardAssets(db, new Date().toISOString());
        logEvent(db, { runId, level: 'info', category: 'system', message: `Linked ${linked} pokemon-card.com image(s) to cards` });
      }
    } else if (opts.source === 'pcgsearch') {
      if (opts.stage === 'images' || opts.stage === 'all') {
        const rateLimiter = createRateLimiter({ minDelayMs: 300, jitterMs: 150 });
        seedPcgSearchDiscovery(db);
        await runQueue(db, {
          queue: PCGSEARCH_IMAGES_QUEUE, collector: createPcgSearchImageCollector({ rateLimiter }),
          concurrency: opts.concurrency, leaseTtlMs: opts.leaseTtlMs, runId, isDraining: () => draining,
        });
        const linked = linkPcgSearchAssets(db, new Date().toISOString());
        logEvent(db, { runId, level: 'info', category: 'system', message: `Linked ${linked} PCG Search image(s) to cards` });
      }
    } else if (opts.source === 'ebay') {
      const limit = Number(values.limit);
      const requestedMarketplaces = (values.marketplaces as string)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const invalidMarketplaces = requestedMarketplaces.filter((s) => !(s in EBAY_MARKETPLACES));
      if (invalidMarketplaces.length > 0) throw new Error(`Invalid --marketplaces: ${invalidMarketplaces.join(', ')}`);
      const marketplaces = requestedMarketplaces as EbayMarketplaceKey[];
      if (marketplaces.length === 0) throw new Error('--marketplaces must contain at least one marketplace');
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('--limit must be an integer from 1 to 200');
      const rateLimiter = createRateLimiter({ minDelayMs: 250, jitterMs: 150 });
      const ebayRateLimitSafety = { haltOnRateLimit: true, cooldown: { afterConsecutiveFailures: 3, cooldownMs: 60_000 } };

      if (values['live-auctions']) {
        const query = (values.query as string | undefined) ?? DEFAULT_EBAY_LIVE_AUCTION_QUERY;
        const minBidCount = Number(values['min-bids']);
        const endingWithinHours = Number(values['ending-within-hours']);
        if (!query.trim()) throw new Error('--query must not be empty');
        if (!Number.isInteger(minBidCount) || minBidCount < 0) throw new Error('--min-bids must be a non-negative integer');
        if (!Number.isFinite(endingWithinHours) || endingWithinHours <= 0) throw new Error('--ending-within-hours must be a positive number');

        for (const marketplace of marketplaces) {
          seedEbayLiveAuctionSearch(db, { marketplace, query, limit, minBidCount, endingWithinHours });
          logEvent(db, {
            runId, level: 'info', category: 'system',
            message: `Seeded live-auction search "${query}" for marketplace ${marketplace} (min ${minBidCount} bid(s), ending within ${endingWithinHours}h)`,
          });
          await runQueue(db, {
            queue: 'ebay_search', collector: createEbaySearchCollector({ rateLimiter }),
            scopeContains: `search:${marketplace}:${query}:`,
            concurrency: opts.concurrency, leaseTtlMs: opts.leaseTtlMs, runId, isDraining: () => draining, ...ebayRateLimitSafety,
          });
          await runQueue(db, {
            queue: 'ebay_item_detail', collector: createEbayItemDetailCollector({ rateLimiter }),
            concurrency: opts.concurrency, leaseTtlMs: opts.leaseTtlMs, runId, isDraining: () => draining, ...ebayRateLimitSafety,
          });
        }
      } else {
        const query = (values.query as string | undefined) ?? DEFAULT_EBAY_QUERY;
        const maxItems = Number(values['max-items']);
        if (!query.trim()) throw new Error('--query must not be empty');
        if (!Number.isInteger(maxItems) || maxItems < 0) throw new Error('--max-items must be a non-negative integer (0 means uncapped)');
        if (maxItems > limit && maxItems % limit !== 0) {
          throw new Error('--max-items must be a multiple of --limit when it spans more than one page');
        }

        for (const marketplace of marketplaces) {
          seedEbaySearch(db, { marketplace, query, limit, maxItems, campaignId: values['campaign-id'] as string | undefined,
            refreshDetails:!values['campaign-search-only'] });
          await runQueue(db, {
            queue: 'ebay_search', collector: createEbaySearchCollector({ rateLimiter }),
            scopeContains: `search:${marketplace}:${query}:`,
            concurrency: opts.concurrency, leaseTtlMs: opts.leaseTtlMs, runId, isDraining: () => draining, ...ebayRateLimitSafety,
          });
          await runQueue(db, {
            queue: 'ebay_item_detail', collector: createEbayItemDetailCollector({ rateLimiter }),
            concurrency: opts.concurrency, leaseTtlMs: opts.leaseTtlMs, runId, isDraining: () => draining, ...ebayRateLimitSafety,
          });
        }
      }
      printEbayRunSummary(db, runId);
    } else if (opts.source === 'ecb') {
      seedEcbRates(db);
      await runQueue(db, {
        queue: ECB_RATES_QUEUE, collector: createEcbRatesCollector(createRateLimiter({ minDelayMs: 0, jitterMs: 0 })),
        concurrency: 1, leaseTtlMs: opts.leaseTtlMs, runId, isDraining: () => draining,
      });
    } else if (opts.source === 'psa') {
      // Native discovery of PSA's own population-report tree (see
      // src/sources/psa/collectors/popDiscovery.ts) -- replaces the old
      // dependency on a hand-curated snapshot from clean_rewrite. Needs a
      // real, Cloudflare-cleared browser profile signed in via `psa-login`.
      // Cooldown constants match the legacy psa-fetch.ts safety valve
      // (confirmed live 2026-08-29: a details-stage run without this hit a
      // sustained 429 storm because runQueue had no circuit breaker and kept
      // claiming fresh pending items at full rate-limiter speed regardless
      // of how many in a row had just failed).
      const rateLimiter = createRateLimiter({ minDelayMs: 600, jitterMs: 300 });
      const cooldown = { afterConsecutiveFailures: 3, cooldownMs: 60_000 };
      let context = await launchPsaProfile({ headless: false });
      let page = await context.newPage();
      const ensurePage = async () => {
        if (!page.isClosed() && (context.browser()?.isConnected() ?? false)) return page;
        console.warn('PSA browser page/context closed; relaunching the persistent profile before retrying...');
        await context.close().catch(() => {});
        context = await launchPsaProfile({ headless: false });
        page = await context.newPage();
        await page.goto('https://www.psacard.com/pop/tcg-cards/156940', { waitUntil: 'domcontentloaded', timeout: 60_000 });
        return page;
      };
      try {
        await page.goto('https://www.psacard.com/pop/tcg-cards/156940', { waitUntil: 'domcontentloaded', timeout: 60_000 });
        if (opts.stage === 'index' || opts.stage === 'all') {
          seedPsaPopDiscovery(db);
          await runQueue(db, {
            queue: 'psa_pop_discovery', collector: createPsaPopDiscoveryCollector({ page, rateLimiter }),
            concurrency: 1, leaseTtlMs: opts.leaseTtlMs, runId, isDraining: () => draining, cooldown,
          });
        }
        if (opts.stage === 'details' || opts.stage === 'all') {
          await runQueue(db, {
            queue: 'psa_pop_set_items', collector: createPsaSetItemsCollector({ page, rateLimiter }),
            concurrency: 1, leaseTtlMs: opts.leaseTtlMs, runId, isDraining: () => draining, cooldown,
          });
        }
        // Certification numbers published on eBay listings, resolved back to
        // the spec PSA graded them under. This is the only exact eBay->variant
        // path there is, and it doubles as the precision baseline the scored
        // matcher is measured against -- so it is its own stage rather than
        // part of `all`, and is run on demand once eBay data has been
        // materialized.
        if (opts.stage === 'cert') {
          const seeded = seedPsaCertLookups(db);
          console.log(`Seeded ${seeded} PSA cert lookups from eBay listings.`);
          let certsSinceMaterialize=0;
          await runQueue(db, {
            queue: 'psa_cert', collector: createPsaCertCollector({ page, getPage:ensurePage, rateLimiter }),
            concurrency: 1, leaseTtlMs: opts.leaseTtlMs, runId, isDraining: () => draining, cooldown,
            onItemComplete:async(result)=>{
              if(result.final!=='succeeded')return;
              certsSinceMaterialize++;
              if(certsSinceMaterialize<25)return;
              certsSinceMaterialize=0;
              await materialize(db,{includeTcgdex:false,includePsa:false,includeEbay:true,includeEcb:false});
              console.log('Incremental eBay rematch materialized after 25 PSA certs.');
            },
          });
        }
      } finally {
        await context.close();
      }
    } else {
      console.error(`Unknown source '${opts.source}'.`);
      process.exitCode = 1;
    }
    finishRun(db, runId, draining ? 'cancelled' : 'completed');
  } catch (err) {
    finishRun(db, runId, 'failed');
    logEvent(db, {
      runId,
      level: 'error',
      category: 'system',
      message: `Run failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    throw err;
  } finally {
    process.removeListener('SIGINT', sigintHandler);
    process.removeListener('SIGTERM', sigtermHandler);
    db.close();
  }
}
