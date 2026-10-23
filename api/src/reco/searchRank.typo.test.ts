import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  damerauWithin,
  pickTopResult,
  rankByQuery,
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

  it('dingga met le titre Mamamoo devant cover, performance et fan-made', () => {
    const q = 'dingga';
    const officiel = song('딩가딩가 (Dingga)', 'MAMAMOO', 'FQI9B9TcSTI');
    const piano = song('Dingga', 'Pianella Piano', 'piano000001');
    const perf = song("[마마무] '딩가딩가 (Dingga)' Performance Video", 'MAMAMOO', 'perf0000001');
    const killing = song('딩가딩가 (Dingga)', 'KillingVoice MAMAMOO', 'kill0000001');
    const fitness = song('Dingga (Fitness Version 120 Bpm)', 'Girlzz', 'fit00000001');
    assert.ok(scoreSearchItem(officiel, q) > scoreSearchItem(piano, q));
    assert.ok(scoreSearchItem(officiel, q) > scoreSearchItem(perf, q));
    assert.ok(scoreSearchItem(officiel, q) > scoreSearchItem(killing, q));
    const top = pickTopResult(q, {
      topResult: perf,
      songs: [piano, perf, killing, fitness, officiel],
      artists: [],
      albums: [],
      videos: [],
      playlists: [],
    });
    assert.equal(top?.id, officiel.id);
    const ranked = rankByQuery([piano, perf, killing, fitness, officiel], q);
    assert.equal(ranked[0]?.id, officiel.id);
    assert.ok(ranked.findIndex((t) => t.id === piano.id) > 0);
    assert.ok(ranked.findIndex((t) => t.id === perf.id) > 0);
  });

  it('une phrase entière bat un titre qui ne partage qu’un mot', () => {
    const q = 'What Comes Funky';
    const vrai = song('Parliament - What Comes Funky', 'gebjgbtl571', 'parl000001');
    const autre = song('Funky Little Baby', 'Here Come the Mummies', 'mummy00001');
    assert.ok(scoreSearchItem(vrai, q) > scoreSearchItem(autre, q));
  });

  it('deux copies du même titre ne passent pas devant le crédit unique', () => {
    const q = 'Моя игра';
    const basta = song(q, 'Баста', 'basta000001');
    const coleA = song(q, 'Cole Walker', 'cole0000001');
    const coleB = song(q, 'Cole Walker', 'cole0000002');
    const top = pickTopResult(q, {
      topResult: coleA,
      songs: [basta, coleA, coleB],
      artists: [],
      albums: [],
      videos: [],
      playlists: [],
    });
    assert.equal(top?.id, basta.id);
  });

  it('un album homonyme ne passe pas devant le morceau', () => {
    const q = 'Trois heures vingt';
    const album = { ...song(q, 'Sylvain Alary', 'album000001'), type: 'album' as const };
    const celine = song('Trois heures vingt (Remasterisée)', 'Céline Dion', 'celine00001');
    const top = pickTopResult(q, {
      topResult: album,
      songs: [celine],
      artists: [],
      albums: [album],
      videos: [],
      playlists: [],
    });
    assert.equal(top?.id, celine.id);
  });

  it('un groupe homonyme ne passe pas devant le même titre', () => {
    const q = 'Second souffle';
    const groupe = song('Second Souffle', 'Second Souffle', 'groupe0001');
    const iam = song('Second souffle', 'IAM', 'iam00000001');
    assert.ok(scoreSearchItem(iam, q) >= scoreSearchItem(groupe, q));
    const groupe2 = song('Second Souffle Oblivion', 'Second Souffle', 'groupe0002');
    const ranked = rankByQuery([groupe, groupe2, iam], q);
    assert.equal(ranked[0]?.id, iam.id);
  });

  it('un artiste Beats passe après le même titre sans beats', () => {
    const q = 'Мокрые кроссы';
    const beat = song(q, 'SokolBeats', 'beat0000001');
    const tima = song(q, 'Тима Белорусских', 'tima0000001');
    assert.ok(scoreSearchItem(tima, q) > scoreSearchItem(beat, q));
    const top = pickTopResult(q, {
      topResult: beat,
      songs: [beat, tima],
      artists: [],
      albums: [],
      videos: [],
      playlists: [],
    });
    assert.equal(top?.id, tima.id);
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
