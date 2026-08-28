import type { Collector, CollectorOutcome } from '../../../core/queue/runner.ts';
import type { EnqueueSpec } from '../../../core/queue/workItem.ts';
import { classifyHttpStatus, fetchRaw, type RawFetchResult } from '../../../core/http/fetchClient.ts';
import type { RateLimiter } from '../../../core/http/rateLimiter.ts';
import {
  DOWNLOADED_FORMAT,
  DOWNLOADED_QUALITY,
  TCGDEX_API_BASE,
  buildCardImageRenditionUrls,
  buildSetAssetRenditionUrls,
} from '../config.ts';
import { cardImageScopeKey, cardScopeKey, setImageScopeKey } from '../scopeKeys.ts';

interface SetCardBrief {
  id: string;
  localId: string;
  name: string;
}

interface SetFull {
  id: string;
  name: string;
  logo?: string;
  symbol?: string;
  cards: SetCardBrief[];
}

interface CardFull {
  id: string;
  image?: string;
}

export interface CatalogueDeps {
  rateLimiter: RateLimiter;
}

/** Handles both `set` and `card` entity types on the shared catalogue_json queue. */
export function createTcgdexCatalogueCollector(deps: CatalogueDeps): Collector {
  return async (_db, item) => {
    await deps.rateLimiter();

    if (item.entity_type === 'set') {
      const { lang, setId } = JSON.parse(item.params_json) as { lang: string; setId: string };
      const url = `${TCGDEX_API_BASE}/${lang}/sets/${setId}`;
      const res = await fetchRaw(url);
      return handleSetResponse(lang, setId, url, res);
    }

    if (item.entity_type === 'card') {
      const { lang, cardId } = JSON.parse(item.params_json) as { lang: string; cardId: string };
      const url = `${TCGDEX_API_BASE}/${lang}/cards/${cardId}`;
      const res = await fetchRaw(url);
      return handleCardResponse(lang, cardId, url, res);
    }

    return {
      outcome: 'failure',
      final: 'permanent_failed',
      sourceIdentity: 'tcgdex',
      errorMessage: `Unknown catalogue_json entity_type: ${item.entity_type}`,
    };
  };
}

function handleSetResponse(lang: string, setId: string, url: string, res: RawFetchResult): CollectorOutcome {
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
      errorMessage: `HTTP ${res.status} fetching set ${setId}`,
    };
  }

  const base = {
    outcome: 'success' as const,
    sourceIdentity,
    httpStatus: res.status,
    requestMethod: 'GET',
    requestUrl: url,
    responseHeaders: res.headers,
    durationMs: res.durationMs,
    object: { source: 'tcgdex', mediaKind: 'json' as const, mediaType: 'application/json', ext: 'json', body: res.body },
  };

  let set: SetFull;
  try {
    set = JSON.parse(res.body.toString('utf8')) as SetFull;
  } catch (err) {
    return {
      ...base,
      outcome: 'schema_drift',
      final: 'permanent_failed',
      errorMessage: `Failed to parse set JSON for ${setId}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const enqueueNext: EnqueueSpec[] = [];
  for (const card of set.cards ?? []) {
    enqueueNext.push({
      source: 'tcgdex',
      queue: 'catalogue_json',
      entityType: 'card',
      scopeKey: cardScopeKey(lang, card.id),
      params: { lang, cardId: card.id },
    });
  }
  if (set.logo) enqueueNext.push(buildSetImageEnqueue(lang, setId, 'logo', set.logo));
  if (set.symbol) enqueueNext.push(buildSetImageEnqueue(lang, setId, 'symbol', set.symbol));

  return { ...base, final: 'succeeded', enqueueNext };
}

function handleCardResponse(lang: string, cardId: string, url: string, res: RawFetchResult): CollectorOutcome {
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
      errorMessage: `HTTP ${res.status} fetching card ${cardId}`,
    };
  }

  const base = {
    outcome: 'success' as const,
    sourceIdentity,
    httpStatus: res.status,
    requestMethod: 'GET',
    requestUrl: url,
    responseHeaders: res.headers,
    durationMs: res.durationMs,
    object: { source: 'tcgdex', mediaKind: 'json' as const, mediaType: 'application/json', ext: 'json', body: res.body },
  };

  let card: CardFull;
  try {
    card = JSON.parse(res.body.toString('utf8')) as CardFull;
  } catch (err) {
    return {
      ...base,
      outcome: 'schema_drift',
      final: 'permanent_failed',
      errorMessage: `Failed to parse card JSON for ${cardId}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const enqueueNext: EnqueueSpec[] = [];
  if (card.image) {
    const { downloaded, all } = buildCardImageRenditionUrls(card.image);
    enqueueNext.push({
      source: 'tcgdex',
      queue: 'images',
      entityType: 'card_image',
      scopeKey: cardImageScopeKey(lang, cardId, DOWNLOADED_QUALITY, DOWNLOADED_FORMAT),
      params: { lang, url: downloaded, allRenditions: all },
    });
  }

  return { ...base, final: 'succeeded', enqueueNext };
}

function buildSetImageEnqueue(lang: string, setId: string, kind: 'logo' | 'symbol', assetBaseUrl: string): EnqueueSpec {
  const { downloaded, all } = buildSetAssetRenditionUrls(assetBaseUrl);
  return {
    source: 'tcgdex',
    queue: 'images',
    entityType: `set_${kind}`,
    scopeKey: setImageScopeKey(lang, setId, kind, DOWNLOADED_QUALITY, DOWNLOADED_FORMAT),
    params: { lang, url: downloaded, allRenditions: all },
  };
}

