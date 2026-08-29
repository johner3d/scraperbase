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
