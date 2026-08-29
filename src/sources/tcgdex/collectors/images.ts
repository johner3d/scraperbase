import type { Collector } from '../../../core/queue/runner.ts';
import { classifyHttpStatus, fetchRaw } from '../../../core/http/fetchClient.ts';
import type { RateLimiter } from '../../../core/http/rateLimiter.ts';
import { DOWNLOADED_FORMAT, extForFormat, mediaTypeForFormat } from '../config.ts';

export interface ImageDeps {
  rateLimiter: RateLimiter;
}

export function createTcgdexImageCollector(deps: ImageDeps): Collector {
  return async (_db, item) => {
    const { lang, url, allRenditions } = JSON.parse(item.params_json) as {
      lang: string;
      url: string;
      allRenditions?: Record<string, string>;
    };

    // TCGdex occasionally advertises a WebP base while only a PNG exists.
    // Prefer the configured rendition, then try the other advertised URLs.
    const candidates = [url, ...Object.values(allRenditions ?? {})]
      .filter((candidate, index, values) => values.indexOf(candidate) === index);
    let requestUrl = url;
    let res = null;
    for (const candidate of candidates) {
      await deps.rateLimiter();
      const response = await fetchRaw(candidate);
      requestUrl = candidate;
      res = response;
      if (classifyHttpStatus(response.status) === 'success') break;
      if (response.status !== 404) break;
    }
    if (!res) throw new Error(`No image rendition URL for ${item.scope_key}`);
    const httpClass = classifyHttpStatus(res.status);
    const sourceIdentity = `tcgdex:${lang}`;

    if (httpClass !== 'success') {
      return {
        outcome: 'failure',
        final: httpClass === 'permanent' ? 'permanent_failed' : 'retryable_failed',
        sourceIdentity,
        httpStatus: res.status,
        requestMethod: 'GET',
        requestUrl,
        durationMs: res.durationMs,
        errorMessage: `HTTP ${res.status} fetching image ${requestUrl}`,
      };
    }

    const extension = new URL(requestUrl).pathname.split('.').at(-1)?.toLowerCase() ?? DOWNLOADED_FORMAT;
    const format = extension === 'jpeg' ? 'jpg' : extension;

    return {
      outcome: 'success',
      final: 'succeeded',
      sourceIdentity,
      httpStatus: res.status,
      requestMethod: 'GET',
      requestUrl,
      responseHeaders: res.headers,
      durationMs: res.durationMs,
      object: {
        source: 'tcgdex',
        mediaKind: 'image',
        mediaType: mediaTypeForFormat(format),
        ext: extForFormat(format),
        body: res.body,
      },
    };
  };
}
