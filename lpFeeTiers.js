// lpFeeTiers.js
//
// Pure fee tier normalization logic. Extracted from lpService.js so the
// normalization and fallback logic can be tested without network access.

// Hardcoded fallback for when the Raydium API is unreachable. Keep these
// aligned with https://api-v3.raydium.io/main/clmm-config; a stale config
// index can select the wrong on-chain AmmConfig or make pool creation fail.
// All four are fixed-fee configs; a dynamic tier is never invented here.
export const FALLBACK_FEE_TIERS = [
  { index: 4, tradeFeeRate:   100, tickSpacing:   1, feeModel: 'fixed' }, // 0.01%
  { index: 5, tradeFeeRate:   500, tickSpacing:   1, feeModel: 'fixed' }, // 0.05%
  { index: 1, tradeFeeRate:  2500, tickSpacing:  60, feeModel: 'fixed' }, // 0.25%
  { index: 3, tradeFeeRate: 10000, tickSpacing: 120, feeModel: 'fixed' }, // 1%
];

/**
 * Normalize a raw fee tier list from the Raydium CLMM config API into
 * a sorted array of { index, tradeFeeRate, tickSpacing, feeModel } objects.
 *
 *   - Accepts either a bare array or { data: [...] } wrapper
 *   - Keeps dynamic-fee configs (Raydium CLMM upgrade, May 2026) but TAGS
 *     them `feeModel: 'dynamic'`; a dynamic config's tradeFeeRate is its
 *     baseline, and the pool charges more under volatility. The fee-tier
 *     picker and the funding estimate must present a dynamic tier as a
 *     base rate with a disclosure, never as a single fixed fee.
 *   - Filters out entries with non-integer index or rate
 *   - Sorts by ascending tradeFeeRate
 *   - Returns FALLBACK_FEE_TIERS if the input is empty or invalid
 */
export function normalizeFeeTierList(raw) {
  const list = Array.isArray(raw) ? raw : (raw && raw.data ? raw.data : null);
  if (!Array.isArray(list) || list.length === 0) {
    return FALLBACK_FEE_TIERS;
  }
  const normalized = list
    .map((c) => ({
      index: c.index,
      tradeFeeRate: c.tradeFeeRate,
      tickSpacing: c.tickSpacing,
      feeModel: isDynamicFeeConfig(c) ? 'dynamic' : 'fixed',
    }))
    .filter((c) => Number.isInteger(c.index) && Number.isInteger(c.tradeFeeRate));
  if (normalized.length === 0) {
    return FALLBACK_FEE_TIERS;
  }
  return normalized.sort((a, b) => a.tradeFeeRate - b.tradeFeeRate);
}

// A config is dynamic-fee when its control flag is set (non-zero / true).
// Tolerant of the field's absence and of either numeric or boolean forms,
// since the API shape may differ from the on-chain decode.
export function isDynamicFeeConfig(c) {
  if (!c || typeof c !== 'object') return false;
  const v = c.dynamicFeeControl ?? c.dynamic_fee_control ?? c.dynamicFee ?? null;
  if (v === null || v === undefined) return false;
  if (typeof v === 'boolean') return v;
  const n = Number(v);
  return Number.isFinite(n) && n !== 0;
}
