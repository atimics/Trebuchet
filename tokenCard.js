// A coin's basic market facts for the token card: its price, and how its liquidity splits across
// its pools. Built from the market rows the coin page already reads; nothing here reads the chain.

// A pool's size in SOL: its quote side valued in SOL plus its coin side at the pool's own price.
function poolValueSol(pool, fallbackPriceSol) {
  const quoteSol = pool.isSolPool ? Number(pool.quoteReserve) : Number(pool.quoteReserveSol);
  const priceSol = Number(pool.priceSol) > 0 ? Number(pool.priceSol) : fallbackPriceSol;
  const coinSol = Number(pool.tokenReserve) > 0 && priceSol > 0 ? Number(pool.tokenReserve) * priceSol : 0;
  const value = (Number.isFinite(quoteSol) && quoteSol > 0 ? quoteSol : 0) + coinSol;
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function tokenCardFromMarkets(markets, { solUsd = null } = {}) {
  const pools = Array.isArray(markets?.pools) ? markets.pools : [];
  const main = pools.find((pool) => pool.isMainSolPool && Number(pool.priceSol) > 0)
    || pools.filter((pool) => Number(pool.priceSol) > 0).sort((a, b) => poolValueSol(b, 0) - poolValueSol(a, 0))[0]
    || null;
  const priceSol = main ? Number(main.priceSol) : null;
  const rows = pools.map((pool) => ({
    poolId: pool.poolId,
    quoteSymbol: pool.quoteSymbol || null,
    quoteMint: pool.quoteMint || null,
    venue: pool.venue || null,
    isMainSolPool: Boolean(pool.isMainSolPool),
    valueSol: poolValueSol(pool, priceSol),
  })).sort((a, b) => b.valueSol - a.valueSol);
  const liquiditySol = rows.reduce((sum, row) => sum + row.valueSol, 0);
  const sol = Number(solUsd) > 0 ? Number(solUsd) : null;
  return {
    mint: markets?.mint || null,
    priceSol,
    priceUsd: priceSol !== null && sol ? priceSol * sol : null,
    solUsd: sol,
    liquiditySol,
    liquidityUsd: sol ? liquiditySol * sol : null,
    pools: rows.map((row) => ({ ...row, share: liquiditySol > 0 ? row.valueSol / liquiditySol : 0 })),
  };
}
