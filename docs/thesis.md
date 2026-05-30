# Trebuchet: Thesis and Philosophy

## What it is

Trebuchet is an open-source, self-hosted Solana token launcher. It mints an SPL token, deploys single-sided liquidity on Raydium CLMM, locks every position with Burn & Earn, and hands you the Fee Key NFTs that earn fees forever. The entire process runs on your own machine against your own RPC — no server, no middleman, no cut of your supply, no launch fee, no custody of your liquidity.

It is distributed as a desktop application (Electron, with a standalone web build available) under the MIT license. The marketing site lives at [makesometokens.com](https://makesometokens.com) and the source at [github.com/AnOversizedMooseWithSocks/Trebuchet](https://github.com/AnOversizedMooseWithSocks/Trebuchet).

---

## The central thesis

**Token launches in the Solana ecosystem are extractive by default.** The standard tooling — `pump.fun`, Moonshot, and the dozens of copycat launchpads — follows a consistent pattern: the platform takes a percentage of supply, charges a launch fee, picks trading parameters on your behalf (often to its own benefit), and in many cases builds custody of liquidity into the architecture itself. The launch is not an act of creation you control; it is a service you pay for, and the platform's incentives are structurally different from yours.

Trebuchet is built on the opposite premise: **a launch is an act of engineering, not a fee-extraction event.** The creator should own every parameter, every key, every position, and every fee stream that results. The tool should be invisible once the launch is done — nothing to log into, no dashboard to maintain a relationship with, no "platform" standing between you and your token.

The thesis plays out in three layers.

### 1. No extractive platform economics

Trebuchet takes nothing. No supply allocation. No launch fee. No percentage of trading fees. The only costs are what Solana, Raydium, and Metaplex charge — network fees, rent, pool creation costs — and the app shows an itemized breakdown of every lamport before you commit. The phrase "no frills, no extractive nonsense" in the README is not branding; it is the core commitment from which every design decision follows.

Most launchpads justify their cut by bundling services — promotion, listing, a community feed, "discovery." Trebuchet explicitly rejects bundling. It does not promote your token, does not list it anywhere, does not do any marketing. If you wanted any of those, you launched on the wrong tool. The app is a tool, not a platform.

### 2. Self-custody by architecture

The launch flow generates a fresh ephemeral keypair on your machine. Every transaction — mint, pool creation, position opens, Burn & Earn lock — is signed locally by that keypair using your own RPC endpoint. The wallet's secret key is saved encrypted in your OS keychain for recovery, but the architecture never transmits it anywhere. At the end of the launch, all assets sweep to your designated destination wallet.

The practical consequence: there is no Trebuchet server that could hold your liquidity, no admin key that could rug you, no platform custody at any stage. Even if the Trebuchet GitHub org and domain disappear tomorrow, your token, pools, and Fee Key NFTs exist independently on Solana and you can claim fees through Raydium's own portfolio page.

### 3. Permanent, verifiable credibility

The app mints the token, transfers the full supply to the ephemeral wallet, then **renounces the mint, freeze, and metadata-update authorities**. After Step 4 the token exists permanently and nobody — including you — can mint more, freeze accounts, or change its metadata. This is not an optional feature; it is the default behavior, because a revocable token is not a credible one.

The locked liquidity is equally irrevocable. Burn & Earn burns the LP position NFT and mints a transferable Fee Key NFT in its place. The LP is permanently locked; the Fee Key can be transferred or sold, but the locked position stays locked regardless of who holds the key. There is no "unlock" button because there is no unlock mechanism.

The launch report — a self-contained HTML document generated after pool creation and again after the final sweep — records every address, transaction signature, pool ID, position NFT, and lock proof. It is not a dashboard you log into; it is a file you keep offline, share by email, or print to PDF. The report is the canonical reference for your team, your investors, and anyone who needs to verify the launch was done honestly.

---

## Philosophical positions embedded in the design

### "The best tool is the one you don't need after using it."

Trebuchet is designed to be self-erasing. Once Step 6 completes, the ephemeral wallet is empty and the destination wallet holds everything that matters. There is no ongoing relationship — no account, no login, no dashboard. The app is a tool you use and then close. The Fee Key NFTs earn fees regardless of whether Trebuchet exists.

### Fee Keys over supply allocations

The conventional way to compensate team members, advisors, and marketing partners is supply allocations — give them N% of the token, usually with vesting. Trebuchet argues this is bad practice: allocations create overhang (holders know a wallet can dump), vesting cliffs become coordinated sell events, and recipients have no incentive to care once tokens unlock.

The alternative is to split locked liquidity into multiple Fee Key positions and distribute the resulting NFTs. A 10% allocation becomes a pool slice that earns a share of trading fees. The recipient cannot dump (the LP is permanently locked), they earn recurring income proportional to volume, and their incentives compound over time — the more the token trades, the more they earn, so they have continuous reason to drive volume and build. Supply is not diluted at the expense of holders.

### A launch should be a single deliberate act

The six-step wizard is intentionally linear and irreversible. You cannot go back and change inputs once a step is completed. This is not an oversight; it reflects the view that a token launch is a deliberate engineering act, not an iterative WYSIWYG session. The Cancel & Refund path exists for abandonment, and the Resume path exists for transient failures, but the normal flow moves forward only.

The "Edit configuration" escape hatch in Step 3 lets you adjust pool parameters before funding — acknowledging that price estimation is genuinely iterative — while keeping the rest of the flow forward-only. This is the single point of intentional backtracking in the design.

### Flywheels as composability over isolation

Most tokens launch as SOL-only pairs. Trebuchet ships with pre-configured flywheel quote tokens — Reserve (backed by wBTC, ETH, and stable tokens) and Meme (backed by active meme communities plus the Reserve flywheel itself) — that connect your launch to broader pool networks. A flywheel pair means arbitrage flow from exotic pairs can cascade into your token, and price action from those paired assets can correlate back.

This reflects the view that a token's value is never fully isolated and that designing for composability from the start is a strategic advantage rather than a complexity you should avoid. The default 90/10 split (90% SOL, 10% flywheel) encodes this as the sensible default while letting users dial it up, down, or off.

### Centralized launchpads are a systemic risk

The current ecosystem pattern — a handful of centralized launchpads handling the majority of new token launches — concentrates power in entities that can change terms, go offline, get exploited, or selectively gate access. Trebuchet treats this as a systemic risk worth addressing with a self-hosted alternative. The app is open source, runs locally, and uses only public infrastructure (Solana RPC, Raydium CLMM, Metaplex, Arweave for metadata). There is no single point of infrastructure failure controlled by the project.

---

## What Trebuchet is not

The negative space is as important as the positive. Trebuchet:

- Is not a platform. It is a tool.
- Does not have users. It has people who use it and then close it.
- Is not a community. It does not have a Discord, a governance token, or a "creator program."
- Is not a brand you build on top of. It is MIT-licensed software.
- Does not make tokens successful. It makes tokens launchable with credible, verifiable economics.

The distinction matters because conflating tool and platform is how extraction sneaks back in. Trebuchet is built from the conviction that there should be at least one option in the ecosystem that is genuinely just a tool.

