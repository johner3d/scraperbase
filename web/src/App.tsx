import { useEffect, useMemo, useState } from 'react';
import { Link, NavLink, Route, Routes, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { CardDetail, CardSearchItem, FacetsData, HealthData, MarketData, MatchReviewItem, Page, PopulationData, SaleRow, SourceStatus, VariantDetail, VariantSearchItem } from '../../src/web/types.ts';

const API = '/api';
const languages = [['', 'All languages'], ['en', 'English'], ['de', 'German'], ['ja', 'Japanese']];

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? `Request failed (${response.status})`);
  return response.json() as Promise<T>;
}

function useFetch<T>(url: string): { data: T | null; loading: boolean; error: string | null } {
  const [state, setState] = useState<{ data: T | null; loading: boolean; error: string | null }>({ data: null, loading: true, error: null });
  useEffect(() => { let active = true; setState({ data: null, loading: true, error: null }); getJson<T>(url).then((data) => active && setState({ data, loading: false, error: null })).catch((error: unknown) => active && setState({ data: null, loading: false, error: error instanceof Error ? error.message : String(error) })); return () => { active = false; }; }, [url]);
  return state;
}

function Icon({ children }: { children: string }) { return <span className="icon" aria-hidden="true">{children}</span>; }
function formatMoney(value: number | null | undefined): string { return value == null ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(value); }
function formatDate(value: string | null | undefined): string { if (!value) return '—'; const date = new Date(value); return Number.isNaN(date.valueOf()) ? value : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); }
function languageLabel(value: string): string { return value === 'en' ? 'EN' : value === 'de' ? 'DE' : value === 'ja' ? 'JA' : value.toUpperCase(); }
function humanLabel(value: string | null | undefined): string {
  if (!value) return '';
  const known: Record<string, string> = {
    shadowless_first_edition: 'Shadowless · 1st Edition', first_edition: '1st Edition',
    shadowless: 'Shadowless', unlimited: 'Unlimited', holo: 'Holo', normal: 'Normal',
    reverse: 'Reverse', confirmed: 'Confirmed', inferred: 'Inferred', review: 'Review',
    '1999_2000_copyright': '1999–2000 copyright',
  };
  return known[value] ?? value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}
function CardImage({ src, alt, large = false }: { src: string | null; alt: string; large?: boolean }) { return src ? <img className={large ? 'card-image detail-image' : 'card-image'} src={src} alt={alt} loading="lazy" /> : <div className="image-empty">No image</div>; }

function Header() { return <header className="site-header"><Link to="/" className="brand"><span className="pokeball"><i /></span><span>poke/dex</span></Link><nav><NavLink to="/">Browse</NavLink><NavLink to="/sources">Sources</NavLink></nav></header>; }
function Shell({ children }: { children: React.ReactNode }) { return <><Header /><main>{children}</main></>; }
function ErrorState({ error }: { error: string }) { return <div className="state error-state"><strong>Something went wrong</strong><span>{error}</span></div>; }
function EmptyState({ title = 'No cards found', text = 'Try changing your filters or materialize the catalogue first.' }: { title?: string; text?: string }) { return <div className="state"><strong>{title}</strong><span>{text}</span></div>; }

const RANGE_FIELDS: Array<{ key: string; label: string; unit: 'currency' | 'percent' | 'number' }> = [
  { key: 'psa10Price', label: 'PSA 10 price', unit: 'currency' },
  { key: 'avgPsa10Price', label: 'AVG PSA 10 price', unit: 'currency' },
  { key: 'popPsa10', label: 'Pop PSA 10', unit: 'number' },
  { key: 'totalGraded', label: 'Total graded', unit: 'number' },
  { key: 'gemRate', label: 'Gem rate', unit: 'percent' },
  { key: 'sales12mo', label: '#PSA 10 sales (12mo)', unit: 'number' },
  { key: 'lastSalePrice', label: 'Last sale price', unit: 'currency' },
];
type RangeState = Record<string, { min: string; max: string }>;
function emptyRanges(params: URLSearchParams): RangeState { return Object.fromEntries(RANGE_FIELDS.map((field) => [field.key, { min: params.get(`${field.key}Min`) ?? '', max: params.get(`${field.key}Max`) ?? '' }])); }

function RangeField({ field, value, onChange }: { field: { key: string; label: string; unit: 'currency' | 'percent' | 'number' }; value: { min: string; max: string }; onChange: (next: { min: string; max: string }) => void }) {
  const prefix = field.unit === 'currency' ? '$' : undefined, suffix = field.unit === 'percent' ? '%' : undefined;
  return <div className="range-field"><span className="range-label">{field.label}</span><div className="range-inputs"><span className="range-input">{prefix && <em>{prefix}</em>}<input type="number" inputMode="decimal" min={0} value={value.min} placeholder="0" onChange={(event) => onChange({ ...value, min: event.target.value })} />{suffix && <em>{suffix}</em>}</span><span className="range-dash">–</span><span className="range-input">{prefix && <em>{prefix}</em>}<input type="number" inputMode="decimal" min={0} value={value.max} placeholder="No max" onChange={(event) => onChange({ ...value, max: event.target.value })} />{suffix && <em>{suffix}</em>}</span></div></div>;
}

function FilterPanel({ params, setParams, onClose }: { params: URLSearchParams; setParams: (next: URLSearchParams) => void; onClose: () => void }) {
  const facets = useFetch<FacetsData>(`${API}/facets`);
  const [language, setLanguage] = useState(params.get('language') ?? '');
  const [category, setCategory] = useState(params.get('category') ?? '');
  const [rarity, setRarity] = useState(params.get('rarity') ?? '');
  const [setId, setSetId] = useState(params.get('set') ?? '');
  const [setQuery, setSetQuery] = useState('');
  const [finish, setFinish] = useState(params.get('finish') ?? '');
  const [edition, setEdition] = useState(params.get('printRunMarker') ?? '');
  const [ranges, setRanges] = useState<RangeState>(() => emptyRanges(params));
  const isVariants = params.get('view') === 'variants';
  const apply = () => {
    const next = new URLSearchParams(params);
    for (const [key, value] of [['language', language], ['category', category], ['rarity', rarity], ['set', setId], ['finish', finish], ['printRunMarker', edition]]) { if (value) next.set(key, value); else next.delete(key); }
    for (const field of RANGE_FIELDS) { const { min, max } = ranges[field.key]!; if (min) next.set(`${field.key}Min`, min); else next.delete(`${field.key}Min`); if (max) next.set(`${field.key}Max`, max); else next.delete(`${field.key}Max`); }
    next.delete('page'); setParams(next); onClose();
  };
  const reset = () => { setLanguage(''); setCategory(''); setRarity(''); setSetId(''); setSetQuery(''); setFinish(''); setEdition(''); setRanges(emptyRanges(new URLSearchParams())); };
  const data = facets.data;
  const sets = (data?.sets ?? []).filter((set) => (!language || set.language === language) && (!setQuery || set.name.toLowerCase().includes(setQuery.toLowerCase())));
  return <div className="sheet-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="filter-sheet" role="dialog" aria-modal="true">
      <div className="sheet-title"><div><h2>Filter {isVariants ? 'variants' : 'cards'}</h2><p>Narrow the collection without losing your search.</p></div><button className="icon-button" onClick={onClose}>×</button></div>
      <h3 className="filter-group-title">Card identity</h3>
      <div className="filter-grid two"><label>Language<select value={language} onChange={(event) => setLanguage(event.target.value)}>{languages.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label><label>Category<select value={category} onChange={(event) => setCategory(event.target.value)}><option value="">All categories</option>{(data?.categories ?? []).map((value) => <option value={value} key={value}>{value}</option>)}</select></label></div>
      <label>Rarity<select value={rarity} onChange={(event) => setRarity(event.target.value)}><option value="">All rarities</option>{(data?.rarities ?? []).map((value) => <option value={value} key={value}>{value}</option>)}</select></label>
      <h3 className="filter-group-title">Release</h3>
      <input className="set-search" value={setQuery} onChange={(event) => setSetQuery(event.target.value)} placeholder="Find a set" />
      <div className="set-list">
        <button type="button" className={`set-row ${setId === '' ? 'selected' : ''}`} onClick={() => setSetId('')}><span className="set-radio" />All sets</button>
        {sets.map((set) => <button type="button" className={`set-row ${setId === set.id ? 'selected' : ''}`} key={`${set.language}:${set.id}`} onClick={() => setSetId(set.id)}><span className="set-radio" /><span className="set-row-name">{set.name}</span><span className="set-row-lang">{languageLabel(set.language)}</span></button>)}
      </div>
      {isVariants && <>
        <h3 className="filter-group-title">Exact print</h3>
        <div className="filter-grid two"><label>Edition<select value={edition} onChange={(event) => setEdition(event.target.value)}><option value="">Any edition</option>{(data?.printRunMarkers ?? []).map((value) => <option value={value} key={value}>{humanLabel(value)}</option>)}</select></label><label>Finish<select value={finish} onChange={(event) => setFinish(event.target.value)}><option value="">Any finish</option>{(data?.finishes ?? []).map((value) => <option value={value} key={value}>{humanLabel(value)}</option>)}</select></label></div>
        <h3 className="filter-group-title">PSA 10 grading &amp; price</h3>
        <div className="filter-grid two range-grid">{RANGE_FIELDS.map((field) => <RangeField field={field} value={ranges[field.key]!} onChange={(value) => setRanges((prev) => ({ ...prev, [field.key]: value }))} key={field.key} />)}</div>
      </>}
      <div className="sheet-actions"><button className="button secondary" onClick={reset}>Reset</button><button className="button primary" onClick={apply}>Show results</button></div>
    </section>
  </div>;
}

function PopoverSheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return <div className="sheet-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="filter-sheet pill-sheet" role="dialog" aria-modal="true">
      <div className="sheet-title"><h2>{title}</h2><button className="icon-button" onClick={onClose}>×</button></div>
      {children}
    </section>
  </div>;
}

function LanguagePopover({ params, setParams, onClose }: { params: URLSearchParams; setParams: (next: URLSearchParams) => void; onClose: () => void }) {
  const current = params.get('language') ?? '';
  const choose = (value: string) => { const next = new URLSearchParams(params); if (value) next.set('language', value); else next.delete('language'); next.delete('page'); setParams(next); onClose(); };
  return <PopoverSheet title="Language" onClose={onClose}>
    <div className="set-list">{languages.map(([value, label]) => <button type="button" className={`set-row ${current === value ? 'selected' : ''}`} key={value} onClick={() => choose(value)}><span className="set-radio" />{label}</button>)}</div>
  </PopoverSheet>;
}

function RangePopover({ params, setParams, onClose, field }: { params: URLSearchParams; setParams: (next: URLSearchParams) => void; onClose: () => void; field: { key: string; label: string; unit: 'currency' | 'percent' | 'number' } }) {
  const [value, setValue] = useState({ min: params.get(`${field.key}Min`) ?? '', max: params.get(`${field.key}Max`) ?? '' });
  const apply = () => { const next = new URLSearchParams(params); if (value.min) next.set(`${field.key}Min`, value.min); else next.delete(`${field.key}Min`); if (value.max) next.set(`${field.key}Max`, value.max); else next.delete(`${field.key}Max`); next.delete('page'); setParams(next); onClose(); };
  const clear = () => { const next = new URLSearchParams(params); next.delete(`${field.key}Min`); next.delete(`${field.key}Max`); next.delete('page'); setParams(next); onClose(); };
  return <PopoverSheet title={field.label} onClose={onClose}>
    <RangeField field={field} value={value} onChange={setValue} />
    <div className="sheet-actions"><button className="button secondary" onClick={clear}>Clear</button><button className="button primary" onClick={apply}>Apply</button></div>
  </PopoverSheet>;
}

function PillButton({ label, value, onOpen, onClear }: { label: string; value: string | null | undefined; onOpen: () => void; onClear: () => void }) {
  return <span className={`filter-chip pill-chip ${value ? 'active' : ''}`}>
    <button type="button" className="pill-chip-label" onClick={onOpen}>{value || label}</button>
    {value && <button type="button" className="pill-chip-clear" onClick={(event) => { event.stopPropagation(); onClear(); }} aria-label={`Clear ${label}`}>×</button>}
  </span>;
}

type PillModal = 'sort' | 'filters' | 'language' | 'avgPsa10Price' | 'popPsa10' | 'sales12mo';

const commonSortLabels: Record<string, string> = { set_number: 'Set & collector number', newest: 'Newest releases', oldest: 'Oldest releases', name_asc: 'Card name · A–Z', name_desc: 'Card name · Z–A', number_asc: 'Collector number · low to high', number_desc: 'Collector number · high to low' };
const variantOnlySortLabels: Record<string, string> = { gem_rate_desc: 'Gem rate · high to low', gem_rate_asc: 'Gem rate · low to high', pop_psa10_asc: 'Pop PSA 10 · low to high', pop_psa10_desc: 'Pop PSA 10 · high to low', psa10_price_desc: 'PSA 10 price · high to low', psa10_price_asc: 'PSA 10 price · low to high', sales12mo_desc: '#PSA 10 sales (12mo) · most to least', sales12mo_asc: '#PSA 10 sales (12mo) · least to most' };
const cardSortLabels: Record<string, string> = { ...commonSortLabels };
const variantSortLabels: Record<string, string> = { ...commonSortLabels, ...variantOnlySortLabels };
function sortLabelsFor(view: 'cards' | 'variants'): Record<string, string> { return view === 'variants' ? variantSortLabels : cardSortLabels; }
function SortPanel({ params, setParams, onClose }: { params: URLSearchParams; setParams: (next: URLSearchParams) => void; onClose: () => void }) { const view = params.get('view') === 'variants' ? 'variants' : 'cards', selected = params.get('sort') ?? 'set_number', labels = sortLabelsFor(view); return <div className="sheet-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="sort-sheet" role="dialog" aria-modal="true"><div className="sheet-title"><h2>Sort {view}</h2><button className="icon-button" onClick={onClose}>×</button></div>{Object.entries(labels).map(([value, label]) => <button className={`sort-option ${selected === value ? 'selected' : ''}`} key={value} onClick={() => { const next = new URLSearchParams(params); next.set('sort', value); next.delete('page'); setParams(next); onClose(); }}>{label}<span>{selected === value ? '✓' : ''}</span></button>)}</section></div>; }

function CardTile({ card }: { card: CardSearchItem }) { const coverage=card.variantCoverage==='complete'?`${card.variantCount ?? 0} ${(card.variantCount ?? 0)===1?'variant':'variants'}`:'Variants pending'; return <Link to={`/cards/${card.cardId}`} className="catalog-tile"><div className="tile-image"><CardImage src={card.imageUrl} alt={card.name} /><span className="language-badge">{languageLabel(card.language)}</span></div><h3>{card.name}</h3><p className="collector">#{card.number ?? card.localId}</p><p className="tile-meta">{card.rarity ?? 'Card'} · {card.category ?? 'Unknown'} · {coverage}</p></Link>; }
function VariantTile({ variant }: { variant: VariantSearchItem }) { return <Link to={`/variants/${variant.variantId}`} className="catalog-tile variant-tile"><div className="tile-image"><CardImage src={variant.imageUrl} alt={`${variant.name} ${variant.variantLabel}`} /><span className="language-badge">{languageLabel(variant.language)}</span></div><h3>{variant.name}</h3><p className="collector">#{variant.number ?? variant.localId}</p><p className="variant-label">{variant.variantLabel}</p>{variant.identityStatus === 'review' ? <p className="unresolved">Identity needs review</p> : variant.psaPopulationAvailable || variant.psaSalesAvailable ? <div className="tile-metrics"><span>Pop 10 <b>{variant.psaPopulationAvailable ? variant.psa10Population : '—'}</b></span><span>Gem rate <b>{variant.gemRate == null ? '—' : `${variant.gemRate.toFixed(1)}%`}</b></span><span>Guide <b>{formatMoney(variant.latestPsa10Price)}</b></span><span>Sale <b>{formatMoney(variant.latestSalePrice)}</b></span></div> : <p className="tile-meta">No PSA coverage</p>}</Link>; }

function Pagination({ page, totalPages, onPage }: { page: number; totalPages: number; onPage: (page: number) => void }) { if (totalPages < 2) return null; return <div className="pagination"><button disabled={page <= 1} onClick={() => onPage(page - 1)}>← Previous</button><span>{page} / {totalPages}</span><button disabled={page >= totalPages} onClick={() => onPage(page + 1)}>Next →</button></div>; }

function Browse() {
  const [searchParams, setSearchParams] = useSearchParams();
  const view = searchParams.get('view') === 'variants' ? 'variants' : 'cards';
  const [modal, setModal] = useState<PillModal | null>(null);
  const query = new URLSearchParams(searchParams); query.delete('view');
  const endpoint = `${API}/${view}?${query.toString()}`;
  const result = useFetch<Page<CardSearchItem> | Page<VariantSearchItem>>(endpoint);
  const cards = view === 'cards' ? result.data as Page<CardSearchItem> | null : null;
  const variants = view === 'variants' ? result.data as Page<VariantSearchItem> | null : null;
  const activeFilters = [...['language', 'set', 'category', 'rarity', 'finish', 'printRunMarker', 'microVariant'].filter((key) => searchParams.get(key)), ...RANGE_FIELDS.filter((field) => searchParams.get(`${field.key}Min`) || searchParams.get(`${field.key}Max`)).map((field) => field.key)];
  const languageLabelValue = searchParams.get('language') ? languages.find(([value]) => value === searchParams.get('language'))?.[1] ?? searchParams.get('language')! : null;
  const changeView = (next: 'cards' | 'variants') => { const nextParams = new URLSearchParams(searchParams); nextParams.set('view', next); nextParams.delete('page'); setSearchParams(nextParams); };
  const updatePage = (page: number) => { const next = new URLSearchParams(searchParams); next.set('page', String(page)); setSearchParams(next); window.scrollTo({ top: 0, behavior: 'smooth' }); };
  const clearAll = () => { const next = new URLSearchParams(); next.set('view', view); setSearchParams(next); };
  const clearParam = (key: string) => { const next = new URLSearchParams(searchParams); next.delete(key); next.delete('page'); setSearchParams(next); };
  const clearRange = (key: string) => { const next = new URLSearchParams(searchParams); next.delete(`${key}Min`); next.delete(`${key}Max`); next.delete('page'); setSearchParams(next); };
  const rangeLabel = (key: string): string | null => {
    const field = RANGE_FIELDS.find((item) => item.key === key)!;
    const min = searchParams.get(`${key}Min`), max = searchParams.get(`${key}Max`);
    if (!min && !max) return null;
    const fmt = (v: string) => field.unit === 'currency' ? `$${v}` : field.unit === 'percent' ? `${v}%` : v;
    return min && max ? `${fmt(min)}–${fmt(max)}` : min ? `≥ ${fmt(min)}` : `≤ ${fmt(max!)}`;
  };
  const count = cards?.total ?? variants?.total ?? 0; const currentPage = cards?.page ?? variants?.page ?? 1; const totalPages = cards?.totalPages ?? variants?.totalPages ?? 0;
  return <Shell><div className={`page browse-page ${view === 'variants' ? 'variant-browse' : ''}`}><div className="page-heading"><div><h1>Browse</h1><p>{view === 'variants' ? 'Compare exact prints and grading data.' : 'Discover cards across the collection.'}</p></div><div className="segmented"><button className={view === 'cards' ? 'active' : ''} onClick={() => changeView('cards')}>Cards</button><button className={view === 'variants' ? 'active' : ''} onClick={() => changeView('variants')}>Variants</button></div></div><div className="search-row"><label className="search-box"><Icon>⌕</Icon><input value={searchParams.get('q') ?? ''} onChange={(event) => { const next = new URLSearchParams(searchParams); if (event.target.value) next.set('q', event.target.value); else next.delete('q'); next.delete('page'); setSearchParams(next); }} placeholder="Search cards, sets, or collector numbers" /></label></div><div className="filter-row">
    <PillButton label="Language" value={languageLabelValue} onOpen={() => setModal('language')} onClear={() => clearParam('language')} />
    {view === 'variants' && <PillButton label="AVG PSA 10 price" value={rangeLabel('avgPsa10Price')} onOpen={() => setModal('avgPsa10Price')} onClear={() => clearRange('avgPsa10Price')} />}
    {view === 'variants' && <PillButton label="POP PSA 10" value={rangeLabel('popPsa10')} onOpen={() => setModal('popPsa10')} onClear={() => clearRange('popPsa10')} />}
    {view === 'variants' && <PillButton label="#PSA 10 sales 12mo" value={rangeLabel('sales12mo')} onOpen={() => setModal('sales12mo')} onClear={() => clearRange('sales12mo')} />}
    <button className="filter-chip" onClick={() => setModal('filters')}>Filters{activeFilters.length ? ` · ${activeFilters.length}` : ''}</button>
  </div>{activeFilters.length > 0 && <div className="active-filters"><button className="clear-button" onClick={clearAll}>Clear all</button></div>}<div className="results-toolbar"><div><strong>{count.toLocaleString()} {view}</strong><small>{count ? `Showing ${(currentPage - 1) * (Number(searchParams.get('pageSize') ?? 24)) + 1}–${Math.min(currentPage * Number(searchParams.get('pageSize') ?? 24), count)}` : 'No results'}</small></div><button className="sort-button" onClick={() => setModal('sort')}><span className="sort-label">{sortLabelsFor(view)[searchParams.get('sort') ?? 'set_number']}</span><span aria-hidden="true"> ↕</span></button></div>{result.loading ? <div className="loading-grid">{Array.from({ length: 10 }, (_, i) => <div className="skeleton" key={i} />)}</div> : result.error ? <ErrorState error={result.error} /> : count === 0 ? <EmptyState text="The catalogue is empty or no records match. Run TCGdex collection and materialization to populate it." /> : <><div className="catalog-grid">{view === 'cards' ? cards!.items.map((card) => <CardTile card={card} key={card.cardId} />) : variants!.items.map((variant) => <VariantTile variant={variant} key={variant.variantId} />)}</div><Pagination page={currentPage} totalPages={totalPages} onPage={updatePage} /></>}
  {modal === 'filters' && <FilterPanel params={searchParams} setParams={setSearchParams} onClose={() => setModal(null)} />}
  {modal === 'sort' && <SortPanel params={searchParams} setParams={setSearchParams} onClose={() => setModal(null)} />}
  {modal === 'language' && <LanguagePopover params={searchParams} setParams={setSearchParams} onClose={() => setModal(null)} />}
  {modal === 'avgPsa10Price' && <RangePopover params={searchParams} setParams={setSearchParams} onClose={() => setModal(null)} field={RANGE_FIELDS.find((field) => field.key === 'avgPsa10Price')!} />}
  {modal === 'popPsa10' && <RangePopover params={searchParams} setParams={setSearchParams} onClose={() => setModal(null)} field={RANGE_FIELDS.find((field) => field.key === 'popPsa10')!} />}
  {modal === 'sales12mo' && <RangePopover params={searchParams} setParams={setSearchParams} onClose={() => setModal(null)} field={RANGE_FIELDS.find((field) => field.key === 'sales12mo')!} />}
  </div></Shell>;
}

function CardDetailPage() { const { cardId } = useParams(); const state = useFetch<CardDetail>(`${API}/cards/${cardId}`); if (state.loading) return <Shell><div className="page"><div className="detail-loading" /></div></Shell>; if (state.error || !state.data) return <Shell><div className="page"><ErrorState error={state.error ?? 'Card not found'} /></div></Shell>; const card = state.data; return <Shell><div className="page detail-page"><section className="card-hero"><CardImage src={card.imageUrl} alt={card.name} large /><div><h1>{card.name}</h1><p className="subheading">{card.releaseDate?.slice(0, 4) ?? '—'} · {card.setName} ({languageLabel(card.language)}) · #{card.number ?? card.localId}</p><p>{card.category ?? 'Card'}<br />{card.rarity ?? 'Rarity unavailable'}<br />Illustrator: {String(card.attributes.illustrator ?? card.attributes.artist ?? '—')}</p></div></section><section className="detail-section"><h2>Variants</h2><div className="variant-list">{card.variants.length ? card.variants.map((variant) => <Link className="variant-row" to={`/variants/${variant.variantId}`} key={variant.variantId}><span>{variant.variantLabel}</span><span>{variant.psaSalesAvailable && <em>Market history</em>}{variant.psaPopulationAvailable && <em className="psa-badge">PSA history</em>}<b>→</b></span></Link>) : card.variantCoverage==='unknown' ? <EmptyState title="Variant details pending" text="This card is searchable, but its physical issues have not been hydrated yet." /> : <EmptyState title="No variants materialized" text="The hydrated source record did not produce an issue/design record." />}</div></section>{card.alsoPrintedIn.length > 0 && <section className="detail-section"><h2>Also printed in</h2><div className="language-links">{card.alsoPrintedIn.map((other) => <Link to={`/cards/${other.cardId}`} key={other.cardId}>{other.setName} ({languageLabel(other.language)})</Link>)}</div></section>}</div></Shell>; }

function Metric({ label, value, note }: { label: string; value: string; note?: string }) { return <div className="metric"><small>{label}</small><strong>{value}</strong>{note && <span>{note}</span>}</div>; }
function IdentityChips({ variant }: { variant: VariantDetail }) { return <div className="identity-chips"><span className="accent-chip">{humanLabel(variant.printRunMarker) || 'Unmarked'}</span><span>{humanLabel(variant.finish) || 'Finish unknown'}</span>{variant.microVariant && <span>{humanLabel(variant.microVariant)}</span>}{variant.size === 'jumbo' && <span>Jumbo</span>}<span>Identity: {humanLabel(variant.identityStatus)}</span></div>; }

function ChartYAxis({ max, top, bottom, axisX, gridStart, gridEnd, format }: { max: number; top: number; bottom: number; axisX: number; gridStart: number; gridEnd: number; format: (value: number) => string }) {
  const safeMax = Math.max(max, 1);
  const ticks = Array.from({ length: 5 }, (_, index) => {
    const fraction = index / 4;
    return { value: safeMax * fraction, y: bottom - fraction * (bottom - top) };
  });
  return <g className="y-axis">{ticks.map(({ value, y }) => <g key={value}><line x1={gridStart} x2={gridEnd} y1={y} y2={y} className="grid-line" /><line x1={axisX - 5} x2={axisX} y1={y} y2={y} className="tick" /><text x={axisX - 9} y={y + 4} textAnchor="end">{format(value)}</text></g>)}<line x1={axisX} x2={axisX} y1={top} y2={bottom} className="axis" /></g>;
}
function ChartXAxis({ ticks, axisY, start, end }: { ticks: Array<{ x: number; label: string }>; axisY: number; start: number; end: number }) { return <g className="x-axis"><line x1={start} x2={end} y1={axisY} y2={axisY} className="axis" />{ticks.map((tick) => <g key={`${tick.x}:${tick.label}`}><line x1={tick.x} x2={tick.x} y1={axisY} y2={axisY + 5} className="tick" /><text x={tick.x} y={axisY + 19} textAnchor="middle">{tick.label}</text></g>)}</g>; }
function formatDateAxis(value: number, range: number): string { const date = new Date(value); return date.toLocaleDateString('en-US', range >= 1000 * 60 * 60 * 24 * 365 ? { month: 'short', year: 'numeric' } : { month: 'short', day: 'numeric' }); }
function formatMonthAxis(value: string): string { const date = new Date(`${value}-01T00:00:00`); return Number.isNaN(date.valueOf()) ? value : date.toLocaleDateString('en-US', { month: 'short', year: '2-digit' }); }
function formatCountAxis(value: number): string { return new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(value); }
function ScatterChart({ sales }: { sales: SaleRow[] }) { const points = sales.filter((sale) => sale.saleDate && sale.salePrice != null); if (!points.length) return <div className="chart-empty">No sales in the available history.</div>; const width = 900, height = 260, plotLeft = 84, plotRight = 20, plotTop = 16, plotBottom = height - 34; const minDate = new Date(points[0]!.saleDate!).getTime(), maxDate = new Date(points.at(-1)!.saleDate!).getTime() || minDate + 1, dateRange = Math.max(maxDate - minDate, 1), maxPrice = Math.max(...points.map((p) => p.salePrice!), 1); const x = (date: string) => plotLeft + ((new Date(date).getTime() - minDate) / dateRange) * (width - plotLeft - plotRight); const y = (price: number) => plotBottom - (price / maxPrice) * (plotBottom - plotTop); const xTicks = Array.from({ length: Math.min(5, points.length) }, (_, index) => { const fraction = Math.min(index / Math.max(Math.min(5, points.length) - 1, 1), 1); const value = minDate + fraction * dateRange; return { x: plotLeft + fraction * (width - plotLeft - plotRight), label: formatDateAxis(value, dateRange) }; }); return <svg className="chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="PSA sale prices over time"><ChartYAxis max={maxPrice} top={plotTop} bottom={plotBottom} axisX={plotLeft} gridStart={plotLeft} gridEnd={width - plotRight} format={formatMoney} /><ChartXAxis ticks={xTicks} axisY={plotBottom} start={plotLeft} end={width - plotRight} />{points.map((sale) => <circle key={sale.saleRowId} cx={x(sale.saleDate!)} cy={y(sale.salePrice!)} r="5" className="point"><title>{formatDate(sale.saleDate)} · {formatMoney(sale.salePrice)}</title></circle>)}</svg>; }
function MonthlyChart({ data, mode }: { data: MarketData['monthly']; mode: 'median' | 'count' }) { if (!data.length) return <div className="chart-empty">No monthly data available.</div>; const width = 500, height = 180, plotLeft = 58, plotRight = 12, plotTop = 12, plotBottom = height - 26; const values = data.map((item) => mode === 'median' ? item.medianPrice ?? 0 : item.count); const max = Math.max(...values, 1); const x = (index: number) => plotLeft + (index / Math.max(values.length - 1, 1)) * (width - plotLeft - plotRight); const y = (value: number) => plotBottom - (value / max) * (plotBottom - plotTop); const points = values.map((value, i) => `${x(i)},${y(value)}`).join(' '); const xTicks = Array.from({ length: Math.min(5, data.length) }, (_, index) => { const dataIndex = Math.round(index * (data.length - 1) / Math.max(Math.min(5, data.length) - 1, 1)); return { x: x(dataIndex), label: formatMonthAxis(data[dataIndex]!.month) }; }); return <svg className={`chart mini-chart ${mode}`} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={mode === 'median' ? 'Median price by month' : 'Sales by month'}><ChartYAxis max={max} top={plotTop} bottom={plotBottom} axisX={plotLeft} gridStart={plotLeft} gridEnd={width - plotRight} format={mode === 'median' ? formatMoney : formatCountAxis} /><ChartXAxis ticks={xTicks} axisY={plotBottom} start={plotLeft} end={width - plotRight} /><polyline points={points} fill="none" className="line" />{values.map((value, i) => <circle key={data[i]!.month} cx={x(i)} cy={y(value)} r="2.5" className="line-point"><title>{data[i]!.month} · {mode === 'median' ? formatMoney(value) : value}</title></circle>)}</svg>; }

function SalesTable({ sales }: { sales: SaleRow[] }) { return sales.length ? <div className="table-wrap"><table><thead><tr><th>Date</th><th>Price</th><th>House</th><th>Cert #</th><th>Listing</th></tr></thead><tbody>{[...sales].reverse().map((sale) => <tr key={sale.saleRowId}><td>{formatDate(sale.saleDate)}</td><td><strong>{formatMoney(sale.salePrice)}</strong></td><td>{sale.auctionHouse ?? '—'}</td><td>{sale.certNumber ?? '—'}</td><td>{sale.listingUrl ? <a href={sale.listingUrl} target="_blank" rel="noreferrer">View ↗</a> : '—'}</td></tr>)}</tbody></table></div> : <div className="empty-inline">No sales in the available history.</div>; }
function PopulationSection({ data }: { data: PopulationData }) { return <section className="data-panel"><div className="section-title"><div><h2>PSA Population</h2><p>Grade-level population and qualification counts.</p></div>{data.sourceUrl && <a href={data.sourceUrl} target="_blank" rel="noreferrer">View report at PSA ↗</a>}</div><div className="population-summary"><div><small>Gem rate</small><strong>{data.gemRate == null ? '—' : `${data.gemRate.toFixed(1)}%`}</strong></div><div><small>Total graded</small><strong>{data.totalGraded.toLocaleString()}</strong></div><div><small>Observed</small><strong>{formatDate(data.observedAt)}</strong></div></div>{data.grades.length ? <div className="table-wrap"><table><thead><tr><th>Grade</th><th>Population</th><th>+</th><th>Q</th></tr></thead><tbody>{data.grades.map((row) => <tr key={row.gradeKey}><td>{row.gradeLabel}</td><td>{row.populationCount.toLocaleString()}</td><td>{row.halfGradeCount.toLocaleString()}</td><td>{row.qualifiedCount.toLocaleString()}</td></tr>)}</tbody></table></div> : <div className="empty-inline">No population data is matched to this variant.</div>}<h3 className="subsection-title">PSA Price Guide</h3>{data.prices.length ? <div className="table-wrap"><table><thead><tr><th>Grade</th><th>Most recent</th><th>Average</th><th>PSA price</th></tr></thead><tbody>{data.prices.map((row) => <tr key={row.gradeKey}><td>{row.gradeLabel}</td><td>{formatMoney(row.mostRecentPrice)}</td><td>{formatMoney(row.averagePrice)}</td><td>{formatMoney(row.psaPrice)}</td></tr>)}</tbody></table></div> : <div className="empty-inline">No price-guide values available.</div>}</section>; }

function VariantDetailPage() {
  const { variantId } = useParams();
  const detail = useFetch<VariantDetail>(`${API}/variants/${variantId}`);
  const market = useFetch<MarketData>(`${API}/variants/${variantId}/market`);
  const population = useFetch<PopulationData>(`${API}/variants/${variantId}/population`);
  const [tab, setTab] = useState<'overview' | 'detail'>('overview');
  if (detail.loading) return <Shell><div className="page"><div className="detail-loading" /></div></Shell>;
  if (detail.error || !detail.data) return <Shell><div className="page"><ErrorState error={detail.error ?? 'Variant not found'} /></div></Shell>;
  const variant = detail.data, m = market.data, p = population.data;
  const popAvailable = Boolean(m?.populationAvailable), salesAvailable = Boolean(m?.salesAvailable);
  return <Shell><div className="page variant-detail-page"><Link to="/?view=variants" className="back-link">← Back to all variants</Link><div className="detail-tabs"><button className={tab === 'overview' ? 'active' : ''} onClick={() => setTab('overview')}>Overview</button><button className={tab === 'detail' ? 'active' : ''} onClick={() => setTab('detail')}>Detail</button></div><section className="variant-hero"><CardImage src={variant.imageUrl} alt={variant.name} large /><div><h1>{variant.name}</h1><p className="subheading">{variant.releaseDate?.slice(0, 4) ?? '—'} · {variant.setName} ({languageLabel(variant.language)}) · #{variant.number ?? variant.localId}</p><IdentityChips variant={variant} />{tab === 'overview' ? <MetadataTable variant={variant} /> : <SourceEvidence variant={variant} />}</div></section>{tab === 'overview' && <><div className="metric-grid"><Metric label="PSA 10 price" value={m?.priceGuideAvailable ? formatMoney(m.psa10Price) : '—'} /><Metric label="Avg PSA 10 price" value={m?.priceGuideAvailable ? formatMoney(m.averagePsa10Price) : '—'} /><Metric label="Pop PSA 10" value={popAvailable ? String(m?.psa10Population ?? 0) : '—'} /><Metric label="Total graded" value={popAvailable ? (m?.totalGraded ?? 0).toLocaleString() : '—'} /><Metric label="Gem rate" value={!popAvailable || m?.gemRate == null ? '—' : `${m.gemRate.toFixed(1)}%`} /><Metric label="# PSA 10 · 12mo" value={salesAvailable ? String(m?.sales12Month ?? 0) : '—'} /></div>{salesAvailable ? <section className="data-panel market-panel"><div className="section-title"><div><h2>PSA Auction Prices Realized</h2><p>Verified completed sales available for this exact issue.</p></div>{m?.coverage.count ? <span>{m.coverage.count} sales · {formatDate(m.coverage.from)} – {formatDate(m.coverage.to)}</span> : null}</div><div className="chart-large"><div className="chart-heading"><strong>PSA 10 sales</strong><b>{formatMoney(m?.sales.at(-1)?.salePrice)}</b></div><ScatterChart sales={m?.sales ?? []} /></div><div className="chart-columns"><div className="chart-card"><div className="chart-heading"><strong>Median PSA 10 price / month</strong><b>{formatMoney(m?.monthly.at(-1)?.medianPrice)}</b></div><MonthlyChart data={m?.monthly ?? []} mode="median" /></div><div className="chart-card"><div className="chart-heading"><strong>PSA 10 sales / month</strong><b>{m?.monthly.at(-1)?.count ?? 0}</b></div><MonthlyChart data={m?.monthly ?? []} mode="count" /></div></div><SalesTable sales={m?.sales ?? []} /></section> : <section className="data-panel"><EmptyState title="No PSA sales coverage" text="No matched PSA auction-history source exists for this exact variant." /></section>}{p?.available ? <PopulationSection data={p} /> : <section className="data-panel"><EmptyState title="No PSA population coverage" text="No matched PSA population or price-guide source exists for this exact variant." /></section>}</>}</div></Shell>;
}
function MetadataTable({ variant }: { variant: VariantDetail }) { const values: Array<[string, unknown]> = [['Category', variant.relatedCard.category], ['Rarity', variant.relatedCard.rarity], ['Illustrator', variant.cardAttributes.illustrator ?? variant.cardAttributes.artist], ['Card size', variant.cardAttributes.cardSize ?? variant.cardAttributes.size], ['Stamps', variant.attributes.stamps ?? variant.attributes.stamp]]; return <div className="metadata-table">{values.filter(([, value]) => value != null).map(([key, value]) => <div key={key}><span>{key}</span><strong>{String(value)}</strong></div>)}</div>; }
function SourceEvidence({ variant }: { variant: VariantDetail }) { return <div className="metadata-table source-evidence"><div><span>Variant key</span><strong>{variant.variantKey}</strong></div><div><span>Matched sources</span><strong>{variant.matchedSourceCount}</strong></div>{variant.sourceReferences.map((source) => <div key={`${source.source}:${source.namespace}:${source.sourceKey}`}><span>{source.source} · {source.namespace}</span><strong>{source.sourceKey} · {humanLabel(source.status)}</strong></div>)}</div>; }

function SourcesPage() {
  const sources = useFetch<{ items: SourceStatus[] }>(`${API}/sources`), health = useFetch<HealthData>(`${API}/health`), reviews=useFetch<{items:MatchReviewItem[]}>(`${API}/reviews`);
  return <Shell><div className="page sources-page"><div className="page-heading"><div><h1>Sources</h1><p>Catalogue and ingestion health at a glance.</p></div></div>{sources.loading || health.loading ? <div className="loading-stack"><div className="skeleton" /><div className="skeleton" /></div> : sources.error || health.error ? <ErrorState error={sources.error ?? health.error ?? 'Unable to load source status'} /> : <><div className="source-grid">{sources.data!.items.map((source) => <article className="source-card" key={source.source}><div className="source-card-heading"><h2>{source.label}</h2><span className={`status-dot ${source.status}`}>{source.status}</span></div><p>Last observed: {formatDate(source.latestObservation)}</p>{source.indexed != null && <div className="source-stat"><span>Indexed / hydrated</span><strong>{source.indexed.toLocaleString()} / {(source.hydrated ?? 0).toLocaleString()}</strong></div>}<div className="source-stat"><span>Source records</span><strong>{source.sourceRecords.toLocaleString()}</strong></div><div className="source-stat"><span>Matched / unresolved</span><strong>{source.matchedRecords.toLocaleString()} / {source.unresolvedRecords.toLocaleString()}</strong></div><div className="source-stat"><span>Raw objects</span><strong>{source.rawObjects.toLocaleString()} · {(source.rawBytes / 1024 / 1024).toFixed(1)} MB</strong></div>{source.languages?.map((item)=><div className="language-coverage" key={item.language}><strong>{languageLabel(item.language)}</strong><span>{item.hydratedCards.toLocaleString()} / {item.cards.toLocaleString()} cards · {item.imagesStored.toLocaleString()} / {item.imageJobs.toLocaleString()} images · {item.localAssetLinks.toLocaleString()} locally linked</span>{item.cardsWithoutImage||item.cardsWithoutRarity||item.cardsWithoutIllustrator||item.setsWithoutCards?<small>Source omissions: {item.cardsWithoutImage.toLocaleString()} images · {item.cardsWithoutRarity.toLocaleString()} rarities · {item.cardsWithoutIllustrator.toLocaleString()} illustrators · {item.setsWithoutCards.toLocaleString()} sets without card rows</small>:null}</div>)}{source.openReviews > 0 && <p className="unresolved">{source.openReviews.toLocaleString()} open match reviews</p>}</article>)}</div>{reviews.data?.items.length ? <section className="health-panel"><h2>Open match reviews</h2>{reviews.data.items.map((review)=><div className="source-stat" key={review.matchReviewId}><span>{review.issueKey??review.sourceKey}</span><strong>{review.reason}</strong></div>)}</section>:null}<section className="health-panel"><h2>Database health</h2><div className="health-grid"><Metric label="Schema version" value={String(health.data!.schemaVersion)} /><Metric label="Sets" value={health.data!.catalogue.sets.toLocaleString()} /><Metric label="Cards" value={health.data!.catalogue.cards.toLocaleString()} /><Metric label="Variants" value={health.data!.catalogue.variants.toLocaleString()} /><Metric label="PSA specs" value={health.data!.psa.specs.toLocaleString()} /><Metric label="PSA sales" value={health.data!.psa.sales.toLocaleString()} /></div><p className="materialize-help">Last materialization: {formatDate(health.data!.lastMaterialization)}<br />Index: <code>npm run cli -- run --source tcgdex --stage index</code><br />Rebuild: <code>npm run cli -- materialize</code></p></section></>}</div></Shell>;
}

export default function App() { return <Routes><Route path="/" element={<Browse />} /><Route path="/sources" element={<SourcesPage />} /><Route path="/cards/:cardId" element={<CardDetailPage />} /><Route path="/variants/:variantId" element={<VariantDetailPage />} /><Route path="*" element={<Browse />} /></Routes>; }
