import type { DatabaseSync } from 'node:sqlite';
import type {
  AuctionDetail, AuctionFacetsData, AuctionPageData, AuctionPriceObservation, AuctionSearchItem,
  CardDetail, CardSearchItem, FacetsData, FxRateMeta, HealthData, MarketData, MatchReviewItem, Page,
  PopulationData, SaleRow, SortOption, SourceStatus, VariantDetail, VariantSearchItem,
  EbayListingItem,EbayListingPageData,PipelineListItem,CoverageStatus,
} from './types.ts';

type SqlValue = string | number | null;
type Row = Record<string, unknown>;

const CARD_SORTS: Partial<Record<SortOption, string>> = {
  set_number: 'release_date IS NULL, release_date ASC, source_set_id ASC, local_sort_key ASC',
  newest: 'release_date IS NULL, release_date DESC, set_name COLLATE NOCASE ASC, local_sort_key ASC',
  oldest: 'release_date IS NULL, release_date ASC, set_name COLLATE NOCASE ASC, local_sort_key ASC',
  name_asc: 'name COLLATE NOCASE ASC, source_set_id ASC, local_sort_key ASC',
  name_desc: 'name COLLATE NOCASE DESC, source_set_id ASC, local_sort_key ASC',
  number_asc: 'local_sort_key ASC', number_desc: 'local_sort_key DESC',
};
const VARIANT_SORTS: Partial<Record<SortOption, string>> = {
  set_number: 'v.release_date IS NULL, v.release_date ASC, v.source_set_id ASC, v.local_sort_key ASC, v.variant_id ASC',
  newest: 'v.release_date IS NULL, v.release_date DESC, v.set_name COLLATE NOCASE ASC, v.local_sort_key ASC',
  oldest: 'v.release_date IS NULL, v.release_date ASC, v.set_name COLLATE NOCASE ASC, v.local_sort_key ASC',
  name_asc: 'v.name COLLATE NOCASE ASC, v.set_name COLLATE NOCASE ASC, v.local_sort_key ASC',
  name_desc: 'v.name COLLATE NOCASE DESC, v.set_name COLLATE NOCASE ASC, v.local_sort_key ASC',
  number_asc: 'v.local_sort_key ASC', number_desc: 'v.local_sort_key DESC',
  gem_rate_desc: 'm.gem_rate IS NULL, m.gem_rate DESC, v.local_sort_key ASC',
  gem_rate_asc: 'm.gem_rate IS NULL, m.gem_rate ASC, v.local_sort_key ASC',
  pop_psa10_desc: 'm.psa10_population IS NULL, m.psa10_population DESC, v.local_sort_key ASC',
  pop_psa10_asc: 'm.psa10_population IS NULL, m.psa10_population ASC, v.local_sort_key ASC',
  psa10_price_desc: 'm.latest_psa10_price IS NULL, m.latest_psa10_price DESC, v.local_sort_key ASC',
  psa10_price_asc: 'm.latest_psa10_price IS NULL, m.latest_psa10_price ASC, v.local_sort_key ASC',
  sales12mo_desc: 'm.sales_12mo IS NULL, m.sales_12mo DESC, v.local_sort_key ASC',
  sales12mo_asc: 'm.sales_12mo IS NULL, m.sales_12mo ASC, v.local_sort_key ASC',
};

function text(value: unknown): string | null { return value == null ? null : String(value) }
function number(value: unknown): number | null { return value == null || value === '' ? null : Number(value) }
function integer(value: unknown): number { return Number(value ?? 0) }
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return {};
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; } catch { return {}; }
}
function strings(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed.map(String) : []; } catch { return []; }
}
function pageArgs(search: URLSearchParams): { page: number; pageSize: number } {
  const page = Math.max(1, Math.floor(Number(search.get('page') ?? 1) || 1));
  return { page, pageSize: Math.min(60, Math.max(1, Math.floor(Number(search.get('pageSize') ?? 24) || 24))) };
}
function cardSortValue(value: string | null): SortOption { return value && value in CARD_SORTS ? value as SortOption : 'set_number' }
function variantSortValue(value: string | null): SortOption { return value && value in VARIANT_SORTS ? value as SortOption : 'set_number' }
function searchWhere(search: URLSearchParams, prefix = ''): { sql: string; params: SqlValue[] } {
  const clauses: string[] = [], params: SqlValue[] = [];
  const q = search.get('q')?.trim();
  if (q) { clauses.push(`(${prefix}name LIKE ? OR ${prefix}set_name LIKE ? OR ${prefix}local_id LIKE ? OR COALESCE(${prefix}number,'') LIKE ?)`); const p=`%${q}%`; params.push(p,p,p,p); }
  for (const [query,column] of [['language','language'],['category','category'],['rarity','rarity']] as const) { const value=search.get(query); if(value){clauses.push(`${prefix}${column}=?`);params.push(value);} }
  const set=search.get('set'); if(set){clauses.push(`(${prefix}source_set_id=? OR ${prefix}set_name=?)`);params.push(set,set);}
  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

const RANGE_FIELDS = [
  ['psa10Price', 'm.latest_psa10_price'], ['avgPsa10Price', 'm.avg_psa10_price'],
  ['popPsa10', 'm.psa10_population'], ['totalGraded', 'm.total_graded'],
  ['gemRate', 'm.gem_rate'], ['sales12mo', 'm.sales_12mo'], ['lastSalePrice', 'm.latest_sale_price'],
] as const;
function rangeClauses(search: URLSearchParams): { sql: string[]; params: SqlValue[] } {
  const sql: string[] = [], params: SqlValue[] = [];
  for (const [key, column] of RANGE_FIELDS) {
    const min = search.get(`${key}Min`), max = search.get(`${key}Max`);
    if (min) { sql.push(`${column} >= ?`); params.push(Number(min)); }
    if (max) { sql.push(`${column} <= ?`); params.push(Number(max)); }
  }
  return { sql, params };
}
// One CTE powers both list-time filtering/sorting and item display, so the
// numbers a filter range narrows on always match the numbers rendered.
// `idFilter` restricts the underlying psa_specs scan to a known id set (used
// by summaryRows for single-card/variant lookups); omitted for the full list.
function variantMetricsCte(idFilter?: { sql: string; params: SqlValue[] }): { sql: string; params: SqlValue[] } {
  const cutoff = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
  const extra = idFilter ? ` AND ${idFilter.sql}` : '';
  const sql = `latest_pop AS (SELECT *,ROW_NUMBER() OVER(PARTITION BY variant_id ORDER BY fetched_at DESC,psa_spec_pk DESC) rn
      FROM psa_specs WHERE namespace='population' AND match_status IN ('matched','manual')${extra}),
    pop AS (SELECT lp.variant_id,MAX(p.total_population) total_graded,
      SUM(CASE WHEN p.grade_value=10 AND p.qualified=0 THEN p.population_count ELSE 0 END) psa10_population
      FROM latest_pop lp JOIN psa_population_current p ON p.population_spec_pk=lp.psa_spec_pk WHERE lp.rn=1 GROUP BY lp.variant_id),
    price AS (SELECT lp.variant_id,pc.psa_price latest_psa10_price,pc.average_price avg_psa10_price
      FROM latest_pop lp JOIN psa_price_current pc ON pc.population_spec_pk=lp.psa_spec_pk WHERE lp.rn=1 AND pc.grade_value=10),
    latest_sales_spec AS (SELECT ps.*,ROW_NUMBER() OVER(PARTITION BY ps.variant_id ORDER BY
      EXISTS(SELECT 1 FROM psa_sales s WHERE s.sales_spec_pk=ps.psa_spec_pk) DESC,
      ps.fetched_at DESC,ps.psa_spec_pk DESC) rn
      FROM psa_specs ps WHERE ps.namespace='sales' AND ps.match_status IN ('matched','manual')${extra}),
    ranked_sales AS (SELECT lss.variant_id,s.sale_price,s.sale_date,
      ROW_NUMBER() OVER(PARTITION BY lss.variant_id ORDER BY s.sale_date DESC,s.sale_row_id DESC) rn,
      COUNT(*) OVER(PARTITION BY lss.variant_id) sale_count,
      SUM(CASE WHEN s.grade_value=10 AND s.sale_date>=? THEN 1 ELSE 0 END) OVER(PARTITION BY lss.variant_id) sales_12mo
      FROM latest_sales_spec lss JOIN psa_sales s ON s.sales_spec_pk=lss.psa_spec_pk WHERE lss.rn=1),
    metrics AS (SELECT v.variant_id,pop.total_graded,pop.psa10_population,
      CASE WHEN pop.total_graded>0 THEN CAST(pop.psa10_population AS REAL)*100.0/pop.total_graded END gem_rate,
      price.latest_psa10_price,price.avg_psa10_price,
      rs.sale_price latest_sale_price,rs.sale_date latest_sale_date,COALESCE(rs.sale_count,0) sale_count,COALESCE(rs.sales_12mo,0) sales_12mo,
      EXISTS(SELECT 1 FROM latest_pop lp WHERE lp.variant_id=v.variant_id AND lp.rn=1) population_available,
      EXISTS(SELECT 1 FROM latest_sales_spec ls WHERE ls.variant_id=v.variant_id AND ls.rn=1) sales_available
      FROM variants v LEFT JOIN pop ON pop.variant_id=v.variant_id LEFT JOIN price ON price.variant_id=v.variant_id
      LEFT JOIN ranked_sales rs ON rs.variant_id=v.variant_id AND rs.rn=1)`;
  const params = idFilter ? [...idFilter.params, ...idFilter.params, cutoff] : [cutoff];
  return { sql, params };
}
function cardImage(db: DatabaseSync, cardId: number, fallback: unknown): string | null {
  const has = db.prepare(`SELECT 1 FROM assets WHERE target_type='card' AND target_id=? LIMIT 1`).get(cardId);
  return has || text(fallback) ? `/media/card/${cardId}` : null;
}
function cardItem(db: DatabaseSync, row: Row): CardSearchItem {
  const cardId=integer(row.card_id);
  const detailStatus=text(row.detail_status)==='hydrated'?'hydrated':'stub';
  return { cardId,setId:integer(row.set_id),language:String(row.language),sourceSetId:String(row.source_set_id),setName:String(row.set_name),
    series:text(row.series),releaseDate:text(row.release_date),localId:String(row.local_id),number:text(row.number),name:String(row.name),
    category:text(row.category),rarity:text(row.rarity),imageUrl:cardImage(db,cardId,row.image_url),detailStatus,
    variantCoverage:detailStatus==='hydrated'?'complete':'unknown',variantCount:row.variant_count==null?null:integer(row.variant_count) };
}

interface VariantSummary {
  total_graded?: unknown; psa10_population?: unknown; latest_psa10_price?: unknown; avg_psa10_price?: unknown;
  latest_sale_price?: unknown; latest_sale_date?: unknown; sale_count?: unknown; sales_12mo?: unknown;
  population_available?: unknown; sales_available?: unknown;
}
function summaryRows(db:DatabaseSync,ids:number[]):Map<number,VariantSummary>{
  if(!ids.length)return new Map(); const marks=ids.map(()=>'?').join(',');
  const cte=variantMetricsCte({sql:`variant_id IN (${marks})`,params:ids});
  const rows=db.prepare(`WITH ${cte.sql}
    SELECT v.variant_id,m.total_graded,m.psa10_population,m.latest_psa10_price,m.avg_psa10_price,
      m.latest_sale_price,m.latest_sale_date,m.sale_count,m.sales_12mo,m.population_available,m.sales_available
    FROM variants v LEFT JOIN metrics m ON m.variant_id=v.variant_id WHERE v.variant_id IN (${marks})`).all(...cte.params,...ids) as unknown as Array<Row&{variant_id:number}>;
  return new Map(rows.map((row)=>[integer(row.variant_id),row as VariantSummary]));
}
function variantItem(db:DatabaseSync,row:Row,summary:VariantSummary={}):VariantSearchItem{
  const variantId=integer(row.variant_id),cardId=integer(row.card_id);
  const population=Boolean(integer(summary.population_available)),sales=Boolean(integer(summary.sales_available));
  const psaPopulationTotal=integer(summary.total_graded),psa10Population=integer(summary.psa10_population);
  return {variantId,cardId,setId:integer(row.set_id),language:String(row.language),sourceSetId:String(row.source_set_id),setName:String(row.set_name),
    localId:String(row.local_id),number:text(row.number),name:String(row.name),variantLabel:String(row.variant_label),finish:text(row.finish),
    printRunMarker:text(row.print_run_marker),microVariant:text(row.micro_variant),size:text(row.size),stamps:strings(row.stamps_json),
    identityStatus:(text(row.identity_status) as VariantSearchItem['identityStatus'])??'inferred',imageUrl:cardImage(db,cardId,row.image_url),
    psaMatchStatus:population||sales?'matched':'none',psaPopulationTotal,psa10Population,
    gemRate:psaPopulationTotal?psa10Population/psaPopulationTotal*100:null,
    latestPsa10Price:number(summary.latest_psa10_price),avgPsa10Price:number(summary.avg_psa10_price),
    latestSalePrice:number(summary.latest_sale_price),latestSaleDate:text(summary.latest_sale_date),
    saleCount:integer(summary.sale_count),psa10Sales12Month:integer(summary.sales_12mo),
    psaPopulationAvailable:population,psaSalesAvailable:sales};
}

export function listCards(db:DatabaseSync,search:URLSearchParams):Page<CardSearchItem>{
  const {page,pageSize}=pageArgs(search),where=searchWhere(search),order=CARD_SORTS[cardSortValue(search.get('sort'))];
  const total=integer((db.prepare(`SELECT COUNT(*) total FROM v_card_search ${where.sql}`).get(...where.params) as Row).total),totalPages=Math.ceil(total/pageSize),safe=totalPages?Math.min(page,totalPages):1;
  const rows=db.prepare(`SELECT * FROM v_card_search ${where.sql} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...where.params,pageSize,(safe-1)*pageSize) as unknown as Row[];
  return {items:rows.map((row)=>cardItem(db,row)),total,page:safe,pageSize,totalPages};
}
export function listVariants(db:DatabaseSync,search:URLSearchParams):Page<VariantSearchItem>{
  const {page,pageSize}=pageArgs(search),where=searchWhere(search,'v.'),clauses=where.sql?[where.sql.slice(6)]:[],params=[...where.params];
  for(const [query,column] of [['finish','finish'],['printRunMarker','print_run_marker'],['microVariant','micro_variant']] as const){const value=search.get(query);if(value){clauses.push(`v.${column}=?`);params.push(value);}}
  const ranges=rangeClauses(search); clauses.push(...ranges.sql); params.push(...ranges.params);
  const filter=clauses.length?`WHERE ${clauses.join(' AND ')}`:'',order=VARIANT_SORTS[variantSortValue(search.get('sort'))];
  const cte=variantMetricsCte();
  const from=`FROM v_variant_search v LEFT JOIN metrics m ON m.variant_id=v.variant_id`;
  const total=integer((db.prepare(`WITH ${cte.sql} SELECT COUNT(*) total ${from} ${filter}`).get(...cte.params,...params) as Row).total),totalPages=Math.ceil(total/pageSize),safe=totalPages?Math.min(page,totalPages):1;
  const rows=db.prepare(`WITH ${cte.sql} SELECT v.*,m.total_graded,m.psa10_population,m.latest_psa10_price,m.avg_psa10_price,
      m.latest_sale_price,m.latest_sale_date,m.sale_count,m.sales_12mo,m.population_available,m.sales_available
    ${from} ${filter} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...cte.params,...params,pageSize,(safe-1)*pageSize) as unknown as Row[];
  return {items:rows.map((row)=>variantItem(db,row,row as unknown as VariantSummary)),total,page:safe,pageSize,totalPages};
}
function baseCard(db:DatabaseSync,cardId:number):CardSearchItem|null{const row=db.prepare(`SELECT * FROM v_card_search WHERE card_id=?`).get(cardId) as Row|undefined;return row?cardItem(db,row):null}
export function getCard(db:DatabaseSync,cardId:number):CardDetail|null{
  const card=baseCard(db,cardId);if(!card)return null;
  const attrs=db.prepare(`SELECT attributes_json FROM cards WHERE card_id=?`).get(cardId) as Row;
  // Keep source/materialization order: it is stable and preserves the intended
  // issue sequence (base print, editions, then micro-variants) better than an
  // alphabetical display-label sort.
  const rows=db.prepare(`SELECT * FROM v_variant_search WHERE card_id=? ORDER BY variant_id`).all(cardId) as unknown as Row[];
  const summaries=summaryRows(db,rows.map((row)=>integer(row.variant_id)));
  const also=db.prepare(`SELECT other.card_id,s.language,s.name set_name,s.set_id FROM cards current JOIN sets current_set ON current_set.set_id=current.set_id
    JOIN sets s ON s.source_set_id=current_set.source_set_id JOIN cards other ON other.set_id=s.set_id AND other.local_id=current.local_id
    WHERE current.card_id=? AND other.card_id<>current.card_id ORDER BY s.language`).all(cardId) as unknown as Row[];
  return {...card,attributes:object(attrs.attributes_json),variants:rows.map((row)=>variantItem(db,row,summaries.get(integer(row.variant_id)))),
    alsoPrintedIn:also.map((row)=>({cardId:integer(row.card_id),language:String(row.language),setName:String(row.set_name),setId:integer(row.set_id)}))};
}
function variantRow(db:DatabaseSync,variantId:number):Row|undefined{return db.prepare(`SELECT * FROM v_variant_search WHERE variant_id=?`).get(variantId) as Row|undefined}
export function getVariant(db:DatabaseSync,variantId:number):VariantDetail|null{
  const row=variantRow(db,variantId);if(!row)return null;const detail=db.prepare(`SELECT * FROM v_variant_detail WHERE variant_id=?`).get(variantId) as Row;
  const related=baseCard(db,integer(row.card_id));if(!related)return null;const summary=summaryRows(db,[variantId]).get(variantId);
  const refs=db.prepare(`SELECT sr.source,sr.namespace,sr.source_key,sl.match_status,ps.source_url FROM source_links sl JOIN source_records sr ON sr.source_record_id=sl.source_record_id
    LEFT JOIN psa_specs ps ON ps.source_record_id=sr.source_record_id WHERE sl.target_type='variant' AND sl.target_id=? ORDER BY sr.source,sr.namespace,sr.source_key`).all(variantId) as unknown as Row[];
  return {...variantItem(db,row,summary),variantKey:String(detail.variant_key),releaseDate:text(detail.release_date),attributes:object(detail.variant_attributes_json),
    cardAttributes:object(detail.card_attributes_json),matchedSourceCount:integer(detail.matched_source_count),assetCount:integer(detail.asset_count),relatedCard:related,
    sourceReferences:refs.map((ref)=>({source:String(ref.source),namespace:String(ref.namespace),sourceKey:String(ref.source_key),status:String(ref.match_status),url:text(ref.source_url)}))};
}
function matchedSpec(db:DatabaseSync,variantId:number,namespace:'population'|'sales'):Row|undefined{
  const salesOrder=namespace==='sales'?`EXISTS(SELECT 1 FROM psa_sales s WHERE s.sales_spec_pk=ps.psa_spec_pk) DESC,`:'';
  return db.prepare(`SELECT ps.* FROM psa_specs ps WHERE ps.variant_id=? AND ps.namespace=? AND ps.match_status IN ('matched','manual')
    ORDER BY ${salesOrder} ps.fetched_at DESC,ps.psa_spec_pk DESC LIMIT 1`).get(variantId,namespace) as Row|undefined;
}
function sale(row:Row):SaleRow{return {saleRowId:integer(row.sale_row_id),saleItemId:String(row.sale_item_id),saleDate:text(row.sale_date),salePrice:number(row.sale_price),currency:String(row.currency??'USD'),gradeValue:number(row.grade_value),auctionHouse:text(row.auction_house),saleType:text(row.sale_type),certNumber:text(row.cert_number),lotNumber:text(row.lot_number),listingUrl:text(row.listing_url),qualifierCode:text(row.qualifier_code)}}
export function getMarket(db:DatabaseSync,variantId:number):MarketData{
  const pop=matchedSpec(db,variantId,'population'),salesSpec=matchedSpec(db,variantId,'sales');
  const price=pop?db.prepare(`SELECT psa_price,average_price FROM psa_price_current WHERE population_spec_pk=? AND grade_value=10 ORDER BY observed_at DESC LIMIT 1`).get(integer(pop.psa_spec_pk)) as Row|undefined:undefined;
  const pop10=pop?db.prepare(`SELECT COALESCE(SUM(CASE WHEN qualified=0 THEN population_count ELSE 0 END),0)n,MAX(total_population) total FROM psa_population_current WHERE population_spec_pk=? AND grade_value=10`).get(integer(pop.psa_spec_pk)) as Row:{n:0,total:0};
  const sales=salesSpec?(db.prepare(`SELECT * FROM psa_sales WHERE sales_spec_pk=? AND grade_value=10 ORDER BY sale_date,sale_row_id`).all(integer(salesSpec.psa_spec_pk)) as unknown as Row[]).map(sale):[];
  const byMonth=new Map<string,number[]>();for(const item of sales){if(!item.saleDate||item.salePrice==null)continue;const month=item.saleDate.slice(0,7),values=byMonth.get(month)??[];values.push(item.salePrice);byMonth.set(month,values);}
  const monthly=[...byMonth].sort(([a],[b])=>a.localeCompare(b)).map(([month,values])=>{values.sort((a,b)=>a-b);const middle=Math.floor(values.length/2);const median=values.length%2?values[middle]!:(values[middle-1]!+values[middle]!)/2;return{month,medianPrice:median,count:values.length}});
  const cutoff=new Date(Date.now()-365*86400000).toISOString().slice(0,10),totalGraded=integer(pop10.total),psa10=integer(pop10.n);
  return {populationAvailable:Boolean(pop),priceGuideAvailable:Boolean(price),salesAvailable:Boolean(salesSpec),psa10Price:number(price?.psa_price),averagePsa10Price:number(price?.average_price),psa10Population:psa10,totalGraded,gemRate:totalGraded?psa10/totalGraded*100:null,
    sales12Month:sales.filter((item)=>(item.saleDate??'')>=cutoff).length,coverage:{from:sales[0]?.saleDate??null,to:sales.at(-1)?.saleDate??null,count:sales.length,
      cutoff:text(salesSpec?.coverage_cutoff),totalCount:number(salesSpec?.coverage_total_count),pagesFetched:number(salesSpec?.coverage_pages_fetched),complete:salesSpec?.coverage_complete==null?null:Boolean(integer(salesSpec.coverage_complete))},sales,monthly};
}
export function getPopulation(db:DatabaseSync,variantId:number):PopulationData{
  const spec=matchedSpec(db,variantId,'population');if(!spec)return{available:false,observedAt:null,sourceUrl:null,totalGraded:0,gemRate:null,grades:[],prices:[]};
  const rows=db.prepare(`SELECT * FROM psa_population_current WHERE population_spec_pk=? ORDER BY grade_order,qualified`).all(integer(spec.psa_spec_pk)) as unknown as Row[];
  const grouped=new Map<string,{gradeKey:string;gradeLabel:string;gradeValue:number|null;populationCount:number;qualifiedCount:number;halfGradeCount:number}>();
  for(const row of rows){const key=String(row.grade_key),item=grouped.get(key)??{gradeKey:key,gradeLabel:String(row.grade_label??key),gradeValue:number(row.grade_value),populationCount:0,qualifiedCount:0,halfGradeCount:integer(row.half_grade_count)};if(integer(row.qualified))item.qualifiedCount+=integer(row.population_count);else item.populationCount+=integer(row.population_count);grouped.set(key,item);}
  const total=integer(rows[0]?.total_population),gem10=grouped.get('10')?.populationCount??0;
  const prices=db.prepare(`SELECT * FROM psa_price_current WHERE population_spec_pk=? ORDER BY grade_order`).all(integer(spec.psa_spec_pk)) as unknown as Row[];
  return {available:true,observedAt:text(rows[0]?.observed_at),sourceUrl:text(spec.source_url),totalGraded:total,gemRate:total?gem10/total*100:null,grades:[...grouped.values()],prices:prices.map((row)=>({gradeKey:String(row.grade_key),gradeLabel:String(row.grade_label??row.grade_key),gradeValue:number(row.grade_value),mostRecentPrice:number(row.most_recent_price),averagePrice:number(row.average_price),psaPrice:number(row.psa_price)}))};
}

function latestFx(db:DatabaseSync,now:Date):FxRateMeta|null{
  const row=db.prepare(`SELECT * FROM exchange_rates WHERE source='ecb' AND base_currency='EUR' AND quote_currency='USD'
    ORDER BY rate_date DESC,exchange_rate_id DESC LIMIT 1`).get() as Row|undefined;
  if(!row)return null;
  const rateDate=String(row.rate_date),age=Math.max(0,(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate())-new Date(`${rateDate}T00:00:00Z`).getTime())/86400000);
  return{baseCurrency:'EUR',quoteCurrency:'USD',rate:Number(row.rate),rateDate,observedAt:String(row.observed_at),stale:age>1,usable:age<=7};
}

function auctionRows(db:DatabaseSync,auctionId?:number):Row[]{
  const idSql=auctionId==null?'':'AND e.ebay_listing_id=?';
  return db.prepare(`WITH latest_price AS (
      SELECT *,ROW_NUMBER() OVER(PARTITION BY ebay_listing_id ORDER BY observed_at DESC,ebay_price_observation_id DESC) rn
      FROM ebay_listing_price_observations)
    SELECT e.*,lp.price_value auction_price,lp.price_currency auction_currency,lp.current_bid_price,lp.minimum_bid_price,
      lp.bid_count,lp.item_end_date,lp.observed_at auction_observed_at,lp.buying_options_json,v.*
    FROM ebay_listings e JOIN latest_price lp ON lp.ebay_listing_id=e.ebay_listing_id AND lp.rn=1
    JOIN v_variant_search v ON v.variant_id=e.variant_id
    WHERE e.variant_id IS NOT NULL AND e.grade_value=10 AND e.is_lot=0 AND e.flagged=0 AND e.match_status IN ('matched','manual')
      AND e.match_tier IN ('exact','strong') ${idSql}`).all(...(auctionId==null?[]:[auctionId])) as unknown as Row[];
}

function comparison(psaGuide:number|null,bid:number|null,currency:string|null,fx:FxRateMeta|null){
  let eur:number|null=null,discount:number|null=null;
  if(psaGuide!=null&&bid!=null){
    const comparable=currency==='USD'?psaGuide:currency==='EUR'&&fx?.usable?psaGuide/fx.rate:null;
    eur=fx?.usable?psaGuide/fx.rate:null;
    if(comparable!=null&&comparable>0)discount=(comparable-bid)/comparable*100;
  }
  return{psaGuideUsd:psaGuide,psaGuideEur:eur,discountPercent:discount,fxRateDate:eur!=null?fx!.rateDate:null};
}

function auctionItem(db:DatabaseSync,row:Row,summary:VariantSummary,fx:FxRateMeta|null,now:Date):AuctionSearchItem{
  const variant=variantItem(db,row,summary),bid=number(row.current_bid_price)??number(row.auction_price),end=text(row.item_end_date),observed=String(row.auction_observed_at);
  return{auctionId:integer(row.ebay_listing_id),itemId:String(row.item_id),marketplace:String(row.marketplace),title:String(row.title),
    itemUrl:text(row.item_web_url),imageUrl:text(row.primary_image_url)?`/media/ebay/${integer(row.ebay_listing_id)}`:null,
    matchTier:text(row.match_tier)==='exact'?'exact':'strong',certNumber:text(row.cert_number),variant,currentBid:bid,
    minimumBid:number(row.minimum_bid_price),currency:text(row.auction_currency),bidCount:integer(row.bid_count),endAt:end,observedAt:observed,
    shippingCost:number(row.shipping_cost_value),shippingCurrency:text(row.shipping_cost_currency),shippingService:text(row.shipping_service),
    active:Boolean(end&&new Date(end)>now),stale:now.getTime()-new Date(observed).getTime()>6*3600000,
    comparison:comparison(variant.latestPsa10Price,bid,text(row.auction_currency),fx)};
}

function activeAuctions(db:DatabaseSync,now:Date):AuctionSearchItem[]{
  const rows=auctionRows(db),summaries=summaryRows(db,rows.map((row)=>integer(row.variant_id))),fx=latestFx(db,now),cutoff=now.getTime()+72*3600000;
  return rows.filter((row)=>strings(row.buying_options_json).includes('AUCTION')).map((row)=>auctionItem(db,row,summaries.get(integer(row.variant_id))??{},fx,now)).filter((item)=>
    item.active&&item.bidCount>=1&&item.endAt!=null&&new Date(item.endAt).getTime()<=cutoff);
}

export function listAuctions(db:DatabaseSync,search:URLSearchParams,now=new Date()):AuctionPageData{
  const fx=latestFx(db,now),all=activeAuctions(db,now),endingWithin=Math.min(72,Math.max(1,Number(search.get('endingWithin')??72)||72));
  const q=(search.get('q')??'').trim().toLowerCase(),language=search.get('language'),set=search.get('set'),psaPrice=search.get('psaPrice')??'all';
  const bidMin=number(search.get('bidMin')),bidMax=number(search.get('bidMax')),discountMin=number(search.get('discountMin'));
  let items=all.filter((item)=>{
    const endOk=item.endAt!=null&&new Date(item.endAt).getTime()<=now.getTime()+endingWithin*3600000;
    const queryOk=!q||[item.title,item.variant.name,item.variant.setName,item.variant.number,item.variant.localId].some((value)=>String(value??'').toLowerCase().includes(q));
    const setOk=!set||item.variant.sourceSetId===set||item.variant.setName===set;
    const priceOk=psaPrice==='available'?item.comparison.psaGuideUsd!=null:psaPrice==='missing'?item.comparison.psaGuideUsd==null:true;
    const bidOk=(bidMin==null||item.currentBid!=null&&item.currentBid>=bidMin)&&(bidMax==null||item.currentBid!=null&&item.currentBid<=bidMax);
    return endOk&&queryOk&&(!language||item.variant.language===language)&&setOk&&priceOk&&bidOk&&(discountMin==null||item.comparison.discountPercent!=null&&item.comparison.discountPercent>=discountMin);
  });
  const sort=search.get('sort')??'opportunity_desc';
  items.sort((a,b)=>sort==='ending_soon'?(a.endAt??'').localeCompare(b.endAt??''):
    sort==='bids_desc'?b.bidCount-a.bidCount:
    sort==='bid_asc'?(a.currentBid??Infinity)-(b.currentBid??Infinity):
    sort==='bid_desc'?(b.currentBid??-Infinity)-(a.currentBid??-Infinity):
    sort==='psa_price_desc'?(b.comparison.psaGuideUsd??-Infinity)-(a.comparison.psaGuideUsd??-Infinity):
    (b.comparison.discountPercent??-Infinity)-(a.comparison.discountPercent??-Infinity)||(a.endAt??'').localeCompare(b.endAt??''));
  const discounts=all.map((item)=>item.comparison.discountPercent).filter((value):value is number=>value!=null).sort((a,b)=>a-b),middle=Math.floor(discounts.length/2);
  const median=discounts.length?(discounts.length%2?discounts[middle]!:(discounts[middle-1]!+discounts[middle]!)/2):null;
  const {page,pageSize}=pageArgs(search),total=items.length,totalPages=Math.ceil(total/pageSize),safe=totalPages?Math.min(page,totalPages):1;
  return{items:items.slice((safe-1)*pageSize,safe*pageSize),total,page:safe,pageSize,totalPages,
    summary:{active:all.length,ending24Hours:all.filter((item)=>item.endAt!=null&&new Date(item.endAt).getTime()<=now.getTime()+24*3600000).length,
      withPsaGuide:all.filter((item)=>item.comparison.psaGuideUsd!=null).length,medianDiscountPercent:median},
    lastObservedAt:all.map((item)=>item.observedAt).sort().at(-1)??null,fx};
}

export function getAuctionFacets(db:DatabaseSync,now=new Date()):AuctionFacetsData{
  const items=activeAuctions(db,now),sets=new Map<string,{id:string;name:string;language:string}>();
  for(const item of items)sets.set(`${item.variant.language}:${item.variant.sourceSetId}`,{id:item.variant.sourceSetId,name:item.variant.setName,language:item.variant.language});
  return{languages:[...new Set(items.map((item)=>item.variant.language))].sort(),sets:[...sets.values()].sort((a,b)=>a.name.localeCompare(b.name))};
}

export function getAuction(db:DatabaseSync,auctionId:number,now=new Date()):AuctionDetail|null{
  const row=auctionRows(db,auctionId)[0];if(!row)return null;
  const variantId=integer(row.variant_id),variant=getVariant(db,variantId);if(!variant)return null;
  const fx=latestFx(db,now),item=auctionItem(db,row,summaryRows(db,[variantId]).get(variantId)??{},fx,now);
  const history=db.prepare(`SELECT * FROM ebay_listing_price_observations WHERE ebay_listing_id=? ORDER BY observed_at,ebay_price_observation_id`).all(auctionId) as unknown as Row[];
  const priceHistory:AuctionPriceObservation[]=history.map((entry)=>({observationId:integer(entry.ebay_price_observation_id),observedAt:String(entry.observed_at),
    price:number(entry.price_value),currentBid:number(entry.current_bid_price),minimumBid:number(entry.minimum_bid_price),currency:text(entry.price_currency),
    bidCount:number(entry.bid_count),endAt:text(entry.item_end_date),buyingOptions:strings(entry.buying_options_json)}));
  return{auction:{...item,subtitle:text(row.subtitle),condition:text(row.condition_label),sellerUsername:text(row.seller_username),
    sellerFeedbackScore:number(row.seller_feedback_score),sellerFeedbackPercent:number(row.seller_feedback_percent),locationCountry:text(row.item_location_country),
    locationText:text(row.item_location_text),returnsAccepted:row.returns_accepted==null?null:Boolean(integer(row.returns_accepted))},
    priceHistory,variant,market:getMarket(db,variantId),population:getPopulation(db,variantId),fx};
}

function rawStats(db:DatabaseSync,source:string,namespace?:string):{objects:number;bytes:number;latest:string|null}{
  const ns=namespace?`AND sr.namespace=?`:'';const params=namespace?[source,namespace]:[source];
  const row=db.prepare(`SELECT COUNT(*) objects,COALESCE(SUM(byte_size),0) bytes,MAX(observed_at) latest FROM(
    SELECT DISTINCT ro.hash,ro.byte_size,o.observed_at FROM source_records sr JOIN observations o ON o.observation_id=sr.latest_observation_id JOIN raw_objects ro ON ro.hash=o.hash WHERE sr.source=? ${ns})`).get(...params) as Row;
  return{objects:integer(row.objects),bytes:integer(row.bytes),latest:text(row.latest)};
}
function acquisitionRawStats(db:DatabaseSync,source:string):{objects:number;bytes:number;latest:string|null}{
  const row=db.prepare(`SELECT COUNT(*) objects,COALESCE(SUM(byte_size),0) bytes,MAX(latest) latest FROM(
    SELECT ro.hash,ro.byte_size,MAX(o.observed_at) latest FROM observations o JOIN work_items w ON w.work_item_id=o.work_item_id
      JOIN raw_objects ro ON ro.hash=o.hash WHERE w.source=? GROUP BY ro.hash)`).get(source) as Row;
  return{objects:integer(row.objects),bytes:integer(row.bytes),latest:text(row.latest)};
}
function imageLinkSourceStatus(db:DatabaseSync,source:string,queue:string,label:string):SourceStatus{
  const raw=acquisitionRawStats(db,source);
  const work=db.prepare(`SELECT COUNT(*) total,SUM(state='succeeded') succeeded,SUM(state IN ('pending','leased','running','retryable_failed','partial')) pending FROM work_items WHERE source=? AND queue=?`).get(source,queue) as Row;
  const linked=integer((db.prepare(`SELECT COUNT(*) n FROM assets WHERE rendition LIKE ?`).get(`${source}:%`) as Row).n);
  const succeeded=integer(work.succeeded),total=integer(work.total);
  return {source,label,latestObservation:raw.latest,sourceRecords:succeeded,matchedRecords:linked,unresolvedRecords:Math.max(succeeded-linked,0),rawObjects:raw.objects,rawBytes:raw.bytes,openReviews:0,status:!total?'empty':integer(work.pending)?'partial':'ready'};
}
function rawOnlySourceStatus(db:DatabaseSync,source:string,label:string):SourceStatus{
  const raw=acquisitionRawStats(db,source);
  return {source,label,latestObservation:raw.latest,sourceRecords:0,matchedRecords:0,unresolvedRecords:0,rawObjects:raw.objects,rawBytes:raw.bytes,openReviews:0,status:raw.objects?'partial':'empty'};
}
export function listSources(db:DatabaseSync):SourceStatus[]{
  const tcg=db.prepare(`SELECT COUNT(*) records,SUM(CASE WHEN entity_type='card' THEN 1 ELSE 0 END) cards FROM source_records WHERE source='tcgdex'`).get() as Row;
  const work=db.prepare(`SELECT SUM(CASE WHEN entity_type='set' AND state='succeeded' THEN 1 ELSE 0 END) indexed_count,
    SUM(CASE WHEN entity_type='card' AND state='succeeded' THEN 1 ELSE 0 END) hydrated_count,SUM(CASE WHEN entity_type='card' AND state='pending' THEN 1 ELSE 0 END) queued_count FROM work_items WHERE source='tcgdex'`).get() as Row;
  const tcgRaw=acquisitionRawStats(db,'tcgdex');
  const languages=(db.prepare(`SELECT DISTINCT language FROM sets ORDER BY language`).all() as unknown as Array<{language:string}>).map(({language})=>{
    const catalogue=db.prepare(`SELECT COUNT(*) cards,SUM(detail_status='hydrated') hydrated,
      SUM(image_url IS NULL) missing_image,SUM(rarity IS NULL) missing_rarity,
      SUM(json_extract(attributes_json,'$.illustrator') IS NULL) missing_illustrator
      FROM cards WHERE set_id IN (SELECT set_id FROM sets WHERE language=?)`).get(language) as Row;
    const sets=db.prepare(`SELECT COUNT(*) sets,SUM(total_cards>0 AND NOT EXISTS(SELECT 1 FROM cards c WHERE c.set_id=sets.set_id)) empty_sets FROM sets WHERE language=?`).get(language) as Row;
    const images=db.prepare(`SELECT COUNT(*) jobs,SUM(state='succeeded') stored,SUM(state IN ('pending','leased','running','retryable_failed','partial')) pending
      FROM work_items WHERE source='tcgdex' AND queue='images' AND scope_key LIKE ?`).get(`${language}:image:%`) as Row;
    const localCards=integer((db.prepare(`SELECT COUNT(*) n FROM assets a JOIN cards c ON a.target_type='card' AND a.target_id=c.card_id
      JOIN sets s ON s.set_id=c.set_id WHERE s.language=? AND a.object_hash IS NOT NULL`).get(language) as Row).n);
    const localSets=integer((db.prepare(`SELECT COUNT(*) n FROM assets a JOIN sets s ON a.target_type='set' AND a.target_id=s.set_id
      WHERE s.language=? AND a.object_hash IS NOT NULL`).get(language) as Row).n);
    return{language,sets:integer(sets.sets),cards:integer(catalogue.cards),hydratedCards:integer(catalogue.hydrated),imageJobs:integer(images.jobs),imagesStored:integer(images.stored),imagesPending:integer(images.pending),localAssetLinks:localCards+localSets,
      cardsWithoutImage:integer(catalogue.missing_image),cardsWithoutRarity:integer(catalogue.missing_rarity),cardsWithoutIllustrator:integer(catalogue.missing_illustrator),setsWithoutCards:integer(sets.empty_sets)};
  });
  const imagePending=languages.reduce((sum,item)=>sum+item.imagesPending,0);
  const result:SourceStatus[]=[{source:'tcgdex',label:'TCGdex catalogue',latestObservation:tcgRaw.latest,sourceRecords:integer(tcg.records),matchedRecords:integer(tcg.records),unresolvedRecords:0,rawObjects:tcgRaw.objects,rawBytes:tcgRaw.bytes,openReviews:0,status:!integer(tcg.records)?'empty':integer(work.queued_count)||imagePending?'partial':'ready',indexed:integer(work.indexed_count),hydrated:integer(work.hydrated_count),queued:integer(work.queued_count),languages}];
  for(const namespace of ['population','sales'] as const){const stat=db.prepare(`SELECT COUNT(DISTINCT sr.source_record_id) records,COUNT(DISTINCT CASE WHEN sl.match_status IN ('matched','manual') THEN sr.source_record_id END) matched FROM source_records sr LEFT JOIN source_links sl ON sl.source_record_id=sr.source_record_id WHERE sr.source='psa' AND sr.namespace=?`).get(namespace) as Row;const unresolved=integer(stat.records)-integer(stat.matched);const raw=rawStats(db,'psa',namespace);const reviews=integer((db.prepare(`SELECT COUNT(*) n FROM match_reviews mr JOIN source_records sr ON sr.source_record_id=mr.source_record_id WHERE mr.status='open' AND sr.namespace=?`).get(namespace) as Row).n);result.push({source:`psa-${namespace}`,label:namespace==='population'?'PSA population & price guide':'PSA auction sales',latestObservation:raw.latest,sourceRecords:integer(stat.records),matchedRecords:integer(stat.matched),unresolvedRecords:unresolved,rawObjects:raw.objects,rawBytes:raw.bytes,openReviews:reviews,status:!integer(stat.records)?'empty':unresolved?'partial':'ready'});}
  result.push(imageLinkSourceStatus(db,'pokemoncard','pokemoncard_images','Pokémon-card.com images (JA)'));
  result.push(imageLinkSourceStatus(db,'pcgsearch','pcgsearch_images','PCG Search images (vintage JA)'));
  result.push(rawOnlySourceStatus(db,'ebay','eBay raw fetch'));
  const ecbRaw=acquisitionRawStats(db,'ecb'),ecbCount=integer((db.prepare(`SELECT COUNT(*) n FROM exchange_rates WHERE source='ecb'`).get() as Row).n);
  result.push({source:'ecb',label:'ECB reference rates',latestObservation:ecbRaw.latest,sourceRecords:ecbCount,matchedRecords:ecbCount,
    unresolvedRecords:0,rawObjects:ecbRaw.objects,rawBytes:ecbRaw.bytes,openReviews:0,status:ecbCount?'ready':ecbRaw.objects?'partial':'empty'});
  return result;
}
export function getFacets(db:DatabaseSync):FacetsData{
  const values=(sql:string)=> (db.prepare(sql).all() as unknown as Array<{value:string}>).map((row)=>row.value).filter(Boolean);
  return {languages:values(`SELECT DISTINCT language value FROM sets ORDER BY value`),sets:(db.prepare(`SELECT source_set_id id,name,language FROM sets ORDER BY language,name COLLATE NOCASE`).all() as unknown as Array<{id:string;name:string;language:string}>),categories:values(`SELECT DISTINCT category value FROM cards WHERE category IS NOT NULL ORDER BY value`),rarities:values(`SELECT DISTINCT rarity value FROM cards WHERE rarity IS NOT NULL ORDER BY value`),finishes:values(`SELECT DISTINCT finish value FROM variants WHERE finish IS NOT NULL ORDER BY value`),printRunMarkers:values(`SELECT DISTINCT print_run_marker value FROM variants WHERE print_run_marker IS NOT NULL ORDER BY value`),microVariants:values(`SELECT DISTINCT micro_variant value FROM variants WHERE micro_variant IS NOT NULL ORDER BY value`)};
}
/**
 * The open review queue. eBay rows carry the listing title and the matcher's
 * own working -- extracted numbers, set text, language, and the ranked
 * candidates with the per-feature reasons each one scored on -- because a
 * reviewer deciding between two same-numbered cards needs to see what the
 * matcher saw, not just that it gave up.
 */
export function listMatchReviews(db:DatabaseSync):MatchReviewItem[]{
  return (db.prepare(`SELECT mr.match_review_id,mr.issue_key,sr.source,sr.namespace,sr.source_key,mr.reason,mr.created_at,
      el.title,el.match_tier,el.score,el.runner_up_score,el.signals_json
    FROM match_reviews mr
    JOIN source_records sr ON sr.source_record_id=mr.source_record_id
    LEFT JOIN ebay_listings el ON el.source_record_id=mr.source_record_id
    WHERE mr.status='open' ORDER BY mr.created_at DESC LIMIT 200`).all() as unknown as Row[]).map((row)=>{
    let signals:Record<string,unknown>|null=null;
    try{ signals=row.signals_json?JSON.parse(String(row.signals_json)) as Record<string,unknown>:null; }catch{ signals=null; }
    const candidates=Array.isArray(signals?.candidates)?signals.candidates as MatchReviewItem['candidates']:[];
    return{matchReviewId:integer(row.match_review_id),issueKey:text(row.issue_key),source:String(row.source),
      namespace:String(row.namespace),sourceKey:String(row.source_key),reason:String(row.reason),createdAt:String(row.created_at),
      title:text(row.title),matchTier:text(row.match_tier),
      score:row.score==null?null:Number(row.score),runnerUpScore:row.runner_up_score==null?null:Number(row.runner_up_score),
      candidates,signals};
  });
}

function coverage(value:unknown,fallback:CoverageStatus):CoverageStatus{
  const allowed=new Set<CoverageStatus>(['pending','identity_missing','raw_missing','raw_present','processed','no_data','rate_limited','failed']);
  return allowed.has(String(value) as CoverageStatus)?String(value) as CoverageStatus:fallback;
}

export function listEbayListings(db:DatabaseSync,search:URLSearchParams,now=new Date()):EbayListingPageData{
  const campaign=search.get('campaign'),marketplace=search.get('marketplace'),query=search.get('query');
  const source=db.prepare(`WITH latest_price AS (
      SELECT *,ROW_NUMBER() OVER(PARTITION BY ebay_listing_id ORDER BY observed_at DESC,ebay_price_observation_id DESC) rn
      FROM ebay_listing_price_observations)
    SELECT ci.campaign_id,c.pipeline_run_id,c.query_text,c.marketplace,c.status campaign_status,c.coverage_status,
      c.resume_after,ci.item_id,w.state work_state,w.last_error,
      e.ebay_listing_id,e.title,e.match_tier,e.match_status,e.signals_json,e.variant_id,
      lp.price_value,lp.price_currency,lp.current_bid_price,lp.bid_count,lp.item_end_date,v.*,
      (SELECT cov.status FROM pipeline_psa_target_listings tl
        JOIN pipeline_psa_targets t ON t.pipeline_psa_target_id=tl.pipeline_psa_target_id
        JOIN pipeline_psa_coverage cov ON cov.pipeline_psa_target_id=t.pipeline_psa_target_id AND cov.phase='population'
        WHERE tl.ebay_listing_id=e.ebay_listing_id ORDER BY t.created_at DESC LIMIT 1) population_status,
      (SELECT cov.status FROM pipeline_psa_target_listings tl
        JOIN pipeline_psa_targets t ON t.pipeline_psa_target_id=tl.pipeline_psa_target_id
        JOIN pipeline_psa_coverage cov ON cov.pipeline_psa_target_id=t.pipeline_psa_target_id AND cov.phase='guide'
        WHERE tl.ebay_listing_id=e.ebay_listing_id ORDER BY t.created_at DESC LIMIT 1) guide_status,
      (SELECT cov.status FROM pipeline_psa_target_listings tl
        JOIN pipeline_psa_targets t ON t.pipeline_psa_target_id=tl.pipeline_psa_target_id
        JOIN pipeline_psa_coverage cov ON cov.pipeline_psa_target_id=t.pipeline_psa_target_id AND cov.phase='sales'
        WHERE tl.ebay_listing_id=e.ebay_listing_id ORDER BY t.created_at DESC LIMIT 1) sales_status,
      EXISTS(SELECT 1 FROM psa_specs ps WHERE ps.variant_id=e.variant_id AND ps.namespace='population'
        AND ps.match_status IN ('matched','manual')) has_identity,
      EXISTS(SELECT 1 FROM psa_population_current pc JOIN psa_specs ps ON ps.psa_spec_pk=pc.population_spec_pk
        WHERE ps.variant_id=e.variant_id AND ps.match_status IN ('matched','manual')) has_population_rows,
      EXISTS(SELECT 1 FROM psa_price_current pc JOIN psa_specs ps ON ps.psa_spec_pk=pc.population_spec_pk
        WHERE ps.variant_id=e.variant_id AND ps.match_status IN ('matched','manual') AND pc.grade_value=10) has_guide_rows,
      EXISTS(SELECT 1 FROM psa_sales sx JOIN psa_specs ps ON ps.psa_spec_pk=sx.sales_spec_pk
        WHERE ps.variant_id=e.variant_id AND ps.match_status IN ('matched','manual') AND sx.grade_value=10) has_sales_rows
    FROM ebay_campaign_items ci JOIN ebay_campaigns c ON c.campaign_id=ci.campaign_id
    LEFT JOIN work_items w ON w.source='ebay' AND w.queue='ebay_item_detail'
      AND w.scope_key='item:'||ci.marketplace||':'||ci.item_id
    LEFT JOIN ebay_listings e ON e.marketplace=ci.marketplace AND e.item_id=ci.item_id
    LEFT JOIN latest_price lp ON lp.ebay_listing_id=e.ebay_listing_id AND lp.rn=1
    LEFT JOIN v_variant_search v ON v.variant_id=e.variant_id
    WHERE (? IS NULL OR ci.campaign_id=?) AND (? IS NULL OR c.marketplace=?) AND (? IS NULL OR c.query_text=?)
    ORDER BY ci.last_seen_at DESC,ci.item_id`).all(campaign,campaign,marketplace,marketplace,query,query) as unknown as Row[];
  const summaries=summaryRows(db,source.map((row)=>number(row.variant_id)).filter((id):id is number=>id!=null));
  const mapped:EbayListingItem[]=source.map((row)=>{
    const variantId=number(row.variant_id),variant=variantId==null?null:variantItem(db,row,summaries.get(variantId));
    const state=String(row.work_state??'pending');
    const acquisitionStatus:EbayListingItem['acquisitionStatus']=row.ebay_listing_id!=null?'fetched':
      /429|rate.?limit/i.test(String(row.last_error??''))?'rate_limited':state==='permanent_failed'?'failed':'pending';
    const end=text(row.item_end_date),live=Boolean(end&&new Date(end)>now);
    const trusted=['exact','strong'].includes(String(row.match_tier))&&integer(row.flagged)===0;
    const identity:CoverageStatus=trusted?(integer(row.has_identity)?'processed':'identity_missing'):'identity_missing';
    const signals=object(row.signals_json);
    return{campaignId:String(row.campaign_id),pipelineRunId:String(row.pipeline_run_id),query:String(row.query_text),
      marketplace:String(row.marketplace),itemId:String(row.item_id),listingId:number(row.ebay_listing_id),title:text(row.title),
      acquisitionStatus,matchTier:text(row.match_tier),matchStatus:text(row.match_status),matchReason:text(signals.reason),variant,
      price:number(row.current_bid_price)??number(row.price_value),currency:text(row.price_currency),bidCount:number(row.bid_count),endAt:end,live,
      psa:{identity,population:coverage(row.population_status,identity==='processed'?(integer(row.has_population_rows)?'processed':'raw_missing'):'identity_missing'),
        guide:coverage(row.guide_status,identity==='processed'?(integer(row.has_guide_rows)?'processed':'raw_missing'):'identity_missing'),
        sales:coverage(row.sales_status,identity==='processed'?(integer(row.has_sales_rows)?'processed':'raw_missing'):'identity_missing')}};
  });
  const base=mapped;
  const q=(search.get('q')??'').trim().toLowerCase(),tier=search.get('matchTier'),psa=search.get('psa'),scope=search.get('scope')??'all';
  let filtered=base.filter((item)=>(!q||[item.title,item.itemId,item.variant?.name,item.variant?.setName].some((v)=>String(v??'').toLowerCase().includes(q)))
    &&(!tier||item.matchTier===tier)&&(!psa||Object.values(item.psa).includes(psa as CoverageStatus))
    &&(scope!=='live'||item.live));
  filtered.sort((a,b)=>(b.live?1:0)-(a.live?1:0)||(a.endAt??'9999').localeCompare(b.endAt??'9999')||(b.listingId??0)-(a.listingId??0));
  const {page,pageSize}=pageArgs(search),total=filtered.length,totalPages=Math.ceil(total/pageSize),safe=totalPages?Math.min(page,totalPages):1;
  const campaigns=db.prepare(`SELECT campaign_id,query_text,marketplace,status,coverage_status,resume_after FROM ebay_campaigns
    ORDER BY created_at DESC`).all() as unknown as Row[];
  return{items:filtered.slice((safe-1)*pageSize,safe*pageSize),total,page:safe,pageSize,totalPages,
    funnel:{searchMembers:base.length,detailsFetched:base.filter((x)=>x.acquisitionStatus==='fetched').length,
      matched:base.filter((x)=>['exact','strong'].includes(x.matchTier??'')).length,
      identityMissing:base.filter((x)=>['exact','strong'].includes(x.matchTier??'')&&x.psa.identity==='identity_missing').length,
      population:base.filter((x)=>x.psa.population==='processed').length,guide:base.filter((x)=>x.psa.guide==='processed').length,
      sales:base.filter((x)=>x.psa.sales==='processed').length},
    campaigns:campaigns.map((row)=>({campaignId:String(row.campaign_id),query:String(row.query_text),marketplace:String(row.marketplace),
      status:String(row.status),coverageStatus:String(row.coverage_status),resumeAfter:text(row.resume_after)}))};
}

export function listPipelines(db:DatabaseSync):PipelineListItem[]{
  const queueRows=db.prepare(`SELECT source,queue,state,COUNT(*) n FROM work_items
    WHERE (source='ebay' AND queue='ebay_item_detail' AND state IN ('pending','leased','running','retryable_failed','succeeded'))
       OR (source='ebay' AND queue='ebay_search' AND state IN ('pending','leased','running'))
       OR (source='psa' AND queue='psa_cert' AND state IN ('pending','leased','running','retryable_failed','succeeded'))
    GROUP BY source,queue,state`).all() as unknown as Array<{source:string;queue:string;state:string;n:number}>;
  const queueCount=(source:string,queue:string,state:string):number=>Number(queueRows.find((row)=>row.source===source&&row.queue===queue&&row.state===state)?.n??0);
  const latestAttempt=(db.prepare(`SELECT MAX(a.finished_at) latest FROM attempts a JOIN work_items w ON w.work_item_id=a.work_item_id
    WHERE w.source IN ('ebay','psa') AND w.queue IN ('ebay_item_detail','ebay_search','psa_cert')`).get() as {latest:string|null}).latest;
  const progress={ebay:{searchPending:queueCount('ebay','ebay_search','pending'),detailPending:queueCount('ebay','ebay_item_detail','pending'),detailFetched:queueCount('ebay','ebay_item_detail','succeeded')},
    psaCert:{pending:queueCount('psa','psa_cert','pending'),leased:queueCount('psa','psa_cert','leased')+queueCount('psa','psa_cert','running'),retryableFailed:queueCount('psa','psa_cert','retryable_failed'),succeeded:queueCount('psa','psa_cert','succeeded')},latestAttemptAt:latestAttempt};
  return (db.prepare(`SELECT r.*,(SELECT source FROM pipeline_pauses p WHERE p.pipeline_run_id=r.pipeline_run_id AND p.resolved_at IS NULL ORDER BY created_at DESC LIMIT 1) pause_source,
      (SELECT reason FROM pipeline_pauses p WHERE p.pipeline_run_id=r.pipeline_run_id AND p.resolved_at IS NULL ORDER BY created_at DESC LIMIT 1) pause_reason,
      (SELECT resume_after FROM pipeline_pauses p WHERE p.pipeline_run_id=r.pipeline_run_id AND p.resolved_at IS NULL ORDER BY created_at DESC LIMIT 1) pause_resume
    FROM pipeline_runs r ORDER BY r.created_at DESC LIMIT 50`).all() as unknown as Row[]).map((row)=>({
      pipelineRunId:String(row.pipeline_run_id),status:row.pause_reason&&row.status!=='running'?'paused':String(row.status),activeStage:text(row.active_stage),
      startedAt:String(row.started_at),endedAt:text(row.ended_at),pause:row.pause_reason?{source:String(row.pause_source),reason:String(row.pause_reason),resumeAfter:text(row.pause_resume)}:null,progress,
    }));
}

export function getPipeline(db:DatabaseSync,id:string):Record<string,unknown>|null{
  const run=db.prepare(`SELECT * FROM pipeline_runs WHERE pipeline_run_id=?`).get(id) as Row|undefined;if(!run)return null;
  const stages=db.prepare(`SELECT stage_name,status,attempts,started_at,ended_at,summary_json,error_message FROM pipeline_stages
    WHERE pipeline_run_id=? ORDER BY stage_order`).all(id) as unknown as Row[];
  const campaigns=db.prepare(`SELECT c.*,(SELECT COUNT(*) FROM ebay_campaign_items i WHERE i.campaign_id=c.campaign_id) item_count
    FROM ebay_campaigns c WHERE pipeline_run_id=?`).all(id);
  const coverage=db.prepare(`SELECT c.phase,c.status,COUNT(*) n FROM pipeline_psa_coverage c JOIN pipeline_psa_targets t
    ON t.pipeline_psa_target_id=c.pipeline_psa_target_id WHERE t.pipeline_run_id=? GROUP BY c.phase,c.status`).all(id);
  const pause=db.prepare(`SELECT source,reason,resume_after,created_at FROM pipeline_pauses WHERE pipeline_run_id=? AND resolved_at IS NULL
    ORDER BY created_at DESC LIMIT 1`).get(id);
  return{run:{...run,status:pause&&run.status!=='running'?'paused':run.status},stages,campaigns,coverage,pause:pause??null};
}
export function getHealth(db:DatabaseSync):HealthData{const c=db.prepare(`SELECT (SELECT COUNT(*) FROM sets)sets,(SELECT COUNT(*) FROM cards)cards,(SELECT COUNT(*) FROM variants)variants,(SELECT COUNT(*) FROM psa_specs)specs,(SELECT COUNT(*) FROM psa_sales)sales`).get() as Row;const last=db.prepare(`SELECT MAX(executed_at)at FROM parser_executions WHERE parser_name='curated-materializer'`).get() as Row;const version=db.prepare(`PRAGMA user_version`).get() as Row;return{database:'ok',schemaVersion:integer(version.user_version),catalogue:{sets:integer(c.sets),cards:integer(c.cards),variants:integer(c.variants)},psa:{specs:integer(c.specs),sales:integer(c.sales)},lastMaterialization:text(last.at)}}
