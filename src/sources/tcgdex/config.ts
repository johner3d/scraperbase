export const TCGDEX_API_BASE = 'https://api.tcgdex.net/v2';
export const TCGDEX_ASSET_BASE = 'https://assets.tcgdex.net';

// Scope decision (confirmed with the user): exhaustive discovery within
// these three languages for now, not "all languages."
export const DEFAULT_TCGDEX_LANGUAGES = ['en', 'de', 'ja'];

// Image policy decision (confirmed with the user): download only the
// high-quality webp rendition now; the other 5 combinations' URLs are
// still recorded (on the images work item's params) for a later backfill.
export const DOWNLOADED_QUALITY = 'high';
export const DOWNLOADED_FORMAT = 'webp';
export const ALL_QUALITIES = ['high', 'low'] as const;
export const ALL_FORMATS = ['png', 'webp', 'jpg'] as const;

/** Card images have a quality tier: {base}/{high|low}.{ext}. */
export function buildCardImageRenditionUrls(assetBaseUrl: string): { downloaded: string; all: Record<string, string> } {
  const all: Record<string, string> = {};
  for (const quality of ALL_QUALITIES) {
    for (const format of ALL_FORMATS) {
      all[`${quality}.${format}`] = `${assetBaseUrl}/${quality}.${format}`;
    }
  }
  return { downloaded: all[`${DOWNLOADED_QUALITY}.${DOWNLOADED_FORMAT}`]!, all };
}

/** Set logos/symbols have no quality tier -- just {base}.{ext}. */
export function buildSetAssetRenditionUrls(assetBaseUrl: string): { downloaded: string; all: Record<string, string> } {
  const all: Record<string, string> = {};
  for (const format of ALL_FORMATS) {
    all[format] = `${assetBaseUrl}.${format}`;
  }
  return { downloaded: all[DOWNLOADED_FORMAT]!, all };
}

export function extForFormat(format: string): string {
  return format === 'jpg' ? 'jpg' : format; // webp/png already match their extension
}

export function mediaTypeForFormat(format: string): string {
  if (format === 'jpg') return 'image/jpeg';
  if (format === 'png') return 'image/png';
  return 'image/webp';
}
