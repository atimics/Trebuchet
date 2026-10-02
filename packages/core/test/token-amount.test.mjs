import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTokenAmountRaw, formatTokenAmountRaw } from '../src/validators.js';

for (const [value, decimals, raw] of [['0.1', 9, '100000000'], ['0.000001', 6, '1'], ['1e-9', 9, '1'],
  ['2.500000', 6, '2500000'], ['1.20e2', 0, '120'], ['18446744073709551615', 0, '18446744073709551615'],
  ['18446744073.709551615', 9, '18446744073709551615'], ['1e-255', 255, '1']]) {
  test(`token amount ${value} at ${decimals} decimals uses exact integer units`, () => {
    assert.equal(normalizeTokenAmountRaw(value, decimals), raw);
    assert.equal(normalizeTokenAmountRaw(formatTokenAmountRaw(raw, decimals), decimals), raw);
  });
}

test('ambiguous, zero, overflowing, and excessive-precision token amounts stop before conversion', () => {
  for (const [value, decimals] of [['0', 9], ['-1', 9], ['Infinity', 9], ['NaN', 9], ['0.0000000001', 9],
    ['18446744073709551616', 0], [9007199254740992, 0], ['1e9999999', 9], ['1', 256], ['1', -1], ['0.30000000000000004', 9]]) {
    assert.throws(() => normalizeTokenAmountRaw(value, decimals), String(value));
  }
});


test('numeric UI amounts round once to the nearest mint unit before approval', () => {
  assert.equal(normalizeTokenAmountRaw(0.1 + 0.2, 9), '300000000');
  assert.equal(normalizeTokenAmountRaw(0.0000000005, 9), '1');
  assert.equal(normalizeTokenAmountRaw(0.15, 1), '2');
  assert.throws(() => normalizeTokenAmountRaw(0.0000000004, 9));
});
