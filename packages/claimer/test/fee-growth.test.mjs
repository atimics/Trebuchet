import test from 'node:test';
import assert from 'node:assert/strict';

import { positionInRange, unclaimedClmmInRange, clmmUnclaimed } from '../src/fee-growth.js';

test('positionInRange: in-range is tickLower <= current < tickUpper', () => {
  assert.equal(positionInRange({ tickCurrent: 100, tickLower: 0, tickUpper: 200 }), true);
  assert.equal(positionInRange({ tickCurrent: 0, tickLower: 0, tickUpper: 200 }), true);
  assert.equal(positionInRange({ tickCurrent: 200, tickLower: 0, tickUpper: 200 }), false);
  assert.equal(positionInRange({ tickCurrent: -150, tickLower: -100, tickUpper: 0 }), false, 'current below lower bound');
});

test('unclaimedClmmInRange: liquidity * growth-delta / 2^64, floored', () => {
  // 1 liquidity unit, 2^64 growth delta => exactly 1 raw unit accrued.
  assert.equal(unclaimedClmmInRange({ liquidityWei: 1n, feeGrowthGlobalX64: 1n << 64n, feeGrowthInsideLastX64: 0n }), 1n);
  // Half the delta => floor(0.5) = 0 whole units.
  assert.equal(unclaimedClmmInRange({ liquidityWei: 1n, feeGrowthGlobalX64: 1n << 63n, feeGrowthInsideLastX64: 0n }), 0n);
  // Large liquidity, small delta.
  assert.equal(unclaimedClmmInRange({ liquidityWei: 1n << 100n, feeGrowthGlobalX64: 2n, feeGrowthInsideLastX64: 1n }), 1n << 36n);
});

test('unclaimedClmmInRange: pool growth behind the snapshot is unknown, never negative', () => {
  assert.equal(unclaimedClmmInRange({ liquidityWei: 1n, feeGrowthGlobalX64: 1n, feeGrowthInsideLastX64: 5n }), null);
});

test('clmmUnclaimed: in-range position yields per-side estimates', () => {
  const result = clmmUnclaimed({
    position: {
      liquidity: 1n << 100n,
      tickLower: -100,
      tickUpper: 100,
      feeGrowthInside0LastX64: 0n,
      feeGrowthInside1LastX64: 1n,
    },
    pool: {
      tickCurrent: 0,
      feeGrowthGlobal0X64: 2n,
      feeGrowthGlobal1X64: (1n << 64n) + 1n,
    },
  });
  assert.equal(result.inRange, true);
  assert.equal(result.unclaimedA, 1n << 37n);
  assert.equal(result.unclaimedB, 1n << 100n);
});

test('clmmUnclaimed: out-of-range position reports null amounts and a reason', () => {
  const result = clmmUnclaimed({
    position: { liquidity: 1n << 100n, tickLower: 500, tickUpper: 700, feeGrowthInside0LastX64: 0n, feeGrowthInside1LastX64: 0n },
    pool: { tickCurrent: 0, feeGrowthGlobal0X64: 1n << 64n, feeGrowthGlobal1X64: 0n },
  });
  assert.equal(result.inRange, false);
  assert.equal(result.unclaimedA, null);
  assert.equal(result.unclaimedB, null);
  assert.match(result.reason, /out of range/);
});