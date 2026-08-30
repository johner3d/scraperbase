import { existsSync } from 'node:fs';
import type { Page } from 'playwright';
import { PSA_PROFILE_DIR } from '../../core/config/config.ts';
import { launchPsaProfile } from '../../sources/psa/browser/profile.ts';
import { isPsaSignInUrl, PsaSessionExpiredError } from '../../sources/psa/rawFetch.ts';
import type { StagePause } from './types.ts';

export const PSA_SESSION_PAUSE: StagePause = {
  source: 'psa',
  reason: 'PSA session expired -- run: npm run cli -- pipeline psa-login',
  resumeAfter: null,
};

export function psaProfilePresent(): boolean {
  return existsSync(PSA_PROFILE_DIR);
}

/**
 * Launch the persistent PSA profile, hand a signed-in page to `fn`, then always
 * close the context. Returns `{ pause }` instead of throwing when the profile
 * is no longer signed in, so the supervisor can park the stage cleanly.
 */
export async function withPsaPage<T>(
  bootstrapUrl: string,
  fn: (page: Page) => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; pause: StagePause }> {
  if (!psaProfilePresent()) return { ok: false, pause: PSA_SESSION_PAUSE };
  const context = await launchPsaProfile({ headless: false });
  try {
    const page = await context.newPage();
    await page.goto(bootstrapUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    if (isPsaSignInUrl(page.url())) return { ok: false, pause: PSA_SESSION_PAUSE };
    const value = await fn(page);
    return { ok: true, value };
  } catch (error) {
    if (error instanceof PsaSessionExpiredError) return { ok: false, pause: PSA_SESSION_PAUSE };
    throw error;
  } finally {
    await context.close().catch(() => {});
  }
}
