import type { BrowserContext } from 'playwright';

// A page that requires auth (population reports) redirects an unauthenticated
// session to PSA's account-management host. Confirmed by live testing during
// planning: GET https://www.psacard.com/pop -> app.collectors.com/signin
// when not signed in.
const AUTH_CHECK_URL = 'https://www.psacard.com/pop';
const SIGNIN_HOST_MARKER = 'app.collectors.com';

export function looksLikeSignInRedirect(url: string): boolean {
  return url.includes(SIGNIN_HOST_MARKER) || url.includes('/signin');
}

export async function checkSignedIn(context: BrowserContext): Promise<boolean> {
  const page = await context.newPage();
  try {
    await page.goto(AUTH_CHECK_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    return !looksLikeSignInRedirect(page.url());
  } finally {
    await page.close();
  }
}
