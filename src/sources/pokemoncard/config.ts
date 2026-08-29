import type { RawFetchResult } from '../../core/http/fetchClient.ts';

export const POKEMONCARD_SEARCH_API = 'https://www.pokemon-card.com/card-search/resultAPI.php';
export const POKEMONCARD_DETAIL_BASE = 'https://www.pokemon-card.com/card-search/details.php/card';
export const POKEMONCARD_EX_BASE = 'https://www.pokemon-card.com/ex';

// The official site resets connections under sustained automated traffic
// more readily than a plain fan wiki does; a normal browser UA plus a
// couple of retries with backoff absorbs that instead of failing the item.
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const REQUEST_HEADERS = { 'User-Agent': USER_AGENT, Referer: 'https://www.pokemon-card.com/card-search/', 'Accept-Language': 'ja,en;q=0.5' };

export async function pokemonCardFetchRaw(url: string, attempt = 1): Promise<RawFetchResult> {
  const start = Date.now();
  try {
    const res = await fetch(url, { headers: REQUEST_HEADERS });
    const body = Buffer.from(await res.arrayBuffer());
    return { body, status: res.status, headers: {}, url, durationMs: Date.now() - start };
  } catch (err) {
    if (attempt >= 4) throw err;
    await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    return pokemonCardFetchRaw(url, attempt + 1);
  }
}

export async function pokemonCardGetJson(url: string): Promise<unknown> {
  const res = await pokemonCardFetchRaw(url);
  if (res.status !== 200) throw new Error(`HTTP ${res.status} from pokemon-card.com: ${url}`);
  return JSON.parse(res.body.toString('utf8'));
}

export async function pokemonCardGetText(url: string): Promise<{ status: number; text: string }> {
  const res = await pokemonCardFetchRaw(url);
  return { status: res.status, text: res.body.toString('utf8') };
}
