import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before } from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'hubera-fts-'));
process.env.SEARCH_FTS_PATH = join(dir, 't.db');

const { upsertIndexedTrack, searchIndexed, localSearchSufficient, indexedCount } = await import(
  './searchIndex.js'
);

describe('searchIndex FTS', () => {
  before(() => {
    upsertIndexedTrack({
      id: '3Modbc_k_XY',
      title: 'Amsterdam',
      artists: [{ name: 'Jacques Brel' }],
      thumbnails: [],
      type: 'song',
    });
    upsertIndexedTrack({
      id: 'J-OWpqvcPYk',
      title: 'Grosse Bléta',
      artists: [{ name: 'Gims' }],
      thumbnails: [],
      type: 'song',
    });
  });

  it('trouve Brel / Amsterdam', () => {
    const hits = searchIndexed('brel');
    assert.ok(hits.some((h) => h.id === '3Modbc_k_XY'));
    const a = searchIndexed('amsterdam');
    assert.equal(a[0]?.id, '3Modbc_k_XY');
  });

  it('filtre musique indexée (grosse bleta)', () => {
    const hits = searchIndexed('grosse');
    assert.ok(hits.some((h) => /bléta|bleta/i.test(hits.map((h) => h.title).join(' '))));
  });

  it('localSearchSufficient à 5+ hits', () => {
    assert.equal(localSearchSufficient('x', []), false);
    assert.equal(localSearchSufficient('br', searchIndexed('brel')), false);
    assert.ok(indexedCount() >= 2);
  });
});
