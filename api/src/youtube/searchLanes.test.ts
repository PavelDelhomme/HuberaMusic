import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  SEARCH_LIST_GRACE_MS,
  SEARCH_LIST_HARD_CAP_MS,
  SEARCH_WEB_EMPTY_BUDGET_MS,
  collectSearchLanes,
  listWithoutSlowPath,
} from './searchLanes.js';

function later<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

describe('recherche — la liste n’attend pas le chemin lent', () => {
  it('le budget de la liste reste court', () => {
    assert.equal(SEARCH_LIST_GRACE_MS, 0);
    assert.ok(SEARCH_LIST_HARD_CAP_MS <= 9_000);
    assert.ok(SEARCH_WEB_EMPTY_BUDGET_MS <= 1_000);
    assert.ok(SEARCH_WEB_EMPTY_BUDGET_MS < SEARCH_LIST_HARD_CAP_MS);
  });

  it('la liste revient avant les paroles et avant album / détails', async () => {
    let lyricsSettled = false;
    const lyrics = later(1_500, 'paroles très lentes').then((text) => {
      lyricsSettled = true;
      return text;
    });

    const t0 = Date.now();
    const songs = listWithoutSlowPath(
      [{ id: 'abcdefghijk', title: 'Amsterdam' }],
      lyrics,
    );
    const lanes = await collectSearchLanes<{
      songs?: { id: string; title?: string }[];
      albums?: { id: string }[];
      enriched?: boolean;
    }>(
      {
        primary: Promise.resolve({ songs }),
        album: later(1_500, { albums: [{ id: 'SLOWALBUM11' }] }),
        details: later(1_500, { enriched: true }),
      },
      {
        listLanes: ['primary'],
        hasList: (v) => Array.isArray(v.songs) && v.songs.length > 0,
        graceMs: 80,
        hardCapMs: 5_000,
      },
    );

    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 500, `la liste a attendu ${elapsed} ms`);
    assert.equal(lyricsSettled, false);
    assert.equal(songs[0]?.title, 'Amsterdam');
    assert.equal(lanes.values.primary?.songs[0]?.id, 'abcdefghijk');
    assert.equal(lanes.values.album, undefined);
    assert.equal(lanes.values.details, undefined);
    assert.ok(lanes.pending.includes('album'));
    assert.ok(lanes.pending.includes('details'));
  });

  it('si toutes les voies sont déjà là, on ne rajoute pas le sursis', async () => {
    const t0 = Date.now();
    const lanes = await collectSearchLanes<{
      songs?: { id: string }[];
      albums?: { id: string }[];
    }>(
      {
        primary: Promise.resolve({ songs: [{ id: 'a' }] }),
        album: Promise.resolve({ albums: [{ id: 'b' }] }),
      },
      {
        listLanes: ['primary'],
        hasList: (v) => Array.isArray((v as { songs?: unknown[] }).songs) && ((v as { songs?: unknown[] }).songs?.length || 0) > 0,
        graceMs: 800,
        hardCapMs: 5_000,
      },
    );
    assert.ok(Date.now() - t0 < 200);
    assert.ok(lanes.values.album);
    assert.equal(lanes.pending.length, 0);
  });

  it('sans aucun titre, on coupe au plafond au lieu d’attendre 12 s', async () => {
    const t0 = Date.now();
    const lanes = await collectSearchLanes<{
      songs: { id: string }[];
      albums?: { id: string }[];
    }>(
      {
        primary: Promise.resolve({ songs: [] as { id: string }[] }),
        album: later(2_000, { albums: [{ id: 'late' }] }),
      },
      {
        listLanes: ['primary'],
        hasList: (v) => v.songs.length > 0,
        graceMs: 50,
        hardCapMs: 160,
      },
    );
    assert.ok(Date.now() - t0 < 500);
    assert.equal(lanes.values.album, undefined);
  });

  it('sans hit bibliothèque, la liste revient sans attendre la voie lente', async () => {
    let slowSettled = false;
    const slow = later(1_500, { albums: [{ id: 'SLOW' }], web: true }).then((value) => {
      slowSettled = true;
      return value;
    });
    const t0 = Date.now();
    const songs = listWithoutSlowPath(
      [{ id: 'rarevideo01', title: 'Adan no Shima' }],
      slow,
    );
    const lanes = await collectSearchLanes<{
      songs?: { id: string; title?: string }[];
    }>(
      { primary: Promise.resolve({ songs }) },
      {
        listLanes: ['primary'],
        hasList: (v) => Array.isArray(v.songs) && v.songs.length > 0,
        graceMs: SEARCH_LIST_GRACE_MS,
        hardCapMs: SEARCH_LIST_HARD_CAP_MS,
      },
    );
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 250, `la liste a attendu ${elapsed} ms`);
    assert.equal(slowSettled, false);
    assert.equal(lanes.pending.length, 0);
    assert.equal(lanes.values.primary?.songs?.[0]?.title, 'Adan no Shima');
  });

  it('search() utilise ce chemin et n’appelle pas getLyrics pour la liste', () => {
    const src = readFileSync(new URL('./yt.ts', import.meta.url), 'utf8');
    const pin = src.indexOf('function pinCanonicalHit');
    const start = src.indexOf('async function searchUncached');
    const end = src.indexOf('async function searchSpokenContent');
    assert.ok(pin > 0 && start > pin && end > start);
    const body = src.slice(start, end);
    const hitPin = src.slice(pin, start);
    assert.match(body, /collectSearchLanes\(/);
    assert.match(body, /pinCanonicalHit\(/);
    assert.match(body, /primary: innertubeSearch\(q\)/);
    assert.match(body, /!haveList/);
    assert.match(body, /SEARCH_WEB_EMPTY_BUDGET_MS/);
    // Lane « song » en parallèle pour les titres multi-mots (versions tendances).
    assert.match(body, /innertubeSearch\(q, 'song'\)/);
    assert.equal(body.includes("innertubeSearch(q, 'album')"), false);
    assert.equal(body.includes("innertubeSearch(q, 'artist')"), false);
    assert.equal(body.includes('artistSpellingAlternates'), false);
    assert.equal(body.includes('12_000'), false);
    assert.equal(body.includes('12000'), false);
    assert.match(hitPin, /listWithoutSlowPath\(/);
    assert.equal(hitPin.includes('await '), false);
    assert.equal(body.includes('getLyrics'), false);
    assert.equal(body.includes('await getTrack'), false);
    assert.equal(body.includes('getFullLibrary'), false);
    assert.equal(body.includes('getLibraryTasteTracks'), false);
    assert.equal(body.includes('scanReadyAudioFromDisk'), false);
    assert.equal(src.includes('getFullLibrary'), false);
    const taste = src.indexOf('function buildSearchPersonalization');
    const tasteEnd = src.indexOf('export async function search', taste);
    assert.ok(taste > 0 && tasteEnd > taste);
    const tasteBody = src.slice(taste, tasteEnd);
    assert.match(tasteBody, /listFollows\(userId, 40\)/);
    assert.match(tasteBody, /getHistory\(userId, 80\)/);
    assert.equal(tasteBody.includes('getLibraryTasteTracks'), false);
    assert.equal(tasteBody.includes('getFullLibrary'), false);
  });
});
