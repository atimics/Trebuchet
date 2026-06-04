// test/price-drift.test.mjs
//
// Unit tests for the pure drift-check helpers in lpMath.js. These
// power the Milestone A drift guard in lpService.js — when the
// just-in-time Raydium probe disagrees with the funding-estimate
// price by more than the configured threshold (default 25%), the
// launch aborts before any on-chain action.
//
// Why the boundary tests matter: 1.25 is THE threshold. A user with
// 25.0% drift should pass; 25.01% should fail. Off-by-one or floating-
// point sloppiness here would either nuisance-abort legitimate launches
// or silently let bad-price launches through.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  measurePriceDrift,
  driftExceedsThreshold,
  driftPercent,
} from '../lpMath.js';

// ---------------------------------------------------------------------------
// measurePriceDrift
// ---------------------------------------------------------------------------

test('measurePriceDrift: identical values → 1.0', () => {
  assert.equal(measurePriceDrift(1.0, 1.0), 1.0);
  assert.equal(measurePriceDrift(150, 150), 1.0);
  assert.equal(measurePriceDrift(0.000001, 0.000001), 1.0);
});

test('measurePriceDrift: 25% higher → 1.25', () => {
  // 1.25 / 1.0 = 1.25
  assert.equal(measurePriceDrift(1.25, 1.0), 1.25);
});

test('measurePriceDrift: 25% lower → 1.25 (symmetric)', () => {
  // 1.0 / 0.8 = 1.25
  assert.equal(measurePriceDrift(0.8, 1.0), 1.25);
});

test('measurePriceDrift: ratio is symmetric regardless of argument order', () => {
  assert.equal(measurePriceDrift(0.8, 1.0), measurePriceDrift(1.0, 0.8));
  assert.equal(measurePriceDrift(150, 200), measurePriceDrift(200, 150));
});

test('measurePriceDrift: 10x drift → 10.0', () => {
  assert.equal(measurePriceDrift(10, 1), 10);
  assert.equal(measurePriceDrift(1, 10), 10);
});

test('measurePriceDrift: NaN on invalid input', () => {
  assert.ok(Number.isNaN(measurePriceDrift(0, 1.0)));
  assert.ok(Number.isNaN(measurePriceDrift(1.0, 0)));
  assert.ok(Number.isNaN(measurePriceDrift(-1, 1.0)));
  assert.ok(Number.isNaN(measurePriceDrift(1.0, -1)));
  assert.ok(Number.isNaN(measurePriceDrift(NaN, 1.0)));
  assert.ok(Number.isNaN(measurePriceDrift(1.0, Infinity)));
});

// ---------------------------------------------------------------------------
// driftExceedsThreshold — the actual safety-critical decision function
// ---------------------------------------------------------------------------

test('driftExceedsThreshold: at exactly the threshold → false', () => {
  // 1.0 vs 1.25, threshold 1.25. Ratio is exactly 1.25, NOT greater
  // than. The plan's intent is "abort when drift EXCEEDS threshold,"
  // so the boundary should be a pass.
  assert.equal(driftExceedsThreshold(1.0, 1.25, 1.25), false);
  assert.equal(driftExceedsThreshold(1.25, 1.0, 1.25), false);
});

test('driftExceedsThreshold: just above threshold → true', () => {
  // 1.0 vs 1.26 = 26% drift, threshold 1.25.
  assert.equal(driftExceedsThreshold(1.0, 1.26, 1.25), true);
  assert.equal(driftExceedsThreshold(1.26, 1.0, 1.25), true);
});

test('driftExceedsThreshold: just below threshold → false', () => {
  // 1.0 vs 1.24 = 24% drift, threshold 1.25.
  assert.equal(driftExceedsThreshold(1.0, 1.24, 1.25), false);
  assert.equal(driftExceedsThreshold(1.24, 1.0, 1.25), false);
});

test('driftExceedsThreshold: documented plan boundaries', () => {
  // The plan calls out specific boundary cases that should match.
  // probe=$1.00 override=$1.25 → pass (exactly threshold)
  // probe=$1.00 override=$1.26 → fail (just over)
  // probe=$1.00 override=$0.80 → pass (1/0.8 = 1.25 = threshold)
  // probe=$1.00 override=$0.74 → fail (1/0.74 ≈ 1.351 > 1.25)
  assert.equal(driftExceedsThreshold(1.00, 1.25, 1.25), false);
  assert.equal(driftExceedsThreshold(1.00, 1.26, 1.25), true);
  assert.equal(driftExceedsThreshold(1.00, 0.80, 1.25), false);
  assert.equal(driftExceedsThreshold(1.00, 0.74, 1.25), true);
});

test('driftExceedsThreshold: 50% threshold (env override case)', () => {
  // PRICE_DRIFT_THRESHOLD_PCT=50 → ratio 1.50.
  assert.equal(driftExceedsThreshold(1.0, 1.4, 1.5), false);
  assert.equal(driftExceedsThreshold(1.0, 1.5, 1.5), false);
  assert.equal(driftExceedsThreshold(1.0, 1.51, 1.5), true);
});

test('driftExceedsThreshold: identical values never exceed', () => {
  assert.equal(driftExceedsThreshold(1.0, 1.0, 1.25), false);
  assert.equal(driftExceedsThreshold(150, 150, 1.25), false);
});

test('driftExceedsThreshold: huge drift → true', () => {
  // 100x drift — the wrong-base/quote bug from the original user
  // report — clearly exceeds any reasonable threshold.
  assert.equal(driftExceedsThreshold(1.0, 100, 1.25), true);
  assert.equal(driftExceedsThreshold(100, 1.0, 1.25), true);
});

test('driftExceedsThreshold: invalid inputs → false (safe default)', () => {
  // If we got bad inputs we shouldn't trip the abort — the calling
  // code is responsible for validating its own inputs separately.
  // The drift check should silently say "no drift detected" so the
  // caller's sanity floor catches the real problem.
  assert.equal(driftExceedsThreshold(0, 1.0, 1.25), false);
  assert.equal(driftExceedsThreshold(1.0, 0, 1.25), false);
  assert.equal(driftExceedsThreshold(NaN, 1.0, 1.25), false);
});

test('driftExceedsThreshold: invalid threshold → false', () => {
  // A threshold less than 1.0 would say "any drift fails" (every
  // ratio is >= 1). Treating that as a bug rather than a feature.
  assert.equal(driftExceedsThreshold(1.0, 1.0, 0.5), false);
  assert.equal(driftExceedsThreshold(1.0, 1.0, NaN), false);
});

// ---------------------------------------------------------------------------
// driftPercent — display helper, signed
// ---------------------------------------------------------------------------

test('driftPercent: identical values → 0', () => {
  assert.equal(driftPercent(1.0, 1.0), 0);
});

test('driftPercent: current higher than reference → positive', () => {
  // probe is 25% higher than funding-estimate. Use tolerance because
  // (1.25 - 1.0) / 1.0 * 100 might not land on exactly 25.0 in IEEE 754.
  const result = driftPercent(1.25, 1.0);
  assert.ok(Math.abs(result - 25) < 1e-9, `expected ~25, got ${result}`);
});

test('driftPercent: current lower than reference → negative', () => {
  // probe is 20% lower than funding-estimate
  const result = driftPercent(0.8, 1.0);
  assert.ok(Math.abs(result - (-20)) < 1e-9, `expected ~-20, got ${result}`);
});

test('driftPercent: NaN on invalid input', () => {
  // reference=0 would divide-by-zero — return NaN.
  assert.ok(Number.isNaN(driftPercent(1.0, 0)));
  // negative reference is also invalid (drift is bidirectional but
  // doesn't make sense against a negative anchor).
  assert.ok(Number.isNaN(driftPercent(1.0, -1)));
  // NaN inputs propagate.
  assert.ok(Number.isNaN(driftPercent(NaN, 1.0)));
  assert.ok(Number.isNaN(driftPercent(1.0, NaN)));
  // current=0 is VALID though — means "new value is zero" → -100%.
  // Not a NaN case, but confirm it's handled sanely.
  assert.equal(driftPercent(0, 1.0), -100);
});
