# Launch presets

Four starting presets, each a bigger network than the last: **Spark → Anchor → Constellation → Vortex**. They are starting points, not return-optimised strategies. Source: `public/v2/features/launch/presets.js`.

**Budgets are capital deposited into liquidity, excluding setup.** 0 SOL means no initial SOL support, not a free deployment: pool creation, account rent, transactions and locking still need funding. NEW is your token; M1 to M4 are partner tokens (the first hub tokens, which you can swap on the Pairs page). Percentages of NEW are of the supply the pools may use (everything not held back for the team or an airdrop).

| Preset | Budget | Markets | Quote | Positions |
|---|---:|---|---|---:|
| Spark | 0 SOL | NEW/SOL | none | 1 |
| Anchor | 1 SOL | NEW/SOL | 1 SOL | 4 |
| Constellation | 10 SOL | NEW/SOL, NEW/M1, NEW/M2 | 8 SOL + 1 SOL of each partner | 18 |
| Vortex | 100 SOL | NEW/SOL + four partners | 80 SOL + 5 SOL of each partner | 40 |

Positions are the main position, each NEW-side band and each quote-side layer, per market. The small bootstrap position that opens trading is not counted.

Every market uses the 0.25% fee tier and opens at the same price (no start premium), so the markets agree at the start; only the ranges are staggered. The recipes for a market:

- **Anchor**: main 40% over 1x to 1,000x; bands 40% at 1x-3x and 20% at 2x-10x; one bid layer, all of the SOL, 0.4x-1x.
- **Constellation** (each market): main 30%; bands 35% 1x-3x, 25% 2x-10x, 10% 8x-40x; bids 70% at 0.7x-1x and 30% at 0.25x-0.7x.
- **Vortex** (each market): main 20%; bands 30% 1x-2x, 25% 1.5x-5x, 15% 4x-20x, 10% 15x-100x; bids 50% at 0.8x-1x, 30% at 0.5x-0.8x, 20% at 0.2x-0.5x.

## Support layers

Support used to be one quote-side range, `depthPct` below the start price. It can now be layers: `support.layers = [{ sharePercent, lowerMultiplier, upperMultiplier }]`, up to 6, each a share of the quote over a range of start-price multiples (at most 1x). Shares add up to 100%. Each layer opens its own position, with its own journal key (`position/<pool>/support/<n>`), lock and recovery. Without layers nothing changes.

In the editor a pool's **Support layers** field takes one layer per line (`share %, low×, high×`), the same style as the custom ladder. In the CSV pool config a layer is a `bid,share,low,high` line under its pool.

## Read this before launching one

- **Support is inventory, not a floor.** Bids can run out of quote. Locking a position prevents withdrawing or moving it; it does not keep its SOL balance or guarantee continuous fees. Positions outside the current price earn no swap fees until price returns.
- **Partner markets need real routes.** Check that M1/SOL and the others have usable external pools before trusting the connections; aggregator routing depends on what it finds and quotes.
- **Simulate before locking.** Ranges snap to the pool's tick spacing. Test a first buy, a following sell and trades across every range boundary before you lock.
