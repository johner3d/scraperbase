import type { DatabaseSync } from 'node:sqlite';
import { normalizePart } from './materialize.ts';

// Native PSA-heading <-> tcgdex-set matching, replacing what used to be
// resolved by hand in the sibling `clean_rewrite` project. PSA's own
// population-report heading names (e.g. "Pokemon Promo Black Star",
// "Pokemon French Neo Genesis") rarely match tcgdex set names verbatim, so
// this is a normalized token-overlap heuristic: confident unique matches are
// auto-accepted, everything else is left for manual resolution via
// resolvePsaSetMap() rather than guessed.

const STOPWORDS = new Set(['pokemon', 'promo', 'promos', 'tcg', 'card', 'cards', 'the', 'of', 'set']);

const LANGUAGE_HINTS: Array<{ pattern: RegExp; language: string }> = [
  { pattern: /\bfrench\b/i, language: 'fr' },
  { pattern: /\bgerman\b/i, language: 'de' },
  { pattern: /\bitalian\b/i, language: 'it' },
  { pattern: /\bspanish\b/i, language: 'es' },
  { pattern: /\bjapanese\b/i, language: 'ja' },
  { pattern: /\bkorean\b/i, language: 'ko' },
  { pattern: /\bportuguese\b/i, language: 'pt' },
  { pattern: /\bchinese\b/i, language: 'zh' },
];

/** PSA heading names don't carry an explicit language field -- infer it from wording, defaulting to English. */
export function inferHeadingLanguage(headingName: string): string {
  for (const hint of LANGUAGE_HINTS) if (hint.pattern.test(headingName)) return hint.language;
  return 'en';
}

function tokenize(name: string): Set<string> {
  const words = normalizePart(name).split('_').filter(Boolean);
  return new Set(words.filter((w) => !STOPWORDS.has(w) && !LANGUAGE_HINTS.some((h) => h.pattern.test(w))));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

interface TcgdexSetRow {
  set_id: number;
  source_set_id: string;
  name: string;
  language: string;
}

const AUTO_MATCH_THRESHOLD = 0.5;

/**
 * Scores every tcgdex set in the inferred language against a PSA heading
 * name and returns the best candidate(s). Exported for the manual-review
 * CLI (shows candidates) as well as the auto-matcher below.
 */
export function scoreCandidates(db: DatabaseSync, headingName: string): Array<{ setId: number; sourceSetId: string; name: string; score: number }> {
  const language = inferHeadingLanguage(headingName);
  const headingTokens = tokenize(headingName);
  const rows = db.prepare(`SELECT set_id, source_set_id, name, language FROM sets WHERE language = ?`).all(language) as unknown as TcgdexSetRow[];
  return rows
    .map((row) => ({ setId: row.set_id, sourceSetId: row.source_set_id, name: row.name, score: jaccard(headingTokens, tokenize(row.name)) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score);
}

export interface SetMatchAttemptResult {
  status: 'matched' | 'ambiguous' | 'unmatched';
  sourceSetId: string | null;
}

/** Auto-matches one psa_set_map row against tcgdex sets and writes the result back. */
export function autoMatchHeading(db: DatabaseSync, psaSetMapId: number, headingName: string, at: string): SetMatchAttemptResult {
  const candidates = scoreCandidates(db, headingName);
  const best = candidates[0];
  const runnerUp = candidates[1];

  if (best && best.score >= AUTO_MATCH_THRESHOLD && (!runnerUp || best.score - runnerUp.score >= 0.15)) {
    db.prepare(`UPDATE psa_set_map SET source_set_id=?, language=?, match_status='matched', match_method='token-overlap', updated_at=? WHERE psa_set_map_id=?`)
      .run(best.sourceSetId, inferHeadingLanguage(headingName), at, psaSetMapId);
    return { status: 'matched', sourceSetId: best.sourceSetId };
  }
  const status = candidates.length > 1 ? 'ambiguous' : 'unmatched';
  db.prepare(`UPDATE psa_set_map SET match_status=?, match_method=NULL, updated_at=? WHERE psa_set_map_id=?`).run(status, at, psaSetMapId);
  return { status, sourceSetId: null };
}

/** Runs auto-matching over every unresolved heading. Returns counts for reporting. */
export function autoMatchAllHeadings(db: DatabaseSync, at = new Date().toISOString()): { matched: number; ambiguous: number; unmatched: number } {
  const rows = db.prepare(`SELECT psa_set_map_id, psa_heading_name FROM psa_set_map WHERE match_status IN ('unmatched', 'ambiguous')`)
    .all() as unknown as Array<{ psa_set_map_id: number; psa_heading_name: string }>;
  let matched = 0, ambiguous = 0, unmatched = 0;
  for (const row of rows) {
    const result = autoMatchHeading(db, row.psa_set_map_id, row.psa_heading_name, at);
    if (result.status === 'matched') matched++;
    else if (result.status === 'ambiguous') ambiguous++;
    else unmatched++;
  }
  return { matched, ambiguous, unmatched };
}

/** Manual resolution: writes a specific tcgdex source_set_id for a PSA heading, e.g. from a CLI command. */
export function resolvePsaSetMap(db: DatabaseSync, headingId: number, sourceSetId: string, note: string | null, at = new Date().toISOString()): void {
  db.prepare(`UPDATE psa_set_map SET source_set_id=?, match_status='manual', match_method='manual-resolution', notes=?, updated_at=? WHERE psa_heading_id=?`)
    .run(sourceSetId, note, at, headingId);
}
