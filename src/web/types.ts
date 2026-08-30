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
  /** eBay listings only: the title and the evidence behind the reason, so a reviewer can decide without opening the raw payload. */
  title: string | null;
  matchTier: string | null;
  score: number | null;
  runnerUpScore: number | null;
  /** Ranked candidate cards the matcher was choosing between, best first. */
  candidates: MatchReviewCandidate[];
  /** What was read out of the listing: numbers, set text, language, species-bearing aspects. */
  signals: Record<string, unknown> | null;
}

export interface MatchReviewCandidate {
  cardId: number;
  label: string;
  score: number;
  features: string[];
}

export interface HealthData {
  database: 'ok' | 'error';
  schemaVersion: number;
  catalogue: { sets: number; cards: number; variants: number };
  psa: { specs: number; sales: number };
  lastMaterialization: string | null;
}

export interface FxRateMeta {
  baseCurrency: 'EUR';
  quoteCurrency: 'USD';
  rate: number;
  rateDate: string;
  observedAt: string;
  stale: boolean;
  usable: boolean;
}

export interface AuctionComparison {
  psaGuideUsd: number | null;
  psaGuideEur: number | null;
  discountPercent: number | null;
  fxRateDate: string | null;
}

export interface AuctionPriceObservation {
  observationId: number;
  observedAt: string;
  price: number | null;
  currentBid: number | null;
  minimumBid: number | null;
  currency: string | null;
  bidCount: number | null;
  endAt: string | null;
  buyingOptions: string[];
}

export interface AuctionSearchItem {
  auctionId: number;
  itemId: string;
  marketplace: string;
  title: string;
  itemUrl: string | null;
  imageUrl: string | null;
  matchTier: 'exact' | 'strong';
  certNumber: string | null;
  variant: VariantSearchItem;
  currentBid: number | null;
  minimumBid: number | null;
  currency: string | null;
  bidCount: number;
  endAt: string | null;
  observedAt: string;
  shippingCost: number | null;
  shippingCurrency: string | null;
  shippingService: string | null;
  active: boolean;
  stale: boolean;
  comparison: AuctionComparison;
}

export interface AuctionSummary {
  active: number;
  ending24Hours: number;
  withPsaGuide: number;
  medianDiscountPercent: number | null;
}

export interface AuctionPageData extends Page<AuctionSearchItem> {
  summary: AuctionSummary;
  lastObservedAt: string | null;
  fx: FxRateMeta | null;
}

export interface AuctionFacetsData {
  languages: string[];
  sets: Array<{ id: string; name: string; language: string }>;
}

export interface AuctionDetail {
  auction: AuctionSearchItem & {
    subtitle: string | null;
    condition: string | null;
    sellerUsername: string | null;
    sellerFeedbackScore: number | null;
    sellerFeedbackPercent: number | null;
    locationCountry: string | null;
    locationText: string | null;
    returnsAccepted: boolean | null;
  };
  priceHistory: AuctionPriceObservation[];
  variant: VariantDetail;
  market: MarketData;
  population: PopulationData;
  fx: FxRateMeta | null;
}

export interface ApiError { error: string; detail?: string }

export type CoverageStatus = 'pending'|'identity_missing'|'raw_missing'|'raw_present'|'processed'|'no_data'|'rate_limited'|'failed';

export interface EbayListingItem {
  campaignId: string;
  pipelineRunId: string;
  query: string;
  marketplace: string;
  itemId: string;
  listingId: number|null;
  title: string|null;
  acquisitionStatus: 'pending'|'fetched'|'rate_limited'|'failed';
  matchTier: string|null;
  matchStatus: string|null;
  matchReason: string|null;
  variant: VariantSearchItem|null;
  price: number|null;
  currency: string|null;
  bidCount: number|null;
  endAt: string|null;
  live: boolean;
  psa: { identity:CoverageStatus; population:CoverageStatus; guide:CoverageStatus; sales:CoverageStatus };
}

export interface EbayListingPageData extends Page<EbayListingItem> {
  funnel: { searchMembers:number;detailsFetched:number;matched:number;identityMissing:number;population:number;guide:number;sales:number };
  campaigns: Array<{campaignId:string;query:string;marketplace:string;status:string;coverageStatus:string;resumeAfter:string|null}>;
}

export interface PipelineListItem {
  pipelineRunId:string;
  status:string;
  activeStage:string|null;
  startedAt:string;
  endedAt:string|null;
  pause:{source:string;reason:string;resumeAfter:string|null}|null;
  progress?:{ebay:{searchPending:number;detailPending:number;detailFetched:number};psaCert:{pending:number;leased:number;retryableFailed:number;succeeded:number};latestAttemptAt:string|null};
}

export interface PublicationStatus {
  mode:'working'|'published';
  generationId?:string;
  pipelineRunId?:string;
  createdAt?:string;
  completeness:'partial'|'complete';
  incompleteReason:string|null;
}

export interface StageStatusView {
  stage:string;
  state:string;
  queueDepth:number;
  inFlight:number;
  retryable:number;
  permanentFailed:number;
  doneTotal:number;
  deadLetterOpen:number;
  throughputPerMin:number;
  lastActivityAt:string|null;
  nextEligibleAt:string|null;
  note:string|null;
}

export interface TermFunnelView {
  searchTermId:number;
  query:string;
  marketplace:string;
  buyingOption:string;
  enabled:boolean;
  lastCompletedAt:string|null;
  lastResultCount:number|null;
  funnel:{found:number;detailed:number;matched:number;psaTargetedLive:number;population:number;guide:number;sales:number};
}

export interface SupervisorStatusView {
  running:boolean;
  runId:string|null;
  startedAt:string|null;
  publishDirty:boolean;
  lastPublishAt:string|null;
  quota:{used:number;limit:number;allowance:number;resumeAfter:string;paused:boolean};
  stages:StageStatusView[];
  terms:TermFunnelView[];
  deadLetters:Array<{stage:string;scopeKey:string;reason:string;lastSeenAt:string}>;
  activePauses:Array<{stage:string;source:string;reason:string;resumeAfter:string|null}>;
}
