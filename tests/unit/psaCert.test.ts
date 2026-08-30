import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb } from '../../src/core/db/client.ts';
import { certLookupUrl, extractSpecId, seedPsaCertLookups } from '../../src/sources/psa/collectors/cert.ts';
import { certScopeKey } from '../../src/sources/psa/scopeKeys.ts';

test('a SpecID is recovered from any of the routes PSA links a cert through', () => {
  // PSA rewrites the cert page template regularly, but these routes are
  // stable, so all of them are tried rather than one.
  assert.equal(extractSpecId('<a href="/spec/psa/2388970">Population</a>'), '2388970');
  assert.equal(extractSpecId('{"specId":"605243","grade":10}'), '605243');
  assert.equal(extractSpecId('<a href="/pop/pokemon/base-set/card/12345">Pop report</a>'), '12345');
  assert.equal(extractSpecId('<html><body>No spec here</body></html>'), null);
});

test('cert lookups are seeded once per distinct certification number, not once per listing', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'scraperbase-psa-cert-'));
  const db = openDb(path.join(root, 'db.sqlite'));
  try {
    const now = '2026-08-30T00:00:00.000Z';
    const insert = (itemId: string, cert: string | null): void => {
      const record = db.prepare(`INSERT INTO source_records (source, namespace, source_key, entity_type, first_seen_at, last_seen_at)
        VALUES ('ebay','de',?, 'item', ?, ?) RETURNING source_record_id`).get(itemId, now, now) as { source_record_id: number };
      db.prepare(`INSERT INTO ebay_listings (source_record_id, marketplace, item_id, title, cert_number, first_seen_at, last_seen_at)
        VALUES (?,'de',?,?,?,?,?)`).run(record.source_record_id, itemId, `listing ${itemId}`, cert, now, now);
    };
    // The same slab relisted twice, one other card, and two listings whose
    // "cert number" is not one.
    insert('1', '70352452');
    insert('2', '70352452');
    insert('3', '64051738');
    insert('4', null);
    insert('5', 'NA');

    const seeded = seedPsaCertLookups(db);
    assert.equal(seeded, 2, 'one lookup per distinct, well-formed cert number');
    const scopeKeys = (db.prepare(`SELECT scope_key FROM work_items WHERE queue = 'psa_cert' ORDER BY scope_key`).all() as unknown as Array<{ scope_key: string }>)
      .map((row) => row.scope_key);
    assert.deepEqual(scopeKeys, [certScopeKey('64051738'), certScopeKey('70352452')]);

    // Re-seeding is idempotent: the queue is keyed on the cert itself.
    seedPsaCertLookups(db);
    assert.equal((db.prepare(`SELECT COUNT(*) n FROM work_items WHERE queue = 'psa_cert'`).get() as { n: number }).n, 2);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('cert lookups go to PSA’s own cert route', () => {
  assert.equal(certLookupUrl('70352452'), 'https://www.psacard.com/cert/70352452');
});
