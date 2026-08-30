import { EBAY_TOKEN_TIMEOUT_MS } from '../../core/config/config.ts';
import { EBAY_TOKEN_URL, loadEbayCredentials } from './config.ts';

interface CachedToken {
  accessToken: string;
  expiresAt: number; // epoch ms
}

let cached: CachedToken | undefined;

const EXPIRY_SAFETY_MARGIN_MS = 60_000;

/**
 * OAuth2 client-credentials bearer token for the eBay Buy APIs. Cached
 * in-process (one CLI run = one process = one token). Never written to disk
 * or run through the queue/object-store machinery -- it's a credential, not
 * raw listing data.
 */
export async function getEbayAccessToken(): Promise<string> {
  if (cached && cached.expiresAt > Date.now()) return cached.accessToken;

  const { appId, certId } = loadEbayCredentials();
  const basic = Buffer.from(`${appId}:${certId}`).toString('base64');

  const res = await fetch(EBAY_TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope',
    signal: AbortSignal.timeout(EBAY_TOKEN_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`eBay OAuth token request failed: HTTP ${res.status} ${await res.text()}`);
  }

  const body = (await res.json()) as { access_token: string; expires_in: number };
  cached = {
    accessToken: body.access_token,
    expiresAt: Date.now() + body.expires_in * 1000 - EXPIRY_SAFETY_MARGIN_MS,
  };
  return cached.accessToken;
}
