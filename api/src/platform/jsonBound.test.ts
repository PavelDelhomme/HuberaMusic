import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fitClientJson } from './jsonBound.js';

describe('réponse JSON bornée', () => {
  it('retire les vignettes d’un titre YouTube', () => {
    const fitted = fitClientJson({
      id: 'abcdefghijk',
      title: 'Papaoutai',
      thumbnails: [
        { url: 'https://example/a.jpg', width: 60 },
        { url: 'https://example/b.jpg', width: 120 },
      ],
    });
    const body = fitted.body as { thumbnails: unknown[] };
    assert.equal(fitted.clipped, false);
    assert.deepEqual(body.thumbnails, []);
  });

  it('garde une vignette pour un album', () => {
    const fitted = fitClientJson({
      id: 'MPREb_longer_album',
      thumbnails: [
        { url: 'https://example/a.jpg' },
        { url: 'https://example/b.jpg' },
      ],
    });
    const body = fitted.body as { thumbnails: { url: string }[] };
    assert.equal(body.thumbnails.length, 1);
    assert.equal(body.thumbnails[0].url, 'https://example/a.jpg');
  });

  it('coupe une liste qui dépasse le plafond', () => {
    const songs = Array.from({ length: 80 }, (_, i) => ({
      id: `id${i}`,
      title: 'x'.repeat(20),
    }));
    const fitted = fitClientJson({ songs }, 2000);
    const body = fitted.body as { songs: unknown[]; totalSongs: number; partial: boolean };
    assert.equal(fitted.clipped, true);
    assert.equal(body.totalSongs, 80);
    assert.equal(body.partial, true);
    assert.ok(body.songs.length < 80);
    assert.ok(Buffer.byteLength(JSON.stringify(body)) <= 2000);
  });
});
