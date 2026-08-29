import { launchPsaProfile } from '../../sources/psa/browser/profile.ts';
import { looksLikeSignInRedirect } from '../../sources/psa/browser/session.ts';

const POLL_MS = 2_000;
const TIMEOUT_MS = 10 * 60_000; // 10 minutes to complete sign-in by hand

/**
 * The ONLY place a human enters PSA credentials: a real, visible browser
 * window on PSA's own sign-in page. Nothing here reads a password from
 * anywhere -- it just waits for the page to leave the sign-in host, then
 * saves the resulting session in the persistent profile for every other
 * PSA command to reuse.
 */
export async function psaLoginCommand(_args: string[]): Promise<void> {
  const context = await launchPsaProfile({ headless: false });
  const page = await context.newPage();
  await page.goto('https://www.psacard.com/pop', { waitUntil: 'domcontentloaded' });

  if (!looksLikeSignInRedirect(page.url())) {
    console.log('Already signed in (this profile has a valid PSA session).');
    await context.close();
    return;
  }

  console.log('A browser window has opened. Sign in to PSA there -- your credentials never pass through this tool.');
  console.log('Waiting for sign-in to complete (up to 10 minutes)...');

  const deadline = Date.now() + TIMEOUT_MS;
  let signedIn = false;
  while (Date.now() < deadline) {
    await page.waitForTimeout(POLL_MS);
    if (page.isClosed()) {
      console.error('Browser window was closed before sign-in completed.');
      break;
    }
    if (!looksLikeSignInRedirect(page.url())) {
      signedIn = true;
      break;
    }
  }

  if (signedIn) {
    console.log('Signed in. This browser profile now has a valid PSA session for future runs.');
  } else {
    console.error('Timed out (or window closed) waiting for sign-in.');
    process.exitCode = 1;
  }

  await context.close();
}
