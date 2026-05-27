import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ceilToSpacing,
  computeBootstrapTicks,
  computeLadderTicks,
  computeLadderTicksManual,
  computeMainTicks,
  floorToSpacing,
  MAX_TICK,
  MIN_TICK,
} from '../lpMath.js';

test('snaps ticks to Raydium spacing in both directions', () => {
  assert.equal(floorToSpacing(121, 120), 120);
  assert.equal(ceilToSpacing(121, 120), 240);
  assert.equal(floorToSpacing(-121, 120), -240);
  assert.equal(ceilToSpacing(-121, 120), -120);
});

test('main position starts single-sided on either mint ordering', () => {
  assert.deepEqual(
    computeMainTicks({ currentTick: 0, tickSpacing: 120, launchedIsMintA: true }),
    { tickLower: 120, tickUpper: 443520 },
  );

  assert.deepEqual(
    computeMainTicks({ currentTick: 0, tickSpacing: 120, launchedIsMintA: false }),
    { tickLower: -443520, tickUpper: -120 },
  );
});

test('minimal bootstrap keeps a consistent percentage width after snapping', () => {
  assert.deepEqual(
    computeBootstrapTicks({ currentTick: 123, tickSpacing: 120, mode: 'minimal' }),
    { tickLower: -1320, tickUpper: 1560 },
  );
});

test('custom bootstrap uses the full aligned Raydium tick range', () => {
  assert.deepEqual(
    computeBootstrapTicks({ currentTick: 123, tickSpacing: 120, mode: 'custom' }),
    {
      tickLower: ceilToSpacing(MIN_TICK, 120),
      tickUpper: floorToSpacing(MAX_TICK, 120),
    },
  );
});

test('simple ladder bands extend above launch price for mintA', () => {
  const bands = computeLadderTicks({
    currentTick: 0,
    tickSpacing: 120,
    bandCount: 3,
    ceilingMultiplier: 10,
    launchedIsMintA: true,
  });

  assert.equal(bands.length, 3);
  for (const band of bands) {
    assert.equal(Math.abs(band.tickLower % 120), 0);
    assert.equal(Math.abs(band.tickUpper % 120), 0);
    assert.ok(band.tickLower > 0);
    assert.ok(band.tickUpper > band.tickLower);
  }
  assert.ok(bands[1].tickLower > bands[0].tickUpper);
  assert.ok(bands[2].tickLower > bands[1].tickUpper);
});

test('simple ladder bands mirror below launch price for mintB', () => {
  const bands = computeLadderTicks({
    currentTick: 0,
    tickSpacing: 120,
    bandCount: 3,
    ceilingMultiplier: 10,
    launchedIsMintA: false,
  });

  assert.equal(bands.length, 3);
  for (const band of bands) {
    assert.equal(Math.abs(band.tickLower % 120), 0);
    assert.equal(Math.abs(band.tickUpper % 120), 0);
    assert.ok(band.tickUpper < 0);
    assert.ok(band.tickUpper > band.tickLower);
  }
  assert.ok(bands[1].tickUpper < bands[0].tickLower);
  assert.ok(bands[2].tickUpper < bands[1].tickLower);
});

test('manual ladder uses explicit multipliers and mirrors direction', () => {
  const inputBands = [
    { lowerMultiplier: 1, upperMultiplier: 2 },
    { lowerMultiplier: 3, upperMultiplier: 5 },
  ];

  const mintA = computeLadderTicksManual({
    currentTick: 0,
    tickSpacing: 120,
    bands: inputBands,
    launchedIsMintA: true,
  });
  const mintB = computeLadderTicksManual({
    currentTick: 0,
    tickSpacing: 120,
    bands: inputBands,
    launchedIsMintA: false,
  });

  assert.equal(mintA[0].tickLower, 120);
  assert.ok(mintA[0].tickUpper > mintA[0].tickLower);
  assert.ok(mintA[1].tickLower > mintA[0].tickUpper);

  assert.equal(mintB[0].tickUpper, -120);
  assert.ok(mintB[0].tickUpper > mintB[0].tickLower);
  assert.ok(mintB[1].tickUpper < mintB[0].tickLower);
});
