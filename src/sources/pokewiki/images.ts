import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Collector, CollectorOutcome } from '../../core/queue/runner.ts';
import { enqueueWorkItem } from '../../core/queue/scheduler.ts';
import { classifyHttpStatus, fetchRaw } from '../../core/http/fetchClient.ts';
import type { RateLimiter } from '../../core/http/rateLimiter.ts';

export const POKEWIKI_API = 'https://www.pokewiki.de/api.php';
export const POKEWIKI_PAGE_BASE = 'https://www.pokewiki.de/';
export const POKEWIKI_METADATA_QUEUE = 'pokewiki_card_metadata';
export const POKEWIKI_FILE_METADATA_QUEUE = 'pokewiki_file_metadata';
export const POKEWIKI_IMAGE_QUEUE = 'pokewiki_images';
export const POKEWIKI_BATCH_SIZE = 40;

export interface PokewikiCardCandidate {
  tcgdexCardId: string;
  cardName: string;
  setName: string;
  localId: string;
  pageTitle: string;
}

interface MetadataParams {
  cards: PokewikiCardCandidate[];
}

interface WikiRevision {
  slots?: { main?: { content?: string } };
  content?: string;
  '*'?: string;
}

interface WikiPage {
  pageid?: number;
  title?: string;
  missing?: boolean;
  revisions?: WikiRevision[];
  imageinfo?: Array<{
    url?: string;
    descriptionurl?: string;
    mime?: string;
    width?: number;
    height?: number;
  }>;
}

interface WikiTitleMapping {
  from?: string;
  to?: string;
}

interface WikiQueryResponse {
  query?: {
    normalized?: WikiTitleMapping[];
    redirects?: WikiTitleMapping[];
    pages?: WikiPage[] | Record<string, WikiPage>;
  };
}

export interface PokewikiImageDeps {
  rateLimiter: RateLimiter;
}

function wikiTitleKey(value: string): string {
  return value.replaceAll('_', ' ').replace(/\s+/g, ' ').trim().toLocaleLowerCase('de');
}

function pageList(response: WikiQueryResponse): WikiPage[] {
  const pages = response.query?.pages;
  if (!pages) return [];
  return Array.isArray(pages) ? pages : Object.values(pages);
}

function revisionContent(page: WikiPage): string {
  const revision = page.revisions?.[0];
  return revision?.slots?.main?.content ?? revision?.content ?? revision?.['*'] ?? '';
}

function canonicalTitles(response: WikiQueryResponse): Map<string, string> {
  const mappings = [
    ...(response.query?.normalized ?? []),
    ...(response.query?.redirects ?? []),
  ];
  const next = new Map(mappings
    .filter((mapping): mapping is Required<WikiTitleMapping> => Boolean(mapping.from && mapping.to))
    .map((mapping) => [wikiTitleKey(mapping.from), mapping.to]));
  const result = new Map<string, string>();
  for (const mapping of mappings) {
    if (!mapping.from) continue;
    let value = mapping.from;
    const seen = new Set<string>();
    while (next.has(wikiTitleKey(value)) && !seen.has(wikiTitleKey(value))) {
      seen.add(wikiTitleKey(value));
      value = next.get(wikiTitleKey(value))!;
    }
    result.set(wikiTitleKey(mapping.from), value);
  }
  return result;
}

export function buildPokewikiCardPageTitle(cardName: string, setName: string, localId: string): string {
  return `${cardName.trim()} (${setName.trim()} ${localId.trim()})`;
}

export function parsePokewikiCardImage(wikitext: string): string | null {
  if (!/\{\{\s*Karte Infobox\b/i.test(wikitext)) return null;
  const match = /^\s*\|\s*bild\s*=\s*([^\r\n|}]+)/im.exec(wikitext);
  const value = match?.[1]?.trim().replace(/^Datei:/i, '');
  return value || null;
}

export function pokewikiFileNameCandidates(cardName: string, setName: string, localId: string): string[] {
  const names = [cardName.trim()];
  if (/Nidoran M$/i.test(cardName)) names.push(cardName.replace(/Nidoran M$/i, 'Nidoran♂'));
  if (/Nidoran F$/i.test(cardName)) names.push(cardName.replace(/Nidoran F$/i, 'Nidoran♀'));
  const bases = [...new Set(names.map((name) => buildPokewikiCardPageTitle(name, setName, localId)))];
  return bases.flatMap((base) => ['jpg', 'png', 'webp'].map((ext) => `${base}.${ext}`));
}

function imageRedirectUrl(fileName: string): string {
  return `https://www.pokewiki.de/Special:Redirect/file/${encodeURIComponent(fileName.replaceAll(' ', '_'))}`;
}

function pageUrl(title: string): string {
  return new URL(encodeURIComponent(title.replaceAll(' ', '_')), POKEWIKI_PAGE_BASE).toString();
}

function metadataUrl(cards: PokewikiCardCandidate[]): string {
  const url = new URL(POKEWIKI_API);
  url.search = new URLSearchParams({
    action: 'query',
    format: 'json',
    formatversion: '2',
    redirects: '1',
    prop: 'revisions',
    rvprop: 'content',
    rvslots: 'main',
    titles: cards.map((card) => card.pageTitle).join('|'),
  }).toString();
  return url.toString();
}

export function createPokewikiMetadataCollector(deps: PokewikiImageDeps): Collector {
  return async (_db, item) => {
    const { cards } = JSON.parse(item.params_json) as MetadataParams;
    const url = metadataUrl(cards);
    await deps.rateLimiter();
    const res = await fetchRaw(url);
    const httpClass = classifyHttpStatus(res.status);
    if (httpClass !== 'success') {
      return {
        outcome: 'failure',
        final: httpClass === 'permanent' ? 'permanent_failed' : 'retryable_failed',
        sourceIdentity: 'pokewiki:de',
        httpStatus: res.status,
        requestMethod: 'GET',
        requestUrl: url,
        responseHeaders: res.headers,
        durationMs: res.durationMs,
        errorMessage: `HTTP ${res.status} fetching PokéWiki metadata batch`,
      };
    }

    let parsed: WikiQueryResponse;
    try {
      parsed = JSON.parse(res.body.toString('utf8')) as WikiQueryResponse;
    } catch (error) {
      return {
        outcome: 'schema_drift',
        final: 'permanent_failed',
        sourceIdentity: 'pokewiki:de',
        httpStatus: res.status,
        requestMethod: 'GET',
        requestUrl: url,
        responseHeaders: res.headers,
        durationMs: res.durationMs,
        object: { source: 'pokewiki', mediaKind: 'json', mediaType: 'application/json', ext: 'json', body: res.body },
        errorMessage: `Failed to parse PokéWiki metadata JSON: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    const pages = new Map(pageList(parsed)
      .filter((page) => !page.missing && page.title)
      .map((page) => [wikiTitleKey(page.title!), page]));
    const canonical = canonicalTitles(parsed);
    const enqueueNext = [];
    let matched = 0;
    for (const card of cards) {
      const resolvedTitle = canonical.get(wikiTitleKey(card.pageTitle)) ?? card.pageTitle;
      const page = pages.get(wikiTitleKey(resolvedTitle));
      if (!page) continue;
      const fileName = parsePokewikiCardImage(revisionContent(page));
      if (!fileName) continue;
      matched++;
      enqueueNext.push({
        source: 'pokewiki',
        queue: POKEWIKI_IMAGE_QUEUE,
        entityType: 'pokewiki_card_image',
        scopeKey: `de:card:${card.tcgdexCardId}`,
        params: {
          lang: 'de',
          tcgdexCardId: card.tcgdexCardId,
          cardName: card.cardName,
          setName: card.setName,
          localId: card.localId,
          pageTitle: page.title,
          pageUrl: pageUrl(page.title!),
          fileName,
          url: imageRedirectUrl(fileName),
        },
        maxAttempts: 5,
      });
    }

    return {
      outcome: 'success',
      final: 'succeeded',
      sourceIdentity: 'pokewiki:de',
      httpStatus: res.status,
      requestMethod: 'GET',
      requestUrl: url,
      requestParams: { requested: cards.length, matched },
      responseHeaders: res.headers,
      durationMs: res.durationMs,
      object: { source: 'pokewiki', mediaKind: 'json', mediaType: 'application/json', ext: 'json', body: res.body },
      enqueueNext,
    };
  };
}

function fileMetadataUrl(cards: PokewikiCardCandidate[]): string {
  const titles = cards.flatMap((card) => pokewikiFileNameCandidates(card.cardName, card.setName, card.localId))
    .map((name) => `Datei:${name}`);
  const url = new URL(POKEWIKI_API);
  url.search = new URLSearchParams({
    action: 'query',
    format: 'json',
    formatversion: '2',
    redirects: '1',
    prop: 'imageinfo',
    iiprop: 'url|mime|size',
    titles: titles.join('|'),
  }).toString();
  return url.toString();
}

export function createPokewikiFileMetadataCollector(deps: PokewikiImageDeps): Collector {
  return async (_db, item) => {
    const { cards } = JSON.parse(item.params_json) as MetadataParams;
    const url = fileMetadataUrl(cards);
    await deps.rateLimiter();
    const res = await fetchRaw(url);
    const httpClass = classifyHttpStatus(res.status);
    if (httpClass !== 'success') {
      return {
        outcome: 'failure',
        final: httpClass === 'permanent' ? 'permanent_failed' : 'retryable_failed',
        sourceIdentity: 'pokewiki:de',
        httpStatus: res.status,
        requestMethod: 'GET',
        requestUrl: url,
        responseHeaders: res.headers,
        durationMs: res.durationMs,
        errorMessage: `HTTP ${res.status} fetching PokéWiki file metadata batch`,
      };
    }
    let parsed: WikiQueryResponse;
    try {
      parsed = JSON.parse(res.body.toString('utf8')) as WikiQueryResponse;
    } catch (error) {
      return {
        outcome: 'schema_drift',
        final: 'permanent_failed',
        sourceIdentity: 'pokewiki:de',
        httpStatus: res.status,
        requestMethod: 'GET',
        requestUrl: url,
        responseHeaders: res.headers,
        durationMs: res.durationMs,
        object: { source: 'pokewiki', mediaKind: 'json', mediaType: 'application/json', ext: 'json', body: res.body },
        errorMessage: `Failed to parse PokéWiki file metadata JSON: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const files = new Map(pageList(parsed)
      .filter((page) => !page.missing && page.title && page.imageinfo?.[0]?.url)
      .map((page) => [wikiTitleKey(page.title!.replace(/^Datei:/i, '')), page]));
    const enqueueNext = [];
    let matched = 0;
    for (const card of cards) {
      const fileName = pokewikiFileNameCandidates(card.cardName, card.setName, card.localId)
        .find((candidate) => files.has(wikiTitleKey(candidate)));
      if (!fileName) continue;
      const file = files.get(wikiTitleKey(fileName))!;
      const info = file.imageinfo![0]!;
      matched++;
      enqueueNext.push({
        source: 'pokewiki',
        queue: POKEWIKI_IMAGE_QUEUE,
        entityType: 'pokewiki_card_image',
        scopeKey: `de:card:${card.tcgdexCardId}`,
        params: {
          lang: 'de', tcgdexCardId: card.tcgdexCardId, cardName: card.cardName,
          setName: card.setName, localId: card.localId,
          pageTitle: file.title, pageUrl: info.descriptionurl ?? pageUrl(file.title!),
          fileName: file.title!.replace(/^Datei:/i, ''), url: info.url,
          width: info.width, height: info.height, declaredMime: info.mime,
        },
        maxAttempts: 5,
      });
    }
    return {
      outcome: 'success',
      final: 'succeeded',
      sourceIdentity: 'pokewiki:de',
      httpStatus: res.status,
      requestMethod: 'GET',
      requestUrl: url,
      requestParams: { requested: cards.length, matched },
      responseHeaders: res.headers,
      durationMs: res.durationMs,
      object: { source: 'pokewiki', mediaKind: 'json', mediaType: 'application/json', ext: 'json', body: res.body },
      enqueueNext,
    };
  };
}

function imageFormat(mediaType: string | undefined, finalUrl: string): { mediaType: string; ext: string } | null {
  const type = mediaType?.split(';')[0]?.trim().toLowerCase();
  if (type === 'image/jpeg') return { mediaType: type, ext: 'jpg' };
  if (type === 'image/png') return { mediaType: type, ext: 'png' };
  if (type === 'image/webp') return { mediaType: type, ext: 'webp' };
  if (type === 'image/gif') return { mediaType: type, ext: 'gif' };
  const extension = new URL(finalUrl).pathname.split('.').at(-1)?.toLowerCase();
  if (extension === 'jpg' || extension === 'jpeg') return { mediaType: 'image/jpeg', ext: 'jpg' };
  if (extension === 'png') return { mediaType: 'image/png', ext: 'png' };
  if (extension === 'webp') return { mediaType: 'image/webp', ext: 'webp' };
  if (extension === 'gif') return { mediaType: 'image/gif', ext: 'gif' };
  return null;
}

export function createPokewikiImageCollector(deps: PokewikiImageDeps): Collector {
  return async (_db, item): Promise<CollectorOutcome> => {
    const params = JSON.parse(item.params_json) as { url: string; pageUrl: string; fileName: string };
    await deps.rateLimiter();
    const res = await fetchRaw(params.url);
    const httpClass = classifyHttpStatus(res.status);
    if (httpClass !== 'success') {
      return {
        outcome: 'failure',
        final: httpClass === 'permanent' ? 'permanent_failed' : 'retryable_failed',
        sourceIdentity: 'pokewiki:de',
        httpStatus: res.status,
        requestMethod: 'GET',
        requestUrl: res.url,
        requestParams: { sourcePage: params.pageUrl, fileName: params.fileName },
        responseHeaders: res.headers,
        durationMs: res.durationMs,
        errorMessage: `HTTP ${res.status} fetching PokéWiki image ${params.fileName}`,
      };
    }
    const format = imageFormat(res.headers['content-type'], res.url);
    if (!format) {
      return {
        outcome: 'schema_drift',
        final: 'permanent_failed',
        sourceIdentity: 'pokewiki:de',
        httpStatus: res.status,
        requestMethod: 'GET',
        requestUrl: res.url,
        requestParams: { sourcePage: params.pageUrl, fileName: params.fileName },
        responseHeaders: res.headers,
        durationMs: res.durationMs,
        errorMessage: `PokéWiki returned non-image content for ${params.fileName}`,
      };
    }
    return {
      outcome: 'success',
      final: 'succeeded',
      sourceIdentity: 'pokewiki:de',
      httpStatus: res.status,
      requestMethod: 'GET',
      requestUrl: res.url,
      requestParams: { sourcePage: params.pageUrl, fileName: params.fileName },
      responseHeaders: res.headers,
      durationMs: res.durationMs,
      object: { source: 'pokewiki', mediaKind: 'image', mediaType: format.mediaType, ext: format.ext, body: res.body },
    };
  };
}

export function seedMissingGermanPokewikiImages(db: DatabaseSync): { cards: number; batches: number } {
  const rows = db.prepare(`SELECT sr.source_key tcgdex_card_id,c.name card_name,s.name set_name,c.local_id
    FROM cards c JOIN sets s ON s.set_id=c.set_id
    JOIN source_records sr ON sr.source_record_id=c.source_record_id
    WHERE s.language='de' AND sr.source='tcgdex'
      AND NOT EXISTS(SELECT 1 FROM assets a WHERE a.target_type='card' AND a.target_id=c.card_id AND a.object_hash IS NOT NULL)
    ORDER BY s.source_set_id,c.local_sort_key`).all() as unknown as Array<{
      tcgdex_card_id: string; card_name: string; set_name: string; local_id: string;
    }>;

  let batches = 0;
  for (let index = 0; index < rows.length; index += POKEWIKI_BATCH_SIZE) {
    const cards = rows.slice(index, index + POKEWIKI_BATCH_SIZE).map((row) => ({
      tcgdexCardId: row.tcgdex_card_id,
      cardName: row.card_name,
      setName: row.set_name,
      localId: row.local_id,
      pageTitle: buildPokewikiCardPageTitle(row.card_name, row.set_name, row.local_id),
    }));
    const hash = createHash('sha256').update(cards.map((card) => card.tcgdexCardId).join('|')).digest('hex').slice(0, 16);
    enqueueWorkItem(db, {
      source: 'pokewiki',
      queue: POKEWIKI_METADATA_QUEUE,
      entityType: 'pokewiki_card_metadata_batch',
      scopeKey: `de:batch:${hash}`,
      params: { cards },
      maxAttempts: 5,
    });
    batches++;
  }
  return { cards: rows.length, batches };
}

export function seedMissingGermanPokewikiFiles(db: DatabaseSync): { cards: number; batches: number } {
  const rows = db.prepare(`SELECT sr.source_key tcgdex_card_id,c.name card_name,s.name set_name,c.local_id
    FROM cards c JOIN sets s ON s.set_id=c.set_id
    JOIN source_records sr ON sr.source_record_id=c.source_record_id
    WHERE s.language='de' AND sr.source='tcgdex'
      AND NOT EXISTS(SELECT 1 FROM assets a WHERE a.target_type='card' AND a.target_id=c.card_id AND a.object_hash IS NOT NULL)
    ORDER BY s.source_set_id,c.local_sort_key`).all() as unknown as Array<{
      tcgdex_card_id: string; card_name: string; set_name: string; local_id: string;
    }>;
  let batches = 0;
  // Each card normally contributes three file titles; keep MediaWiki's title
  // list below the ordinary user's 50-title request limit.
  const batchSize = 15;
  for (let index = 0; index < rows.length; index += batchSize) {
    const cards = rows.slice(index, index + batchSize).map((row) => ({
      tcgdexCardId: row.tcgdex_card_id,
      cardName: row.card_name,
      setName: row.set_name,
      localId: row.local_id,
      pageTitle: buildPokewikiCardPageTitle(row.card_name, row.set_name, row.local_id),
    }));
    const hash = createHash('sha256').update(cards.map((card) => card.tcgdexCardId).join('|')).digest('hex').slice(0, 16);
    enqueueWorkItem(db, {
      source: 'pokewiki', queue: POKEWIKI_FILE_METADATA_QUEUE,
      entityType: 'pokewiki_file_metadata_batch', scopeKey: `de:file-batch:${hash}`,
      params: { cards }, maxAttempts: 5,
    });
    batches++;
  }
  return { cards: rows.length, batches };
}

export function materializePokewikiImages(db: DatabaseSync, at = new Date().toISOString()): { linked: number; skipped: number } {
  const rows = db.prepare(`SELECT o.observation_id,o.hash,o.scope_key,a.request_url,ro.media_type
    FROM observations o JOIN attempts a ON a.attempt_id=o.attempt_id JOIN raw_objects ro ON ro.hash=o.hash
    WHERE o.entity_type='pokewiki_card_image' AND NOT EXISTS(
      SELECT 1 FROM observations newer WHERE newer.entity_type=o.entity_type AND newer.scope_key=o.scope_key
        AND newer.observation_id>o.observation_id)
    ORDER BY o.scope_key`).all() as unknown as Array<{
      observation_id: number; hash: string; scope_key: string; request_url: string; media_type: string;
    }>;
  let linked = 0;
  let skipped = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const row of rows) {
      const match = /^de:card:(.+)$/.exec(row.scope_key);
      if (!match || !row.request_url) { skipped++; continue; }
      const sourceKey = match[1]!;
      const target = db.prepare(`SELECT sl.target_id FROM source_records sr JOIN source_links sl ON sl.source_record_id=sr.source_record_id
        WHERE sr.source='tcgdex' AND sr.namespace='de' AND sr.source_key=? AND sl.target_type='card'
          AND sl.match_status IN ('matched','manual') ORDER BY sl.source_link_id DESC LIMIT 1`).get(sourceKey) as { target_id: number } | undefined;
      if (!target) { skipped++; continue; }
      const sourceRecordId = (db.prepare(`INSERT INTO source_records
        (source,namespace,source_key,entity_type,language,latest_observation_id,first_seen_at,last_seen_at,parser_name,parser_version)
        VALUES ('pokewiki','de',?,'card_image','de',?,?,?,'pokewiki-image-materializer','1')
        ON CONFLICT(source,namespace,source_key) DO UPDATE SET latest_observation_id=excluded.latest_observation_id,
          last_seen_at=excluded.last_seen_at,parser_name=excluded.parser_name,parser_version=excluded.parser_version
        RETURNING source_record_id`).get(sourceKey, row.observation_id, at, at) as { source_record_id: number }).source_record_id;
      db.prepare(`INSERT INTO source_links
        (source_record_id,target_type,target_id,match_status,confidence,match_method,first_seen_at,last_seen_at)
        VALUES (?,'card',?,'matched',1,'pokewiki-exact-card-page',?,?)
        ON CONFLICT(source_record_id,target_type,target_id) DO UPDATE SET match_status='matched',confidence=1,
          match_method='pokewiki-exact-card-page',last_seen_at=excluded.last_seen_at`).run(sourceRecordId, target.target_id, at, at);
      db.prepare(`UPDATE assets SET is_primary=0,updated_at=? WHERE target_type='card' AND target_id=?`).run(at, target.target_id);
      db.prepare(`INSERT INTO assets
        (source_record_id,target_type,target_id,object_hash,url,rendition,media_type,is_primary,created_at,updated_at)
        VALUES (?,'card',?,?,?,'original',?,1,?,?)
        ON CONFLICT(target_type,target_id,url,rendition) DO UPDATE SET source_record_id=excluded.source_record_id,
          object_hash=excluded.object_hash,media_type=excluded.media_type,is_primary=1,updated_at=excluded.updated_at`)
        .run(sourceRecordId, target.target_id, row.hash, row.request_url, row.media_type, at, at);
      db.prepare(`UPDATE cards SET image_url=COALESCE(image_url,?),updated_at=? WHERE card_id=?`)
        .run(row.request_url, at, target.target_id);
      db.prepare(`INSERT INTO parser_executions
        (parser_name,parser_version,observation_id,executed_at,outcome,output_summary_json)
        VALUES ('pokewiki-image-materializer','1',?,?,'success',?)
        ON CONFLICT(parser_name,parser_version,observation_id) DO UPDATE SET executed_at=excluded.executed_at,
          outcome='success',output_summary_json=excluded.output_summary_json`)
        .run(row.observation_id, at, JSON.stringify({ targetType: 'card', targetId: target.target_id, sourceKey }));
      linked++;
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { linked, skipped };
}
