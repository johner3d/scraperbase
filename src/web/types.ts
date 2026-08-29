export type SortOption =
  | 'set_number' | 'newest' | 'oldest' | 'name_asc' | 'name_desc' | 'number_asc' | 'number_desc'
  | 'gem_rate_desc' | 'gem_rate_asc' | 'pop_psa10_asc' | 'pop_psa10_desc'
  | 'psa10_price_desc' | 'psa10_price_asc' | 'sales12mo_desc' | 'sales12mo_asc';

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface CardSearchItem {
  cardId: number;
  setId: number;
  language: string;
  sourceSetId: string;
  setName: string;
  series: string | null;
  releaseDate: string | null;
  localId: string;
  number: string | null;
  name: string;
  category: string | null;
  rarity: string | null;
  imageUrl: string | null;
  detailStatus: 'stub' | 'hydrated';
  variantCoverage: 'unknown' | 'complete';
  variantCount: number | null;
}

export interface VariantSearchItem {
  variantId: number;
  cardId: number;
  setId: number;
  language: string;
  sourceSetId: string;
  setName: string;
  localId: string;
  number: string | null;
  name: string;
  variantLabel: string;
  finish: string | null;
  printRunMarker: string | null;
  microVariant: string | null;
  size: string | null;
  stamps: string[];
  identityStatus: 'confirmed' | 'inferred' | 'review';
  imageUrl: string | null;
  psaMatchStatus: 'matched' | 'unmatched' | 'ambiguous' | 'manual' | 'none';
  psaPopulationTotal: number;
  psa10Population: number;
  gemRate: number | null;
  latestPsa10Price: number | null;
  avgPsa10Price: number | null;
  latestSalePrice: number | null;
  latestSaleDate: string | null;
  saleCount: number;
  psa10Sales12Month: number;
  psaPopulationAvailable: boolean;
  psaSalesAvailable: boolean;
}

export interface CardDetail extends CardSearchItem {
  attributes: Record<string, unknown>;
  variants: VariantSearchItem[];
  alsoPrintedIn: Array<{ cardId: number; language: string; setName: string; setId: number }>;
}

export interface VariantDetail extends VariantSearchItem {
  variantKey: string;
  releaseDate: string | null;
  attributes: Record<string, unknown>;
  cardAttributes: Record<string, unknown>;
  matchedSourceCount: number;
  assetCount: number;
  relatedCard: CardSearchItem;
  sourceReferences: Array<{ source: string; namespace: string; sourceKey: string; status: string; url: string | null }>;
}

export interface MarketData {
  populationAvailable: boolean;
  priceGuideAvailable: boolean;
  salesAvailable: boolean;
  psa10Price: number | null;
  averagePsa10Price: number | null;
  psa10Population: number;
  totalGraded: number;
  gemRate: number | null;
  sales12Month: number;
  coverage: { from: string | null; to: string | null; count: number; cutoff: string | null; totalCount: number | null; pagesFetched: number | null; complete: boolean | null };
  sales: SaleRow[];
  monthly: Array<{ month: string; medianPrice: number | null; count: number }>;
}

export interface SaleRow {
  saleRowId: number;
  saleItemId: string;
  saleDate: string | null;
  salePrice: number | null;
  currency: string;
  gradeValue: number | null;
  auctionHouse: string | null;
  saleType: string | null;
  certNumber: string | null;
  lotNumber: string | null;
  listingUrl: string | null;
  qualifierCode: string | null;
}

export interface PopulationData {
  available: boolean;
  observedAt: string | null;
  sourceUrl: string | null;
  totalGraded: number;
  gemRate: number | null;
  grades: Array<{ gradeKey: string; gradeLabel: string; gradeValue: number | null; populationCount: number; qualifiedCount: number; halfGradeCount: number }>;
  prices: Array<{ gradeKey: string; gradeLabel: string; gradeValue: number | null; mostRecentPrice: number | null; averagePrice: number | null; psaPrice: number | null }>;
}

export interface SourceStatus {
  source: string;
  label: string;
  latestObservation: string | null;
  sourceRecords: number;
  matchedRecords: number;
  unresolvedRecords: number;
  rawObjects: number;
  rawBytes: number;
  openReviews: number;
  status: 'ready' | 'partial' | 'empty';
  indexed?: number;
  hydrated?: number;
  queued?: number;
  languages?: SourceLanguageCoverage[];
}

export interface SourceLanguageCoverage {
  language: string;
  sets: number;
  cards: number;
  hydratedCards: number;
  imageJobs: number;
  imagesStored: number;
  imagesPending: number;
  localAssetLinks: number;
  cardsWithoutImage: number;
  cardsWithoutRarity: number;
  cardsWithoutIllustrator: number;
  setsWithoutCards: number;
}

export interface FacetsData {
  languages: string[];
  sets: Array<{ id: string; name: string; language: string }>;
  categories: string[];
  rarities: string[];
  finishes: string[];
  printRunMarkers: string[];
  microVariants: string[];
}

export interface MatchReviewItem {
  matchReviewId: number;
  issueKey: string | null;
  source: string;
  namespace: string;
  sourceKey: string;
  reason: string;
  createdAt: string;
}

export interface HealthData {
  database: 'ok' | 'error';
  schemaVersion: number;
  catalogue: { sets: number; cards: number; variants: number };
  psa: { specs: number; sales: number };
  lastMaterialization: string | null;
}

export interface ApiError { error: string; detail?: string }
