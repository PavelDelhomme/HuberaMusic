import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  damerauWithin,
  pickTopResult,
  repairQuery,
  scoreSearchItem,
} from './searchRank.js';

function song(title: string, artist: string, id: string) {
  return {
    id,
    title,
    artists: [{ name: artist }],
    thumbnails: [],
    type: 'song' as const,
  };
}

describe('fautes de frappe recherche', () => {
  it('bine/bien est une transposition, ostromae/stromae une lettre en trop', () => {
    assert.equal(damerauWithin('bine', 'bien', 1), 1);
    assert.equal(damerauWithin('ostromae', 'stromae', 1), 1);
    assert.ok(damerauWithin('madonna', 'stromae', 2) > 2);
  });

  it('corrige la requête sans inventer un autre artiste', () => {
    const fixed = repairQuery('je vais bine ostromae', ['je', 'vais', 'bien', 'stromae', 'ridsa']);
    assert.equal(fixed, 'je vais bien stromae');
    const notMine = repairQuery('je vais bine ostromae', ['bien', 'je', 'vais'], ['mine', 'stromae']);
    assert.equal(notMine, 'je vais bien stromae');
    assert.equal(repairQuery('stromae', ['stromae', 'madonna']), null);
  });

  it('Je vais bien de Stromae bat Je vais bien d’un autre artiste', () => {
    const q = 'je vais bine ostromae';
    const stromae = song('Je vais bien', 'Stromae', 'stromaejev1');
    const autre = song('Je vais bien', 'Ridsa', 'ridsajevais');
    assert.ok(scoreSearchItem(stromae, q) > scoreSearchItem(autre, q) + 400);
    const top = pickTopResult(q, {
      topResult: autre,
      songs: [autre, stromae],
      artists: [],
      albums: [],
      videos: [],
      playlists: [],
    });
    assert.equal(top?.id, stromae.id);
    const phrase = song('Stromae – Maman croit (que je vais bien)', 'EL Melodies', 'maman01xxx');
    const other = song('Peace Or Violence', 'Stromae', 'peaceorvio1');
    assert.ok(scoreSearchItem(phrase, q) > scoreSearchItem(other, q) + 400);
    const phraseTop = pickTopResult(q, {
      topResult: other,
      songs: [other, phrase],
      artists: [],
      albums: [],
      videos: [],
      playlists: [],
    });
    assert.equal(phraseTop?.id, phrase.id);
  });

  it('stromae ne met pas Madonna en meilleur résultat', () => {
    const madonna = song('Like a Prayer', 'Madonna', 'madonnason1');
    const artist = {
      id: 'UCstromae01',
      title: 'Stromae',
      artists: [{ name: 'Stromae' }],
      thumbnails: [{ url: 'https://example.test/a.jpg', width: 200, height: 200 }],
      type: 'artist' as const,
    };
    const top = pickTopResult('stromae', {
      topResult: madonna,
      songs: [madonna],
      artists: [artist],
      albums: [],
      videos: [],
      playlists: [],
    });
    assert.equal(top?.type, 'artist');
    assert.match(top?.title || '', /stromae/i);
    assert.ok(scoreSearchItem(artist, 'stromae') > scoreSearchItem(madonna, 'stromae') + 200);
  });
});
