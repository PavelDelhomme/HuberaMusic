import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ANDROID_COLD_DISK_WAIT_MS,
  ANDROID_CLIENT_UA_RE,
  GET_AUDIO_FORMAT_DEADLINE_MS,
  downloadFailCooldownMs,
  downloadFailKind,
  shouldReplaceCachedLyrics,
  shouldKeepLocalFileUri,
  clipPositionStuck,
} from './playbackPolicy.js';

describe('playbackPolicy — non-régression lecture / paroles', () => {
  it('attend assez longtemps le disque à froid (yt-dlp ~30 s)', () => {
    assert.ok(ANDROID_COLD_DISK_WAIT_MS >= 25_000);
    assert.ok(GET_AUDIO_FORMAT_DEADLINE_MS >= 35_000);
  });

  it('un timeout yt-dlp n’ouvre pas un circuit 30 s', () => {
    assert.equal(downloadFailKind('timeout ytdlpUrlAntiDash'), 'transient');
    assert.equal(downloadFailKind('getAudioFormat deadline'), 'transient');
    assert.equal(downloadFailKind('yt-dlp KO, disque pas encore prêt'), 'transient');
    assert.ok(downloadFailCooldownMs('transient', 90_000) <= 5_000);
  });

  it('un blocage bot reste en cooldown long', () => {
    assert.equal(downloadFailKind('Sign in to confirm you are not a bot'), 'bot');
    assert.ok(downloadFailCooldownMs('bot', 60_000) >= 45_000);
  });

  it('reconnaît l’UA Android HuberaMusic (pas seulement PLM-Android)', () => {
    assert.equal(ANDROID_CLIENT_UA_RE.test('HuberaMusic-Android'), true);
    assert.equal(ANDROID_CLIENT_UA_RE.test('PLM-Android/1.3.357'), true);
    assert.equal(ANDROID_CLIENT_UA_RE.test('Mozilla/5.0'), false);
  });

  it('ne remplace pas des paroles synchronisées par une réponse vide', () => {
    assert.equal(shouldReplaceCachedLyrics(''), false);
    assert.equal(shouldReplaceCachedLyrics(null), false);
    assert.equal(shouldReplaceCachedLyrics('short'), false);
    assert.equal(shouldReplaceCachedLyrics('Couplet un\nCouplet deux\nRefrain'), true);
  });

  it('ne recâble jamais un file:// local vers le proxy (même en ligne)', () => {
    assert.equal(shouldKeepLocalFileUri('file'), true);
    assert.equal(shouldKeepLocalFileUri('file:///data/user/0/cloud.hubera.music/files/offline/abc.m4a'), true);
    assert.equal(shouldKeepLocalFileUri('/data/user/0/x/files/offline/abc.mp4'), true);
    assert.equal(shouldKeepLocalFileUri('https://music.hubera.cloud/api/stream/abc?type=video'), false);
    assert.equal(shouldKeepLocalFileUri('http'), false);
  });

  it('un clip officiel >30 s n’a pas POSITION coincée', () => {
    const advancing = [0, 5_000, 12_000, 20_000, 31_200];
    assert.equal(clipPositionStuck(advancing), false);
    const stuck = [1_200, 1_200, 1_250, 1_200];
    assert.equal(clipPositionStuck(stuck), true);
  });
});
