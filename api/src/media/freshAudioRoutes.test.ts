import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  FRESH_ROUTE_PLAN,
  isMissingAudioUrlFailure,
  redactStreamLocator,
  runMissingAudioRecoveryThenDaily,
  tryFreshAudioRoutes,
  type FreshAudioHit,
  type FreshRouteSpec,
} from './freshAudioRoutes.js';

const FAILING = 'Bo644plDuYM';

describe('freshAudioRoutes', () => {
  it('classe LOGIN_REQUIRED / pas de format, pas une vidéo morte', () => {
    assert.equal(isMissingAudioUrlFailure('LOGIN_REQUIRED'), true);
    assert.equal(isMissingAudioUrlFailure('Requested format is not available'), true);
    assert.equal(isMissingAudioUrlFailure('getAudioFormat deadline'), true);
    assert.equal(isMissingAudioUrlFailure('no-stream-url'), true);
    assert.equal(isMissingAudioUrlFailure('streaming data not available'), true);
    assert.equal(isMissingAudioUrlFailure('resolve-timeout'), true);
    assert.equal(isMissingAudioUrlFailure('This video is unavailable'), false);
    assert.equal(isMissingAudioUrlFailure('private video'), false);
    assert.equal(isMissingAudioUrlFailure('probe-timeout'), false);
  });

  it('masque une URL googlevideo qui porte un jeton', () => {
    const raw =
      'https://rr3---sn.googlevideo.com/videoplayback?expire=1&ei=abc&itag=251&sig=secret&lsig=s';
    const redacted = redactStreamLocator(raw);
    assert.match(redacted, /redacted=1/);
    assert.match(redacted, /itag=251/);
    assert.equal(redacted.includes('secret'), false);
    assert.equal(redacted.includes('sig='), false);
  });

  it('tente ANDROID, MWEB, ANDROID_VR puis le relais avant le job quotidien', async () => {
    const order: string[] = [];
    const out = await runMissingAudioRecoveryThenDaily({
      videoIds: [FAILING],
      attempt: async (route: FreshRouteSpec) => {
        order.push(route.name);
        if (route.kind === 'innertube' && route.client === 'MWEB') {
          const hit: FreshAudioHit = {
            url: 'https://audio.test/fresh',
            probe: 'HEAD',
            itag: '250',
          };
          return hit;
        }
        throw new Error('LOGIN_REQUIRED');
      },
      daily: async () => {
        order.push('daily');
        return { checked: 1 };
      },
    });
    assert.deepEqual(
      order,
      ['innertube:ANDROID:251', 'innertube:MWEB:250', 'daily'],
    );
    assert.equal(out.recoveries[0]?.ok, true);
    assert.equal(out.recoveries[0]?.route, 'innertube:MWEB:250');
    assert.equal(out.recoveries[0]?.tried.some((t) => t.name === 'relay:stream-upstream'), false);
    assert.equal(JSON.stringify(out).includes('https://audio.test'), false);
    assert.equal(out.daily.checked, 1);
  });

  it('enchaîne toutes les routes puis le job si aucune URL', async () => {
    const order: string[] = [];
    const result = await tryFreshAudioRoutes(FAILING, async (route) => {
      order.push(route.name);
      throw new Error('pas de format https://rr.googlevideo.com/videoplayback?sig=tok');
    });
    assert.deepEqual(
      order,
      FRESH_ROUTE_PLAN.map((r) => r.name),
    );
    assert.equal(result.ok, false);
    assert.equal(result.route, null);
    assert.equal(result.tried.every((t) => t.ok === false), true);
    assert.equal(result.tried.some((t) => t.detail.includes('sig=')), false);
    assert.match(result.tried[0]!.detail, /pas de format/);

    let dailyRan = false;
    await runMissingAudioRecoveryThenDaily({
      videoIds: [],
      attempt: async () => {
        throw new Error('ne doit pas partir');
      },
      daily: async () => {
        dailyRan = true;
        return 'job';
      },
    });
    assert.equal(dailyRan, true);
  });
});
