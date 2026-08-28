import { openDb } from '../core/db/client.ts';
import { DB_PATH } from '../core/config/config.ts';
import { mkdir } from 'node:fs/promises';
import { DATA_DIR } from '../core/config/config.ts';

await mkdir(DATA_DIR, { recursive: true });
const db = openDb(DB_PATH);
console.log(`Schema up to date at ${DB_PATH}`);
db.close();
