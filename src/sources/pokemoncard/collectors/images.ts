import type { Collector } from '../../../core/queue/runner.ts';
import { classifyHttpStatus } from '../../../core/http/fetchClient.ts';
import type { RateLimiter } from '../../../core/http/rateLimiter.ts';
import { pokemonCardFetchRaw } from '../config.ts';
import { matchCardImage, type CardLookupInput } from '../match.ts';

export interface PokemonCardImageDeps {
  rateLimiter: RateLimiter;
}

function mediaTypeForExt(ext: string): string {
  if (ext === 'png') return 'image/png';
  if (ext === 'gif') return 'image/gif';
  return 'image/jpeg';
}

export function createPokemonCardImageCollector(deps: PokemonCardImageDeps): Collector {
  return async (_db, item) => {
    const params = JSON.parse(item.params_json) as CardLookupInput & { cardId: number };
    const sourceIdentity = 'pokemoncard:ja';

    await deps.rateLimiter();
    let match;
    try {
      match = await matchCardImage(params);
    } catch (err) {
      return {
        outcome: 'failure',
        final: 'retryable_failed',
        sourceIdentity,
        requestParams: params,
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }
    if (!match) {
      return {
        outcome: 'failure',
        final: 'permanent_failed',
        sourceIdentity,
        requestParams: params,
        errorMessage: `No pokemon-card.com match for "${params.name}" (${params.setName} ${params.localId})`,
      };
    }

    const imageUrl = `https://www.pokemon-card.com${match.imageUrl}`;
    await deps.rateLimiter();
    const res = await pokemonCardFetchRaw(imageUrl);
    const httpClass = classifyHttpStatus(res.status);
    if (httpClass !== 'success') {
      return {
        outcome: 'failure',
        final: httpClass === 'permanent' ? 'permanent_failed' : 'retryable_failed',
        sourceIdentity,
        httpStatus: res.status,
        requestMethod: 'GET',
        requestUrl: imageUrl,
        requestParams: { ...params, method: match.method, cardID: match.cardID },
        durationMs: res.durationMs,
        errorMessage: `HTTP ${res.status} fetching matched image ${imageUrl}`,
      };
    }

    const ext = (imageUrl.split('.').at(-1) ?? 'jpg').toLowerCase();

    return {
      outcome: 'success',
      final: 'succeeded',
      sourceIdentity,
      httpStatus: res.status,
      requestMethod: 'GET',
      requestUrl: imageUrl,
      requestParams: { ...params, method: match.method, cardID: match.cardID },
      durationMs: res.durationMs,
      object: { source: 'pokemoncard', mediaKind: 'image', mediaType: mediaTypeForExt(ext), ext, body: res.body },
    };
  };
}
