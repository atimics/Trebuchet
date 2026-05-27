// Pure CLMM geometry helpers. Kept separate from lpService.js so unit tests
// can exercise launch-range math without importing Raydium SDK dependencies.

export const MIN_TICK = -443636;
export const MAX_TICK = 443636;
export const MINIMAL_BOOTSTRAP_WIDTH_PCT = 30;

export function floorToSpacing(tick, tickSpacing) {
  return Math.floor(tick / tickSpacing) * tickSpacing;
}

export function ceilToSpacing(tick, tickSpacing) {
  return Math.ceil(tick / tickSpacing) * tickSpacing;
}

/**
 * Compute the main position's tick range, asymmetric based on which side the
 * launched token sorted to. The position starts 100% launched-token.
 */
export function computeMainTicks({ currentTick, tickSpacing, launchedIsMintA }) {
  const maxAligned = floorToSpacing(MAX_TICK, tickSpacing);
  const minAligned = ceilToSpacing(MIN_TICK, tickSpacing);

  if (launchedIsMintA) {
    return {
      tickLower: ceilToSpacing(currentTick + 1, tickSpacing),
      tickUpper: maxAligned,
    };
  }

  return {
    tickLower: minAligned,
    tickUpper: floorToSpacing(currentTick - 1, tickSpacing),
  };
}

/**
 * Minimal bootstrap: fixed percentage-width band around currentTick.
 * Custom bootstrap: full valid tick range.
 */
export function computeBootstrapTicks({ currentTick, tickSpacing, mode }) {
  if (mode === 'custom') {
    return {
      tickLower: ceilToSpacing(MIN_TICK, tickSpacing),
      tickUpper: floorToSpacing(MAX_TICK, tickSpacing),
    };
  }

  const halfWidthFactor = 1 + MINIMAL_BOOTSTRAP_WIDTH_PCT / 200;
  const idealTicks = Math.log(halfWidthFactor) / Math.log(1.0001);
  const ticksEachSide = Math.ceil(idealTicks / tickSpacing) * tickSpacing;
  const center = floorToSpacing(currentTick, tickSpacing);
  return {
    tickLower: center - ticksEachSide,
    tickUpper: center + ticksEachSide,
  };
}

/**
 * Compute evenly spaced ladder bands up to ceilingMultiplier times launch
 * price. For mintB launches, the bands mirror below currentTick.
 */
export function computeLadderTicks({
  currentTick,
  tickSpacing,
  bandCount,
  ceilingMultiplier,
  launchedIsMintA,
}) {
  const totalLogSpan = Math.log(ceilingMultiplier);
  const perUnitLog = totalLogSpan / (2 * bandCount - 1);
  const logBase = Math.log(1.0001);
  const perUnitTicks = perUnitLog / logBase;

  const minAlignedLower = ceilToSpacing(MIN_TICK, tickSpacing);
  const maxAlignedUpper = floorToSpacing(MAX_TICK, tickSpacing);

  const bands = [];
  for (let i = 0; i < bandCount; i++) {
    const idealLowerOffset = 2 * i * perUnitTicks;
    const idealUpperOffset = (2 * i + 1) * perUnitTicks;

    let tickLower;
    let tickUpper;
    if (launchedIsMintA) {
      const launchTick = currentTick + tickSpacing;
      tickLower = Math.min(
        ceilToSpacing(launchTick + idealLowerOffset, tickSpacing),
        maxAlignedUpper - tickSpacing,
      );
      tickUpper = Math.min(
        floorToSpacing(launchTick + idealUpperOffset, tickSpacing),
        maxAlignedUpper,
      );
    } else {
      const launchTick = currentTick - tickSpacing;
      tickUpper = Math.max(
        floorToSpacing(launchTick - idealLowerOffset, tickSpacing),
        minAlignedLower + tickSpacing,
      );
      tickLower = Math.max(
        ceilToSpacing(launchTick - idealUpperOffset, tickSpacing),
        minAlignedLower,
      );
    }

    const finalUpper = tickUpper > tickLower ? tickUpper : tickLower + tickSpacing;
    bands.push({ tickLower, tickUpper: finalUpper });
  }
  return bands;
}

/**
 * Compute tick ranges for explicit manual ladder bands. Multipliers are
 * relative to launch price and mirror below currentTick for mintB launches.
 */
export function computeLadderTicksManual({
  currentTick,
  tickSpacing,
  bands,
  launchedIsMintA,
}) {
  const logBase = Math.log(1.0001);
  const minAlignedLower = ceilToSpacing(MIN_TICK, tickSpacing);
  const maxAlignedUpper = floorToSpacing(MAX_TICK, tickSpacing);
  const result = [];

  for (const b of bands) {
    const lowerLogOffset = Math.log(Number(b.lowerMultiplier)) / logBase;
    const upperLogOffset = Math.log(Number(b.upperMultiplier)) / logBase;
    let tickLower;
    let tickUpper;

    if (launchedIsMintA) {
      const launchTick = currentTick + tickSpacing;
      tickLower = Math.min(
        ceilToSpacing(launchTick + lowerLogOffset, tickSpacing),
        maxAlignedUpper - tickSpacing,
      );
      tickUpper = Math.min(
        floorToSpacing(launchTick + upperLogOffset, tickSpacing),
        maxAlignedUpper,
      );
    } else {
      const launchTick = currentTick - tickSpacing;
      tickUpper = Math.max(
        floorToSpacing(launchTick - lowerLogOffset, tickSpacing),
        minAlignedLower + tickSpacing,
      );
      tickLower = Math.max(
        ceilToSpacing(launchTick - upperLogOffset, tickSpacing),
        minAlignedLower,
      );
    }

    const finalUpper = tickUpper > tickLower ? tickUpper : tickLower + tickSpacing;
    result.push({ tickLower, tickUpper: finalUpper });
  }

  return result;
}
