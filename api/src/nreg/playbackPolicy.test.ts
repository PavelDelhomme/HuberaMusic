import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ANDROID_COLD_DISK_WAIT_MS,
  GET_AUDIO_FORMAT_DEADLINE_MS,
  downloadFailCooldownMs,
  downloadFailKind,
  shouldReplaceCachedLyrics,
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

  it('ne remplace pas des paroles synchronisées par une réponse vide', () => {
    assert.equal(shouldReplaceCachedLyrics(''), false);
    assert.equal(shouldReplaceCachedLyrics(null), false);
    assert.equal(shouldReplaceCachedLyrics('short'), false);
    assert.equal(shouldReplaceCachedLyrics('Couplet un\nCouplet deux\nRefrain'), true);
  });
});
