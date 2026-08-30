import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

// Overridable so integration tests (and, later, alternate environments) can
// point the whole store at an isolated directory instead of the real one.
export const DATA_DIR = process.env.SCRAPERBASE_DATA_DIR
  ? path.resolve(process.env.SCRAPERBASE_DATA_DIR)
  : path.join(PROJECT_ROOT, 'data');
export const DB_PATH = path.join(DATA_DIR, 'db.sqlite');
export const OBJECTS_DIR = path.join(DATA_DIR, 'objects');
export const OBJECTS_TMP_DIR = path.join(OBJECTS_DIR, 'tmp');
export const MEDIA_CACHE_DIR = path.join(DATA_DIR, 'media-cache');
export const PSA_PROFILE_DIR = path.join(DATA_DIR, 'psa-browser-profile');
export const EBAY_RAW_DIR = path.join(DATA_DIR, 'ebay-raw');
export const EBAY_RAW_TMP_DIR = path.join(EBAY_RAW_DIR, 'tmp');
export const PUBLISHED_DIR = path.join(DATA_DIR, 'published');
export const PUBLISHED_POINTER_PATH = path.join(PUBLISHED_DIR, 'current.json');

// Wall-clock ceiling on any single outbound HTTP request. Without it a stalled
// TCP connection hangs a queue worker forever, which in turn hangs its stage and
// (in the sequential pipeline) the whole run. Overridable per call.
export const DEFAULT_HTTP_TIMEOUT_MS = Number(process.env.SCRAPERBASE_HTTP_TIMEOUT_MS) || 20_000;
// eBay's OAuth token endpoint is on the critical path for every eBay request; a
// shorter ceiling keeps a token-server hiccup from masquerading as a dead queue.
export const EBAY_TOKEN_TIMEOUT_MS = Number(process.env.SCRAPERBASE_EBAY_TOKEN_TIMEOUT_MS) || 15_000;
