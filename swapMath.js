import BN from 'bn.js';
import Decimal from 'decimal.js';

export const LAMPORTS_PER_SOL_DECIMAL = 1_000_000_000;
export const SWAP_MIN_SPEND_LAMPORTS = new BN(50_000);
export const SWAP_DEFAULT_MAX_SPEND_LAMPORTS = new BN(0.05 * LAMPORTS_PER_SOL_DECIMAL);
export const SWAP_TX_FEE_HEADROOM_LAMPORTS = new BN(0.005 * LAMPORTS_PER_SOL_DECIMAL);

/**
 * Classify a thrown swap error into one of:
 *   balance   - wallet does not have enough SOL; do not retry
 *   no_route  - Trade API cannot route this pair; do not retry
 *   transient - retryable HTTP/RPC/slippage issue
 *   unknown   - retry with bounded budget
 */
export function classifySwapError(err) {
  const msg = String(err?.message || err || '').toLowerCase();

  if (
    msg.includes('insufficient lamports') ||
    msg.includes('insufficient funds') ||
    msg.includes('insufficient balance') ||
    msg.includes('account does not have enough') ||
    msg.includes('debit an account but found no record')
  ) {
    return 'balance';
  }

  if (
    msg.includes('no route') ||
    msg.includes('cannot find route') ||
    msg.includes('route not found') ||
    msg.includes('no liquidity')
  ) {
    return 'no_route';
  }

  if (
    msg.includes('slippage') ||
    msg.includes('exceeds maximum') ||
    msg.includes('amount out below minimum') ||
    msg.includes('min amount out') ||
    msg.includes('priceslippageexceed')
  ) {
    return 'transient';
  }

  if (
    msg.includes('blockhash') ||
    msg.includes('timeout') ||
    msg.includes('timed out') ||
    msg.includes('aborted') ||
    msg.includes('network') ||
    msg.includes('429') ||
    msg.includes('rate limit') ||
    msg.includes('too many requests') ||
    msg.includes('connection') ||
    msg.includes('econn') ||
    msg.includes('socket') ||
    msg.includes('fetch failed') ||
    msg.includes('was not confirmed') ||
    msg.includes('node behind') ||
    msg.includes('http 5') ||
    msg.includes('http 502') ||
    msg.includes('http 503') ||
    msg.includes('http 504')
  ) {
    return 'transient';
  }

  return 'unknown';
}

export function computeSwapSpendLamports({
  targetRaw,
  initialQuoteRaw,
  quoteDecimals,
  quoteUsd,
  solUsd,
  sizingMultiplier = 2,
  maxSpendLamports,
}) {
  const target = new BN(String(targetRaw));
  const initial = new BN(String(initialQuoteRaw));
  const missingRaw = target.sub(initial);
  const missingWhole = new Decimal(missingRaw.toString()).div(
    new Decimal(10).pow(quoteDecimals),
  );
  const missingUsd = missingWhole.mul(quoteUsd);
  const solNeeded = missingUsd.div(solUsd).mul(sizingMultiplier);
  const uncappedLamports = new BN(solNeeded.mul(LAMPORTS_PER_SOL_DECIMAL).toFixed(0));
  const effectiveMaxSpend = maxSpendLamports != null
    ? new BN(String(maxSpendLamports))
    : SWAP_DEFAULT_MAX_SPEND_LAMPORTS;
  const spendLamports = BN.max(
    BN.min(uncappedLamports, effectiveMaxSpend),
    SWAP_MIN_SPEND_LAMPORTS,
  );

  return {
    missingRaw,
    missingWhole,
    uncappedLamports,
    spendLamports,
    requiredLamports: spendLamports.add(SWAP_TX_FEE_HEADROOM_LAMPORTS),
    txFeeHeadroomLamports: SWAP_TX_FEE_HEADROOM_LAMPORTS,
  };
}
