import type { Collector } from '../../../core/queue/runner.ts';
import { classifyHttpStatus, fetchRaw } from '../../../core/http/fetchClient.ts';
import type { RateLimiter } from '../../../core/http/rateLimiter.ts';
import { DOWNLOADED_FORMAT, extForFormat, mediaTypeForFormat } from '../config.ts';

export interface ImageDeps {
  rateLimiter: RateLimiter;
}

export function createTcgdexImageCollector(deps: ImageDeps): Collector {
  return async (_db, item) => {
    const { lang, url } = JSON.parse(item.params_json) as { lang: string; url: string };

    await deps.rateLimiter();
    const res = await fetchRaw(url);
    const httpClass = classifyHttpStatus(res.status);
    const sourceIdentity = `tcgdex:${lang}`;

    if (httpClass !== 'success') {
      return {
        outcome: 'failure',
        final: httpClass === 'permanent' ? 'permanent_failed' : 'retryable_failed',
        sourceIdentity,
        httpStatus: res.status,
        requestMethod: 'GET',
        requestUrl: url,
        durationMs: res.durationMs,
        errorMessage: `HTTP ${res.status} fetching image ${url}`,
      };
    }

    return {
      outcome: 'success',
      final: 'succeeded',
      sourceIdentity,
      httpStatus: res.status,
      requestMethod: 'GET',
      requestUrl: url,
      responseHeaders: res.headers,
      durationMs: res.durationMs,
      object: {
        source: 'tcgdex',
        mediaKind: 'image',
        mediaType: mediaTypeForFormat(DOWNLOADED_FORMAT),
        ext: extForFormat(DOWNLOADED_FORMAT),
        body: res.body,
      },
    };
  };
}
