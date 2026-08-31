import type { DatabaseSync } from 'node:sqlite';
import type { Page } from 'playwright';
import type { Collector } from '../../../core/queue/runner.ts';
import { enqueueWorkItem } from '../../../core/queue/scheduler.ts';
import { classifyHttpStatus } from '../../../core/http/fetchClient.ts';
import { looksLikeCloudflareChallenge } from '../rawFetch.ts';
import type { RateLimiter } from '../../../core/http/rateLimiter.ts';
import { PSA_BASE, POP_ROOT_CATEGORY_ID, POP_ROOT_URL } from '../config.ts';
import { popCategoryScopeKey, popYearScopeKey, popSetItemsScopeKey } from '../scopeKeys.ts';

// Native discovery of PSA's own population-report "headings" (its term for
// a set, in this part of the site) -- replaces depending on the sibling
// `clean_rewrite` project's hand-curated set list. PSA's /pop/tcg-cards
// tree is a 3-level crawl, confirmed live 2026-08-29:
//   /pop/tcg-cards/156940                      (root: every TCG, not just Pokemon)
//     -> /pop/tcg-cards/{year}/{yearHeadingId}  (one page per year)
//       -> /pop/tcg-cards/{year}/{slug}/{headingId}  (one page per set/heading)
// Each leaf headingId is fed to /Pop/GetSetItems (see setItems.ts) to get
// every card + variety + population count in that heading in one call.

export interface PopDiscoveryDeps {
  /** A Page belonging to the authenticated, Cloudflare-cleared PSA profile. */
  page: Page;
  rateLimiter: RateLimiter;
}

interface DiscoveredLink {
  href: string;
  text: string;
}

/** Fetches a PSA page's rendered HTML via the authenticated page's own fetch (carries cookies). */
async function fetchHtml(page: Page, url: string): Promise<{ status: number; body: string }> {
  return page.evaluate(async (u) => {
    const res = await fetch(u, { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
    return { status: res.status, body: await res.text() };
  }, url);
}

/** Parses `<a href="...">text</a>` pairs for links under /pop/tcg-cards/. */
function parsePopLinks(html: string): DiscoveredLink[] {
  const re = /<a[^>]+href=["'](\/pop\/tcg-cards\/[^"']+)["'][^>]*>([^<]*)</g;
  const found = new Map<string, string>();
  let match: RegExpExecArray | null;
  while ((match = re.exec(html))) {
    const href = match[1]!;
    const text = match[2]!.trim();
    if (!found.has(href)) found.set(href, text);
  }
  return [...found].map(([href, text]) => ({ href, text }));
}

/** `/pop/tcg-cards/{year}/{yearHeadingId}` -- exactly two path segments after the prefix. */
function isYearLink(href: string): { year: string; yearHeadingId: string } | null {
  const match = /^\/pop\/tcg-cards\/([^/]+)\/(\d+)$/.exec(href);
  return match ? { year: match[1]!, yearHeadingId: match[2]! } : null;
}

/** `/pop/tcg-cards/{year}/{slug}/{headingId}` -- exactly three path segments after the prefix. */
function isHeadingLink(href: string): { year: string; slug: string; headingId: string } | null {
  const match = /^\/pop\/tcg-cards\/([^/]+)\/([^/]+)\/(\d+)$/.exec(href);
  return match ? { year: match[1]!, slug: match[2]!, headingId: match[3]! } : null;
}

function looksLikePokemon(slug: string, text: string): boolean {
  return /pokemon/i.test(slug) || /pok[eé]mon/i.test(text);
}

/**
 * Handles both `pop_category` (the root -- fans out one work item per year)
 * and `pop_year` (a year page -- fans out one work item per Pokemon heading
 * found on it) entity types on the `psa_pop_discovery` queue.
 */
function upsertHeadingStub(db: DatabaseSync, args: { headingId: string; name: string; slug: string; year: string }, at: string): void {
  db.prepare(
    `INSERT INTO psa_set_map (psa_heading_id, psa_heading_name, psa_heading_slug, psa_heading_year, language, match_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'en', 'unmatched', ?, ?)
     ON CONFLICT(psa_heading_id) DO UPDATE SET psa_heading_name = excluded.psa_heading_name,
       psa_heading_slug = excluded.psa_heading_slug, psa_heading_year = excluded.psa_heading_year, updated_at = excluded.updated_at`,
  ).run(Number(args.headingId), args.name, args.slug, args.year, at, at);
}

export function createPsaPopDiscoveryCollector(deps: PopDiscoveryDeps): Collector {
  return async (db, item) => {
    const params = JSON.parse(item.params_json) as { url: string; year?: string };
    const requestUrl = params.url;
    const sourceIdentity = `psa:${item.entity_type}:${item.scope_key}`;

    await deps.rateLimiter();
    const start = Date.now();
    const result = await fetchHtml(deps.page, requestUrl);
    const durationMs = Date.now() - start;
    const body = Buffer.from(result.body, 'utf8');
    const httpClass = classifyHttpStatus(result.status);

    if (httpClass !== 'success') {
      return {
        outcome: 'failure',
        final: httpClass === 'permanent' ? 'permanent_failed' : 'retryable_failed',
        sourceIdentity,
        httpStatus: result.status,
        requestUrl,
        durationMs,
        errorMessage: `HTTP ${result.status} fetching ${requestUrl}`,
      };
    }

    if (looksLikeCloudflareChallenge(result.body)) {
      return {
        outcome: 'failure', final: 'retryable_failed', sourceIdentity,
        httpStatus: result.status, requestUrl, durationMs,
        errorMessage: `Cloudflare challenge fetching ${requestUrl}`,
      };
    }

    const links = parsePopLinks(result.body);

    if (item.entity_type === 'pop_category') {
      const years = links.map((l) => isYearLink(l.href)).filter((v): v is { year: string; yearHeadingId: string } => v !== null);
      const enqueueNext = years.map((y) => ({
        source: 'psa',
        queue: 'psa_pop_discovery',
        entityType: 'pop_year',
        scopeKey: popYearScopeKey(y.yearHeadingId),
        params: { url: `${PSA_BASE}/pop/tcg-cards/${y.year}/${y.yearHeadingId}`, year: y.year },
      }));
      return {
        outcome: 'success',
        final: 'succeeded',
        sourceIdentity,
        httpStatus: result.status,
        requestUrl,
        durationMs,
        object: { source: 'psa', mediaKind: 'html', mediaType: 'text/html', ext: 'html', body },
        enqueueNext,
      };
    }

    // pop_year: filter to headings that look like Pokemon TCG sets.
    const headings = links
      .map((l) => ({ link: l, parsed: isHeadingLink(l.href) }))
      .filter((v): v is { link: DiscoveredLink; parsed: { year: string; slug: string; headingId: string } } => v.parsed !== null)
      .filter((v) => looksLikePokemon(v.parsed.slug, v.link.text));

    const at = new Date().toISOString();
    for (const h of headings) {
      upsertHeadingStub(db, { headingId: h.parsed.headingId, name: h.link.text, slug: h.parsed.slug, year: h.parsed.year }, at);
    }
    const enqueueNext = headings.map((h) => ({
      source: 'psa',
      queue: 'psa_pop_set_items',
      entityType: 'pop_set_items',
      scopeKey: popSetItemsScopeKey(h.parsed.headingId),
      params: { headingId: h.parsed.headingId, name: h.link.text, slug: h.parsed.slug, year: h.parsed.year },
    }));

    return {
      outcome: 'success',
      final: 'succeeded',
      sourceIdentity,
      httpStatus: result.status,
      requestUrl,
      durationMs,
      object: { source: 'psa', mediaKind: 'html', mediaType: 'text/html', ext: 'html', body },
      enqueueNext,
    };
  };
}

/** Enqueues the single root work item that kicks off the whole discovery crawl. */
export function seedPsaPopDiscovery(db: DatabaseSync): void {
  enqueueWorkItem(db, {
    source: 'psa',
    queue: 'psa_pop_discovery',
    entityType: 'pop_category',
    scopeKey: popCategoryScopeKey(POP_ROOT_CATEGORY_ID),
    params: { url: POP_ROOT_URL },
  });
}
