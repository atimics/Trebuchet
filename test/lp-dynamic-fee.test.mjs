import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveTickSpacingForConfig, resetTestFactories, cachedClmmFeeTiers, setCachedClmmFeeTiersForTests } from '../lpService.js';
import { FALLBACK_FEE_TIERS } from '../lpFeeTiers.js';

test.afterEach(() => {
  setCachedClmmFeeTiersForTests(null);
  resetTestFactories();
});

test('tick spacing falls back to the default when the cache is empty', () => {
  setCachedClmmFeeTiersForTests(null);
  const spacing = resolveTickSpacingForConfig(1);
  const expected = FALLBACK_FEE_TIERS.find((t) => t.index === 1).tickSpacing;
  assert.equal(spacing, expected);
});

test('tick spacing honors a live config for an index not in the fallback', () => {
  // A dynamic / newer config that does NOT exist in FALLBACK_FEE_TIERS. The
  // estimator must price its rent with the real spacing (120), never the
  // default's (60) — that was the under-funding risk when dynamic tiers became
  // selectable in P1.
  setCachedClmmFeeTiersForTests([
    { index: 3, tradeFeeRate: 10000, tickSpacing: 120, feeModel: 'fixed' },
    { index: 9, tradeFeeRate: 400, tickSpacing: 200, feeModel: 'dynamic' },
  ]);
  assert.equal(resolveTickSpacingForConfig(9), 200);
  assert.equal(resolveTickSpacingForConfig(3), 120);
});

test('tick spacing falls back for an unknown index even with a live cache', () => {
  setCachedClmmFeeTiersForTests([{ index: 9, tradeFeeRate: 400, tickSpacing: 200, feeModel: 'dynamic' }]);
  // DEFAULT_AMM_CONFIG_INDEX (3) is the fallback when an index is unknown.
  const fallbackDefault = FALLBACK_FEE_TIERS.find((t) => t.index === 3) || FALLBACK_FEE_TIERS[0];
  assert.equal(resolveTickSpacingForConfig(99), fallbackDefault.tickSpacing);
});

test('cachedClmmFeeTiers stays null until a fetch or a stated cache', () => {
  setCachedClmmFeeTiersForTests(null);
  assert.equal(cachedClmmFeeTiers(), null);
});