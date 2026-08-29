export interface RawFetchResult {
  body: Buffer;
  status: number;
  headers: Record<string, string>;
  url: string;
  durationMs: number;
}

// Never capture cookies/auth/set-cookie -- only headers useful for
// provenance and change-detection are recorded.
const ALLOWED_RESPONSE_HEADERS = ['content-type', 'content-length', 'last-modified', 'etag'];

export async function fetchRaw(url: string, requestHeaders: Record<string, string> = {}): Promise<RawFetchResult> {
  const start = Date.now();
  const res = await fetch(url, { headers: requestHeaders });
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
