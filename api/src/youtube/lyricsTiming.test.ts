import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  alignTimedToVocalOnset,
  applyBestVocalOnset,
  firstVocalMs,
  isInstrumentalCaption,
} from './lyricsTiming.js';

describe('alignTimedToVocalOnset', () => {
  it('décale un LRC à 0 s vers l’intro du clip (Fils de joie ~37 s)', () => {
    const lrc = [
      { startMs: 0, text: 'Fils de joie' },
      { startMs: 4000, text: 'On t’enterre aujourd’hui' },
    ];
    const caps = [
      { startMs: 1200, text: '[Music]' },
      { startMs: 37200, text: 'Fils de joie' },
      { startMs: 41200, text: 'On t’enterre aujourd’hui' },
    ];
    const onset = firstVocalMs(caps);
    assert.equal(onset, 37200);
    const { timed, offsetMs } = alignTimedToVocalOnset(lrc, onset);
    assert.equal(offsetMs, 37200);
    assert.equal(timed[0]!.startMs, 37200);
    assert.equal(timed[1]!.startMs, 41200);
  });

  it('ne tire jamais les paroles en arrière', () => {
    const { offsetMs } = alignTimedToVocalOnset(
      [{ startMs: 12000, text: 'Hey' }],
      400,
    );
    assert.equal(offsetMs, 0);
  });

  it('ignore un jitter < 800 ms', () => {
    const { offsetMs } = alignTimedToVocalOnset(
      [{ startMs: 1000, text: 'Hey' }],
      1400,
    );
    assert.equal(offsetMs, 0);
  });

  it('détecte les captions instrumentales', () => {
    assert.equal(isInstrumentalCaption('[Music]'), true);
    assert.equal(isInstrumentalCaption('♪'), true);
    assert.equal(isInstrumentalCaption('Fils de joie'), false);
  });

  it('applique le décalage VEVO connu si les captions manquent (Fils de joie)', () => {
    const lrc = [
      { startMs: 4430, text: 'Être seul c’est difficile' },
      { startMs: 5900, text: 'Et là, ça fait des années' },
    ];
    const { timed, offsetMs } = applyBestVocalOnset(lrc, null, 'M7Z2tgJo8Hg');
    assert.equal(offsetMs, 32770);
    assert.equal(timed[0]!.startMs, 37200);
  });
});
