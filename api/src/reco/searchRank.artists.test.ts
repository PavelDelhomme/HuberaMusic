import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Track } from '../youtube/types.js';
import {
  diversifyExactTitleArtists,
  isLowQualitySearchHit,
  pickTopResult,
  synthesizeArtistsFromSongs,
} from './searchRank.js';

function song(title: string, artist: string, id: string): Track {
  return {
    id: id.slice(0, 11).padEnd(11, '0'),
    title,
    artists: [{ name: artist }],
    type: 'song',
    source: 'youtube',
  };
}

describe('searchRank artists / tendances', () => {
  it('marque les pubs « est dispo sur les plateformes » comme junk', () => {
    const junk = song(
      '« la maison brûle » est dispo sur toutes les plateformes ❤️‍🩹',
      'Lorette',
      'junkpromo01',
    );
    assert.equal(isLowQualitySearchHit(junk), true);
    assert.equal(isLowQualitySearchHit(song('la maison brûle', 'Lorette', 'realtrack01')), false);
  });

  it('synthétise Lenaïg / Lorette depuis les crédits', () => {
    const songs = [
      song('Aussi simple que toi', 'Lenaïg', 'lenaigsong1'),
      song('Rien à carrer', 'Lenaïg', 'lenaigsong2'),
      song('Vas-y, aboie !', 'Lenaïg', 'lenaigsong3'),
    ];
    const artists = synthesizeArtistsFromSongs(songs, 'lenaïg');
    assert.ok(artists.length >= 1);
    assert.match(artists[0].title || '', /lena[iï]g/i);
    assert.equal(artists[0].type, 'artist');
  });

  it('diversifie les versions d’un même titre catalogue', () => {
    const items = [
      song('la maison brûle', 'Diane', 'diane000001'),
      song('la maison brûle', 'Diane', 'diane000002'),
      song('la maison brûle', 'Lorette', 'lorette0001'),
      song('la maison brûle', 'Richard Séguin', 'seguin00001'),
      song('autre', 'X', 'autre000001'),
    ];
    const out = diversifyExactTitleArtists(items, 'la maison brûle');
    const head = out.slice(0, 3).map((t) => t.artists?.[0]?.name);
    assert.ok(head.includes('Diane'));
    assert.ok(head.includes('Lorette'));
    assert.ok(head.includes('Richard Séguin'));
  });

  it('pickTop : artiste synthétique bat un album homonyme', () => {
    const album: Track = {
      id: 'albumlenaig',
      title: 'Lenaïg',
      artists: [{ name: 'Erwan Deneve' }],
      type: 'album',
      source: 'youtube',
    };
    const songs = [
      song('Aussi simple que toi', 'Lenaïg', 'lenaigsong1'),
      song('Rien à carrer', 'Lenaïg', 'lenaigsong2'),
    ];
    const artists = synthesizeArtistsFromSongs(songs, 'lenaïg');
    const top = pickTopResult('lenaïg', {
      topResult: album,
      songs,
      artists,
      albums: [album],
      videos: [],
      playlists: [],
    });
    assert.equal(top?.type, 'artist');
    assert.match(top?.title || '', /lena[iï]g/i);
  });
});
