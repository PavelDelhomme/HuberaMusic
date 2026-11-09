import assert from 'node:assert/strict';
import { betaOfferBeatsProd, isBetaAccount } from './betaChannel.ts';

const allow = 'paul@delhomme.ovh, lab@hubera.cloud';

assert.equal(isBetaAccount('paul@delhomme.ovh', allow), true);
assert.equal(isBetaAccount('Paul@Delhomme.ovh', allow), true);
assert.equal(isBetaAccount('autre@example.com', allow), false);
assert.equal(isBetaAccount('', allow), false);
assert.equal(isBetaAccount(null, allow), false);

assert.equal(
  betaOfferBeatsProd({ betaReady: true, betaCode: 10680, prodCode: 10672, clientCode: 10672 }),
  true,
);
assert.equal(
  betaOfferBeatsProd({ betaReady: true, betaCode: 10670, prodCode: 10672, clientCode: 10660 }),
  false,
);
assert.equal(
  betaOfferBeatsProd({ betaReady: false, betaCode: 10900, prodCode: 10672, clientCode: 1 }),
  false,
);
assert.equal(
  betaOfferBeatsProd({ betaReady: true, betaCode: 10672, prodCode: 10672, clientCode: 10680 }),
  false,
);

console.log('betaChannel.test ok');
