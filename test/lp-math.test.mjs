import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ceilToSpacing,
  computeBootstrapTicks,
  computeLadderTicks,
  computeLadderTicksManual,
  computeMainTicks,
  computeSupportTicks,
  floorToSpacing,
  MAX_TICK,
  MIN_TICK,
  SUPPORT_DEPTH_PCT_DEFAULT,
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

// computeSupportTicks: single-sided quote position sitting just on the
// other side of currentTick, covering a configurable depth below the
// launch price (above for mintB-side launches). Behavior parallels
// computeLadderTicks but inverted in direction.

test('support range sits below currentTick when launched is mintA', () => {
  // depthPct=10, tickSpacing=120 → tickDelta ≈ 1054. Snapping puts
  // tickUpper just below current (≤ -120) and tickLower one full
  // delta below that, snapped to spacing.
  const ticks = computeSupportTicks({
    currentTick: 0,
    tickSpacing: 120,
    launchedIsMintA: true,
    depthPct: 10,
  });
  assert.ok(ticks.tickUpper < 0, 'tickUpper must be below currentTick=0');
  assert.ok(ticks.tickLower < ticks.tickUpper, 'tickLower must be below tickUpper');
  // Both ticks aligned to spacing. abs() avoids the JS -0 vs 0 quirk
  // (negative modulo produces -0 which doesn't strict-equal 0).
  assert.equal(Math.abs(ticks.tickLower % 120), 0);
  assert.equal(Math.abs(ticks.tickUpper % 120), 0);
});

test('support range sits above currentTick when launched is mintB', () => {
  const ticks = computeSupportTicks({
    currentTick: 0,
    tickSpacing: 120,
    launchedIsMintA: false,
    depthPct: 10,
  });
  assert.ok(ticks.tickLower > 0, 'tickLower must be above currentTick=0');
  assert.ok(ticks.tickUpper > ticks.tickLower, 'tickUpper must be above tickLower');
  assert.equal(Math.abs(ticks.tickLower % 120), 0);
  assert.equal(Math.abs(ticks.tickUpper % 120), 0);
});

test('support range is approximately symmetric across mint ordering', () => {
  // For currentTick=0, the two mintA/mintB cases should be mirror images:
  // mintA range is [-D, -1*spacing], mintB range is [+1*spacing, +D].
  const mintA = computeSupportTicks({
    currentTick: 0,
    tickSpacing: 120,
    launchedIsMintA: true,
    depthPct: 10,
  });
  const mintB = computeSupportTicks({
    currentTick: 0,
    tickSpacing: 120,
    launchedIsMintA: false,
    depthPct: 10,
  });
  assert.equal(-mintA.tickUpper, mintB.tickLower);
  assert.equal(-mintA.tickLower, mintB.tickUpper);
});

test('support range uses default depth when depthPct is not provided', () => {
  // Calling without depthPct should match calling with the explicit
  // default. Keeps the public API safe for callers who omit the arg.
  const withDefault = computeSupportTicks({
    currentTick: 0,
    tickSpacing: 120,
    launchedIsMintA: true,
  });
  const explicit = computeSupportTicks({
    currentTick: 0,
    tickSpacing: 120,
    launchedIsMintA: true,
    depthPct: SUPPORT_DEPTH_PCT_DEFAULT,
  });
  assert.deepEqual(withDefault, explicit);
});

test('support range expands when depthPct increases', () => {
  // Larger depth = wider range. Each output should be at least as wide
  // as the previous one (monotonic in depthPct).
  let lastWidth = 0;
  for (const depthPct of [1, 5, 10, 25, 50]) {
    const ticks = computeSupportTicks({
      currentTick: 0,
      tickSpacing: 60,
      launchedIsMintA: true,
      depthPct,
    });
    const width = ticks.tickUpper - ticks.tickLower;
    assert.ok(
      width >= lastWidth,
      `depthPct=${depthPct} width=${width} should be >= prior width ${lastWidth}`,
    );
    lastWidth = width;
  }
});

test('support range guards against degenerate widths at high tickSpacing', () => {
  // 1% fee tier has tickSpacing=200. A 1% depth (tickDelta ≈ 100) would
  // round to less than one spacing of width without the degenerate
  // guard. Verify the guard produces a position with at least one full
  // tickSpacing of width on both mint orderings.
  const mintA = computeSupportTicks({
    currentTick: 0,
    tickSpacing: 200,
    launchedIsMintA: true,
    depthPct: 1,
  });
  assert.equal(mintA.tickUpper - mintA.tickLower, 200);
  assert.ok(mintA.tickUpper < 0);

  const mintB = computeSupportTicks({
    currentTick: 0,
    tickSpacing: 200,
    launchedIsMintA: false,
    depthPct: 1,
  });
  assert.equal(mintB.tickUpper - mintB.tickLower, 200);
  assert.ok(mintB.tickLower > 0);
});

test('support range snaps to spacing on non-zero currentTick', () => {
  // currentTick that isn't a multiple of spacing — output ticks must
  // still snap to multiples of tickSpacing. This catches a class of
  // off-by-one bugs where the snapping math gets the modulo wrong on
  // negative deltas.
  const ticks = computeSupportTicks({
    currentTick: 12345,
    tickSpacing: 60,
    launchedIsMintA: true,
    depthPct: 10,
  });
  assert.equal(Math.abs(ticks.tickLower % 60), 0);
  assert.equal(Math.abs(ticks.tickUpper % 60), 0);
  // Must stay below currentTick so the position is single-sided in quote.
  assert.ok(ticks.tickUpper < 12345);
});
