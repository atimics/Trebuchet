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
  // Acquisition combines every allocation for a mint into one purchase.
  // Match that grouping when applying partial-balance credits.
  const purchases = new Map();
  for (const route of routes) {
    const purchase = purchases.get(route.quoteMint) || { minimum: 0n, target: 0n, spend: 0 };
    purchase.minimum += raw(route.minRaw || route.targetRaw);
    purchase.target += raw(route.targetRaw);
    const spend = Number(route.estSolSpend);
    if (Number.isFinite(spend) && spend > 0) purchase.spend += spend;
    purchases.set(route.quoteMint, purchase);
  }
  let swapCreditSol = 0;
  for (const [mint, purchase] of purchases) {
    const row = get(mint);
    const held = row.held > row.manual ? row.held - row.manual : 0n;
    if (purchase.minimum > 0n && held >= purchase.minimum) swapCreditSol += purchase.spend;
    else if (purchase.target > 0n) {
      const lamports = Math.floor(purchase.spend * 1e9);
      if (Number.isSafeInteger(lamports)) swapCreditSol += Number(BigInt(lamports) * held / purchase.target) / 1e9;
    }
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
