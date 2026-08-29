/**
 * Small boundary for future catalogue sources. Source-specific code can map
 * its payloads into these records without changing the curated schema.
 */
export interface NormalizedSet {
  sourceSetId: string;
  language: string;
  name: string;
  series?: string | null;
  releaseDate?: string | null;
  totalCards?: number | null;
  officialCards?: number | null;
  logoUrl?: string | null;
  symbolUrl?: string | null;
}

export interface NormalizedCard {
  sourceCardId: string;
  sourceSetId: string;
  language: string;
  localId: string;
  name: string;
  category?: string | null;
  rarity?: string | null;
  number?: string | null;
  imageUrl?: string | null;
  attributes?: Record<string, unknown>;
}

export interface NormalizedVariant {
  sourceCardId: string;
  finish?: string | null;
  printRunMarker?: string | null;
  microVariant?: string | null;
  displayLabel?: string;
  attributes?: Record<string, unknown>;
}

export interface SourceAdapter<RawSet = unknown, RawCard = unknown> {
  readonly source: string;
  normalizeSet(raw: RawSet, language: string): NormalizedSet;
  normalizeCard(raw: RawCard, language: string): NormalizedCard;
  normalizeVariants(raw: RawCard, language: string): NormalizedVariant[];
}
