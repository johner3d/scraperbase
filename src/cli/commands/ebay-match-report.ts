import { parseArgs } from 'node:util';
import { openCliDb } from '../context.ts';

/**
 * What the eBay matcher actually decided, and what to fix next.
 *
 * The headline number is deliberately not "percent matched". Three of the
 * outcomes are not matching failures at all -- a Dragon Ball listing, a
 * four-card lot, and a Japanese promo set the catalogue never ingested cannot
 * be matched by any algorithm or by any human -- so they are reported
 * separately from the listings that genuinely needed a decision. The two
 * work lists at the end are the actionable output: which sets to ingest, and
 * which set names to add to data/aliases/ebay-sets.json.
 */

interface TierRow { match_tier: string | null; n: number }
interface Row { [key: string]: unknown }

const MATCHED_TIERS = new Set(['exact', 'strong', 'card-level', 'flagged']);
const NOT_MATCHABLE_TIERS = new Set(['out-of-scope', 'lot', 'catalogue-gap']);

export async function ebayMatchReportCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { json: { type: 'boolean', default: false }, limit: { type: 'string', default: '20' } } });
  const limit = Number(values.limit) || 20;
  const db = openCliDb();

  const tiers = db.prepare(`SELECT match_tier, COUNT(*) n FROM ebay_listings GROUP BY match_tier`).all() as unknown as TierRow[];
  const total = tiers.reduce((sum, row) => sum + row.n, 0);
  const count = (tier: string): number => tiers.find((row) => row.match_tier === tier)?.n ?? 0;
  const sum = (predicate: (tier: string) => boolean): number =>
    tiers.filter((row) => predicate(row.match_tier ?? '')).reduce((acc, row) => acc + row.n, 0);

  const matched = sum((tier) => MATCHED_TIERS.has(tier));
  const notMatchable = sum((tier) => NOT_MATCHABLE_TIERS.has(tier));
  const review = count('review');
  const matchable = total - notMatchable;

  const methods = db.prepare(`SELECT match_method, COUNT(*) n FROM ebay_listings GROUP BY match_method ORDER BY n DESC`).all() as unknown as Row[];
  const variantConfidence = db.prepare(`SELECT variant_confidence, COUNT(*) n FROM ebay_listings WHERE card_id IS NOT NULL GROUP BY variant_confidence`).all() as unknown as Row[];

  // Ground truth: listings resolved from their PSA certification number are
  // exact by construction, so any disagreement with the scored answer is a
  // real precision failure rather than a judgement call.
  const truth = db.prepare(`SELECT
      COUNT(*) n,
      SUM(CASE WHEN match_method = 'ebay-psa-cert' THEN 1 ELSE 0 END) resolved
    FROM ebay_listings WHERE cert_number IS NOT NULL`).get() as Row;

  const gapsBySet = db.prepare(`SELECT
      COALESCE(json_extract(signals_json, '$.gapSubject'), '(unknown)') source_set_id,
      COUNT(*) n
    FROM ebay_listings WHERE match_tier = 'catalogue-gap'
    GROUP BY source_set_id ORDER BY n DESC LIMIT ?`).all(limit) as unknown as Row[];

  const unresolvedSetTexts = db.prepare(`SELECT extracted_set_name, COUNT(*) n
    FROM ebay_listings WHERE match_tier = 'review' AND extracted_set_name IS NOT NULL
    GROUP BY extracted_set_name ORDER BY n DESC LIMIT ?`).all(limit) as unknown as Row[];

  const reviewReasons = db.prepare(`SELECT mr.reason, COUNT(*) n FROM match_reviews mr
    JOIN source_records sr ON sr.source_record_id = mr.source_record_id
    WHERE mr.status = 'open' AND sr.source = 'ebay' GROUP BY mr.reason ORDER BY n DESC LIMIT ?`).all(limit) as unknown as Row[];

  const aliases = db.prepare(`SELECT origin, COUNT(*) n FROM ebay_set_aliases GROUP BY origin`).all() as unknown as Row[];

  db.close();

  if (values.json) {
    console.log(JSON.stringify({ total, matched, review, notMatchable, tiers, methods, variantConfidence, truth, gapsBySet, unresolvedSetTexts, reviewReasons, aliases }, null, 2));
    return;
  }

  const pct = (value: number, of: number): string => (of ? `${((100 * value) / of).toFixed(1)}%` : 'n/a');
  console.log(`eBay PSA-10 listings materialized: ${total}`);
  console.log('');
  console.log('Outcome:');
  for (const tier of ['exact', 'strong', 'card-level', 'flagged', 'review', 'catalogue-gap', 'out-of-scope', 'lot']) {
    const n = count(tier);
    if (n) console.log(`  ${tier.padEnd(14)} ${String(n).padStart(6)}  ${pct(n, total)}`);
  }
  console.log('');
  console.log(`Not matchable by anyone (other games, lots, sets not in the catalogue): ${notMatchable} (${pct(notMatchable, total)})`);
  console.log(`Of the ${matchable} listings that could be matched: ${matched} matched (${pct(matched, matchable)}), ${review} need a human (${pct(review, matchable)})`);
  console.log('');
  console.log('Variant certainty for matched listings:');
  for (const row of variantConfidence) console.log(`  ${String(row.variant_confidence ?? 'none').padEnd(12)} ${String(row.n).padStart(6)}`);
  console.log('');
  console.log(`Listings carrying a PSA certification number: ${truth.n} (resolved against PSA: ${truth.resolved ?? 0})`);
  if (Number(truth.resolved ?? 0) === 0 && Number(truth.n ?? 0) > 0) {
    console.log('  Run `npm run cli -- run --source psa --stage cert` to turn these into exact matches and a precision baseline.');
  }
  console.log('');
  console.log('Catalogue gaps -- ingest these sets to unlock the listings behind them:');
  for (const row of gapsBySet) console.log(`  ${String(row.n).padStart(5)}  ${row.source_set_id}`);
  console.log('');
  console.log('Set names in the review queue that no alias resolves -- add the real ones to data/aliases/ebay-sets.json:');
  for (const row of unresolvedSetTexts) console.log(`  ${String(row.n).padStart(5)}  ${row.extracted_set_name}`);
  console.log('');
  console.log('Open review reasons:');
  for (const row of reviewReasons) console.log(`  ${String(row.n).padStart(5)}  ${row.reason}`);
  console.log('');
  console.log(`Set aliases: ${aliases.map((row) => `${row.origin} ${row.n}`).join(', ') || 'none'}`);
}
