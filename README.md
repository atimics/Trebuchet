# Trebuchet

A barebones Solana token launcher. No frills, no extractive nonsense.

> The trebuchet is the superior siege weapon. It can launch a 90 kg
> projectile over 300 meters.

Trebuchet mints an SPL token, deploys it as single-sided liquidity on
Raydium CLMM, locks the position with Burn & Earn, and hands you the
Fee Key NFTs that will earn fees forever. It runs on your own machine
against your own RPC, with no middleman taking a cut of your supply,
charging launch fees, or holding your liquidity hostage.

---

## ⚠ Before you start: get a paid RPC endpoint

**Do not attempt to launch a token using the public Solana RPC.** The
free `api.mainnet-beta.solana.com` endpoint is shared by the entire
ecosystem and is aggressively rate-limited. Pool creation requires a
sustained burst of dozens of requests; you will be throttled mid-flow,
transactions will fail, and you can lose SOL on partial failures that
require manual recovery.

This is the single most common cause of failed launches. Spend the
five minutes to set up a real RPC before doing anything else.

**Recommended:** [Helius](https://www.helius.dev/) — sign up, create an
API key on the dashboard, and you'll get a URL like
`https://mainnet.helius-rpc.com/?api-key=YOUR_KEY`. Helius has a free
tier that's enough to test with, and paid tiers that are reliable
under the load that a real launch generates.

**Alternatives:** Triton, QuickNode, Alchemy. Any reputable paid
Solana RPC will work. Avoid free aggregator endpoints — they fail
in the same ways as the public RPC, just with extra middleware in the
way to obscure the cause.

Add your endpoint inside the app: click the **RPC** bar at the top
of the page, paste your URL into "Add a New RPC", give it a name,
click "Test connection", then "Add & use". The setting is saved and
will be remembered between sessions.

---

## What you'll need

Before launching, have these ready:

- **A paid RPC endpoint** (see above — non-negotiable).
- **A funding wallet** with enough SOL to cover the launch costs.
  The app calculates the exact amount required during Step 3 and
  shows an itemised breakdown. Roughly: 0.1–0.3 SOL for fees plus
  whatever USD-equivalent of liquidity you want to deploy.
- **A logo image** for your token. PNG or JPG, square, under 100 KB.
- **A destination wallet address** — where the Fee Key NFTs and any
  leftover tokens/SOL will end up at the end. Use a wallet you own
  and control.

---

## Pool design: splits and pair tokens

Step 2 lets you create multiple pools and pair each with any token you
want. Most basic launches use neither feature — one pool, paired with
SOL, full supply. But these are the most interesting things Trebuchet
does, and worth understanding before you configure your pools.

### Splitting liquidity into multiple Fee Keys

The conventional way to compensate team members, venture capitalists,
advisors, and marketing partners is **supply allocations** — give them
N% of the token, usually with a vesting schedule, and they sell when
they're ready.

I think this is bad practice and don't recommend it. Allocations create
overhang: holders know there's a wallet out there that can dump at any
time, vesting cliffs become coordinated sell events, and recipients
have no reason to care about the project once their tokens unlock. It's
also one of the most common rug pull vectors in the ecosystem.

Trebuchet's alternative is to split locked liquidity into multiple
positions and hand out the resulting **Fee Key NFTs**. To allocate
"10%" to a marketing partner, create a 10% pool, let Burn & Earn lock
it, and transfer the Fee Key NFT to them. The mechanics change in ways
that materially align incentives:

- **They can't dump.** The LP is locked permanently. No overhang, no
  vesting cliff, no exit pressure on holders.
- **They're paid by volume, not by sale.** Fee Keys collect a share of
  trading fees from their pool. It's recurring income, not a one-time
  grant — the more the token trades, the more they earn.
- **Incentives compound over time.** A marketing partner with a Fee
  Key has continuous reason to drive volume. A team member has reason
  to keep building. In theory this fosters longer-term strategy and
  effort than a tokens-and-vest arrangement, where the relationship
  effectively ends at the unlock.
- **Your supply isn't diluted.** You're not paying people by printing
  tokens at the expense of holders. The cost comes out of trading
  fees, paid by whoever's actually using the token.

Fee Keys are transferable NFTs, so recipients aren't trapped — they
can sell on a secondary NFT market if they need liquidity. The locked
LP stays locked regardless of who holds the key.

### Pairing with non-SOL tokens

Every CLMM pool has a quote token. SOL is the obvious default and what
most users will expect to swap against. But you can pair with any SPL
token, and there are real reasons to:

- **Support another project.** Pairing your token with theirs creates
  permanent, locked liquidity between the two. It's a credible signal
  of alignment that's hard to fake — you literally can't take it back —
  and it gives both communities a way to swap directly without
  routing through SOL.
- **Generate arbitrage volume and price action.** If your token has
  pools against multiple quotes (yours/SOL and yours/USDC, say),
  arbitrageurs will trade between them whenever the implied prices
  diverge. That's volume that generates fees for every Fee Key holder
  in the system, with no organic demand required to bootstrap it.

One caveat: pairing with an illiquid or untrusted token couples part
of your launch's price discovery to whatever happens to that token.
Don't pair with something whose risk profile you don't understand.

---

## How to launch a token

The app walks through six steps. Each step unlocks the next when its
prerequisites are met. You can always scroll back up to revisit an
earlier step.

### Step 1 — Generate temporary wallet

Click **Generate Wallet**. Trebuchet creates a fresh keypair and
displays its public key plus a QR code. This wallet exists only for
this launch — every transaction below is signed by it. It does not
need to be funded yet.

The 12-word recovery phrase is shown for your records, but you don't
need to copy it down for the normal flow. Step 6 sweeps everything
out of this wallet at the end. Save it only if you want a paranoid
backup in case something interrupts the flow — and remember that the
app already saves an encrypted copy in your OS keychain, so this is
genuinely just a paranoia option, not a normal step.

### Step 2 — Configure token & pools

**Token Details:**

- **Name** — what your token is called. "Doge Killer Killer."
- **Symbol** — the ticker, 1–10 characters. "DKK."
- **Total supply** — how many tokens to mint. Common choices: 1
  million, 1 billion. Bigger numbers don't make your token worth more,
  smaller numbers don't make it scarcer in any meaningful way; pick
  what looks right alongside the price.
- **Description** — a sentence or two for the metadata.
- **Logo** — upload your image.

**Pool Configuration:**

- **Target launch market cap (USD)** — sets the initial price. If you
  pick $100,000 with a 1B supply, each token is worth $0.0001. All
  pools start at the same USD-equivalent price.
- **Pools to create** — at minimum one pool, paired with SOL. You can
  add more pools paired with USDC, USDT, or any other token mint, and
  split your supply across them. The percentages need to add up to
  ≤100% — anything left over stays in your wallet. See *Pool design*
  above for why you might want multiple pools, or pools paired with
  something other than SOL.
- **Lock liquidity (Burn & Earn)** — leave this on. It permanently
  locks the LP position and gives you a transferable NFT (the "Fee
  Key") that collects trading fees forever. Without it, your liquidity
  isn't really locked and traders will rightly distrust the launch.

Click **Continue to Funding**.

### Step 3 — Fund the wallet

The app shows you exactly how much SOL (and any quote tokens for
non-SOL pools) need to land in the temporary wallet. Send those
amounts from your funding wallet. Click **Refresh balances** until
everything turns green, then **Continue to Token Creation**.

The "Show cost breakdown" link expands an itemised list — pool
creation rent, position NFT mint fees, Metaplex metadata fees, network
fees, plus your actual liquidity deposit. You're not being charged a
launch fee; this is what Solana and Raydium and Metaplex cost.

### Step 4 — Create the token

Click **Create Token**. The app:

1. Mints the SPL token with your metadata.
2. Transfers the full supply to the temporary wallet.
3. Renounces the mint, freeze, and metadata-update authorities.

After this step the token exists permanently on Solana, and nobody
(including you) can mint more of it, freeze accounts, or change its
metadata. This is intentional — it's what makes the launch credible.

### Step 5 — Create pools and lock liquidity

Click **Create Pools**. The app creates each Raydium CLMM pool you
configured, opens a single-sided position in each, and (if you left
the Burn & Earn checkbox on) locks the position and mints a Fee Key
NFT to the temporary wallet.

This is the step that's most sensitive to RPC quality. If a pool
creation fails partway through, the app will tell you which one and
let you retry, or let you skip to Step 6 to recover whatever did
succeed plus any unspent SOL.

### Step 6 — Sweep assets to your destination wallet

Enter your destination wallet address. **Verify it character by
character** — there is no undo. The app shows a confirmation modal
listing exactly what's about to move; read it.

Click **Confirm and Transfer**. The app sweeps:

- All Fee Key NFTs (these are your earnings stream — keep them safe)
- Any unallocated tokens that didn't go into pools
- Remaining SOL above what's needed for the final transaction fees

Done. The temporary wallet is now empty and your destination wallet
holds everything that matters.

---

## What Trebuchet doesn't do

- Take a cut of your supply
- Charge a launch fee
- Hold your liquidity hostage
- Promote your token, list it anywhere, or do any marketing
- Anything you didn't tell it to do

If you wanted any of those, you launched on the wrong tool.

---

## Recommendations

- **Use a paid RPC.** Said it twice already, saying it a third time.
- **Test on devnet first** if you change anything substantive about
  the launch parameters or you're learning the flow. Mistakes on
  mainnet cost real money.
- **Verify the destination wallet** in Step 6 character by character
  before confirming. Solana addresses look similar enough that swapped
  characters are easy to miss; Solana transactions are final.
- **Don't burn or transfer your Fee Key NFTs** unless you mean to
  permanently give up the income from your locked liquidity. Treat
  them like a property deed.

---

## Troubleshooting

**"Transactions keep failing in Step 5."**
Almost always an RPC problem. Double-check that the active RPC at the
top of the page is your paid endpoint and not the public mainnet
fallback.

**"Pool creation succeeded for one pool but failed for another."**
Use the **Skip to Transfer Assets** button on Step 5 to move to
Step 6. The successfully-created pools are real; you can recover
their Fee Keys plus any leftover SOL.

**"I closed the app in the middle of a launch."**
Reopen it. The temporary wallet's recovery phrase is automatically
saved (encrypted at rest using your OS keychain) when it's generated
in Step 1, and shown again in the recovery panel at the top of the
page on next launch. Copy that phrase, import it into Phantom or
Solflare, and recover any SOL/tokens manually. Once you're done,
click Discard to clear the entry.

---

## For developers

The desktop app is an Electron wrapper around the original web build.
Both share the same source files, and the web build still works
standalone:

```bash
npm install
npm run web        # standalone web server on port 3000
npm start          # Electron desktop app
npm run build:win  # build a Windows installer
```

Source files of interest:

- `server.js` — Express API
- `tokenService.js` — wallet generation, SPL mint via Metaplex Umi
- `lpService.js` — Raydium CLMM pool + position creation, Burn & Earn
- `walletHelpers.js` — multi-token balance + NFT enumeration/sweep
- `rpcConfig.js` — persistent RPC endpoint settings
- `public/` — single-page frontend (Bulma + vanilla JS)
- `main.js` — Electron entry point

Running on devnet: change `cluster: 'mainnet'` to `'devnet'` in
`lpService.js`, swap to `DEVNET_PROGRAM_ID.CLMM_PROGRAM_ID`, hit a
faucet, iterate freely.

---

## License

MIT
