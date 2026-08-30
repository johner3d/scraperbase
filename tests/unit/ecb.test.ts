import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEcbUsdRate } from '../../src/sources/ecb/parse.ts';

test('parses the dated USD-per-EUR rate from ECB daily XML',()=>{
  const xml=`<gesmes:Envelope><Cube><Cube time='2026-08-28'><Cube currency='USD' rate='1.1643'/><Cube currency='GBP' rate='0.86'/></Cube></Cube></gesmes:Envelope>`;
  assert.deepEqual(parseEcbUsdRate(xml),{rateDate:'2026-08-28',usdPerEur:1.1643});
});

test('rejects an ECB payload without a valid dated USD rate',()=>{
  assert.equal(parseEcbUsdRate(`<Cube time='2026-08-28'><Cube currency='USD' rate='nope'/></Cube>`),null);
  assert.equal(parseEcbUsdRate(`<Cube><Cube currency='USD' rate='1.2'/></Cube>`),null);
});
