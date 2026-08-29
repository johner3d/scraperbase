import type { DatabaseSync } from 'node:sqlite';
import type { Page } from 'playwright';
import type { Collector } from '../../core/queue/runner.ts';
import { enqueueWorkItem } from '../../core/queue/scheduler.ts';
import { classifyHttpStatus } from '../../core/http/fetchClient.ts';
import type { RateLimiter } from '../../core/http/rateLimiter.ts';
import { PSA_BASE, cardFactsUrl } from './config.ts';
import { cardIdentityScopeKey, discoverySetScopeKey } from './scopeKeys.ts';

export interface DiscoveryDeps {
  /**
   * A page belonging to the authenticated, Cloudflare-cleared persistent PSA
   * profile (see browser/profile.ts). A plain Node `fetch()` gets blocked by
   * PSA's Cloudflare check; this must run in-page so it carries the page's
   * cookies. The caller is responsible for having already navigated it to a
   * psacard.com page before running this collector.
   */
  page: Page;
  rateLimiter: RateLimiter;
}

interface GetSetListRow {
  CardName: string;
  CardNumber: string;
}

interface GetSetListResponse {
  data?: GetSetListRow[];
  recordsTotal?: number;
  recordsFiltered?: number;
}

interface CardIdentity {
  psaSpecId: number;
  cardNumber: string;
  name: string;
  sourceUrl: string;
}

/**
 * Parses one GetSetList row into a raw card identity. `CardName` arrives as
 * an HTML fragment -- an anchor whose href's trailing numeric segment is the
 * card's psaSpecId, e.g. `<a href="/cardfacts/.../605243">Charizard</a>`.
 */
function parseCardRow(row: GetSetListRow): CardIdentity | null {
  const href = row.CardName.match(/href=['"]([^'"]+)['"]/i)?.[1];
  const name = row.CardName.match(/>([^<]+)<\/a>/i)?.[1]?.trim();
  const specId = href?.match(/\/(\d+)\/?$/)?.[1];
  if (!href || !name || !specId) return null;
  return {
    psaSpecId: Number(specId),
    cardNumber: row.CardNumber.trim(),
    name,
    sourceUrl: cardFactsUrl(specId),
  };
}

/**
 * Enumerates every card PSA has CardFacts data for within one PSA set, via
 * PSA's own `GetSetList` endpoint. Stores the raw response and fans out one
 * `card_identity` work item per card for downstream collectors (population,
 * CardFacts HTML, sales -- not yet built) to pick up.
 */
export function createPsaDiscoveryCollector(deps: DiscoveryDeps): Collector {
  return async (_db, item) => {
    const { psaSetId } = JSON.parse(item.params_json) as { psaSetId: string };
    const requestUrl = `${PSA_BASE}/cardfacts/GetSetList`;
    const sourceIdentity = `psa:set:${psaSetId}`;

    await deps.rateLimiter();
    const start = Date.now();
    const result = await deps.page.evaluate(
      async ({ endpoint, setId }) => {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'X-Requested-With': 'XMLHttpRequest',
          },
          body: new URLSearchParams({ setID: setId, draw: '1', start: '0', length: '10000' }).toString(),
        });
        return { status: res.status, body: await res.text() };
      },
      { endpoint: requestUrl, setId: psaSetId },
    );
    const durationMs = Date.now() - start;
    const body = Buffer.from(result.body, 'utf8');
    const httpClass = classifyHttpStatus(result.status);

    if (httpClass !== 'success') {
      return {
        outcome: 'failure',
        final: httpClass === 'permanent' ? 'permanent_failed' : 'retryable_failed',
        sourceIdentity,
        httpStatus: result.status,
        requestMethod: 'POST',
        requestUrl,
        durationMs,
        errorMessage: `HTTP ${result.status} fetching PSA set list`,
      };
    }

    let parsed: GetSetListResponse;
    try {
      parsed = JSON.parse(result.body) as GetSetListResponse;
    } catch (err) {
      // The bytes are still stored below -- only the fan-out is skipped.
      return {
        outcome: 'schema_drift',
        final: 'permanent_failed',
        sourceIdentity,
        httpStatus: result.status,
        requestUrl,
        durationMs,
        object: { source: 'psa', mediaKind: 'json', mediaType: 'application/json', ext: 'json', body },
        errorMessage: `Failed to parse GetSetList JSON: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const rows = parsed.data ?? [];
    const identities = rows.map(parseCardRow).filter((c): c is CardIdentity => c !== null);
    const unparsed = rows.length - identities.length;

    const enqueueNext = identities.map((identity) => ({
      source: 'psa',
      queue: 'psa_card_identity',
      entityType: 'card_identity',
      scopeKey: cardIdentityScopeKey(String(identity.psaSpecId)),
      params: identity,
    }));

    // Every row failed to parse: CardName's shape has likely changed on
    // PSA's end, not a transient issue -- surface it instead of silently
    // storing an object nothing fans out from.
    const allUnparsed = rows.length > 0 && identities.length === 0;

    return {
      outcome: allUnparsed ? 'schema_drift' : 'success',
      final: allUnparsed ? 'permanent_failed' : 'succeeded',
      sourceIdentity,
      httpStatus: result.status,
      requestMethod: 'POST',
      requestUrl,
      durationMs,
      object: { source: 'psa', mediaKind: 'json', mediaType: 'application/json', ext: 'json', body },
      enqueueNext,
      errorMessage: unparsed > 0 ? `${unparsed}/${rows.length} rows failed to parse (CardName shape unexpected)` : undefined,
    };
  };
}

/** Enqueues discovery for a curated, caller-supplied list of PSA CardFacts set IDs. */
export function seedPsaDiscovery(db: DatabaseSync, psaSetIds: readonly string[]): void {
  for (const psaSetId of psaSetIds) {
    enqueueWorkItem(db, {
      source: 'psa',
      queue: 'psa_discovery',
      entityType: 'set_card_list',
      scopeKey: discoverySetScopeKey(psaSetId),
      params: { psaSetId },
    });
  }
}
