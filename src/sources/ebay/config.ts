import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { ObjectStoreDirs } from '../../core/objectstore/store.ts';
import { EBAY_RAW_DIR, EBAY_RAW_TMP_DIR, PROJECT_ROOT } from '../../core/config/config.ts';

export const EBAY_RAW_DIRS: ObjectStoreDirs = { objectsDir: EBAY_RAW_DIR, objectsTmpDir: EBAY_RAW_TMP_DIR };

export const EBAY_API_BASE = 'https://api.ebay.com';
export const EBAY_TOKEN_URL = `${EBAY_API_BASE}/identity/v1/oauth2/token`;
export const EBAY_SEARCH_URL = `${EBAY_API_BASE}/buy/browse/v1/item_summary/search`;
export const EBAY_ITEM_URL = `${EBAY_API_BASE}/buy/browse/v1/item`;

export type EbayMarketplaceKey = 'de' | 'eu' | 'international';

export interface EbayMarketplaceDef {
  marketplaceId: string;
  itemLocationCountries?: string[];
}

// Confirmed with the user: "de" = ebay.de site with no location filter,
// "eu" = ebay.de site narrowed to a curated EU country list, "international"
// = ebay.com (US) site, unfiltered (broadest global reach).
export const EBAY_MARKETPLACES: Record<EbayMarketplaceKey, EbayMarketplaceDef> = {
  de: { marketplaceId: 'EBAY_DE' },
  eu: {
    marketplaceId: 'EBAY_DE',
    itemLocationCountries: [
      'DE', 'AT', 'FR', 'IT', 'ES', 'NL', 'BE', 'PL', 'SE', 'DK', 'IE', 'PT', 'CZ', 'FI', 'LU',
    ],
  },
  international: { marketplaceId: 'EBAY_US' },
};

export const DEFAULT_EBAY_QUERY = 'pikachu psa 10';
export const DEFAULT_EBAY_PAGE_LIMIT = 200;
// Zero means uncapped. Raw acquisition should be complete by default; callers
// must opt into a safety cap explicitly (for example during a smoke test).
export const DEFAULT_EBAY_MAX_ITEMS = 0;

const EBAY_ENV_FILE = path.join(PROJECT_ROOT, 'ibbi', '.env');

export interface EbayCredentials {
  appId: string;
  certId: string;
}

/** Trivial KEY=VALUE parser -- no dotenv dependency, matching this codebase's convention of never auto-loading .env files, with ibbi/.env as the one established exception the user already relies on. */
function parseEnvFile(filePath: string): Record<string, string> {
  const out: Record<string, string> = {};
  const text = readFileSync(filePath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

export function loadEbayCredentials(): EbayCredentials {
  let appId = process.env.EBAY_APP_ID;
  let certId = process.env.EBAY_CERT_ID;

  if ((!appId || !certId) && existsSync(EBAY_ENV_FILE)) {
    const fromFile = parseEnvFile(EBAY_ENV_FILE);
    appId ??= fromFile.EBAY_APP_ID;
    certId ??= fromFile.EBAY_CERT_ID;
  }

  if (!appId || !certId) {
    throw new Error(
      `eBay credentials not found. Set EBAY_APP_ID/EBAY_CERT_ID in the environment, or provide them in ${EBAY_ENV_FILE}.`,
    );
  }
  return { appId, certId };
}
