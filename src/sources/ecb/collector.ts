import type { Collector, CollectorOutcome } from '../../core/queue/runner.ts';
import { classifyHttpStatus, fetchRaw } from '../../core/http/fetchClient.ts';
import type { RateLimiter } from '../../core/http/rateLimiter.ts';
import { ECB_DAILY_RATES_URL } from './config.ts';
import { parseEcbUsdRate } from './parse.ts';

export function createEcbRatesCollector(rateLimiter: RateLimiter): Collector {
  return async () => {
    await rateLimiter();
    const res = await fetchRaw(ECB_DAILY_RATES_URL);
    const httpClass = classifyHttpStatus(res.status);
    const base = {
      sourceIdentity: 'ecb:reference-rates', httpStatus: res.status, requestMethod: 'GET',
      requestUrl: ECB_DAILY_RATES_URL, responseHeaders: res.headers, durationMs: res.durationMs,
      byteSize: res.body.byteLength,
    };
    if (httpClass !== 'success') return {
      ...base, outcome: 'failure' as const,
      final: httpClass === 'permanent' ? 'permanent_failed' as const : 'retryable_failed' as const,
      errorMessage: `HTTP ${res.status} fetching ECB reference rates`,
    } satisfies CollectorOutcome;
    const xml = res.body.toString('utf8');
    if (!parseEcbUsdRate(xml)) {
      return { ...base, outcome: 'schema_drift', final: 'permanent_failed', errorMessage: 'ECB daily XML did not contain a dated USD reference rate',
        object: { source: 'ecb', mediaKind: 'xml', mediaType: 'application/xml', ext: 'xml', body: res.body } } satisfies CollectorOutcome;
    }
    return { ...base, outcome: 'success', final: 'succeeded', object: {
      source: 'ecb', mediaKind: 'xml', mediaType: 'application/xml', ext: 'xml', body: res.body,
    } } satisfies CollectorOutcome;
  };
}
