#!/usr/bin/env node
/**
 * Tests unitaires purs (durée / horloge) — sans réseau.
 * Usage: npx tsx scripts/test/test-time.mjs
 */
import assert from 'node:assert/strict';
import {
  formatClock,
  formatRemaining,
  formatTrackDuration,
  trackDurationSeconds,
  sumTracksDurationSeconds,
  formatTotalDuration,
} from '../web/src/lib/time.ts';

assert.equal(formatClock(0), '0:00');
assert.equal(formatClock(65), '1:05');
assert.equal(formatClock(3661), '1:01:01');
assert.equal(formatRemaining(10, 70), '-1:00');
assert.equal(trackDurationSeconds({ duration: '3:45' }), 225);
assert.equal(trackDurationSeconds({ durationSeconds: 90 }), 90);
assert.equal(trackDurationSeconds({ duration: 120 }), 120);
assert.equal(trackDurationSeconds({}), null);
assert.equal(formatTrackDuration({ duration: '4:01' }), '4:01');
assert.equal(formatTrackDuration({}), '');
assert.equal(
  sumTracksDurationSeconds([{ duration: '1:00' }, { durationSeconds: 30 }, { duration: '' }]),
  90,
);
assert.equal(formatTotalDuration(90), '1 min');
assert.equal(formatTotalDuration(3700), '1 h 1 min');

console.log('OK test-time — formatClock / duration helpers');
