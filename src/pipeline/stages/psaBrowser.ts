import { existsSync } from 'node:fs';
import type { BrowserContext, Page } from 'playwright';
import { PSA_PROFILE_DIR } from '../../core/config/config.ts';
import { launchPsaProfile } from '../../sources/psa/browser/profile.ts';
import { isPsaSignInUrl, looksLikeCloudflareChallenge, PsaSessionExpiredError } from '../../sources/psa/rawFetch.ts';
import type { StagePause } from './types.ts';

export const PSA_SESSION_PAUSE: StagePause = {
  source: 'psa',
  reason: 'PSA session expired -- run: npm run cli -- pipeline psa-login',
  resumeAfter: null,
};

export const PSA_CLOUDFLARE_PAUSE: StagePause = {
  source: 'psa',
  reason: 'PSA Cloudflare challenge did not clear -- run: npm run cli -- pipeline psa-login (solve the check, then close)',
  resumeAfter: null,
};

/** Thrown when the shared tab is stuck on Cloudflare's "Just a moment..." page. */
export class PsaCloudflareError extends Error {
  constructor() { super(PSA_CLOUDFLARE_PAUSE.reason); this.name = 'PsaCloudflareError'; }
}

/**
 * Wait for Cloudflare's non-interactive JS challenge to clear on the current
 * tab. A real headed Chrome usually passes it within a few seconds; if it
 * escalates to a CAPTCHA it never will, so give up and let the caller pause.
 */
async function clearCloudflare(target: Page, timeoutMs = 35_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const html = await target.content().catch(() => '');
    if (!looksLikeCloudflareChallenge(html)) return;
    if (Date.now() > deadline) throw new PsaCloudflareError();
    await target.waitForTimeout(2_000);
  }
}

/** Close the shared PSA browser after this long with no PSA work. */
export const PSA_BROWSER_IDLE_MS = 10 * 60_000;

export function psaProfilePresent(): boolean {
  return existsSync(PSA_PROFILE_DIR);
}

/**
 * One warm, persistent PSA browser session shared by every PSA phase.
 *
 * The three PSA phases used to each `launchPsaProfile()` + `context.close()` on
 * every tick -- three headed-Chromium cold starts + Cloudflare clearances +
 * bootstrap navigations per supervisor pass. Now they all borrow this single
 * context, which stays open across ticks and is reaped only when idle
 * (`releasePsaBrowserIfIdle`) or on supervisor shutdown (`closePsaBrowser`).
 */
let context: BrowserContext | null = null;
let page: Page | null = null;
let lastUsedAt = 0;
let launching: Promise<void> | null = null;

/** Bootstrap URL a freshly-launched shared page lands on, so in-page `fetch()`
 *  calls to psacard.com are always same-origin. */
const PSA_HOME = 'https://www.psacard.com/pop';

async function launch(): Promise<void> {
  const ctx = await launchPsaProfile({ headless: false });
  const existing = ctx.pages();
  try {
    const p = existing[0] ?? (await ctx.newPage());
    await p.goto(PSA_HOME, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
    if (isPsaSignInUrl(p.url())) throw new PsaSessionExpiredError('redirected to PSA sign-in');
    await clearCloudflare(p);
    context = ctx;
    page = p;
  } catch (error) {
    await ctx.close().catch(() => {});
    throw error;
  }
}

/**
 * Return the shared PSA page, launching (or relaunching after a crash/close)
 * the persistent context on first use. Callers must not close it.
 */
export async function getPsaPage(): Promise<Page> {
  if (context && page && !page.isClosed()) {
    lastUsedAt = Date.now();
    return page;
  }
  // Context/page gone (crash, manual close, or first call) -- (re)launch once,
  // sharing one in-flight launch between concurrent callers.
  if (!launching) {
    context = null;
    page = null;
    launching = launch().finally(() => { launching = null; });
  }
  await launching;
  if (!page) throw new Error('PSA browser failed to launch');
  lastUsedAt = Date.now();
  return page;
}

/** Navigate the shared page to `url` only when it isn't already on psacard.com. */
export async function ensureOnPsa(target: Page, url: string): Promise<void> {
  let host = '';
  try { host = new URL(target.url()).host; } catch { host = ''; }
  if (host === 'www.psacard.com') {
    // Already on-site, but the clearance cookie may have lapsed since the last
    // tick -- re-warm if the tab is showing the interstitial.
    if (looksLikeCloudflareChallenge(await target.content().catch(() => ''))) {
      await target.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
      await clearCloudflare(target);
    }
    return;
  }
  await target.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  if (isPsaSignInUrl(target.url())) throw new PsaSessionExpiredError('redirected to PSA sign-in');
  await clearCloudflare(target);
}

/** Close the shared context if no PSA phase has touched it recently. */
export async function releasePsaBrowserIfIdle(nowMs: number): Promise<void> {
  if (!context) return;
  if (nowMs - lastUsedAt < PSA_BROWSER_IDLE_MS) return;
  await closePsaBrowser();
}

export async function closePsaBrowser(): Promise<void> {
  const ctx = context;
  context = null;
  page = null;
  lastUsedAt = 0;
  if (ctx) await ctx.close().catch(() => {});
}

/**
 * Run `fn` against the shared PSA page after bootstrapping it to `bootstrapUrl`.
 * Returns `{ pause }` instead of throwing when the profile is no longer signed
 * in, closing the (now useless) context so the next `psa-login` starts clean.
 */
export async function withPsaPage<T>(
  bootstrapUrl: string,
  fn: (page: Page) => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; pause: StagePause }> {
  if (!psaProfilePresent()) return { ok: false, pause: PSA_SESSION_PAUSE };
  try {
    const target = await getPsaPage();
    await ensureOnPsa(target, bootstrapUrl);
    return { ok: true, value: await fn(target) };
  } catch (error) {
    if (error instanceof PsaSessionExpiredError) {
      await closePsaBrowser();
      return { ok: false, pause: PSA_SESSION_PAUSE };
    }
    if (error instanceof PsaCloudflareError) {
      await closePsaBrowser();
      return { ok: false, pause: PSA_CLOUDFLARE_PAUSE };
    }
    throw error;
  }
}
