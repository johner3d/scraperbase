import { POKEMONCARD_DETAIL_BASE, POKEMONCARD_SEARCH_API, pokemonCardGetJson, pokemonCardGetText } from './config.ts';

export interface CardLookupInput {
  name: string;
  setName: string;
  localId: string;
  sourceSetId: string;
}

export interface CardImageMatch {
  method: string;
  imageUrl: string;
  cardID: string;
  folder: string;
}

interface Candidate {
  cardID: string;
  folder: string;
  thumb: string;
}

interface SearchResponse {
  maxPage?: number;
  cardList?: Array<{ cardID: string; cardThumbFile: string }>;
}

function toCandidates(response: SearchResponse): Candidate[] {
  return (response.cardList ?? []).flatMap((c) => {
    const m = /\/large\/([^/]+)\/(\d+)_/.exec(c.cardThumbFile);
    return m ? [{ cardID: c.cardID, folder: m[1]!, thumb: c.cardThumbFile }] : [];
  });
}

const MAX_PAGES = 15;

async function searchByName(name: string): Promise<Candidate[]> {
  // The API returns zero results if `pg` is present at all on page 1 --
  // it must be omitted (empty string) there and only numeric from page 2 on.
  const build = (page: number) =>
    `${POKEMONCARD_SEARCH_API}?${new URLSearchParams({ keyword: name, se_ta: '', regulation_sidebar_form: 'all', pg: page > 1 ? String(page) : '', illust: '', sm_and_keyword: 'true' })}`;
  const first = (await pokemonCardGetJson(build(1))) as SearchResponse;
  let all = toCandidates(first);
  const maxPage = Math.min(first.maxPage ?? 1, MAX_PAGES);
  for (let page = 2; page <= maxPage; page++) {
    const data = (await pokemonCardGetJson(build(page))) as SearchResponse;
    all = all.concat(toCandidates(data));
  }
  return all;
}

function stripHtml(html: string): string[] {
  return html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, '\n').replace(/&nbsp;/g, ' ')
    .split('\n').map((line) => line.trim()).filter(Boolean);
}

const detailCache = new Map<string, string>();
async function fetchDetailHtml(cardID: string): Promise<string> {
  const cached = detailCache.get(cardID);
  if (cached !== undefined) return cached;
  const { text } = await pokemonCardGetText(`${POKEMONCARD_DETAIL_BASE}/${cardID}/regulation/all`);
  detailCache.set(cardID, text);
  return text;
}

async function printedNumber(cardID: string): Promise<string | null> {
  const numLine = stripHtml(await fetchDetailHtml(cardID)).find((line) => /^\d{3}\s*\/\s*\d+/.test(line));
  return numLine ? numLine.split('/')[0]!.trim() : null;
}

/**
 * Every card detail page links to its boxed product with anchor text
 * "{category label}「{core product name}」" (e.g. ハイクラスパック「GXウルトラ
 * シャイニー」). The product's own URL varies by era -- older Sun & Moon-era
 * products live at /products/{series}/{code}.html, newer ones at /ex/{code}/
 * -- so reading the anchor TEXT directly off any candidate's own detail page
 * sidesteps guessing which URL scheme applies (guessing /ex/ for an old-era
 * product just 404s and looks like "no boxed product exists").
 */
async function productNameFromDetail(cardID: string): Promise<string | null> {
  const anchor = /<a[^>]*href="[^"]*"[^>]*>([^<]*「[^」]+」[^<]*)<\/a>/.exec(await fetchDetailHtml(cardID));
  return anchor?.[1]?.trim() ?? null;
}

function normalizeSetName(value: string): string {
  return value.replace(/[「」『』]/g, '').replace(/＆/g, '&').replace(/\s+/g, '').trim();
}

/**
 * The official title is "{category label}「{core product name}」｜..." (e.g.
 * "ハイクラスパック「タッグオールスターズ」｜..."), and the core name often
 * drops words TCGdex's set name keeps (e.g. "TAG TEAM GX タッグオールスターズ"
 * vs. official "タッグオールスターズ") or vice versa. Comparing just the
 * bracketed core both ways catches that instead of requiring an exact title.
 */
function coreTitle(pageTitle: string): string {
  const bracketed = /「([^」]+)」/.exec(pageTitle);
  return bracketed ? bracketed[1]! : pageTitle.split('｜')[0]!.trim();
}

function setNameMatches(pageTitle: string | null, ourSetName: string): boolean {
  if (!pageTitle) return false;
  const p = normalizeSetName(coreTitle(pageTitle));
  const o = normalizeSetName(ourSetName);
  return p === o || p.includes(o) || o.includes(p);
}

/** set_name -> resolved site folder, cached across an entire run so only the first card of each TCGdex set pays the discovery cost. */
const setFolderCache = new Map<string, string>();

async function resolveWithinFolder(candidates: Candidate[], folder: string, localId: string, method: string): Promise<CardImageMatch | null> {
  const inFolder = candidates.filter((c) => c.folder === folder);
  if (inFolder.length === 1) return { method, imageUrl: inFolder[0]!.thumb, cardID: inFolder[0]!.cardID, folder };
  for (const candidate of inFolder) {
    if ((await printedNumber(candidate.cardID)) === localId) {
      return { method: `${method}+number`, imageUrl: candidate.thumb, cardID: candidate.cardID, folder };
    }
  }
  return null;
}

/**
 * Promo "sets" aren't sold as boxed products (no /ex/ page to confirm
 * against), but the site's own promo folder code equals TCGdex's promo
 * source_set_id (both are "SV-P", "M-P", etc.), so an exact folder match is
 * trustworthy without a product-name lookup.
 */
function isPromoSet(sourceSetId: string): boolean {
  return sourceSetId.endsWith('-P');
}

export async function matchCardImage(input: CardLookupInput): Promise<CardImageMatch | null> {
  const candidates = await searchByName(input.name);
  if (!candidates.length) return null;

  if (isPromoSet(input.sourceSetId) && candidates.some((c) => c.folder === input.sourceSetId)) {
    const hit = await resolveWithinFolder(candidates, input.sourceSetId, input.localId, 'promo-exact-folder');
    if (hit) return hit;
  }

  const cachedFolder = setFolderCache.get(input.setName);
  if (cachedFolder) {
    const hit = await resolveWithinFolder(candidates, cachedFolder, input.localId, 'cached-folder');
    if (hit) return hit;
  }

  for (const folder of new Set(candidates.map((c) => c.folder))) {
    if (folder === cachedFolder) continue;
    const representative = candidates.find((c) => c.folder === folder)!;
    const productName = await productNameFromDetail(representative.cardID);
    if (!setNameMatches(productName, input.setName)) continue;
    setFolderCache.set(input.setName, folder);
    const hit = await resolveWithinFolder(candidates, folder, input.localId, 'discovered-folder');
    if (hit) return hit;
  }
  return null;
}
