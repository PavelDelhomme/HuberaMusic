import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  PUBLIC_AUDIO_ROUTES,
  isPlayablePublicAudioUrl,
  publicAudioRoutesForRetry,
} from './publicAudioRoutes.js';

describe('publicAudioRoutes', () => {
  it('deux routes, décalées selon le retry, pour tout compte', () => {
    const first = publicAudioRoutesForRetry(0).map((r) => r.name);
    const next = publicAudioRoutesForRetry(1).map((r) => r.name);
    assert.deepEqual(first, ['public:ANDROID:251', 'public:MWEB:250']);
    assert.equal(first[0] === next[0], false);
    assert.equal(publicAudioRoutesForRetry(5)[0]?.name, PUBLIC_AUDIO_ROUTES[0]?.name);
    assert.equal(JSON.stringify(PUBLIC_AUDIO_ROUTES).includes('relay'), false);
    assert.equal(JSON.stringify(PUBLIC_AUDIO_ROUTES).includes('cookie'), false);
    assert.equal(JSON.stringify(PUBLIC_AUDIO_ROUTES).includes('proxy'), false);
  });

  it('accepte aac et opus, refuse le dash et une page', () => {
    assert.equal(
      isPlayablePublicAudioUrl('https://rr.googlevideo.com/videoplayback?itag=251', 'audio/webm'),
      true,
    );
    assert.equal(
      isPlayablePublicAudioUrl('https://rr.googlevideo.com/videoplayback?itag=140', 'audio/mp4'),
      true,
    );
    assert.equal(
      isPlayablePublicAudioUrl('https://rr.googlevideo.com/videoplayback?itag=18', 'video/mp4'),
      false,
    );
    assert.equal(isPlayablePublicAudioUrl('https://x/dash/a', 'audio/mp4; codecs="dash"'), false);
  });
});
