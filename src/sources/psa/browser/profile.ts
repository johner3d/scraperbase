import fs from 'node:fs';
import { chromium, type BrowserContext } from 'playwright';
import { PSA_PROFILE_DIR } from '../../../core/config/config.ts';

export interface ProfileOptions {
  headless?: boolean;
}

const REAL_CHROME_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

/**
 * Playwright's bundled Chromium gets a harder Cloudflare/PSA response than a
 * real installed Chrome/Edge even with the automation flags stripped -- a
 * real browser build's own executable is a strong distinguishing signal
 * beyond navigator.webdriver. Falls back to bundled Chromium (undefined) if
 * neither is found rather than failing outright.
 */
function findRealChromeExecutable(): string | undefined {
  return process.env.PSA_BROWSER_PATH ?? REAL_CHROME_PATHS.find((p) => fs.existsSync(p));
}

/**
 * The one shared entry point to PSA's site: a persistent Chromium profile
 * (cookies etc. live on disk under data/psa-browser-profile/, never in
 * SQLite or anywhere git-tracked). Signing in is a one-time human action
 * via `psa-login`; every other PSA command reuses this same profile.
 */
export async function launchPsaProfile(opts: ProfileOptions = {}): Promise<BrowserContext> {
  const context = await chromium.launchPersistentContext(PSA_PROFILE_DIR, {
    headless: opts.headless ?? true,
    executablePath: findRealChromeExecutable(),
    viewport: { width: 1280, height: 900 },
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--disable-blink-features=AutomationControlled'],
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  return context;
}
