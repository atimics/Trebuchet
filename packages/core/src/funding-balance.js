// Exact token requirements shared by the funding screen and launch checks.
const raw = (value) => /^\d+$/.test(String(value ?? '')) ? BigInt(value) : 0n;
export function formatFundingTokenAmount(value, decimals) {
  const amount = raw(value);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 19) return `${amount} raw units`;
  const text = amount.toString().padStart(decimals + 1, '0');
  if (!decimals) return text;
  const fraction = text.slice(-decimals).replace(/0+$/, '');
  return text.slice(0, -decimals) + (fraction ? `.${fraction}` : '');
}

export function fundingTokenCoverage(estimate = {}, walletBalance = null) {
  const rows = new Map();
  const manual = estimate.byQuote || {};
  const routes = Array.isArray(estimate.autoSwapPlan) ? estimate.autoSwapPlan : [];
  const get = (mint) => {
    if (!rows.has(mint)) {
      const detail = (estimate.quoteBreakdown || []).find((item) => item.mint === mint);
      const route = routes.find((item) => item.quoteMint === mint);
      const token = walletBalance?.tokens?.[mint];
      rows.set(mint, { mint, symbol: detail?.symbol || route?.quoteSymbol || mint.slice(0, 8),
        decimals: detail?.decimals ?? route?.quoteDecimals ?? token?.decimals,
        required: 0n, held: raw(token?.amountRaw), manual: raw(manual[mint]) });
    }
    return rows.get(mint);
  };
  for (const [mint, amount] of Object.entries(manual)) get(mint).required += raw(amount);
  for (const route of routes) get(route.quoteMint).required += raw(route.minRaw || route.targetRaw);
  let swapCreditSol = 0;
  const available = new Map();
  for (const route of routes) {
    const row = get(route.quoteMint);
    const held = available.get(row.mint) ?? (row.held > row.manual ? row.held - row.manual : 0n);
    const minimum = raw(route.minRaw || route.targetRaw);
    const target = raw(route.targetRaw);
    const used = held < minimum ? held : minimum;
    available.set(row.mint, held - used);
    // The buyer sizes a partial purchase against the buffered target.
    const fraction = minimum > 0n && used >= minimum ? 1 : target > 0n ? Number(used) / Number(target) : 0;
    const spend = Number(route.estSolSpend);
    if (Number.isFinite(spend) && spend > 0) swapCreditSol += spend * fraction;
  }
  return { swapCreditSol, rows: [...rows.values()].map((row) => {
    const missing = row.required > row.held ? row.required - row.held : 0n;
    return { mint: row.mint, symbol: row.symbol, decimals: row.decimals,
      requiredRaw: String(row.required), heldRaw: String(row.held), missingRaw: String(missing),
      required: formatFundingTokenAmount(row.required, row.decimals),
      held: formatFundingTokenAmount(row.held, row.decimals),
      missing: formatFundingTokenAmount(missing, row.decimals), funded: missing === 0n };
  }) };
}
