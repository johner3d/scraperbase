import { createRateLimiter, type RateLimiter } from '../../core/http/rateLimiter.ts';

/**
 * The single min-spacing gate for every request to psacard.com.
 *
 * Cert lookups, pop-tree discovery, and population/sales enrichment all hit the
 * same host behind the same Cloudflare session. Each used to build its own
 * per-tick `createRateLimiter`, so three stages could each fire a request in the
 * same instant and the spacing reset every tick. One shared instance means the
 * combined PSA request rate is actually bounded and spacing survives across
 * ticks.
 */
export const psaRateLimiter: RateLimiter = createRateLimiter({ minDelayMs: 600, jitterMs: 300 });
