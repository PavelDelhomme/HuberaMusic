import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before } from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'hubera-playability-'));
process.env.PLAYABILITY_DB_PATH = join(dir, 'p.db');
process.env.SEARCH_FTS_PATH = join(dir, 'fts.db');

const {
  closePlayabilityDb,
  collapseDuplicateGroups,
  getPlayability,
  isMusicCandidate,
  looksLikeHtml,
  recoverTrack,
  runPlayabilitySweep,
  sweepOne,
} = await import('./playabilitySweep.js');

const DEAD = 'dEaDvideo01';
const GOOD = 'GoOdSong__1';
const DUP_A = 'DupTitleAA1';
const DUP_B = 'DupTitleBB2';

describe('playabilitySweep', () => {
  before(() => closePlayabilityDb());

  it('ne propose jamais un non-music (podcast / video / album)', () => {
    assert.equal(isMusicCandidate({ type: 'song', title: 'Amsterdam', isMusic: true }), true);
    assert.equal(isMusicCandidate({ type: 'video', title: 'Amsterdam', isMusic: true }), false);
    assert.equal(isMusicCandidate({ type: 'song', title: 'Interview exclusive', isMusic: true }), false);
    assert.equal(isMusicCandidate({ type: 'podcast', title: 'Talk', isMusic: true }), false);
    assert.equal(isMusicCandidate({ type: 'album', title: 'Best of', isMusic: true }), false);
    assert.equal(isMusicCandidate({ type: 'song', title: 'Grosse Bléta', isMusic: false }), false);
  });

  it('détecte un corps HTML à la place de l’audio', () => {
    assert.equal(looksLikeHtml(new TextEncoder().encode('<!DOCTYPE html><html>')), true);
    assert.equal(looksLikeHtml(new TextEncoder().encode('\xff\xf1AACD')), false);
  });

  it('dead URL → recover vers un candidat songs qui streame', async () => {
    const aliases: Array<[string, string]> = [];
    const result = await recoverTrack(
      { videoId: DEAD, title: 'Amsterdam', artist: 'Jacques Brel', durationMs: 180_000 },
      {
        resolveStream: async (id) => (id === GOOD ? { url: `https://audio.test/${id}.m4a`, durationMs: 180_000 } : null),
        probeAudio: async (url) =>
          url.includes(GOOD) ? { ok: true, durationMs: 180_000, bytes: 4096 } : { ok: false, error: 'http-403' },
        searchSongs: async () => [
          { id: 'Podcastxx01', title: 'Amsterdam podcast', artist: 'Talk', type: 'podcast', isMusic: false },
          { id: GOOD, title: 'Amsterdam', artist: 'Jacques Brel', type: 'song', isMusic: true, durationSeconds: 180 },
        ],
        listTracks: async () => [],
        persistReplacement: (dead, neu) => {
          aliases.push([dead, neu]);
        },
        remapLibrary: () => {},
        upsertFts: () => {},
        sleep: async () => {},
      },
    );
    assert.equal(result.status, 'replaced');
    assert.equal(result.replacementVideoId, GOOD);
    assert.equal(aliases[0]?.[0], DEAD);
    assert.equal(aliases[0]?.[1], GOOD);
    assert.equal('forceUpdate' in result, false);
    const row = getPlayability(DEAD);
    assert.equal(row?.status, 'replaced');
    assert.equal(row?.replacementVideoId, GOOD);
  });

  it('ignore les candidats non-music même s’ils « streameraient »', async () => {
    const result = await recoverTrack(
      { videoId: DEAD, title: 'Grosse Bléta', artist: 'Gims', durationMs: 200_000 },
      {
        resolveStream: async (id) => ({ url: `https://audio.test/${id}`, durationMs: 200_000 }),
        probeAudio: async () => ({ ok: true, durationMs: 200_000, bytes: 2048 }),
        searchSongs: async () => [
          { id: 'NotASong001', title: 'Grosse Bléta interview', artist: 'TV', type: 'video', isMusic: false },
          { id: 'PodCastxx02', title: 'Grosse Bléta podcast', artist: 'Radio', type: 'podcast', isMusic: true },
        ],
        listTracks: async () => [],
        persistReplacement: () => {
          throw new Error('ne doit pas persister un non-music');
        },
        remapLibrary: () => {},
        upsertFts: () => {},
        sleep: async () => {},
      },
    );
    assert.equal(result.status, 'fail');
    assert.equal(result.replacementVideoId || null, null);
  });

  it('titres dupliqués se replient sur un seul videoId jouable', () => {
    const groups = collapseDuplicateGroups(
      [
        { videoId: DUP_A, title: 'Gims', artist: 'Gims' },
        { videoId: DUP_B, title: 'Gims', artist: 'Gims' },
      ],
      new Map([
        [DUP_A, { videoId: DUP_A, status: 'ok' }],
        [DUP_B, { videoId: DUP_B, status: 'fail', error: 'wrong-song' }],
      ]),
    );
    assert.equal(groups.length, 1);
    assert.equal(groups[0]?.canonical, DUP_A);
    assert.deepEqual(groups[0]?.duds, [DUP_B]);
  });

  it('sweep : URL morte puis candidat qui joue — pas de forceUpdate', async () => {
    const summary = await runPlayabilitySweep(
      { ids: [DEAD], limit: 1, concurrency: 1, sleepMs: 0, collapseDuplicates: false },
      {
        resolveStream: async (id) =>
          id === GOOD ? { url: `https://audio.test/${id}`, durationMs: 180_000 } : null,
        probeAudio: async (url) =>
          url.includes(GOOD) ? { ok: true, durationMs: 180_000 } : { ok: false, error: 'empty-body' },
        searchSongs: async () => [
          { id: GOOD, title: 'Amsterdam', artist: 'Jacques Brel', type: 'song', isMusic: true, durationSeconds: 180 },
        ],
        listTracks: async () => [
          { videoId: DEAD, title: 'Amsterdam', artist: 'Jacques Brel', durationMs: 180_000 },
        ],
        persistReplacement: () => {},
        remapLibrary: () => {},
        upsertFts: () => {},
        sleep: async () => {},
      },
    );
    assert.equal(summary.replaced, 1);
    assert.equal(summary.results[0]?.replacementVideoId, GOOD);
    assert.equal('forceUpdate' in summary, false);
  });

  it('sweepOne ok ne déclenche pas recover', async () => {
    let searches = 0;
    const r = await sweepOne(
      { videoId: GOOD, title: 'Amsterdam', artist: 'Jacques Brel', durationMs: 180_000 },
      {
        resolveStream: async () => ({ url: `https://audio.test/${GOOD}`, durationMs: 180_000 }),
        probeAudio: async () => ({ ok: true, durationMs: 180_000, bytes: 9000 }),
        searchSongs: async () => {
          searches += 1;
          return [];
        },
        listTracks: async () => [],
        persistReplacement: () => {},
        remapLibrary: () => {},
        upsertFts: () => {},
        sleep: async () => {},
      },
      true,
    );
    assert.equal(r.status, 'ok');
    assert.equal(searches, 0);
    assert.equal(getPlayability(GOOD)?.status, 'ok');
  });
});
