import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { safeStoredPath } from '../../src/web/mediaPath.ts';

test('media paths remain inside the object store and reject traversal', () => {
  const root=path.resolve('data','objects');
  assert.equal(safeStoredPath(root,path.join('tcgdex','json','aa','card.webp')),path.join(root,'tcgdex','json','aa','card.webp'));
  assert.equal(safeStoredPath(root,path.join('..','db.sqlite')),null);
  assert.equal(safeStoredPath(root,path.resolve('C:\\Windows\\win.ini')),null);
});
