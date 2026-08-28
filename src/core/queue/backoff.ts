export interface BackoffOptions {
  baseMs: number;
  capMs: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = { baseMs: 1_000, capMs: 5 * 60 * 1_000 };

/** Exponential backoff with full jitter: random(0, min(cap, base * 2^attempt)). */
export function computeBackoffMs(attempt: number, opts: BackoffOptions = DEFAULT_BACKOFF): number {
  const upperBound = Math.min(opts.capMs, opts.baseMs * 2 ** Math.max(0, attempt));
  return Math.floor(Math.random() * upperBound);
}
