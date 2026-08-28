export function discoveryScopeKey(lang: string): string {
  return `${lang}:sets`;
}

export function setScopeKey(lang: string, setId: string): string {
  return `${lang}:set:${setId}`;
}

export function cardScopeKey(lang: string, cardId: string): string {
  return `${lang}:card:${cardId}`;
}

export function cardImageScopeKey(lang: string, cardId: string, quality: string, format: string): string {
  return `${lang}:image:card:${cardId}:${quality}:${format}`;
}

export function setImageScopeKey(
  lang: string,
  setId: string,
  kind: 'logo' | 'symbol',
  quality: string,
  format: string,
): string {
  return `${lang}:image:set:${setId}:${kind}:${quality}:${format}`;
}
