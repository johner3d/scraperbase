import type { Page } from 'playwright';
import type { Collector } from '../../../core/queue/runner.ts';
import { classifyHttpStatus } from '../../../core/http/fetchClient.ts';
import type { RateLimiter } from '../../../core/http/rateLimiter.ts';
import { POP_ROOT_CATEGORY_ID, popSetItemsEndpoint } from '../config.ts';

// Fetches every card + variety + per-grade population count for one PSA
// population-report heading via PSA's own /Pop/GetSetItems endpoint --
// confirmed live 2026-08-29 to return the SubjectName/Variety/CardNumber
// PSA uses internally, plus a modern unified SpecID (the same id PSA's
// /spec/psa/{id} page and its researchJourney.getPriceSummary /
// getSalesBySpecId tRPC calls use), and the full per-grade population
// breakdown inline -- no separate population-page scrape needed.

export interface SetItemsDeps {
  page: Page;
  rateLimiter: RateLimiter;
}

export function createPsaSetItemsCollector(deps: SetItemsDeps): Collector {
  return async (_db, item) => {
    const { headingId, name, slug, year } = JSON.parse(item.params_json) as {
      headingId: string;
      name?: string;
      slug?: string;
      year?: string;
    };
    const requestUrl = popSetItemsEndpoint();
    const sourceIdentity = `psa:pop_set_items:${headingId}`;

    await deps.rateLimiter();
    const start = Date.now();
    const result = await deps.page.evaluate(
      async ({ endpoint, headingID, categoryID }) => {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'X-Requested-With': 'XMLHttpRequest',
          },
          body: new URLSearchParams({
            draw: '1',
            start: '0',
            length: '2000',
            search: '',
            headingID,
            categoryID,
            isPSADNA: 'false',
          }).toString(),
        });
        return { status: res.status, body: await res.text() };
      },
      { endpoint: requestUrl, headingID: headingId, categoryID: POP_ROOT_CATEGORY_ID },
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
        errorMessage: `HTTP ${result.status} fetching GetSetItems for heading ${headingId}`,
      };
    }

    let recordsTotal: number | undefined;
    try {
      recordsTotal = (JSON.parse(result.body) as { recordsTotal?: number }).recordsTotal;
    } catch {
      return {
        outcome: 'schema_drift',
        final: 'permanent_failed',
        sourceIdentity,
        httpStatus: result.status,
        requestUrl,
        durationMs,
        object: { source: 'psa', mediaKind: 'json', mediaType: 'application/json', ext: 'json', body },
        errorMessage: 'Failed to parse GetSetItems JSON',
      };
    }

    return {
      outcome: 'success',
      final: 'succeeded',
      sourceIdentity,
      httpStatus: result.status,
      requestMethod: 'POST',
      requestUrl,
      requestParams: { headingId, name, slug, year },
      durationMs,
      object: { source: 'psa', mediaKind: 'json', mediaType: 'application/json', ext: 'json', body },
      errorMessage: recordsTotal === 0 ? `heading ${headingId} (${name ?? 'unknown'}) returned 0 records` : undefined,
    };
  };
}
