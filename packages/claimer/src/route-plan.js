// Route allocation: how a successful claim's proceeds are split across the
// schedule's outputs. Pure — no chain, no SDK. The signer enforces the
// returned ceilings, never the display.

import { FEE_ROUTING_OUTPUTS } from '@trebuchet/core/flywheel-schedule';

/**
 * Allocate `proceedsLamports` across outputs per their percentages, bounded
 * by the per-crank spend ceiling already computed by decideCrank.
 *
 * input: {
 *   proceedsLamports,          // what the claim landed (lamports, quote side)
 *   outputs,                   // normalized schedule outputs [{ type, pct, wallet }]
 *   spendCeilingLamports,      // decideCrank()'s ceiling, MINUS swap fees if known
 *   slippageBps = 100,
 *   holdersRowCount = 0        // snapshot size for the holders output summary
 * }
 *
 * Returns { rows: [{ type, lamports, wallet?, rowCount? }], routedLamports,
 *          retainedLamports } where retained is what stays in the vault
 * because the ceiling would have been exceeded (a crank never spends more
 * than the ceiling).
 */
export function allocateRoute({ proceedsLamports = 0, outputs = [], spendCeilingLamports = 0, slippageBps = 100, holdersRowCount = 0 } = {}) {
  const proceeds = Math.max(0, Math.floor(Number(proceedsLamports) || 0));
  const ceiling = Math.max(0, Math.floor(Number(spendCeilingLamports) || 0));
  const totalPct = outputs.reduce((sum, output) => sum + (Number(output.pct) || 0), 0);
  if (!outputs.length || Math.abs(totalPct - 100) > 0.1) {
    throw new Error('Route allocation needs outputs summing to 100');
  }

  const rows = [];
  let routedLamports = 0;
  for (const output of outputs) {
    const type = String(output.type || '').trim();
    if (!FEE_ROUTING_OUTPUTS.has(type)) throw new Error(`Unknown fee-routing output type: ${type}`);
    const share = Math.floor((proceeds * (Number(output.pct) || 0)) / 100);
    const allowed = Math.max(0, ceiling - routedLamports);
    const lamports = Math.min(share, allowed);
    routedLamports += lamports;
    rows.push({
      type,
      lamports,
      ...(type === 'transfer' ? { wallet: String(output.wallet || '').trim() || null } : {}),
      ...(type === 'holders' ? { rowCount: Math.max(0, Math.floor(Number(holdersRowCount) || 0)) } : {}),
      ...(type === 'buyback-burn' ? { slippageBps: Math.max(0, Math.floor(Number(slippageBps) || 0)) } : {}),
    });
  }
  return {
    rows,
    routedLamports,
    retainedLamports: Math.max(0, proceeds - routedLamports),
  };
}

/**
 * The buyback's max swap input after fees: route.buyback-burn row, less the
 * swap fee the venue will take (approximated at `swapFeeBps`). A negative or
 * tiny remainder zeroes out rather than sending a dust swap.
 */
export function buybackNotional({ lamports = 0, swapFeeBps = 25, minLamports = 1000 } = {}) {
  const gross = Math.max(0, Math.floor(Number(lamports) || 0));
  const feeBps = Math.max(0, Math.floor(Number(swapFeeBps) || 0));
  const net = Math.floor((gross * (10000 - feeBps)) / 10000);
  return { gross, net, swap: net >= Number(minLamports) ? net : 0 };
}