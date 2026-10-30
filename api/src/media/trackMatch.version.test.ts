import { describe, expect, it } from 'vitest';
import { sameVersion, scoreCandidate, versionCompatible } from './trackMatch.js';
import type { Track } from '../youtube/types.js';

function song(id: string, title: string, artist: string, durationSeconds?: number): Track {
  return {
    id,
    title,
    artists: [{ name: artist }],
    thumbnails: [],
    type: 'song',
    durationSeconds,
  };
}

describe('versionCompatible / Extended → original', () => {
  it('sameVersion refuse Extended vs original', () => {
    expect(
      sameVersion('Laisse Nous Raver (Extended Mix)', 'Laisse Nous Raver'),
    ).toBe(false);
  });

  it('allowBaseFallback accepte Extended → original', () => {
    expect(
      versionCompatible('Laisse Nous Raver (Extended Mix)', 'Laisse Nous Raver', {
        allowBaseFallback: true,
      }),
    ).toBe(true);
  });

  it('ne remplace pas un original par un remix', () => {
    expect(
      versionCompatible('Laisse Nous Raver', 'Laisse Nous Raver (Extended Mix)', {
        allowBaseFallback: true,
      }),
    ).toBe(false);
  });

  it('scoreCandidate soft trouve Rekkt original pour Extended mort', () => {
    const cand = song('PcpOcHlHiog', 'Laisse Nous Raver', 'Rekkt & NIVK', 181);
    expect(
      scoreCandidate(cand, 'Laisse Nous Raver (Extended Mix)', 'Rekkt & NIVK', 254),
    ).toBe(0);
    expect(
      scoreCandidate(cand, 'Laisse Nous Raver (Extended Mix)', 'Rekkt & NIVK', 254, {
        allowBaseFallback: true,
      }),
    ).toBeGreaterThanOrEqual(80);
  });
});
