// PCG Search (pcg-search.com) is a fan-built archive specifically for the
// oldest Japanese sets (1996-2001), which TCGdex's own Japanese localization
// frequently gets wrong (English leftovers, mixed-language names) -- making
// pokemon-card.com's name-search matching unreliable for exactly this era.
// PCG Search sidesteps that: its URLs are a deterministic function of
// (setId, localId), not the card's name, so there is no fuzzy matching or
// substitution risk at all here.
export const PCGSEARCH_BASE = 'https://pcg-search.com';
export const PCGSEARCH_INDEX_URL = `${PCGSEARCH_BASE}/card/card_list.php`;

interface SetConfig {
  folder: string;
  prefix: string;
  localIdWidth: number;
}

const SET_CONFIG: Record<string, SetConfig> = {
  PMCG1: { folder: '1st', prefix: '1st1', localIdWidth: 3 },
  PMCG2: { folder: '1st', prefix: '1st2', localIdWidth: 3 },
  PMCG3: { folder: '1st', prefix: '1st3', localIdWidth: 3 },
  PMCG4: { folder: '1st', prefix: '1st4', localIdWidth: 3 },
  PMCG5: { folder: '1st', prefix: '1stgym1', localIdWidth: 3 },
  PMCG6: { folder: '1st', prefix: '1stgym2', localIdWidth: 3 },
  neo1: { folder: 'neo', prefix: 'neo1', localIdWidth: 3 },
  neo2: { folder: 'neo', prefix: 'neo2', localIdWidth: 3 },
  neo3: { folder: 'neo', prefix: 'neo3', localIdWidth: 3 },
  neo4: { folder: 'neo', prefix: 'neo4', localIdWidth: 3 },
  VS1: { folder: 'vs', prefix: 'vs', localIdWidth: 4 },
  web1: { folder: 'web', prefix: 'web', localIdWidth: 4 },
  E1: { folder: 'e', prefix: 'e1', localIdWidth: 3 },
};

const SPECIAL_STEMS: Record<string, string> = {
  // TCGdex accidentally uses Houndoom's Pokedex number as this card's local id.
  'neo4/229': 'neo4024',
  // VS1 energy cards are unnumbered on-card; TCGdex assigns synthetic local ids.
  'VS1/143': 'vs0en8',
  'VS1/144': 'vs0en7',
  'VS1/151': 'vs0en9',
};

export interface PcgSearchAsset {
  indexPath: string;
  imageUrl: string;
  matchKind: 'exact' | 'special-stem';
}

export function makePcgSearchAsset(sourceSetId: string, localId: string): PcgSearchAsset | null {
  const config = SET_CONFIG[sourceSetId];
  if (!config || !/^\d+$/.test(localId)) return null;
  const specialStem = SPECIAL_STEMS[`${sourceSetId}/${localId}`];
  const stem = specialStem ?? `${config.prefix}${String(Number(localId)).padStart(config.localIdWidth, '0')}`;
  return {
    indexPath: `/card/${config.folder}/${stem}.php`,
    imageUrl: `${PCGSEARCH_BASE}/img/${config.folder}/${stem}.png`,
    matchKind: specialStem ? 'special-stem' : 'exact',
  };
}
