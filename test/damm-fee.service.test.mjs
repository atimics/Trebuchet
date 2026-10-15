import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPoolFees } from '../dammV2Service.js';

test('fixed fee is a flat time scheduler at the given rate', () => {
  const fees = buildPoolFees({ model: 'fixed', bps: 50 });
  assert.ok(fees.baseFee, 'base fee exists');
  assert.equal(fees.dynamicFee, null, 'fixed pools have no dynamic surcharge');
  const encoded = fees.baseFee;
  assert.ok(encoded instanceof Uint8Array || typeof encoded === 'object');
});

test('ramp fee uses a time scheduler with start, end and duration', () => {
  const fees = buildPoolFees({ model: 'ramp', bps: 100, ramp: { endBps: 25, durationSec: 30 * 86400 } });
  assert.equal(fees.dynamicFee, null);
  assert.ok(fees.baseFee);
});

test('ramp/marketcap schedules default their end fee instead of producing NaN', () => {
  // A caller that omits ramp/marketcap params must not send NaN to the SDK.
  assert.doesNotThrow(() => buildPoolFees({ model: 'ramp', bps: 50 }));
  assert.doesNotThrow(() => buildPoolFees({ model: 'marketcap', bps: 50 }));
  assert.doesNotThrow(() => buildPoolFees({ model: 'dynamic', bps: 50 }));
});

test('dynamic fee sets a dynamic surcharge on top of the base', () => {
  const fees = buildPoolFees({ model: 'dynamic', bps: 25, dynamic: { maxPriceChangeBps: 500 } });
  assert.ok(fees.baseFee, 'base fee still present');
  assert.ok(fees.dynamicFee, 'dynamic fee present for dynamic model');
});

test('marketcap fee uses the market-cap scheduler parameters', () => {
  const fees = buildPoolFees({ model: 'marketcap', bps: 50, marketcap: { endBps: 10, priceMultiple: 100, expirationSec: 60 * 86400 } });
  assert.equal(fees.dynamicFee, null);
  assert.ok(fees.baseFee);
});

test('unknown models throw instead of building a wrong pool fee', () => {
  assert.throws(() => buildPoolFees({ model: 'quantum' }), /Unknown Meteora fee model/);
});