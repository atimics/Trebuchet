// Pure Uniswap-v3-style fee-growth math for Raydium CLMM positions.
//
// A CLMM position earns fees as the pool's feeGrowthGlobalX64 (per side)
// advances while the price is inside the position's band. The claimed-but-
// unpaid amount is liquidity * (feeGrowthInside - feeGrowthInsideLast) / 2^64.
//
// THIS MODULE IS DELIBERATELY BRACKETED: it produces an exact estimate only
// while the position is in range, because computing feeGrowthOutside at the
// band edges (the general case) needs the pool's tick arrays. An out-of-range
// position cannot be estimated here — it returns inRange:false and null
// amounts, and callers must say exactly that (the position may still hold
// unclaimed fees from before it left the band). The claim transaction itself
// is the authoritative balance, read after the receipt lands.

export function positionInRange({ tickCurrent, tickLower, tickUpper }) {
  return Number(tickCurrent) >= Number(tickLower) && Number(tickCurrent) < Number(tickUpper);
}

/**
 * Accrued-but-unclaimed raw amount for one side of an in-range position.
 * `liquidityWei` and the growth deltas are BigInts (u128 / u64 fields).
 * Returns a BigInt, or null when the pool growth is behind the position's
 * snapshot (should not happen; treated as unknown, never negative).
 */
export function unclaimedClmmInRange({ liquidityWei, feeGrowthGlobalX64, feeGrowthInsideLastX64 }) {
  const global = BigInt(feeGrowthGlobalX64);
  const last = BigInt(feeGrowthInsideLastX64);
  const liquidity = BigInt(liquidityWei);
  if (global < last) return null;
  const delta = global - last;
  return (liquidity * delta) >> 64n;
}

/**
 * Per-side estimate for one position in one pool.
 *
 * position: { liquidity, tickLower, tickUpper, feeGrowthInside0LastX64, feeGrowthInside1LastX64 }
 * pool:     { tickCurrent, feeGrowthGlobal0X64, feeGrowthGlobal1X64 }
 *
 * Returns { inRange, unclaimedA, unclaimedB, reason? }. Out-of-range
 * positions report null amounts with a reason; callers must label the row
 * "out of range" rather than inventing a number.
 */
export function clmmUnclaimed({ position, pool }) {
  const inRange = positionInRange({
    tickCurrent: pool.tickCurrent,
    tickLower: position.tickLower,
    tickUpper: position.tickUpper,
  });
  if (!inRange) {
    return {
      inRange: false,
      unclaimedA: null,
      unclaimedB: null,
      reason: 'position is out of range; fees accrue only when the price re-enters this band',
    };
  }
  return {
    inRange: true,
    unclaimedA: unclaimedClmmInRange({
      liquidityWei: position.liquidity,
      feeGrowthGlobalX64: pool.feeGrowthGlobal0X64,
      feeGrowthInsideLastX64: position.feeGrowthInside0LastX64,
    }),
    unclaimedB: unclaimedClmmInRange({
      liquidityWei: position.liquidity,
      feeGrowthGlobalX64: pool.feeGrowthGlobal1X64,
      feeGrowthInsideLastX64: position.feeGrowthInside1LastX64,
    }),
    reason: null,
  };
}