import type { DatabaseSync } from 'node:sqlite';
import type { Page } from 'playwright';
import type { Collector } from '../../../core/queue/runner.ts';
import { enqueueWorkItem } from '../../../core/queue/scheduler.ts';
import { classifyHttpStatus } from '../../../core/http/fetchClient.ts';
import type { RateLimiter } from '../../../core/http/rateLimiter.ts';
import { PSA_BASE } from '../config.ts';
import { certScopeKey } from '../scopeKeys.ts';

const CERT_EVALUATE_TIMEOUT_MS=30_000;

/**
 * Resolves a PSA certification number to the graded card's spec.
 *
 * eBay sellers of graded singles frequently publish the cert number as a
 * standard item-specific (791 of the stored PSA-10 listings carry one). PSA's
 * own cert lookup turns that number into the SpecID it was graded under, and
 * `psa_specs` already maps ~23,000 of those SpecIDs to a catalogue variant --
 * including the finish and 1st-edition detail that no listing text ever states
 * reliably.
 *
 * That makes this the only exact path in the whole eBay pipeline, and its
 * results double as a labelled evaluation set: any listing the scored matcher
 * resolved differently from its own cert is a real precision failure, not a
 * judgement call. See `npm run cli -- ebay-match-report`.
 */

export interface CertDeps {
  /**
   * A page from the authenticated, Cloudflare-cleared PSA profile (see
   * browser/profile.ts). A plain Node fetch is blocked by PSA's Cloudflare
   * check; the request has to run in-page to carry its cookies.
   */
  page: Page;
  /** Optional lifecycle hook used by long-running queues. It may recreate a
   * page when the visible browser was closed or Chromium crashed. */
  getPage?: () => Promise<Page>;
  rateLimiter: RateLimiter;
}

export function certLookupUrl(certNumber: string): string {
  return `${PSA_BASE}/cert/${encodeURIComponent(certNumber)}`;
}

/**
 * Seeds one lookup per distinct certification number seen on a PSA-10 eBay
 * listing that is not already resolved. Cert numbers repeat across relistings
 * of the same slab, so the queue is keyed on the number rather than on the
 * listing.
 */
export function seedPsaCertLookups(db: DatabaseSync, limit = 5000): number {
  const rows = db.prepare(`SELECT DISTINCT cert_number FROM ebay_listings
    WHERE cert_number IS NOT NULL AND TRIM(cert_number) <> ''
      AND match_method IS NOT 'ebay-psa-cert'
    LIMIT ?`).all(limit) as unknown as Array<{ cert_number: string }>;
  let seeded = 0;
  for (const row of rows) {
    const certNumber = row.cert_number.trim();
    if (!/^\d{5,12}$/.test(certNumber)) continue;
    enqueueWorkItem(db, {
      source: 'psa',
      queue: 'psa_cert',
      entityType: 'cert',
      scopeKey: certScopeKey(certNumber),
      params: { certNumber },
    });
    seeded += 1;
  }
  return seeded;
}

export function createPsaCertCollector(deps: CertDeps): Collector {
  return async (_db, item) => {
    const { certNumber } = JSON.parse(item.params_json) as { certNumber: string };
    const requestUrl = certLookupUrl(certNumber);
    const sourceIdentity = `psa:cert:${certNumber}`;

    await deps.rateLimiter();
    const page=deps.getPage?await deps.getPage():deps.page;
    const start = Date.now();
    const result = await new Promise<{status:number;body:string}>((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error(`PSA cert request timed out after ${CERT_EVALUATE_TIMEOUT_MS}ms`)),CERT_EVALUATE_TIMEOUT_MS);
      page.evaluate(async (url: string) => {
        const res = await fetch(url, { headers: { Accept: 'text/html' } });
        return { status: res.status, body: await res.text() };
      }, requestUrl).then((value)=>{clearTimeout(timer);resolve(value);},(error)=>{clearTimeout(timer);reject(error);});
    });
    const durationMs = Date.now() - start;
    const body = Buffer.from(result.body, 'utf8');
    const httpClass = classifyHttpStatus(result.status);

    if (httpClass !== 'success') {
      return {
        outcome: 'failure',
        final: httpClass === 'permanent' ? 'permanent_failed' : 'retryable_failed',
        sourceIdentity,
        httpStatus: result.status,
        requestMethod: 'GET',
        requestUrl,
        durationMs,
        // The error body is stored like any other response: a cert that PSA
        // does not recognise is evidence about the listing, not a lost fetch.
        object: { source: 'psa', mediaKind: 'html', mediaType: 'text/html', ext: 'html', body },
        errorMessage: `HTTP ${result.status} looking up PSA cert ${certNumber}`,
      };
    }

    return {
      outcome: 'success',
      final: 'succeeded',
      sourceIdentity,
      httpStatus: result.status,
      requestMethod: 'GET',
      requestUrl,
      requestParams: { certNumber },
      durationMs,
      object: { source: 'psa', mediaKind: 'html', mediaType: 'text/html', ext: 'html', body },
      errorMessage: extractSpecId(result.body) == null ? `cert ${certNumber} page carried no SpecID` : undefined,
    };
  };
}

/**
 * Pulls the SpecID out of a stored cert page.
 *
 * PSA links the cert to its population report and price guide through the
 * spec, and the id appears in those hrefs (`/spec/psa/2388970`,
 * `/pop/.../card/2388970`) as well as in the page's embedded JSON payload.
 * All three forms are tried rather than one, because PSA changes the page
 * template far more often than it changes those routes.
 */
export function extractSpecId(html: string): string | null {
  const patterns = [
    /"specId"\s*:\s*"?(\d{4,})"?/i,
    /"SpecID"\s*:\s*"?(\d{4,})"?/,
    /\/spec\/psa\/(\d{4,})/i,
    /\/pop\/[^"']*\/card\/(\d{4,})/i,
    /\/cardfacts\/[^"']*\/card\/(\d{4,})/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (match) return match[1]!;
  }
  return null;
}
