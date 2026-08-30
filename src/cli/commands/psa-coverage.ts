import { parseArgs } from 'node:util';
import { openCliDb } from '../context.ts';

// Concrete, re-runnable numbers proving PSA coverage is real and growing --
// the acceptance check for the native-discovery pipeline replacing the old
// clean_rewrite-snapshot dependency. See docs/psa-raw-fetch.md.

interface HeadingRow {
  psa_heading_id: number;
  psa_heading_name: string;
  source_set_id: string | null;
  match_status: string;
}

export async function psaCoverageCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { json: { type: 'boolean', default: false } } });
  const db = openCliDb();

  const headings = db.prepare(
    `SELECT psa_heading_id, psa_heading_name, source_set_id, match_status FROM psa_set_map ORDER BY psa_heading_name`,
  ).all() as unknown as HeadingRow[];

  const bySet = new Map<string, { headingCount: number; matchedHeadingCount: number }>();
  let matchedHeadings = 0, ambiguousHeadings = 0, unmatchedHeadings = 0;
  for (const h of headings) {
    if (h.match_status === 'matched' || h.match_status === 'manual') matchedHeadings++;
    else if (h.match_status === 'ambiguous') ambiguousHeadings++;
    else unmatchedHeadings++;
    if (h.source_set_id) {
      const entry = bySet.get(h.source_set_id) ?? { headingCount: 0, matchedHeadingCount: 0 };
      entry.headingCount++;
      if (h.match_status === 'matched' || h.match_status === 'manual') entry.matchedHeadingCount++;
      bySet.set(h.source_set_id, entry);
    }
  }

  const specCounts = db.prepare(
    `SELECT s.source_set_id, COUNT(*) n, SUM(CASE WHEN ps.variant_id IS NOT NULL THEN 1 ELSE 0 END) matched
     FROM psa_specs ps JOIN variants v ON v.variant_id = ps.variant_id JOIN cards c ON c.card_id = v.card_id JOIN sets s ON s.set_id = c.set_id
     WHERE ps.namespace = 'population' GROUP BY s.source_set_id`,
  ).all() as unknown as Array<{ source_set_id: string; n: number; matched: number }>;
  const specsBySet = new Map(specCounts.map((r) => [r.source_set_id, r]));

  const totalCardsBySet = db.prepare(
    `SELECT s.source_set_id, COUNT(*) n FROM cards c JOIN sets s ON s.set_id = c.set_id WHERE s.language = 'en' GROUP BY s.source_set_id`,
  ).all() as unknown as Array<{ source_set_id: string; n: number }>;
  const totalsBySet = new Map(totalCardsBySet.map((r) => [r.source_set_id, r.n]));

  db.close();

  if (values.json) {
    console.log(JSON.stringify({ headings, bySet: Object.fromEntries(bySet), specsBySet: Object.fromEntries(specsBySet) }, null, 2));
    return;
  }

  console.log(`PSA population-report headings discovered: ${headings.length}`);
  console.log(`  matched/manual: ${matchedHeadings}  ambiguous: ${ambiguousHeadings}  unmatched: ${unmatchedHeadings}`);
  console.log('');
  console.log('Per tcgdex release (English cards matched by PSA population data / total cards in the release):');
  const sourceSetIds = [...new Set([...bySet.keys(), ...specsBySet.keys(), ...totalsBySet.keys()])].sort();
  for (const sourceSetId of sourceSetIds) {
    const spec = specsBySet.get(sourceSetId);
    const total = totalsBySet.get(sourceSetId) ?? 0;
    console.log(`  ${sourceSetId}: ${spec?.matched ?? 0}/${total}`);
  }
}
