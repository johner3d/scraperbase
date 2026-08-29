import type { DatabaseSync } from 'node:sqlite';
import type { Collector } from '../../core/queue/runner.ts';
import { enqueueWorkItem } from '../../core/queue/scheduler.ts';
import { classifyHttpStatus, fetchRaw } from '../../core/http/fetchClient.ts';
import type { RateLimiter } from '../../core/http/rateLimiter.ts';
import { TCGDEX_API_BASE } from './config.ts';
import { discoveryScopeKey, setScopeKey } from './scopeKeys.ts';

export interface DiscoveryDeps {
  rateLimiter: RateLimiter;
  /** If set, only this setId is fanned out to catalogue_json (the pilot/--scope path). */
  setFilter?: string;
}

interface SetBrief {
  id: string;
  name: string;
  logo?: string;
  symbol?: string;
  cardCount: { total: number; official: number };
}

/**
 * Enumerates every set for one language via TCGdex's own set list -- this is
 * how "all desired sets" is discovered rather than a curated release list.
 */
export function createTcgdexDiscoveryCollector(deps: DiscoveryDeps): Collector {
  return async (_db, item) => {
    const { lang } = JSON.parse(item.params_json) as { lang: string };
    const url = `${TCGDEX_API_BASE}/${encodeURIComponent(lang)}/sets`;

    await deps.rateLimiter();
    const res = await fetchRaw(url);
    const httpClass = classifyHttpStatus(res.status);

    if (httpClass !== 'success') {
      return {
        outcome: 'failure',
        final: httpClass === 'permanent' ? 'permanent_failed' : 'retryable_failed',
        sourceIdentity: `tcgdex:${lang}`,
        httpStatus: res.status,
        requestMethod: 'GET',
        requestUrl: url,
        durationMs: res.durationMs,
        errorMessage: `HTTP ${res.status} fetching set list`,
      };
    }

    let sets: SetBrief[];
    try {
      sets = JSON.parse(res.body.toString('utf8')) as SetBrief[];
    } catch (err) {
      // The bytes are still stored below -- only the fan-out is skipped.
      return {
        outcome: 'schema_drift',
        final: 'permanent_failed',
        sourceIdentity: `tcgdex:${lang}`,
        httpStatus: res.status,
        requestUrl: url,
        responseHeaders: res.headers,
        durationMs: res.durationMs,
        object: { source: 'tcgdex', mediaKind: 'json', mediaType: 'application/json', ext: 'json', body: res.body },
        errorMessage: `Failed to parse set list JSON: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const enqueueNext = [];
    for (const set of sets) {
      if (deps.setFilter && set.id !== deps.setFilter) continue;
      enqueueNext.push({
        source: 'tcgdex',
        queue: 'catalogue_json',
        entityType: 'set',
        scopeKey: setScopeKey(lang, set.id),
        params: { lang, setId: set.id },
      });
    }

    return {
      outcome: 'success',
      final: 'succeeded',
      sourceIdentity: `tcgdex:${lang}`,
      httpStatus: res.status,
      requestMethod: 'GET',
      requestUrl: url,
      responseHeaders: res.headers,
      durationMs: res.durationMs,
      object: { source: 'tcgdex', mediaKind: 'json', mediaType: 'application/json', ext: 'json', body: res.body },
      enqueueNext,
    };
  };
}

export function seedDiscovery(db: DatabaseSync, langs: string[]): void {
  for (const lang of langs) {
    enqueueWorkItem(db, {
      source: 'tcgdex',
      queue: 'tcgdex_discovery',
      entityType: 'lang_set_list',
      scopeKey: discoveryScopeKey(lang),
      params: { lang },
    });
  }
}
