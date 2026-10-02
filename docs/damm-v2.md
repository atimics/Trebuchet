# Lean launch on Meteora DAMM v2

A cheaper way to launch. One pool holds the whole supply, locked for good. No SOL goes into the pool; buyers supply it.

Open **Lean launch** in the sidebar.

## What it does

1. Creates the token the same way every Trebuchet launch does: Token-2022, on-mint metadata, mint and freeze authority gone, metadata fixed.
2. Creates one Meteora DAMM v2 pool and puts the whole supply into a single position. The position is **locked permanently inside the pool-creation transaction**, so there is never a moment when liquidity can be withdrawn.
3. Reads the pool back and checks it: the new token is side A, SOL is side B, the position is permanently locked, nothing is withdrawable, the vault holds the supply, and fees are collected in SOL.
4. If you set a destination, sends the Fee Key (the position NFT that claims the fees) there.
5. Adds the coin to the Coins list.

## Price

The pool is single-sided. Its range starts at the **starting market cap** (default $250,000) and runs up from there to the **price range** (default x1,000). There is no SOL seed, so the starting price does not depend on how much SOL you put in.

The review shows what it takes to move the price. At a $250,000 start with a x1,000 range:

| To push the price to | Buying costs | Supply sold |
|---|---|---|
| x2 | about 890 SOL | about 30% |
| x5 | about 2,670 SOL | about 57% |
| x10 | about 4,670 SOL | about 71% |

A fresh 10 SOL buy gets about 0.5% of the supply and pays about 0.7% above the start. These are the numbers the real program produced on a local validator (`test/damm-v2-plan.test.mjs` checks the model against them).

## Cost

Measured on a local validator running the mainnet DAMM v2 program:

| | SOL |
|---|---|
| Pool, position, position NFT and vaults (rent) | 0.024645 |
| Two signatures and a priority fee | about 0.00004 |
| Sending the Fee Key to another wallet | about 0.00208 |
| Creating the token and its metadata (same on any venue) | about 0.05 |

The venue part is about **0.025 SOL**, against about 0.12 SOL for the same single-pool launch on Raydium in the app's own estimate. The review shows both.

The first fee claim from a wallet opens a token account for the pool's token (about 0.002 SOL, refundable). The launch wallet already has one.

## Fees

Trading fees (0.25% by default) are collected in SOL only. The holder of the Fee Key claims them in the view. The LP share is 80%; Meteora keeps 20%.

## Safety

- **Spend cap and price.** Launching sends the most the launch can spend and the SOL price shown in the review. The server refuses a cap below the estimate and a price that no longer matches the market.
- **Practice mode and PIN.** A lean launch needs a live network and an unlocked Recovery PIN.
- **Fee Key destination.** The same rules as the classic Fee Key send apply: no placeholder addresses, and an address you have proven unless it is the wallet that funded the launch.
- **Resumable.** Every step is saved as it finishes. The position NFT's key is saved, encrypted, before the pool transaction is sent. If the app stops after sending, running again adopts the existing pool instead of creating a second one, and it never adopts a pool that is not its own.
- **Nothing to withdraw.** The liquidity cannot be removed by anyone, including the Fee Key holder.

## Not in this version

- Several pools, ladders, buy support or airdrops. Those stay on the classic launch.
- A SOL seed. The pool is tokens only.
- Splitting the Fee Key between several wallets.
- Running through the classic launch phases. The lean launch has its own record and screen.

## Where the code is

| | |
|---|---|
| `packages/core/src/damm-v2-plan.js` | validation, price and depth model, cost ledger |
| `dammV2Service.js` | chain work: pool, lock, verify, Fee Key, claims |
| `dammV2Launch.js` | the resumable runner |
| `dammV2Store.js` | the record on disk |
| `dammV2Routes.js` | the local API (`/api/v2/damm/...`) |
| `public/v2/lean.js` | the view |

## Tests

- `npm test` runs the plan, route and wiring tests.
- `npm run test:e2e:damm:localnet` runs the whole flow against the real program on a local validator. It needs `solana-test-validator` and read access to mainnet-beta to clone the program.
- `npm run test:e2e:lean:ui` drives the view in a browser against the real server.
- `node scripts/damm-v2-localnet-probe.mjs` prints the cost breakdown.
