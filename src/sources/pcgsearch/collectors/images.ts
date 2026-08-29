import type { Collector } from '../../../core/queue/runner.ts';
import { classifyHttpStatus, fetchRaw } from '../../../core/http/fetchClient.ts';
import type { RateLimiter } from '../../../core/http/rateLimiter.ts';
import { makePcgSearchAsset, PCGSEARCH_INDEX_URL } from '../match.ts';

export interface PcgSearchImageDeps {
  rateLimiter: RateLimiter;
}

// The whole card catalogue lives on one ~1.6MB index page; every work item
// in this run shares one fetch of it instead of hitting the site per card.
let indexPromise: Promise<string> | null = null;
async function loadIndex(): Promise<string> {
  indexPromise ??= fetchRaw(PCGSEARCH_INDEX_URL).then((res) => res.body.toString('utf8'));
  return indexPromise;
}

export function createPcgSearchImageCollector(deps: PcgSearchImageDeps): Collector {
  return async (_db, item) => {
    const params = JSON.parse(item.params_json) as { cardId: number; localId: string; sourceSetId: string };
    const sourceIdentity = 'pcgsearch:ja';

    const asset = makePcgSearchAsset(params.sourceSetId, params.localId);
    if (!asset) {
      return { outcome: 'failure', final: 'permanent_failed', sourceIdentity, requestParams: params, errorMessage: 'Not a PCG Search-covered set/local id' };
    }

    const index = await loadIndex();
    if (!index.includes(`href="${asset.indexPath}"`)) {
      return { outcome: 'failure', final: 'permanent_failed', sourceIdentity, requestParams: params, errorMessage: `PCG Search index has no entry for ${asset.indexPath}` };
    }

    await deps.rateLimiter();
    const res = await fetchRaw(asset.imageUrl);
    const httpClass = classifyHttpStatus(res.status);
    if (httpClass !== 'success') {
      return {
        outcome: 'failure',
        final: httpClass === 'permanent' ? 'permanent_failed' : 'retryable_failed',
        sourceIdentity,
        httpStatus: res.status,
        requestMethod: 'GET',
        requestUrl: asset.imageUrl,
        requestParams: { ...params, matchKind: asset.matchKind },
        durationMs: res.durationMs,
        errorMessage: `HTTP ${res.status} fetching ${asset.imageUrl}`,
      };
    }

    return {
      outcome: 'success',
      final: 'succeeded',
      sourceIdentity,
      httpStatus: res.status,
      requestMethod: 'GET',
      requestUrl: asset.imageUrl,
      requestParams: { ...params, matchKind: asset.matchKind },
      durationMs: res.durationMs,
      object: { source: 'pcgsearch', mediaKind: 'image', mediaType: 'image/png', ext: 'png', body: res.body },
    };
  };
}
