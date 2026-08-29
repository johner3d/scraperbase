import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { DATA_DIR } from '../core/config/config.ts';
import { readObject, type ObjectStoreDirs } from '../core/objectstore/store.ts';

export const CURATED_PARSER_NAME = 'curated-materializer';
export const CURATED_PARSER_VERSION = '6';

export interface MaterializeOptions {
  psaDir?: string;
  objectStoreDirs?: ObjectStoreDirs;
  includeTcgdex?: boolean;
  includePsa?: boolean;
  now?: string;
}

export interface MaterializeResult {
  sets: number;
  cards: number;
  hydratedCards: number;
  variants: number;
  assets: number;
  localAssetsLinked: number;
  psaSpecs: number;
  populationRows: number;
  priceRows: number;
  censusRows: number;
  salesRows: number;
  matchedPsaSpecs: number;
  openReviews: number;
}

interface ObservationRow {
  observation_id: number;
  hash: string;
  observed_at: string;
  entity_type: string;
  scope_key: string;
  storage_path: string;
}

interface TcgdexSet {
  id?: string;
  name?: string;
  serie?: { id?: string; name?: string };
  releaseDate?: string;
  logo?: string;
  symbol?: string;
  cardCount?: { total?: number; official?: number };
  cards?: Array<{ id?: string; localId?: string; name?: string; image?: string }>;
}

interface DetailedVariant {
  type?: string;
  subtype?: string;
  size?: string;
  stamp?: string[] | string;
  variantId?: string;
  languages?: string[];
}

interface TcgdexCard {
  id?: string;
  localId?: string;
  name?: string;
  category?: string;
  rarity?: string;
  image?: string;
  set?: { id?: string; name?: string };
  variants?: Record<string, unknown>;
  variants_detailed?: DetailedVariant[];
  [key: string]: unknown;
}

interface PsaIssue {
  release?: string;
  sourceCardId: string;
  finish: string;
  printRunMarker: string;
  microVariant?: string;
}

interface PopulationFile extends PsaIssue {
  psaSpecId: number | string;
  popSourceUrl: string;
  salesSpecId?: number | string | null;
  fetchedAt: string;
  populationRaw: string;
  priceRows?: RawPriceRow[];
  censusRows?: RawCensusRow[];
}

interface SalesFile extends PsaIssue {
  psaSpecId?: number | string | null;
  salesSpecId: number | string;
  salesSourceUrl: string;
  fetchedAt: string;
  cutoffIso?: string;
  totalCount?: number;
  pagesFetched?: number;
  coverageComplete?: boolean;
  sales?: RawSale[];
}

interface RawPriceRow { gradeText: string; mostRecentText: string; averageText: string; psaPriceText: string }
interface RawCensusRow { position: number; gradeLabel: string; pedigree: string }
interface RawSale {
  saleItemId?: string | null;
  certNumber?: string | null;
  auctionHouse?: string | null;
  saleDate?: string | null;
  saleType?: string | null;
  salePrice?: number | null;
  gradeValue?: number | null;
  lotNumber?: string | null;
  listingURL?: string | null;
  imageURL?: string | null;
  thumbnailURL?: string | null;
  qualifierCode?: string | null;
  dnaGradeValue?: number | null;
  gradingCompany?: string | null;
}

interface VariantParts {
  finish?: unknown;
  printRunMarker?: unknown;
  microVariant?: unknown;
  size?: unknown;
  stamps?: unknown[];
}

const DISPLAY_GRADES = [
  { key: 'N0', label: 'Auth', value: null, order: 0, base: 'GradeN0', half: null, qualified: null },
  { key: '1', label: 'PR 1', value: 1, order: 10, base: 'Grade1', half: null, qualified: 'Grade1Q' },
  { key: '1.5', label: 'FR 1.5', value: 1.5, order: 15, base: null, half: 'Grade1_5', qualified: 'Grade1_5Q' },
  { key: '2', label: 'GOOD 2', value: 2, order: 20, base: 'Grade2', half: 'Grade2_5', qualified: 'Grade2Q' },
  { key: '3', label: 'VG 3', value: 3, order: 30, base: 'Grade3', half: 'Grade3_5', qualified: 'Grade3Q' },
  { key: '4', label: 'VG-EX 4', value: 4, order: 40, base: 'Grade4', half: 'Grade4_5', qualified: 'Grade4Q' },
  { key: '5', label: 'EX 5', value: 5, order: 50, base: 'Grade5', half: 'Grade5_5', qualified: 'Grade5Q' },
  { key: '6', label: 'EX-MT 6', value: 6, order: 60, base: 'Grade6', half: 'Grade6_5', qualified: 'Grade6Q' },
  { key: '7', label: 'NM 7', value: 7, order: 70, base: 'Grade7', half: 'Grade7_5', qualified: 'Grade7Q' },
  { key: '8', label: 'NM-MT 8', value: 8, order: 80, base: 'Grade8', half: 'Grade8_5', qualified: 'Grade8Q' },
  { key: '9', label: 'MINT 9', value: 9, order: 90, base: 'Grade9', half: null, qualified: 'Grade9Q' },
  { key: '10', label: 'GEM-MT 10', value: 10, order: 100, base: 'Grade10', half: null, qualified: 'Grade10Q' },
] as const;

function valueText(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : value == null ? fallback : String(value).trim();
}
function nullableText(value: unknown): string | null { return valueText(value) || null }
function json(value: unknown): string { return JSON.stringify(value ?? {}) }
function normalizePart(value: unknown): string {
  return valueText(value).normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}
function normalizedStamps(values: unknown[] | undefined): string[] {
  return [...new Set((values ?? []).map(normalizePart).filter(Boolean))].sort();
}

export function variantKey(parts: VariantParts): string {
  return [
    normalizePart(parts.finish), normalizePart(parts.printRunMarker), normalizePart(parts.microVariant),
    normalizePart(parts.size || 'standard'), normalizedStamps(parts.stamps).join(','),
  ].join('|');
}

function pretty(value: unknown): string {
  const normalized = normalizePart(value);
  const known: Record<string, string> = {
    holo: 'Holo', normal: 'Normal', reverse: 'Reverse', unlimited: 'Unlimited',
    first_edition: '1st Edition', shadowless: 'Shadowless', shadowless_first_edition: 'Shadowless · 1st Edition',
    standard: 'Standard', jumbo: 'Jumbo', '1999_2000_copyright': '1999–2000 copyright',
  };
  return known[normalized] ?? normalized.split('_').map((part) => part ? part[0]!.toUpperCase() + part.slice(1) : '').join(' ');
}

export function variantLabel(parts: VariantParts): string {
  const labels = [parts.printRunMarker, parts.finish, parts.microVariant].filter((v) => valueText(v)).map(pretty);
  if (normalizePart(parts.size) === 'jumbo') labels.push('Jumbo');
  for (const stamp of normalizedStamps(parts.stamps)) labels.push(pretty(stamp));
  return labels.length ? labels.join(' · ') : 'Standard';
}

function naturalSortKey(value: string): string {
  return value.normalize('NFKD').toLowerCase().split(/(\d+)/).map((part) => /^\d+$/.test(part) ? part.padStart(12, '0') : part).join('');
}
function highImageUrl(base: string | null | undefined): string | null {
  const clean = valueText(base).replace(/\/$/, '');
  return clean ? (clean.endsWith('.webp') ? clean : `${clean}/high.webp`) : null;
}
function setImageUrl(base: string | null | undefined): string | null {
  const clean = valueText(base).replace(/\/$/, '');
  return clean ? (clean.endsWith('.webp') ? clean : `${clean}.webp`) : null;
}
function splitCardId(cardId: string): { setId: string; localId: string } {
  const index = cardId.lastIndexOf('-');
  return index <= 0 ? { setId: cardId, localId: cardId } : { setId: cardId.slice(0, index), localId: cardId.slice(index + 1) };
}

function latestObservation(db: DatabaseSync, entityType: string, scopeKey: string): ObservationRow | null {
  return db.prepare(`SELECT o.observation_id, o.hash, o.observed_at, o.entity_type, o.scope_key, ro.storage_path
    FROM observations o JOIN raw_objects ro ON ro.hash=o.hash
    WHERE o.entity_type=? AND o.scope_key=? ORDER BY o.observation_id DESC LIMIT 1`).get(entityType, scopeKey) as unknown as ObservationRow | null;
}
function latestObservations(db: DatabaseSync, entityType: string): ObservationRow[] {
  return db.prepare(`SELECT o.observation_id, o.hash, o.observed_at, o.entity_type, o.scope_key, ro.storage_path
    FROM observations o JOIN raw_objects ro ON ro.hash=o.hash
    WHERE o.entity_type=? AND NOT EXISTS (
      SELECT 1 FROM observations newer WHERE newer.entity_type=o.entity_type AND newer.scope_key=o.scope_key
        AND newer.observation_id>o.observation_id)
    ORDER BY o.scope_key`).all(entityType) as unknown as ObservationRow[];
}
async function readObservationJson<T>(row: ObservationRow, dirs?: ObjectStoreDirs): Promise<T> {
  return JSON.parse((await readObject(row.storage_path, dirs)).toString('utf8')) as T;
}

function upsertSourceRecord(db: DatabaseSync, args: {
  source: string; namespace: string; sourceKey: string; entityType: string; language?: string | null;
  observation?: ObservationRow | null; observedAt: string;
}): number {
  return (db.prepare(`INSERT INTO source_records
    (source,namespace,source_key,entity_type,language,latest_observation_id,first_seen_at,last_seen_at,parser_name,parser_version)
    VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(source,namespace,source_key) DO UPDATE SET entity_type=excluded.entity_type,
      language=excluded.language, latest_observation_id=COALESCE(excluded.latest_observation_id,source_records.latest_observation_id),
      last_seen_at=excluded.last_seen_at, parser_name=excluded.parser_name, parser_version=excluded.parser_version
    RETURNING source_record_id`).get(args.source,args.namespace,args.sourceKey,args.entityType,args.language??null,
      args.observation?.observation_id??null,args.observedAt,args.observedAt,CURATED_PARSER_NAME,CURATED_PARSER_VERSION) as {source_record_id:number}).source_record_id;
}
function linkSource(db: DatabaseSync, sourceRecordId: number, targetType: 'set'|'card'|'variant'|'psa_spec', targetId: number,
  status: 'matched'|'unmatched'|'ambiguous'|'manual', method: string, at: string, confidence: number|null = 1): void {
  db.prepare(`INSERT INTO source_links
    (source_record_id,target_type,target_id,match_status,confidence,match_method,first_seen_at,last_seen_at)
    VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(source_record_id,target_type,target_id) DO UPDATE SET
      match_status=excluded.match_status,confidence=excluded.confidence,match_method=excluded.match_method,last_seen_at=excluded.last_seen_at`)
    .run(sourceRecordId,targetType,targetId,status,confidence,method,at,at);
}
function recordParser(db: DatabaseSync, observation: ObservationRow | null, at: string, summary: unknown): void {
  if (!observation) return;
  db.prepare(`INSERT INTO parser_executions
    (parser_name,parser_version,observation_id,executed_at,outcome,output_summary_json)
    VALUES (?,?,?,?,'success',?) ON CONFLICT(parser_name,parser_version,observation_id) DO UPDATE SET
      executed_at=excluded.executed_at,outcome=excluded.outcome,output_summary_json=excluded.output_summary_json`)
    .run(CURATED_PARSER_NAME,CURATED_PARSER_VERSION,observation.observation_id,at,json(summary));
}

export function setMatchOverride(db: DatabaseSync, sourceRecordId: number, targetType: 'card'|'variant', targetId: number,
  note='manual review', at=new Date().toISOString()): void {
  db.prepare(`INSERT INTO match_overrides(source_record_id,target_type,target_id,note,active,created_at)
    VALUES(?,?,?,?,1,?) ON CONFLICT(source_record_id,target_type) DO UPDATE SET
      target_id=excluded.target_id,note=excluded.note,active=1,created_at=excluded.created_at`)
    .run(sourceRecordId,targetType,targetId,note,at);
  db.prepare(`UPDATE match_reviews SET status='resolved',resolved_at=? WHERE source_record_id=? AND status='open'`).run(at,sourceRecordId);
}

function upsertSet(db: DatabaseSync, lang: string, raw: TcgdexSet, recordId: number, at: string): number {
  const sourceSetId=valueText(raw.id);
  const setId=(db.prepare(`INSERT INTO sets
    (language,source_set_id,name,series,release_date,total_cards,official_cards,logo_url,symbol_url,source_record_id,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(language,source_set_id) DO UPDATE SET
      name=excluded.name,series=excluded.series,release_date=excluded.release_date,total_cards=excluded.total_cards,
      official_cards=excluded.official_cards,logo_url=excluded.logo_url,symbol_url=excluded.symbol_url,
      source_record_id=excluded.source_record_id,updated_at=excluded.updated_at RETURNING set_id`).get(
        lang,sourceSetId,valueText(raw.name,sourceSetId),nullableText(raw.serie?.name),nullableText(raw.releaseDate),
        raw.cardCount?.total??null,raw.cardCount?.official??null,setImageUrl(raw.logo),setImageUrl(raw.symbol),recordId,at,at) as {set_id:number}).set_id;
  linkSource(db,recordId,'set',setId,'matched','tcgdex-source-id',at);
  return setId;
}
function compactCardAttributes(raw: TcgdexCard): Record<string, unknown> {
  const keys=['illustrator','hp','types','stage','evolveFrom','description','retreat','regulationMark','dexId','legal'];
  return Object.fromEntries(keys.filter((key)=>raw[key]!==undefined).map((key)=>[key,raw[key]]));
}
function upsertCard(db: DatabaseSync, args: { setId:number; raw:TcgdexCard; sourceId:string; recordId:number; at:string; hydrated:boolean }): number {
  const localId=valueText(args.raw.localId,splitCardId(args.sourceId).localId);
  const current=db.prepare(`SELECT attributes_json FROM cards WHERE set_id=? AND local_id=?`).get(args.setId,localId) as Record<string,unknown>|undefined;
  const attributes=args.hydrated?json(compactCardAttributes(args.raw)):valueText(current?.attributes_json,'{}');
  const cardId=(db.prepare(`INSERT INTO cards
    (set_id,local_id,local_sort_key,name,category,rarity,number,image_url,attributes_json,detail_status,source_record_id,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(set_id,local_id) DO UPDATE SET
      local_sort_key=excluded.local_sort_key,name=excluded.name,
      category=COALESCE(excluded.category,cards.category),rarity=COALESCE(excluded.rarity,cards.rarity),
      number=excluded.number,image_url=COALESCE(excluded.image_url,cards.image_url),
      attributes_json=CASE WHEN excluded.detail_status='hydrated' THEN excluded.attributes_json ELSE cards.attributes_json END,
      detail_status=CASE WHEN excluded.detail_status='hydrated' THEN 'hydrated' ELSE cards.detail_status END,
      source_record_id=excluded.source_record_id,updated_at=excluded.updated_at RETURNING card_id`).get(
        args.setId,localId,naturalSortKey(localId),valueText(args.raw.name,args.sourceId),nullableText(args.raw.category),nullableText(args.raw.rarity),
        localId,highImageUrl(args.raw.image),attributes,args.hydrated?'hydrated':'stub',args.recordId,args.at,args.at) as {card_id:number}).card_id;
  linkSource(db,args.recordId,'card',cardId,'matched',args.hydrated?'tcgdex-card-detail':'tcgdex-set-card-brief',args.at);
  return cardId;
}
function primaryAsset(db: DatabaseSync, recordId:number, targetType:'set'|'card', targetId:number, url:string|null, at:string, rendition='high.webp'): number {
  if(!url) return 0;
  db.prepare(`UPDATE assets SET is_primary=0,updated_at=? WHERE target_type=? AND target_id=? AND url<>?`).run(at,targetType,targetId,url);
  db.prepare(`INSERT INTO assets(source_record_id,target_type,target_id,object_hash,url,rendition,media_type,is_primary,created_at,updated_at)
    VALUES(?,?,?,NULL,?,?, 'image/webp',1,?,?) ON CONFLICT(target_type,target_id,url,rendition) DO UPDATE SET
      source_record_id=excluded.source_record_id,is_primary=1,updated_at=excluded.updated_at`).run(recordId,targetType,targetId,url,rendition,at,at);
  return 1;
}

function linkedTarget(db:DatabaseSync,language:string,sourceKey:string,targetType:'set'|'card'):number|null{
  const row=db.prepare(`SELECT sl.target_id FROM source_records sr JOIN source_links sl ON sl.source_record_id=sr.source_record_id
    WHERE sr.source='tcgdex' AND sr.namespace=? AND sr.source_key=? AND sl.target_type=?
      AND sl.match_status IN ('matched','manual') ORDER BY sl.source_link_id DESC LIMIT 1`).get(language,sourceKey,targetType) as {target_id:number}|undefined;
  return row?.target_id??null;
}

function linkDownloadedAssets(db:DatabaseSync,at:string):number{
  const rows=db.prepare(`SELECT o.hash,o.entity_type,o.scope_key,ro.media_type FROM observations o
    JOIN raw_objects ro ON ro.hash=o.hash
    WHERE o.entity_type IN ('card_image','set_logo','set_symbol') AND NOT EXISTS(
      SELECT 1 FROM observations newer WHERE newer.entity_type=o.entity_type AND newer.scope_key=o.scope_key
        AND newer.observation_id>o.observation_id) ORDER BY o.scope_key`).all() as unknown as Array<{hash:string;entity_type:string;scope_key:string;media_type:string}>;
  let linked=0;
  for(const row of rows){
    const card=/^([^:]+):image:card:(.+):([^:]+):([^:]+)$/.exec(row.scope_key);
    if(card){
      const targetId=linkedTarget(db,card[1]!,card[2]!,'card');
      if(targetId==null)continue;
      linked+=Number(db.prepare(`UPDATE assets SET object_hash=?,media_type=?,updated_at=? WHERE asset_id=(
        SELECT asset_id FROM assets WHERE target_type='card' AND target_id=? AND is_primary=1 ORDER BY asset_id LIMIT 1
      )`).run(row.hash,row.media_type,at,targetId).changes);
      continue;
    }
    const set=/^([^:]+):image:set:(.+):(logo|symbol):([^:]+):([^:]+)$/.exec(row.scope_key);
    if(!set)continue;
    const targetId=linkedTarget(db,set[1]!,set[2]!,'set');
    if(targetId==null)continue;
    linked+=Number(db.prepare(`UPDATE assets SET object_hash=?,media_type=?,updated_at=? WHERE asset_id=(
      SELECT asset_id FROM assets WHERE target_type='set' AND target_id=? AND url LIKE ? ORDER BY is_primary DESC,asset_id DESC LIMIT 1
    )`).run(row.hash,row.media_type,at,targetId,`%/${set[3]}.%`).changes);
  }
  return linked;
}

interface DetailedVariantContext {
  language: string;
  sourceSetId: string;
  releaseDate?: string|null;
  explicitlyLanguageScoped?: boolean;
}

const GERMAN_SUBTYPE_ALIASES: Record<string,string> = {
  unbegrenzt: 'unlimited',
  schattenlos: 'shadowless',
  schattenlose_rote_wange: 'shadowless_red_cheek',
  copyright_1999_2000: '1999_2000_copyright',
};
const GERMAN_STAMP_ALIASES: Record<string,string> = {
  '1_auflage': '1st_edition',
  vorveroffentlichung: 'pre_release',
  poketour_1999: 'poketour_99',
};

function canonicalDetailedTerm(value:unknown,language:string,kind:'subtype'|'stamp'):string {
  const normalized=normalizePart(value);
  if(language!=='de') return normalized;
  return (kind==='subtype'?GERMAN_SUBTYPE_ALIASES:GERMAN_STAMP_ALIASES)[normalized]??normalized;
}

function detailedParts(raw: DetailedVariant, context:DetailedVariantContext): VariantParts|null {
  if(raw.languages?.length&&!raw.languages.includes(context.language)) return null;
  const size=normalizePart(raw.size)||'standard';
  // TCGdex's Base Set card definition is shared by its international
  // translations. Unless a variant explicitly names German availability, jumbo
  // and other non-standard sizes are not evidence of a German physical issue.
  if(context.language==='de'&&context.sourceSetId==='base1'&&size!=='standard'&&!context.explicitlyLanguageScoped) return null;
  const stamps=Array.isArray(raw.stamp)?raw.stamp:raw.stamp?[raw.stamp]:[];
  const normalized=[...new Set(stamps.map((stamp)=>canonicalDetailedTerm(stamp,context.language,'stamp')).filter(Boolean))].sort();
  const firstEdition=normalized.includes('1st_edition')||normalized.includes('first_edition');
  const retained=normalized.filter((stamp)=>stamp!=='1st_edition'&&stamp!=='first_edition');
  const subtype=canonicalDetailedTerm(raw.subtype,context.language,'subtype');
  let marker:string|null=null;
  let micro:string|null=null;
  let trustedStamps=retained;
  // German Base Set has standard Unlimited and 1st Edition print runs, but no
  // German Shadowless/Red Cheeks/copyright/PokeTour issues. TCGdex mechanically
  // localizes those English identities in the German response. Collapse them to
  // the structural edition they actually prove and never surface translated
  // metadata as a German variant label.
  if(context.language==='de'&&context.sourceSetId==='base1'&&!context.explicitlyLanguageScoped){
    marker=firstEdition?'first_edition':'unlimited';
    trustedStamps=[];
  } else if(subtype==='shadowless'&&context.language==='de'&&!context.explicitlyLanguageScoped){
    marker=firstEdition?'first_edition':'unlimited';
    trustedStamps=[];
  } else if(subtype==='shadowless') marker=firstEdition?'shadowless_first_edition':'shadowless';
  else if(subtype==='unlimited') marker='unlimited';
  else if(subtype==='first_edition'||firstEdition) marker='first_edition';
  else if(subtype){
    micro=context.language==='de'&&!context.explicitlyLanguageScoped?null:subtype;
    if(context.language==='de'&&!context.explicitlyLanguageScoped) trustedStamps=[];
    const year=Number(valueText(context.releaseDate).slice(0,4));
    if(year&&year<=2003&&!firstEdition) marker='unlimited';
  }
  return {finish:normalizePart(raw.type)||null,printRunMarker:marker,microVariant:micro,size,stamps:trustedStamps};
}
function fallbackParts(raw:TcgdexCard): VariantParts[] {
  const variants=raw.variants&&typeof raw.variants==='object'?raw.variants:{};
  const finishes=Object.entries(variants).filter(([key,on])=>on===true&&['normal','holo','reverse'].includes(normalizePart(key))).map(([key])=>normalizePart(key));
  const first=Boolean(variants.firstEdition||variants.first_edition);
  const result:VariantParts[]=[];
  for(const finish of finishes.length?finishes:['normal']){
    result.push({finish,size:'standard'});
    if(first) result.push({finish,printRunMarker:'first_edition',size:'standard'});
  }
  return result;
}
function upsertVariant(db:DatabaseSync,args:{cardId:number;parts:VariantParts;sourceRecordId:number|null;at:string;identity:'confirmed'|'inferred';attributes?:unknown}):number{
  const key=variantKey(args.parts);
  return (db.prepare(`INSERT INTO variants
    (card_id,variant_key,finish,print_run_marker,micro_variant,size,stamps_json,identity_status,display_label,attributes_json,source_record_id,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(card_id,variant_key) DO UPDATE SET
      finish=excluded.finish,print_run_marker=excluded.print_run_marker,micro_variant=excluded.micro_variant,size=excluded.size,
      stamps_json=excluded.stamps_json,identity_status=CASE WHEN variants.identity_status='confirmed' THEN 'confirmed' ELSE excluded.identity_status END,
      display_label=excluded.display_label,attributes_json=excluded.attributes_json,
      source_record_id=COALESCE(variants.source_record_id,excluded.source_record_id),updated_at=excluded.updated_at
    RETURNING variant_id`).get(args.cardId,key,nullableText(args.parts.finish),nullableText(args.parts.printRunMarker),nullableText(args.parts.microVariant),
      valueText(args.parts.size,'standard'),json(normalizedStamps(args.parts.stamps)),args.identity,variantLabel(args.parts),json(args.attributes),args.sourceRecordId,args.at,args.at) as {variant_id:number}).variant_id;
}

async function materializeTcgdex(db:DatabaseSync,at:string,dirs?:ObjectStoreDirs):Promise<{sets:number;cards:number;hydratedCards:number;variants:number;assets:number;localAssetsLinked:number}>{
  const setRows=latestObservations(db,'set');
  const cardRows=latestObservations(db,'card');
  const details=new Map(cardRows.map((row)=>[row.scope_key,row]));
  const detailCache=new Map<string,TcgdexCard>();
  const readDetail=async(scopeKey:string):Promise<TcgdexCard|null>=>{
    const cached=detailCache.get(scopeKey);if(cached)return cached;
    const observation=details.get(scopeKey);if(!observation)return null;
    const detail=await readObservationJson<TcgdexCard>(observation,dirs);detailCache.set(scopeKey,detail);return detail;
  };
  let sets=0,cards=0,hydratedCards=0,variants=0,assets=0;
  for(const row of setRows){
    const match=/^([^:]+):set:(.+)$/.exec(row.scope_key); if(!match) continue;
    const lang=match[1]!,sourceSetId=match[2]!;
    const raw=await readObservationJson<TcgdexSet>(row,dirs);
    const setRecord=upsertSourceRecord(db,{source:'tcgdex',namespace:lang,sourceKey:sourceSetId,entityType:'set',language:lang,observation:row,observedAt:row.observed_at});
    const setId=upsertSet(db,lang,{...raw,id:raw.id??sourceSetId},setRecord,at); sets++;
    assets+=primaryAsset(db,setRecord,'set',setId,setImageUrl(raw.logo),at,'webp');
    assets+=primaryAsset(db,setRecord,'set',setId,setImageUrl(raw.symbol),at,'webp');
    for(const brief of raw.cards??[]){
      const sourceId=valueText(brief.id,`${sourceSetId}-${valueText(brief.localId)}`);
      const detailRow=details.get(`${lang}:card:${sourceId}`);
      const detail=detailRow?await readDetail(`${lang}:card:${sourceId}`):null;
      const observation=detailRow??row;
      const cardRecord=upsertSourceRecord(db,{source:'tcgdex',namespace:lang,sourceKey:sourceId,entityType:'card',language:lang,observation,observedAt:observation.observed_at});
      const rawCard={...brief,...(detail??{}),id:sourceId} as TcgdexCard;
      const cardId=upsertCard(db,{setId,raw:rawCard,sourceId,recordId:cardRecord,at,hydrated:Boolean(detail)});
      cards++;
      assets+=primaryAsset(db,cardRecord,'card',cardId,highImageUrl(rawCard.image),at);
      if(detail){
        hydratedCards++;
        const desired:string[]=[];
        const detailed=detail.variants_detailed?.length?detail.variants_detailed:null;
        const canonicalDetail=lang==='en'?detail:await readDetail(`en:card:${sourceId}`);
        const canonicalByVariantId=new Map((canonicalDetail?.variants_detailed??[])
          .filter((item)=>valueText(item.variantId)).map((item)=>[item.variantId!,item]));
        const candidates=detailed?detailed.flatMap((item)=>{
          const canonical=valueText(item.variantId)?canonicalByVariantId.get(item.variantId!):undefined;
          const identity=canonical??item;
          const explicitlyLanguageScoped=Boolean(item.languages?.includes(lang)||canonical?.languages?.includes(lang));
          const resolved=detailedParts({...identity,languages:item.languages??canonical?.languages},{language:lang,sourceSetId,releaseDate:raw.releaseDate,explicitlyLanguageScoped});
          return resolved?[{parts:resolved,raw:item,canonical}]:[];
        }):fallbackParts(detail).map((item)=>({parts:item,raw:null,canonical:null}));
        const grouped=new Map<string,{parts:VariantParts;raw:Array<DetailedVariant>;canonical:Array<DetailedVariant>}>();
        for(const item of candidates){
          const key=variantKey(item.parts),existing=grouped.get(key);
          if(existing){if(item.raw)existing.raw.push(item.raw);if(item.canonical)existing.canonical.push(item.canonical);continue;}
          grouped.set(key,{parts:item.parts,raw:item.raw?[item.raw]:[],canonical:item.canonical?[item.canonical]:[]});
        }
        const parts=[...grouped.values()].map((item)=>({parts:item.parts,attributes:detailed?{
          tcgdexVariantIds:[...new Set(item.raw.map((raw)=>raw.variantId).filter((id):id is string=>Boolean(id)))],
          tcgdexRawIdentities:item.raw.map(({type,subtype,size,stamp,languages})=>({type,subtype,size,stamp,languages})),
          identityVocabulary:item.canonical.length?'en-canonical-by-variant-id':'source-locale',
          languageCuration:lang==='de'?'german-structural-v1':undefined,
        }:{fallbackFrom:'variants'}}));
        for(const item of parts){
          const variantId=upsertVariant(db,{cardId,parts:item.parts,sourceRecordId:cardRecord,at,identity:detailed?'confirmed':'inferred',attributes:item.attributes});
          desired.push(variantKey(item.parts)); variants++;
          linkSource(db,cardRecord,'variant',variantId,'matched',detailed?'tcgdex-detailed-variant':'tcgdex-boolean-fallback',at,detailed?1:0.6);
        }
        if(desired.length){
          const placeholders=desired.map(()=>'?').join(',');
          db.prepare(`DELETE FROM variants WHERE card_id=? AND source_record_id=? AND variant_key NOT IN (${placeholders})`).run(cardId,cardRecord,...desired);
        }
        recordParser(db,detailRow??null,at,{kind:'card-detail',cardId,variants:parts.length});
      }
    }
    recordParser(db,row,at,{kind:'set-index',setId,cards:raw.cards?.length??0});
  }
  const localAssetsLinked=linkDownloadedAssets(db,at);
  return {sets,cards,hydratedCards,variants,assets,localAssetsLinked};
}

function parseMoney(value:unknown):number|null{
  const raw=valueText(value); if(!raw||raw==='–'||raw==='-'||raw.toLowerCase()==='n/a') return null;
  const parsed=Number(raw.replace(/[^0-9.-]+/g,'')); return Number.isFinite(parsed)?parsed:null;
}
function gradeValue(value:unknown):number|null{
  const raw=valueText(value).toUpperCase(); if(raw==='N0'||raw==='AUTH') return null;
  const match=raw.match(/(\d+(?:[._]\d+)?)(?:\D*)$/); if(!match) return null;
  const parsed=Number(match[1]!.replace('_','.')); return Number.isFinite(parsed)?parsed:null;
}
function listPsaFiles(root:string,kind:'population'|'sales'):string[]{
  if(!fs.existsSync(root)) return [];
  const result:string[]=[];
  for(const release of fs.readdirSync(root,{withFileTypes:true}).filter((entry)=>entry.isDirectory())){
    const dir=path.join(root,release.name,kind); if(!fs.existsSync(dir)) continue;
    for(const file of fs.readdirSync(dir).filter((name)=>name.endsWith('.json'))) result.push(path.join(dir,file));
  }
  return result.sort();
}
function latestFiles<T extends {fetchedAt:string}>(root:string,kind:'population'|'sales',id:(value:T)=>string):Map<string,T>{
  const result=new Map<string,T>();
  for(const file of listPsaFiles(root,kind)){
    const data=JSON.parse(fs.readFileSync(file,'utf8')) as T;
    const key=id(data),existing=result.get(key); if(!existing||data.fetchedAt>existing.fetchedAt) result.set(key,data);
  }
  return result;
}
function issueKey(data:PsaIssue):string{return [data.sourceCardId,normalizePart(data.finish),normalizePart(data.printRunMarker),normalizePart(data.microVariant)].join('|')}
function findCard(db:DatabaseSync,data:PsaIssue):number|null{
  const release=valueText(data.release,valueText(data.sourceCardId).split('-')[0]);
  const localId=data.sourceCardId.startsWith(`${release}-`)?data.sourceCardId.slice(release.length+1):splitCardId(data.sourceCardId).localId;
  const rows=db.prepare(`SELECT c.card_id FROM cards c JOIN sets s ON s.set_id=c.set_id WHERE s.language='en' AND s.source_set_id=? AND c.local_id=?`).all(release,localId) as unknown as {card_id:number}[];
  return rows.length===1?rows[0]!.card_id:null;
}
function recordIssueReview(db:DatabaseSync,sourceRecordId:number,data:PsaIssue,at:string,reason:string):void{
  const key=issueKey(data);
  const exists=db.prepare(`SELECT 1 FROM match_reviews WHERE issue_key=? AND status='open'`).get(key); if(exists) return;
  db.prepare(`INSERT INTO match_reviews(source_record_id,target_type,candidate_target_id,reason,candidates_json,status,created_at,issue_key)
    VALUES(?,'card',NULL,?,'[]','open',?,?)`).run(sourceRecordId,reason,at,key);
}
function resolvePsaVariant(db:DatabaseSync,data:PsaIssue,sourceRecordId:number,at:string):{variantId:number|null;status:'matched'|'manual'|'unmatched'}{
  const override=db.prepare(`SELECT target_id FROM match_overrides WHERE source_record_id=? AND target_type='variant' AND active=1`).get(sourceRecordId) as {target_id:number}|undefined;
  if(override){linkSource(db,sourceRecordId,'variant',override.target_id,'manual','manual-match-override',at);return{variantId:override.target_id,status:'manual'}}
  const cardId=findCard(db,data);
  if(!cardId){recordIssueReview(db,sourceRecordId,data,at,'No unique English card matched release and collector number');return{variantId:null,status:'unmatched'}}
  const parts:VariantParts={finish:data.finish,printRunMarker:data.printRunMarker,microVariant:data.microVariant,size:'standard'};
  const variantId=upsertVariant(db,{cardId,parts,sourceRecordId,at,identity:'confirmed',attributes:{evidence:'psa-selection'}});
  linkSource(db,sourceRecordId,'variant',variantId,'matched','psa-explicit-selection',at);
  return{variantId,status:'matched'};
}
function upsertPsaSpec(db:DatabaseSync,namespace:'population'|'sales',data:PopulationFile|SalesFile,sourceRecordId:number,variantId:number|null,status:'matched'|'manual'|'unmatched'):number{
  const specId=namespace==='population'?String((data as PopulationFile).psaSpecId):String((data as SalesFile).salesSpecId);
  const url=namespace==='population'?(data as PopulationFile).popSourceUrl:(data as SalesFile).salesSourceUrl;
  const sales=namespace==='sales'?data as SalesFile:null;
  const pk=(db.prepare(`INSERT INTO psa_specs
    (namespace,spec_id,source_record_id,variant_id,release,source_card_id,finish,print_run_marker,micro_variant,source_url,
      match_status,match_method,fetched_at,coverage_cutoff,coverage_total_count,coverage_pages_fetched,coverage_complete)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(namespace,spec_id) DO UPDATE SET
      source_record_id=excluded.source_record_id,variant_id=excluded.variant_id,release=excluded.release,source_card_id=excluded.source_card_id,
      finish=excluded.finish,print_run_marker=excluded.print_run_marker,micro_variant=excluded.micro_variant,source_url=excluded.source_url,
      match_status=excluded.match_status,match_method=excluded.match_method,fetched_at=excluded.fetched_at,
      coverage_cutoff=excluded.coverage_cutoff,coverage_total_count=excluded.coverage_total_count,
      coverage_pages_fetched=excluded.coverage_pages_fetched,coverage_complete=excluded.coverage_complete RETURNING psa_spec_pk`).get(
        namespace,specId,sourceRecordId,variantId,nullableText(data.release),data.sourceCardId,nullableText(data.finish),nullableText(data.printRunMarker),
        nullableText(data.microVariant),url,status,status==='matched'?'psa-explicit-selection':status==='manual'?'manual-match-override':null,data.fetchedAt,
        sales?.cutoffIso??null,sales?.totalCount??null,sales?.pagesFetched??null,sales?.coverageComplete==null?null:sales.coverageComplete?1:0) as {psa_spec_pk:number}).psa_spec_pk;
  linkSource(db,sourceRecordId,'psa_spec',pk,status,status==='matched'?'psa-explicit-selection':'psa-unresolved',data.fetchedAt,status==='unmatched'?null:1);
  return pk;
}
function parsePopulation(data:PopulationFile,specPk:number,db:DatabaseSync,popObservation:ObservationRow|null,htmlObservation:ObservationRow|null):{population:number;prices:number;census:number}{
  const parsed=JSON.parse(data.populationRaw) as {Results?:Array<{Counts?:Array<Record<string,number>>}>};
  const counts=parsed.Results?.[0]?.Counts?.[0]??{};
  const total=(counts.GradeTotal??0)+(counts.HalfGradeTotal??0)+(counts.QualifiedTotal??0);
  db.prepare(`DELETE FROM psa_population_current WHERE population_spec_pk=?`).run(specPk);
  for(const grade of DISPLAY_GRADES){
    db.prepare(`INSERT INTO psa_population_current
      (population_spec_pk,grade_key,grade_value,qualified,population_count,total_population,half_grade_total,qualified_total,
        observed_at,observation_id,grade_label,grade_order,half_grade_count)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(specPk,grade.key,grade.value,0,grade.base?counts[grade.base]??0:0,total,
        counts.HalfGradeTotal??0,counts.QualifiedTotal??0,data.fetchedAt,popObservation?.observation_id??null,grade.label,grade.order,
        grade.half?counts[grade.half]??0:0);
    if(grade.qualified&&Number(counts[grade.qualified]??0)>0){
      db.prepare(`INSERT INTO psa_population_current
        (population_spec_pk,grade_key,grade_value,qualified,population_count,total_population,half_grade_total,qualified_total,
          observed_at,observation_id,grade_label,grade_order,half_grade_count)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,0)`).run(specPk,grade.key,grade.value,1,counts[grade.qualified]??0,total,
          counts.HalfGradeTotal??0,counts.QualifiedTotal??0,data.fetchedAt,popObservation?.observation_id??null,grade.label,grade.order);
    }
  }
  db.prepare(`DELETE FROM psa_price_current WHERE population_spec_pk=?`).run(specPk);
  for(const row of data.priceRows??[]){
    const numeric=gradeValue(row.gradeText); const definition=DISPLAY_GRADES.find((g)=>g.value===numeric)||(normalizePart(row.gradeText)==='auth'?DISPLAY_GRADES[0]:undefined);
    db.prepare(`INSERT INTO psa_price_current
      (population_spec_pk,grade_key,grade_value,most_recent_price,average_price,psa_price,observed_at,observation_id,grade_label,grade_order)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(specPk,definition?.key??row.gradeText,numeric,parseMoney(row.mostRecentText),parseMoney(row.averageText),
        parseMoney(row.psaPriceText),data.fetchedAt,htmlObservation?.observation_id??null,definition?.label??row.gradeText,definition?.order??999);
  }
  db.prepare(`DELETE FROM psa_census_current WHERE population_spec_pk=?`).run(specPk);
  for(const row of data.censusRows??[]){
    const count=row.gradeLabel.match(/\((\d+)\)/)?.[1];
    db.prepare(`INSERT INTO psa_census_current(population_spec_pk,position,grade_label,grade_value,population_count,pedigree,observed_at,observation_id)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(population_spec_pk,position) DO UPDATE SET
      grade_label=excluded.grade_label,grade_value=excluded.grade_value,population_count=excluded.population_count,
      pedigree=excluded.pedigree,observed_at=excluded.observed_at,observation_id=excluded.observation_id`).run(specPk,row.position,row.gradeLabel,gradeValue(row.gradeLabel),count?Number(count):null,nullableText(row.pedigree),
        data.fetchedAt,htmlObservation?.observation_id??null);
  }
  return{population:DISPLAY_GRADES.length,prices:data.priceRows?.length??0,census:data.censusRows?.length??0};
}
function fingerprint(sale:RawSale):string{
  return createHash('sha256').update([sale.auctionHouse??'',sale.lotNumber??'',sale.saleDate??'',sale.salePrice??'',sale.certNumber??''].join('|')).digest('hex');
}
function upsertSales(db:DatabaseSync,data:SalesFile,specPk:number,observation:ObservationRow|null):number{
  let count=0;
  for(const sale of data.sales??[]){
    const fp=fingerprint(sale); const id=valueText(sale.saleItemId,`fingerprint:${fp}`);
    db.prepare(`INSERT INTO psa_sales
      (sales_spec_pk,sale_item_id,cert_number,auction_house,sale_date,sale_type,sale_price,currency,grade_value,lot_number,
       listing_url,image_url,thumbnail_url,qualifier_code,dna_grade_value,grading_company,sale_fingerprint,observed_at,observation_id)
      VALUES(?,?,?,?,?,?,?,'USD',?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(sales_spec_pk,sale_item_id) DO UPDATE SET
       cert_number=excluded.cert_number,auction_house=excluded.auction_house,sale_date=excluded.sale_date,sale_type=excluded.sale_type,
       sale_price=excluded.sale_price,grade_value=excluded.grade_value,lot_number=excluded.lot_number,listing_url=excluded.listing_url,
       image_url=excluded.image_url,thumbnail_url=excluded.thumbnail_url,qualifier_code=excluded.qualifier_code,dna_grade_value=excluded.dna_grade_value,
       grading_company=excluded.grading_company,sale_fingerprint=excluded.sale_fingerprint,observed_at=excluded.observed_at,observation_id=excluded.observation_id`)
      .run(specPk,id,sale.certNumber??null,sale.auctionHouse??null,sale.saleDate??null,sale.saleType??null,sale.salePrice??null,
        sale.gradeValue??null,sale.lotNumber??null,sale.listingURL??null,sale.imageURL??null,sale.thumbnailURL??null,sale.qualifierCode??null,
        sale.dnaGradeValue??null,sale.gradingCompany??null,fp,data.fetchedAt,observation?.observation_id??null);
    count++;
  }
  return count;
}
async function materializePsa(db:DatabaseSync,root:string,at:string):Promise<Omit<MaterializeResult,'sets'|'cards'|'hydratedCards'|'variants'|'assets'|'localAssetsLinked'|'openReviews'>>{
  const populations=latestFiles<PopulationFile>(root,'population',(data)=>String(data.psaSpecId));
  const sales=latestFiles<SalesFile>(root,'sales',(data)=>String(data.salesSpecId));
  db.prepare(`DELETE FROM match_reviews WHERE source_record_id IN (SELECT source_record_id FROM source_records WHERE source='psa') AND status='open'`).run();
  db.prepare(`DELETE FROM source_links WHERE source_record_id IN (SELECT source_record_id FROM source_records WHERE source='psa')`).run();
  db.prepare(`DELETE FROM psa_specs`).run();
  let psaSpecs=0,populationRows=0,priceRows=0,censusRows=0,salesRows=0,matchedPsaSpecs=0;
  const popPks=new Map<string,number>(),salesPks=new Map<string,number>();
  for(const [specId,data] of populations){
    const popObs=latestObservation(db,'population',`population:${specId}`);
    const htmlObs=latestObservation(db,'cardfacts_html',`cardfacts_html:${specId}`);
    const record=upsertSourceRecord(db,{source:'psa',namespace:'population',sourceKey:specId,entityType:'population',language:'en',observation:popObs,observedAt:data.fetchedAt});
    const match=resolvePsaVariant(db,data,record,data.fetchedAt);
    const pk=upsertPsaSpec(db,'population',data,record,match.variantId,match.status); popPks.set(specId,pk); psaSpecs++;
    if(match.status!=='unmatched') matchedPsaSpecs++;
    const facts=parsePopulation(data,pk,db,popObs,htmlObs); populationRows+=facts.population;priceRows+=facts.prices;censusRows+=facts.census;
    recordParser(db,popObs,at,{kind:'population',specPk:pk,rows:facts.population});
    recordParser(db,htmlObs,at,{kind:'cardfacts',specPk:pk,prices:facts.prices,census:facts.census});
  }
  for(const [specId,data] of sales){
    const obs=latestObservation(db,'sales_snapshot',`sales:${specId}:snapshot`);
    const record=upsertSourceRecord(db,{source:'psa',namespace:'sales',sourceKey:specId,entityType:'sales_snapshot',language:'en',observation:obs,observedAt:data.fetchedAt});
    const match=resolvePsaVariant(db,data,record,data.fetchedAt);
    const pk=upsertPsaSpec(db,'sales',data,record,match.variantId,match.status);salesPks.set(specId,pk);psaSpecs++;
    if(match.status!=='unmatched')matchedPsaSpecs++;
    const count=upsertSales(db,data,pk,obs);salesRows+=count;recordParser(db,obs,at,{kind:'sales',specPk:pk,rows:count});
  }
  for(const [popId,data] of populations){
    if(data.salesSpecId==null)continue;
    const popPk=popPks.get(popId),salesPk=salesPks.get(String(data.salesSpecId));if(popPk==null||salesPk==null)continue;
    db.prepare(`INSERT INTO psa_spec_pairs(population_spec_pk,sales_spec_pk,link_method,confidence,created_at)
      VALUES(?,?,'explicit-selection-id',1,?)`).run(popPk,salesPk,at);
  }
  return{psaSpecs,populationRows,priceRows,censusRows,salesRows,matchedPsaSpecs};
}

export async function materialize(db:DatabaseSync,options:MaterializeOptions={}):Promise<MaterializeResult>{
  const at=options.now??new Date().toISOString();
  const result:MaterializeResult={sets:0,cards:0,hydratedCards:0,variants:0,assets:0,localAssetsLinked:0,psaSpecs:0,populationRows:0,priceRows:0,censusRows:0,salesRows:0,matchedPsaSpecs:0,openReviews:0};
  db.exec('BEGIN IMMEDIATE');
  try{
    if(options.includeTcgdex!==false){const tcg=await materializeTcgdex(db,at,options.objectStoreDirs);result.sets=tcg.sets;result.cards=tcg.cards;result.hydratedCards=tcg.hydratedCards;result.variants=tcg.variants;result.assets=tcg.assets;result.localAssetsLinked=tcg.localAssetsLinked;}
    if(options.includePsa!==false){const psa=await materializePsa(db,options.psaDir??path.join(DATA_DIR,'psa-raw'),at);Object.assign(result,psa);}
    result.openReviews=Number((db.prepare(`SELECT COUNT(*) n FROM match_reviews WHERE status='open'`).get() as {n:number}).n);
    db.exec('COMMIT');return result;
  }catch(error){db.exec('ROLLBACK');throw error;}
}
