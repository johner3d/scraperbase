import { normalizePart } from '../materialize.ts';
import { extractNumbers, extractLooseNumbers, mergeNumbers, distinctPrintedNumbers, type CardNumberCandidate } from './numbers.ts';

/**
 * Turns one raw eBay item-detail payload into everything we know about the
 * card it is selling.
 *
 * v1 read four item specifics (card name, card number, set, language) out of a
 * German/Spanish/French/Dutch label dictionary and ignored the rest. The
 * stored corpus of 5,477 payloads actually carries ~30 useful specifics --
 * `Spiel`/`Game` on 5,298, `Seltenheit` on 3,215, `Baujahr` on 2,957,
 * `Charakter` on 2,826, `Eigenschaften` on 2,722, `Oberfläche` on 2,538,
 * `Zeichner` on 2,122, `HP` on 1,875 -- plus a `description` on 5,471 of them.
 * Illustrator and HP in particular are near-unique per card and the catalogue
 * already stores both for all 56,385 cards, so they turn "this number exists in
 * nine sets" into a single answer.
 *
 * The label dictionary below is transcribed from the labels that actually
 * occur in the stored payloads (de/en/it/fr/nl/es/pl), not invented.
 */

export interface EbayAspectPair { name?: string; value?: string }
export interface EbayConditionDescriptorValue { content?: string }
export interface EbayConditionDescriptor { name?: string; values?: EbayConditionDescriptorValue[] }
export interface EbayMoney { value?: string; currency?: string }

export interface EbayItemDetail {
  itemId?: string;
  legacyItemId?: string;
  itemWebUrl?: string;
  title?: string;
  subtitle?: string;
  description?: string;
  shortDescription?: string;
  epid?: string;
  categoryPath?: string;
  conditionId?: string;
  conditionDescriptors?: EbayConditionDescriptor[];
  localizedAspects?: EbayAspectPair[];
  price?: EbayMoney;
  currentBidPrice?: EbayMoney;
  minimumPriceToBid?: EbayMoney;
  bidCount?: number;
  buyingOptions?: string[];
  itemEndDate?: string | null;
  quantity?: number;
  condition?: string;
  image?: { imageUrl?: string };
  seller?: { username?: string; feedbackScore?: number; feedbackPercentage?: string };
  itemLocation?: { city?: string; postalCode?: string; country?: string };
  shippingOptions?: Array<{ shippingServiceCode?: string; type?: string; shippingCost?: EbayMoney }>;
  returnTerms?: { returnsAccepted?: boolean };
  [key: string]: unknown;
}

type Concept =
  | 'game' | 'cardName' | 'character' | 'cardNumber' | 'set' | 'language' | 'rarity'
  | 'finish' | 'features' | 'year' | 'hp' | 'illustrator' | 'stage' | 'cardType'
  | 'speciality' | 'convention' | 'edition' | 'grader' | 'grade' | 'cert' | 'cardCount';

/**
 * Aspect / condition-descriptor label -> concept. Labels are compared after
 * normalizePart(), so case, accents and punctuation collapse automatically
 * ("Rareté" -> `rarete`, "Convention/Event" -> `convention_event`).
 */
const LABELS: Record<Concept, string[]> = {
  game: ['spiel', 'game', 'gioco', 'jeu', 'spel', 'gra', 'juego', 'franchise'],
  cardName: ['kartenname', 'card_name', 'nome_della_carta', 'nome_carta', 'nom_de_la_carte', 'kaartnaam', 'nazwa_karty', 'nombre_de_la_carta', 'japanischer_kartenname', 'kartenname_jp'],
  character: ['charakter', 'character', 'personaggio', 'personnage', 'personage', 'postac', 'personaje'],
  // "Numero di carte" / "Nombre de cartes" / "Anzahl Karten" are counts, not
  // card numbers, and are mapped to `cardCount` below instead.
  cardNumber: ['kartennummer', 'card_number', 'numero_della_carta', 'numero_carta', 'numero_de_carte', 'kaartnummer', 'numero_de_carta', 'nummer'],
  set: ['set', 'satz', 'zestaw', 'coleccion', 'japanische_expansion', 'japanischer_erweiterungsname', 'japanische_erweiterung', 'erweiterungsmarkierung', 'expansionmark', 'edition_jp'],
  language: ['sprache', 'language', 'lingua', 'langue', 'taal', 'idioma', 'jezyk'],
  rarity: ['seltenheit', 'rarity', 'rarita', 'rarete', 'zeldzaamheid', 'rzadkosc', 'raritat', 'japanische_raritat'],
  finish: ['oberflache', 'finish', 'finitura', 'finition', 'afwerking', 'acabado', 'oberflacheneffekt', 'holo_foil', 'holo', 'veredeltes'],
  features: ['eigenschaften', 'features', 'caratteristiche', 'caracteristiques', 'kenmerken', 'merkmale', 'besonderheiten', 'cechy', 'caracteristicas', 'parallel_variety', 'parallel_variante', 'parallel_vielfalt', 'variety', 'sortenstammbaum'],
  year: ['baujahr', 'herstellungsjahr', 'year_manufactured', 'anno_di_fabbricazione', 'anno_di_produzione', 'annee_de_fabrication', 'productiejaar', 'rok_produkcji', 'ano_de_fabricacion', 'jahr', 'jahrgang', 'erscheinungsjahr', 'issue_year', 'publish_year', 'produktionsjahr', 'jahr_hergestellt', 'year'],
  hp: ['hp', 'kp', 'punti_vita_pv', 'points_de_vie_pv'],
  illustrator: ['zeichner', 'illustrator', 'illustratore', 'dessinateur', 'ilustrador_o_dibujante'],
  stage: ['buhne', 'stage', 'entwicklungsstufe', 'fase', 'stade_d_evolution', 'palcoscenico'],
  cardType: ['kartentyp', 'card_type', 'tipo_di_carta', 'type_de_la_carte', 'type_de_carte', 'soort_kaart', 'type_kaart', 'rodzaj_karty', 'tipo_de_carta', 'art_der_karte'],
  speciality: ['spezialitat', 'speciality', 'specialty', 'specialita', 'specialite', 'especialidad', 'specialiteit', 'specjalnosc', 'spezialkarte'],
  convention: ['convention_event', 'tagung_veranstaltung', 'tagung_oder_veranstaltung', 'convention_evento', 'evenement', 'event_tournament', 'convention_ou_evenement'],
  edition: ['edition', 'edizione', 'editionen'],
  grader: ['professional_grader', 'bewertungsexperte', 'professioneller_grader', 'profi_grader', 'grader', 'grading_company', 'expertenbewertung', 'grado_profesional', 'tasador_profesional', 'professionele_grader', 'professionele_taxateur', 'classificateur_professionnel', 'certificateur_professionnel', 'societe_de_gradation_professionnelle', 'organisme_de_certification', 'societe_de_notation', 'gradation_professionnelle', 'professionelle_abstufung', 'valutatore_professionista', 'segnapunti_professionale', 'livellatrice_professionale', 'profesjonalny_rzeczoznawca'],
  grade: ['grade', 'bewertung', 'grado', 'note', 'nota', 'classificazione', 'classification', 'clasificacion', 'ocena', 'sterkte', 'grad'],
  cert: ['certification_number', 'zertifizierungsnummer', 'zertifikationsnummer', 'zertifizierung', 'psa_nummer', 'numero_de_certificacion', 'numero_de_certification', 'numero_di_certificazione', 'certificeringsnummer', 'numer_certyfikatu'],
  cardCount: ['anzahl_karten', 'anzahl_karten_im_lot', 'kartenanzahl', 'karten_zahlen', 'number_of_cards', 'numero_di_carte', 'nombre_de_cartes', 'numero_de_cartas', 'cards_count', 'aantal_kaarten', 'menge', 'hoeveelheid', 'quantita'],
};

const LABEL_CONCEPT = new Map<string, Concept>();
for (const [concept, labels] of Object.entries(LABELS) as Array<[Concept, string[]]>) {
  for (const label of labels) if (!LABEL_CONCEPT.has(label)) LABEL_CONCEPT.set(label, concept);
}

/**
 * Sellers write the set as its own label surprisingly often -- "Set: S-P",
 * "Set：Sm9", "Set:Cp6", "Edition ID". Those carry a *set code*, the single
 * most decisive signal there is, so a label that merely begins with `set_`
 * is treated as a set aspect and its label tail kept as a value.
 */
function conceptFor(label: string): { concept: Concept; labelTail: string | null } | null {
  const direct = LABEL_CONCEPT.get(label);
  if (direct) return { concept: direct, labelTail: null };
  if (label.startsWith('set_')) return { concept: 'set', labelTail: label.slice(4) };
  return null;
}

interface AspectPair { label: string; concept: Concept | null; labelTail: string | null; value: string }

function collectAspects(item: EbayItemDetail): AspectPair[] {
  const pairs: AspectPair[] = [];
  const add = (name: string | undefined, value: string | undefined): void => {
    if (!name || !value) return;
    const label = normalizePart(name);
    const match = conceptFor(label);
    pairs.push({ label, concept: match?.concept ?? null, labelTail: match?.labelTail ?? null, value: value.trim() });
  };
  for (const descriptor of item.conditionDescriptors ?? []) add(descriptor.name, descriptor.values?.[0]?.content);
  for (const aspect of item.localizedAspects ?? []) add(aspect.name, aspect.value);
  return pairs;
}

// Sellers routinely leave optional item-specifics as an explicit "not
// applicable" placeholder rather than omitting them; treat those the same as
// missing data instead of matching against the literal text.
const NA_VALUES = new Set(['na', 'n_a', 'nein', 'no', 'none', 'nicht_zutreffend', 'non_applicabile', 'sonstige', 'other', 'andere', '']);

function meaningful(value: string | null | undefined): string | null {
  if (!value) return null;
  return NA_VALUES.has(normalizePart(value)) ? null : value;
}

function valuesFor(pairs: AspectPair[], concept: Concept): string[] {
  const out: string[] = [];
  for (const pair of pairs) {
    if (pair.concept !== concept) continue;
    const value = meaningful(pair.value);
    if (value) out.push(value);
    // "Set: Cp6" -- the code hides in the label, not the value.
    if (pair.labelTail) out.push(pair.labelTail);
  }
  return out;
}

function firstFor(pairs: AspectPair[], concept: Concept): string | null {
  return valuesFor(pairs, concept)[0] ?? null;
}

// ---------------------------------------------------------------- grading

const GRADED_CONDITION_ID = '2750';
const TITLE_GRADER_GRADE = /\b(PSA|BGS|CGC|SGC)\s*[- ]?\s*(10|9\.5|9|8\.5|8)\b/i;
// The grader value is free text, not a code -- observed live as both "PSA" and
// "Professional Sports Authenticator (PSA)" -- so match the abbreviation as a
// whole word rather than requiring equality.
const PSA_GRADER = /(^|[^a-z0-9])psa([^a-z0-9]|$)/i;

export interface GradingInfo {
  grader: string | null;
  gradeLabel: string | null;
  gradeValue: number | null;
  certNumber: string | null;
  method: 'condition-descriptors' | 'title-fallback' | 'none';
}

/**
 * Structured `conditionDescriptors` (eBay's own standardized grading fields)
 * are the primary signal -- far more reliable than the free-text title, which
 * sellers write inconsistently. Title regex is only a fallback for listings
 * that omit the descriptors.
 */
export function extractGrading(item: EbayItemDetail): GradingInfo {
  const pairs = collectAspects(item);
  const graderRaw = firstFor(pairs, 'grader');
  const gradeRaw = firstFor(pairs, 'grade');
  const certNumber = firstFor(pairs, 'cert');
  if (item.conditionId === GRADED_CONDITION_ID && (graderRaw || gradeRaw)) {
    return {
      grader: graderRaw?.trim() ?? null,
      gradeLabel: gradeRaw?.trim() ?? null,
      gradeValue: gradeRaw ? Number(gradeRaw.replace(',', '.')) : null,
      certNumber,
      method: 'condition-descriptors',
    };
  }
  const titleMatch = TITLE_GRADER_GRADE.exec(item.title ?? '');
  if (titleMatch) {
    return { grader: titleMatch[1]!.toUpperCase(), gradeLabel: titleMatch[2]!, gradeValue: Number(titleMatch[2]), certNumber, method: 'title-fallback' };
  }
  return { grader: null, gradeLabel: null, gradeValue: null, certNumber, method: 'none' };
}

/** v1 ingestion scope, per explicit user decision: only PSA-graded 10s become `ebay_listings` rows. */
export function isPsa10(grading: GradingInfo): boolean {
  return PSA_GRADER.test(grading.grader ?? '') && grading.gradeValue === 10;
}

// ---------------------------------------------------------------- language

// Catalogue coverage is en/de/ja only. Anything else is a real Pokemon card we
// simply do not have rows for, which is a different outcome from "we could not
// read this listing" and must not land in the manual review queue.
const LANGUAGE_VALUES: Array<[RegExp, string]> = [
  [/japan|giappone|japon|jp\b|jpn/i, 'ja'],
  [/deutsch|german|tedesc|allemand|duits/i, 'de'],
  [/english|englisch|inglese|anglais|engels|\beng\b/i, 'en'],
  [/franzos|french|francese|francais|frans/i, 'fr'],
  [/italien|italian|italiano|italiaans/i, 'it'],
  [/spanisch|spanish|spagnol|espanol|espagnol/i, 'es'],
  [/korean|koreanisch|coreano/i, 'ko'],
  [/chines|cinese|chinois/i, 'zh'],
  [/portug/i, 'pt'],
];
export const CATALOGUE_LANGUAGES = new Set(['en', 'de', 'ja']);
const CJK = /[぀-ヿ㐀-䶿一-鿿]/;

/**
 * Deliberately ignores the description: it is shop boilerplate written in the
 * seller's own language ("Versand aus Deutschland", "Zustand: neuwertig") and
 * says nothing about the card. Trusting it made English cards look German,
 * which then filtered the correct set out of the candidate pool entirely --
 * "... HIDDEN FATES 2019 44 PSA 10" resolved to no set at all because it was
 * only being compared against German set names.
 */
function inferLanguage(aspectValue: string | null, title: string): string | null {
  for (const source of [aspectValue, title]) {
    if (!source) continue;
    for (const [pattern, code] of LANGUAGE_VALUES) if (pattern.test(source)) return code;
  }
  // A title written in kana/kanji is a Japanese card even when nobody said so.
  return CJK.test(title) ? 'ja' : null;
}

// ---------------------------------------------------------------- scope

const POKEMON_HINT = /pok[eé]mon|pokemon|pok[eé]ka|pocket monsters/i;
// Other TCGs that turn up in a "psa 10" sweep. Matching one of these in the
// Game aspect is decisive; matching it only in a title is not, because titles
// name comparison products ("besser als Yugioh").
// Other games that turn up in a "psa 10" sweep. Every token here is
// distinctive enough to stand alone in a title: bare words like "magic" or
// "star" are not, and would misfire on real Pokemon card names.
const OTHER_GAME = /dragon ?ball|\bdb[sz]\b|fusion world|one ?piece|yu-?gi-?oh|magic the gathering|\bmtg\b|digimon|weiss schwarz|lorcana|cardfight|vanguard|metazoo|flesh and blood|gundam|garbage pail|panini|donruss|fleer|bowman|upper deck|prizm|rated rookie|invincible|\bnba\b|\bnfl\b/i;

// ---------------------------------------------------------------- lots

const LOT_KEYWORDS = /\b(lot of|lot de|bundle|joblot|job lot|sammellos|konvolut|lote de|playset|sammlung|collection of|set of \d|\d+er set|\dx |x ?\d+ karten|karten ?set)\b/i;

// Pokemon merchandise that PSA also grades but tcgdex does not catalogue:
// sticker sets, hanafuda and old-maid playing decks, phone cards, coins.
// These are real listings with no possible answer in `cards`, so they are an
// outcome in their own right rather than a failed match.
const NON_TCG_PRODUCT = /\b(sealdass|hanafuda|old maid|babanuki|playing cards?|spielkarten|taruka|phone ?card|telefonkarte|sticker|aufkleber|münze|figur|pin badge|puzzle|poster|topps)\b/i;

// ---------------------------------------------------------------- finishes

/**
 * Free-text finish/edition wording -> the vocabulary `variants.finish`,
 * `print_run_marker` and `micro_variant` actually use. Only used to *choose*
 * a variant once the card is known; never to pick the card.
 */
const FINISH_HINTS: Array<[RegExp, string]> = [
  [/reverse ?holo|reverse ?foil|reverse/i, 'reverse'],
  [/\bholo(gra\w*|foil)?\b|glitzer/i, 'holo'],
  [/non[- ]?holo|regular|normal/i, 'normal'],
];
const PRINT_RUN_HINTS: Array<[RegExp, string]> = [
  [/1st ?ed|first ?ed|1\.? ?auflage|erstauflage|edicion 1|edizione 1/i, 'first_edition'],
  [/shadowless|schattenlos/i, 'shadowless'],
  [/unlimited|unbegrenzt/i, 'unlimited'],
];
const MICRO_HINTS: Array<[RegExp, string]> = [
  [/full ?art|\bfa\b/i, 'full_art'],
  [/secret ?rare|\bsr\b/i, 'secret'],
  [/rainbow/i, 'rainbow'],
  [/illustration ?rare|\bar\b/i, 'illustration_rare'],
  [/special ?illustration|\bsar\b/i, 'special_illustration_rare'],
  [/master ?ball/i, 'master_ball_reverse_holo'],
  [/pok[eé] ?ball/i, 'poke_ball_reverse_holo'],
];
const STAMP_HINTS: Array<[RegExp, string]> = [
  [/\bstaff\b/i, 'staff'],
  [/pre ?release|vorver/i, 'pre_release'],
  [/pok[eé]mon ?cent(er|re)/i, 'pokemon_center'],
  [/set ?logo|stamped|gestempelt/i, 'set_logo'],
  [/25th|celebrat/i, '25th_celebration'],
];

function hints(patterns: Array<[RegExp, string]>, text: string): string[] {
  const out: string[] = [];
  for (const [pattern, value] of patterns) if (pattern.test(text) && !out.includes(value)) out.push(value);
  return out;
}

// ---------------------------------------------------------------- evidence

export interface ListingEvidence {
  title: string;
  /** Title + aspect text + description, normalized, for token work. */
  searchText: string;
  numbers: CardNumberCandidate[];
  /** Set codes read out of `NNN/CODE` denominators and "Set: CP6"-style labels; resolved against `sets.source_set_id` later. */
  setCodeHints: string[];
  /** Free-text set names, strongest first (aspect before title). */
  setTexts: string[];
  names: string[];
  language: string | null;
  languageSupported: boolean;
  year: number | null;
  hp: number | null;
  illustrator: string | null;
  rarity: string | null;
  finishHints: string[];
  printRunHints: string[];
  microHints: string[];
  stampHints: string[];
  isLot: boolean;
  inScope: boolean;
  /** Whether anything in the listing actually says "Pokemon". A listing that never does, and that no card in the catalogue answers, is very likely not ours at all -- a graded basketball rookie, say. */
  pokemonHint: boolean;
  outOfScopeReason: string | null;
  grading: GradingInfo;
  epid: string | null;
}

const TAGS = /<[^>]*>/g;
const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };

/** Descriptions are seller-authored HTML; keep the words, drop the markup, and cap the length so one 200 KB template cannot dominate token overlap. */
function plainText(html: string | null | undefined): string {
  if (!html) return '';
  return html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(TAGS, ' ')
    .replace(/&[a-z#0-9]+;/gi, (entity) => ENTITIES[entity.toLowerCase()] ?? ' ')
    .replace(/\s+/g, ' ').trim().slice(0, 2000);
}

function numeric(value: string | null): number | null {
  if (!value) return null;
  const match = /(\d{2,4})/.exec(value);
  return match ? Number(match[1]) : null;
}

export interface EvidenceOptions {
  /** Letter prefixes that really begin a printed card number, from the catalogue. Without them, prose in the description reads as card numbers. */
  knownPrefixes?: Set<string>;
}

export function buildEvidence(item: EbayItemDetail, options: EvidenceOptions = {}): ListingEvidence {
  const pairs = collectAspects(item);
  const title = (item.title ?? '').trim();
  const description = plainText(item.description ?? item.shortDescription);
  const subtitle = (item.subtitle ?? '').trim();

  const numberAspects = valuesFor(pairs, 'cardNumber');
  const numbers = mergeNumbers([
    ...numberAspects.map((value) => extractNumbers(value, 'aspect', options.knownPrefixes)),
    extractNumbers(`${title} ${subtitle}`, 'title', options.knownPrefixes),
    extractNumbers(description, 'description', options.knownPrefixes),
  ]);
  // Nothing in a recognisable card-number shape. Fall back to bare integers in
  // the title, which is how PSA-label-style titles write the number.
  if (!numbers.some((n) => n.kind !== 'alnum')) numbers.push(...extractLooseNumbers(`${title} ${subtitle}`, 'title'));

  const setTexts = [...valuesFor(pairs, 'set'), ...valuesFor(pairs, 'edition')].filter((value, index, all) => all.indexOf(value) === index);
  // "S-P 126", "367/SM-P", "XY-P Promo": the `<letters>-P` shape is a Japanese
  // promo set code and nothing else, so it is safe to read straight out of a
  // title even though bare-alpha codes in general are not. These sets are
  // mostly absent from the catalogue, and recognising the code is what turns
  // those listings into a reported gap instead of unanswerable review work.
  const promoCodes = [...`${title} ${subtitle}`.matchAll(/\b([A-Z]{1,4})-P\b/g)].map((match) => `${match[1]}-P`);
  const setCodeHints = [
    ...numbers.map((n) => n.denominatorCode).filter((code): code is string => code != null),
    ...promoCodes,
  ].filter((code, index, all) => all.indexOf(code) === index);

  const language = inferLanguage(firstFor(pairs, 'language'), `${title} ${subtitle}`);
  const gameAspect = firstFor(pairs, 'game');
  const categoryPath = typeof item.categoryPath === 'string' ? item.categoryPath : '';

  // Scope: the Game item-specific is decisive when present (5,298 of 5,477
  // payloads carry one). Without it, fall back to the title and category.
  let inScope = true;
  let outOfScopeReason: string | null = null;
  if (gameAspect && !POKEMON_HINT.test(gameAspect)) {
    inScope = false;
    outOfScopeReason = `game-aspect:${gameAspect}`;
  } else if (OTHER_GAME.test(title) && !POKEMON_HINT.test(`${title} ${categoryPath}`)) {
    // The title names another game and never names this one. Sellers
    // cross-list across categories and mis-tag the Game item-specific, so a
    // title that describes a Dragon Ball card is not overruled by an aspect
    // claiming otherwise.
    inScope = false;
    outOfScopeReason = 'other-tcg-title';
  } else if (language && !CATALOGUE_LANGUAGES.has(language)) {
    inScope = false;
    outOfScopeReason = `language-not-in-catalogue:${language}`;
  } else if (NON_TCG_PRODUCT.test(title)) {
    inScope = false;
    outOfScopeReason = 'not-a-tcg-card';
  }

  const finishText = [firstFor(pairs, 'finish'), firstFor(pairs, 'features'), firstFor(pairs, 'speciality'), firstFor(pairs, 'rarity'), title].filter(Boolean).join(' ');

  const names = [firstFor(pairs, 'cardName'), firstFor(pairs, 'character')].filter((value): value is string => value != null);

  return {
    title,
    searchText: `${title} ${subtitle} ${setTexts.join(' ')} ${names.join(' ')} ${description}`,
    numbers,
    setCodeHints,
    setTexts,
    names,
    language,
    languageSupported: language == null || CATALOGUE_LANGUAGES.has(language),
    year: numeric(firstFor(pairs, 'year')),
    hp: numeric(firstFor(pairs, 'hp')),
    illustrator: firstFor(pairs, 'illustrator'),
    rarity: firstFor(pairs, 'rarity'),
    finishHints: hints(FINISH_HINTS, finishText),
    printRunHints: hints(PRINT_RUN_HINTS, `${finishText} ${title}`),
    microHints: hints(MICRO_HINTS, `${finishText} ${title}`),
    stampHints: hints(STAMP_HINTS, `${finishText} ${title}`),
    // Two different printed numbers in one title is a multi-card lot even when
    // the seller never used a lot word -- that is what let
    // "Set of 4 Pikachu 020/M-P 120/SV-P 197/SV-P 291/SV-P" through in v1.
    isLot: (item.quantity ?? 1) > 1
      || LOT_KEYWORDS.test(title)
      || distinctPrintedNumbers(extractNumbers(title, 'title')) > 1
      || (numeric(firstFor(pairs, 'cardCount')) ?? 1) > 1,
    inScope,
    pokemonHint: POKEMON_HINT.test(`${title} ${categoryPath} ${gameAspect ?? ''} ${setTexts.join(' ')}`),
    outOfScopeReason,
    grading: extractGrading(item),
    epid: typeof item.epid === 'string' ? item.epid : null,
  };
}
