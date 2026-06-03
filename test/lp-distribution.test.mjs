import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey } from '@solana/web3.js';

import { normalizeDistribution } from '../lpDistribution.js';

// Deterministic valid key for recipient tests
const VALID_KEY = 'DRpbCBMxVnDK7maPMoGQFix5grYex3WcBL5NerXWkJBi';

test('null/undefined → single 100% slice', () => {
  assert.deepEqual(normalizeDistribution(null), [{ sharePercent: 100 }]);
  assert.deepEqual(normalizeDistribution(undefined), [{ sharePercent: 100 }]);
  assert.deepEqual(normalizeDistribution([]), [{ sharePercent: 100 }]);
});

test('single slice with no recipient → normalized', () => {
  assert.deepEqual(
    normalizeDistribution([{ sharePercent: 100 }]),
    [{ sharePercent: 100, recipient: null }],
  );
});

test('two slices that sum to 100', () => {
  assert.deepEqual(
    normalizeDistribution([
      { sharePercent: 60 },
      { sharePercent: 40 },
    ]),
    [
      { sharePercent: 60, recipient: null },
      { sharePercent: 40, recipient: null },
    ],
  );
});

test('three unequal slices that sum to 100', () => {
  const result = normalizeDistribution([
    { sharePercent: 50 },
    { sharePercent: 30 },
    { sharePercent: 20 },
  ]);
  assert.equal(result.length, 3);
  assert.equal(result.reduce((a, s) => a + s.sharePercent, 0), 100);
});

test('tolerates floating-point drift within 0.01', () => {
  // 33.33 + 33.33 + 33.34 = 100.00 — should pass
  assert.doesNotThrow(() =>
    normalizeDistribution([
      { sharePercent: 33.33 },
      { sharePercent: 33.33 },
      { sharePercent: 33.34 },
    ]),
  );

  // 33.333 + 33.333 + 33.334 = 100.000 — still within tolerance
  assert.doesNotThrow(() =>
    normalizeDistribution([
      { sharePercent: 100 / 3 },
      { sharePercent: 100 / 3 },
      { sharePercent: 100 / 3 },
    ]),
  );
});

test('rejects shares that do not sum to 100', () => {
  assert.throws(
    () => normalizeDistribution([{ sharePercent: 50 }, { sharePercent: 40 }]),
    { message: /sum to 90%.*must sum to 100%/ },
  );

  assert.throws(
    () => normalizeDistribution([{ sharePercent: 60 }, { sharePercent: 50 }]),
    { message: /sum to 110%.*must sum to 100%/ },
  );

  // Just outside the 0.01 tolerance
  assert.throws(
    () => normalizeDistribution([{ sharePercent: 99.98 }]),
    { message: /sum to 99\.98%.*must sum to 100%/ },
  );
});

test('rejects zero or negative shares', () => {
  assert.throws(
    () => normalizeDistribution([{ sharePercent: 0 }, { sharePercent: 100 }]),
    { message: /must be > 0%/ },
  );

  assert.throws(
    () => normalizeDistribution([{ sharePercent: -10 }, { sharePercent: 110 }]),
    { message: /must be > 0%/ },
  );
});

test('accepts valid recipient addresses', () => {
  const result = normalizeDistribution([
    { sharePercent: 50, recipient: VALID_KEY },
    { sharePercent: 50 },
  ]);
  assert.equal(result[0].recipient, VALID_KEY);
  assert.equal(result[1].recipient, null);
});

test('rejects invalid recipient addresses', () => {
  assert.throws(
    () => normalizeDistribution([{ sharePercent: 100, recipient: 'not-a-key' }]),
    { message: /Invalid recipient address: not-a-key/ },
  );

  // Empty string is falsy, treated as no recipient — not an error

  // Characters outside base58 alphabet
  assert.throws(
    () => normalizeDistribution([{ sharePercent: 100, recipient: '0OIl' }]),
    { message: /Invalid recipient address/ },
  );
});

test('converts sharePercent strings to numbers', () => {
  const result = normalizeDistribution([
    { sharePercent: '60' },
    { sharePercent: '40' },
  ]);
  assert.equal(typeof result[0].sharePercent, 'number');
  assert.equal(result[0].sharePercent, 60);
  assert.equal(result[1].sharePercent, 40);
});

test('null recipient → null (not string "null")', () => {
  const result = normalizeDistribution([{ sharePercent: 100, recipient: null }]);
  assert.equal(result[0].recipient, null);
});
