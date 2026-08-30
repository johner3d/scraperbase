import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createServer as createViteServer, type ViteDevServer } from 'vite';
import { DB_PATH, MEDIA_CACHE_DIR, OBJECTS_DIR } from '../core/config/config.ts';
import { resolvePublishedDatabase, resolvePublishedManifest } from '../pipeline/publication.ts';
import { getAuction, getAuctionFacets, getCard, getFacets, getHealth, getMarket, getPopulation, getVariant, listAuctions, listCards, listMatchReviews, listSources, listVariants, listEbayListings, listPipelines, getPipeline } from './api.ts';
import { supervisorStatus } from '../pipeline/supervisorStatus.ts';
import { safeStoredPath } from './mediaPath.ts';

const PORT = Number(process.env.PORT ?? 8787);
const DEV = process.argv.includes('--dev');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = path.join(ROOT, 'dist', 'web');
const WEB_INDEX = path.join(DIST, 'index.html');

type AnyHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(payload);
}

function idFromPath(pathname: string, prefix: string): number | null {
  if (!pathname.startsWith(prefix)) return null;
  const value = pathname.slice(prefix.length);
  return /^\d+$/.test(value) ? Number(value) : null;
}

function openReadOnly(dbPath = resolvePublishedDatabase()): DatabaseSync {
  if (!existsSync(dbPath)) throw new Error(`Database does not exist at ${dbPath}`);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  db.exec('PRAGMA query_only = ON');
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

/** Hot-swaps only after publication's pointer changes; in-flight synchronous queries finish on the old handle. */
class PublishedDb {
  private path = resolvePublishedDatabase();
  private connection = openReadOnly(this.path);

  get(): DatabaseSync {
    const next = resolvePublishedDatabase();
    if (next !== this.path) {
      const replacement = openReadOnly(next);
      const previous = this.connection;
      this.connection = replacement;
      this.path = next;
      previous.close();
      console.log(`Published data generation switched to ${next}`);
    }
    return this.connection;
  }

  close(): void { this.connection.close(); }
}

export function isOperationalApiPath(pathname:string):boolean {
  return pathname==='/api/pipelines'||pathname.startsWith('/api/pipelines/')||pathname==='/api/sources'
    ||pathname==='/api/reviews'||pathname==='/api/ebay-listings'||pathname==='/api/pipeline-status';
}

async function apiHandler(publishedDb: DatabaseSync, operationalDb:DatabaseSync, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  if (req.method !== 'GET' || !url.pathname.startsWith('/api/')) return false;
  try {
    if(url.pathname==='/api/publication'){
      const manifest=resolvePublishedManifest();
      json(res,200,manifest?{mode:'published',...manifest}:{mode:'working',completeness:'partial',incompleteReason:'No published generation exists yet'});
      return true;
    }
    const pipelineActive=Boolean(operationalDb.prepare("SELECT 1 FROM pipeline_runs WHERE status='running' LIMIT 1").get());
    // During an active run, serve committed working data so each completed
    // downstream batch is visible immediately. Once the run is idle, return to
    // the validated immutable generation for stable reads.
    const db=pipelineActive||isOperationalApiPath(url.pathname)?operationalDb:publishedDb;
    if (url.pathname === '/api/cards') { json(res, 200, listCards(db, url.searchParams)); return true; }
    if (url.pathname === '/api/variants') { json(res, 200, listVariants(db, url.searchParams)); return true; }
    if (url.pathname === '/api/auctions') { json(res, 200, listAuctions(db, url.searchParams)); return true; }
    if (url.pathname === '/api/ebay-listings') { json(res, 200, listEbayListings(db, url.searchParams)); return true; }
    if (url.pathname === '/api/pipelines') { json(res, 200, {items:listPipelines(db)}); return true; }
    if (url.pathname === '/api/pipeline-status') { json(res, 200, supervisorStatus(db)); return true; }
    if (url.pathname === '/api/auction-facets') { json(res, 200, getAuctionFacets(db)); return true; }
    if (url.pathname === '/api/sources') { json(res, 200, { items: listSources(db) }); return true; }
    if (url.pathname === '/api/facets') { json(res, 200, getFacets(db)); return true; }
    if (url.pathname === '/api/reviews') { json(res, 200, { items: listMatchReviews(db) }); return true; }
    if (url.pathname === '/api/health') { json(res, 200, getHealth(db)); return true; }
    const auctionId = idFromPath(url.pathname, '/api/auctions/');
    if (auctionId != null) { const result = getAuction(db, auctionId); json(res, result ? 200 : 404, result ?? { error: 'Auction not found' }); return true; }
    const cardId = idFromPath(url.pathname, '/api/cards/');
    if (cardId != null) { const result = getCard(db, cardId); json(res, result ? 200 : 404, result ?? { error: 'Card not found' }); return true; }
    const variantMarket = url.pathname.match(/^\/api\/variants\/(\d+)\/(market|population)$/);
    if (variantMarket) {
      const variantId = Number(variantMarket[1]);
      if (!getVariant(db, variantId)) { json(res, 404, { error: 'Variant not found' }); return true; }
      json(res, 200, variantMarket[2] === 'market' ? getMarket(db, variantId) : getPopulation(db, variantId)); return true;
    }
    const variantId = idFromPath(url.pathname, '/api/variants/');
    if (variantId != null) { const result = getVariant(db, variantId); json(res, result ? 200 : 404, result ?? { error: 'Variant not found' }); return true; }
    const pipelineId=url.pathname.match(/^\/api\/pipelines\/([a-f0-9-]+)$/i)?.[1];
    if(pipelineId){const result=getPipeline(db,pipelineId);json(res,result?200:404,result??{error:'Pipeline not found'});return true;}
    json(res, 404, { error: 'API route not found' }); return true;
  } catch (error) {
    console.error(error);
    json(res, 500, { error: 'Request failed', detail: error instanceof Error ? error.message : String(error) }); return true;
  }
}

async function mediaHandler(db: DatabaseSync, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  if (req.method !== 'GET' || !url.pathname.startsWith('/media/')) return false;
  const auctionId = idFromPath(url.pathname, '/media/ebay/');
  if (auctionId != null) {
    const listing=db.prepare(`SELECT primary_image_url FROM ebay_listings WHERE ebay_listing_id=?`).get(auctionId) as {primary_image_url?:string}|undefined;
    const sourceUrl=listing?.primary_image_url;
    if(!sourceUrl||!/^https:\/\//i.test(sourceUrl)){json(res,404,{error:'Auction image not found'});return true;}
    await serveCachedRemote(sourceUrl,res);return true;
  }
  const cardId = idFromPath(url.pathname, '/media/card/');
  if (cardId != null) {
    const asset = db.prepare(`SELECT a.media_type,a.object_hash,a.url,ro.storage_path FROM cards c
      LEFT JOIN assets a ON a.target_type='card' AND a.target_id=c.card_id AND a.is_primary=1
      LEFT JOIN raw_objects ro ON ro.hash=a.object_hash WHERE c.card_id=? ORDER BY a.asset_id LIMIT 1`).get(cardId) as
      | { media_type?: string; object_hash?: string; url?: string; storage_path?: string }
      | undefined;
    const fallback = db.prepare(`SELECT image_url FROM cards WHERE card_id=?`).get(cardId) as { image_url?: string } | undefined;
    if (!asset && !fallback?.image_url) { json(res, 404, { error: 'Card image not found' }); return true; }
    if (asset?.storage_path) { await serveStored(asset.storage_path, asset.media_type, res); return true; }
    const sourceUrl = asset?.url ?? fallback?.image_url;
    if (!sourceUrl || !/^https:\/\//i.test(sourceUrl)) { json(res, 404, { error: 'Card image URL unavailable' }); return true; }
    await serveCachedRemote(sourceUrl, res);
    return true;
  }
  const assetId = idFromPath(url.pathname, '/media/');
  if (assetId == null) { json(res, 400, { error: 'Invalid asset id' }); return true; }
  const asset = db.prepare(`SELECT a.url, a.media_type, a.object_hash, ro.storage_path FROM assets a LEFT JOIN raw_objects ro ON ro.hash = a.object_hash WHERE a.asset_id = ?`).get(assetId) as { url?: string; media_type?: string; object_hash?: string; storage_path?: string } | undefined;
  if (!asset) { json(res, 404, { error: 'Asset not found' }); return true; }
  if (!asset.storage_path) { json(res, 404, { error: 'Asset is not stored locally', sourceUrl: asset.url ?? null }); return true; }
  await serveStored(asset.storage_path, asset.media_type, res);
  return true;
}

async function serveStored(storagePath: string, mediaType: string | undefined, res: ServerResponse): Promise<void> {
  const filePath=safeStoredPath(OBJECTS_DIR,storagePath);
  if (!filePath) { json(res, 400, { error: 'Invalid media path' }); return; }
  try { const info=await stat(filePath);if(!info.isFile())throw new Error('Not a file');const body=await readFile(filePath);res.writeHead(200,{'content-type':mediaType??'application/octet-stream','content-length':String(body.byteLength),'cache-control':'public, max-age=86400'});res.end(body); }
  catch { json(res,404,{error:'Stored media is unavailable'}); }
}

async function serveCachedRemote(sourceUrl: string, res: ServerResponse): Promise<void> {
  const key=createHash('sha256').update(sourceUrl).digest('hex'),root=path.resolve(MEDIA_CACHE_DIR),filePath=path.join(root,`${key}.webp`);
  await mkdir(root,{recursive:true});
  try { const cached=await readFile(filePath);res.writeHead(200,{'content-type':'image/webp','content-length':String(cached.byteLength),'cache-control':'public, max-age=604800'});res.end(cached);return; } catch { /* fetch below */ }
  try {
    const response=await fetch(sourceUrl,{signal:AbortSignal.timeout(15_000)});
    if(!response.ok)throw new Error(`HTTP ${response.status}`);
    const contentType=response.headers.get('content-type')??'';if(!contentType.startsWith('image/'))throw new Error('Remote response is not an image');
    const body=Buffer.from(await response.arrayBuffer());if(body.byteLength>12*1024*1024)throw new Error('Remote image is too large');
    const temp=path.join(root,`${key}.${randomUUID()}.tmp`);await writeFile(temp,body);await rename(temp,filePath);
    res.writeHead(200,{'content-type':contentType,'content-length':String(body.byteLength),'cache-control':'public, max-age=604800'});res.end(body);
  } catch (error) { json(res,502,{error:'Unable to fetch card image',detail:error instanceof Error?error.message:String(error)}); }
}

function contentType(filePath: string): string {
  if (filePath.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.svg')) return 'image/svg+xml';
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  return 'application/octet-stream';
}

async function staticHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const requested = url.pathname === '/' ? '/index.html' : url.pathname;
  const candidate = path.resolve(DIST, '.' + requested);
  const relative = path.relative(DIST, candidate);
  const safe = !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
  const filePath = safe && existsSync(candidate) ? candidate : WEB_INDEX;
  if (!existsSync(filePath)) { json(res, 503, { error: 'Frontend is not built. Run npm run web:build.' }); return; }
  try { const body = await readFile(filePath); res.writeHead(200, { 'content-type': contentType(filePath), 'cache-control': filePath.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable' }); res.end(body); } catch { json(res, 404, { error: 'Not found' }); }
}

function lanAddress(): string {
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) for (const entry of entries ?? []) {
    if (entry.family === 'IPv4' && !entry.internal && (entry.address.startsWith('192.168.') || entry.address.startsWith('10.') || entry.address.startsWith('172.'))) return entry.address;
  }
  return 'your-pc-ip';
}

async function main(): Promise<void> {
  const published = new PublishedDb();
  const operational = openReadOnly(DB_PATH);
  let vite: ViteDevServer | undefined;
  if (DEV) vite = await createViteServer({ root: path.join(ROOT, 'web'), server: { middlewareMode: true }, appType: 'spa' });
  const handler: AnyHandler = async (req, res) => {
    const db = published.get();
    if (await apiHandler(db, operational, req, res)) return;
    if (await mediaHandler(db, req, res)) return;
    if (vite) return new Promise<void>((resolve) => vite!.middlewares(req, res, () => resolve()));
    return staticHandler(req, res);
  };
  const server = createServer((req, res) => { void handler(req, res); });
  server.listen(PORT, '0.0.0.0', () => { console.log(`Local: http://localhost:${PORT}`); console.log(`LAN:   http://${lanAddress()}:${PORT}`); });
  const close = () => { vite?.close(); operational.close(); published.close(); server.close(); };
  process.on('SIGINT', close); process.on('SIGTERM', close);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
