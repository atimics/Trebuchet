import test from 'node:test';
import assert from 'node:assert/strict';
import * as constants from '../packages/core/src/lp-constants.js';

test('rent constants follow the rent rate the chain reports', () => {
  try {
    constants.setRentLamportsPerByte(5080);
    assert.ok(Math.abs(constants.COST_TICK_ARRAY_SOL - 0.0722 * 5080 / 6960) < 1e-9);
    assert.ok(constants.COST_TICK_ARRAY_SOL < 0.0722);
    assert.ok(constants.COST_POOL_RENT_SOL < 0.062);
    // Junk rates change nothing.
    constants.setRentLamportsPerByte('nope');
    constants.setRentLamportsPerByte(0);
    assert.equal(constants.rentLamportsPerByte, 5080);
  } finally {
    constants.setRentLamportsPerByte(constants.RENT_BASELINE_LAMPORTS_PER_BYTE);
  }
  assert.equal(constants.COST_TICK_ARRAY_SOL, 0.0722);
});
