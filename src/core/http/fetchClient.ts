import { DEFAULT_HTTP_TIMEOUT_MS } from '../config/config.ts';

export interface RawFetchResult {
  body: Buffer;
  status: number;
  headers: Record<string, string>;
  url: string;
  durationMs: number;
}

export interface RawFetchOptions {
  /** Wall-clock ceiling for the whole request. Defaults to DEFAULT_HTTP_TIMEOUT_MS. */
  timeoutMs?: number;
}

// Never capture cookies/auth/set-cookie -- only headers useful for
// provenance and change-detection are recorded.
const ALLOWED_RESPONSE_HEADERS = ['content-type', 'content-length', 'last-modified', 'etag'];

/**
 * A single outbound fetch, wrapped in an AbortSignal timeout so a stalled
 * connection can never hang a queue worker indefinitely. On timeout this throws
 * a `TimeoutError`; every caller runs inside `processItem`, whose catch turns a
 * thrown error into a `retryable_failed` transition, so backoff + `sweepQueue`
 * recover it on the next pass.
 */
export async function fetchRaw(
  url: string,
  requestHeaders: Record<string, string> = {},
  opts: RawFetchOptions = {},
): Promise<RawFetchResult> {
  const start = Date.now();
  const res = await fetch(url, {
    headers: requestHeaders,
    signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS),
  });
  const body = Buffer.from(await res.arrayBuffer());
  const headers: Record<string, string> = {};
  for (const key of ALLOWED_RESPONSE_HEADERS) {
    const value = res.headers.get(key);
    if (value !== null) headers[key] = value;
  }
  return { body, status: res.status, headers, url, durationMs: Date.now() - start };
}

export type HttpClass = 'success' | 'permanent' | 'retryable';

/** 2xx -> success; 404 and other non-429 4xx -> permanent (won't change on retry); everything else -> retryable. */
export function classifyHttpStatus(status: number): HttpClass {
  if (status >= 200 && status < 300) return 'success';
  if (status === 404 || (status >= 400 && status < 500 && status !== 429)) return 'permanent';
  return 'retryable';
}
