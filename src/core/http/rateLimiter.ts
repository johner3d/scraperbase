export interface RateLimiterOptions {
  minDelayMs: number;
  jitterMs: number;
}

export type RateLimiter = () => Promise<void>;

/**
 * A minimum-spacing gate shared across all workers hitting one source: each
 * call to the returned function resolves only once at least `minDelayMs`
 * (plus a little jitter) has passed since the previous call was granted.
 * This -- not per-worker delays -- is what actually caps request rate,
 * since worker concurrency alone doesn't bound how bursty requests are.
 */
export function createRateLimiter(opts: RateLimiterOptions): RateLimiter {
  let nextAvailable = 0;
  return async function acquire(): Promise<void> {
    const now = Date.now();
    const jitter = Math.random() * opts.jitterMs;
    const scheduled = Math.max(now, nextAvailable) + jitter;
    nextAvailable = Math.max(now, nextAvailable) + opts.minDelayMs;
    const waitMs = scheduled - now;
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
  };
}
