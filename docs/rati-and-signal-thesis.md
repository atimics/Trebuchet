# RATi, Signal, and Trebuchet: A Pipeline Thesis

These three projects form a single pipeline. Each is independently useful, but their real coherence emerges when you see how value flows through all three — and who stands at each stage:

1. **Signal** — the game where RATi is mined into existence through verifiable, provenance-tracked labor.
2. **RATi** — the registry and migration program that defines what RATi is, validates what came out of Signal, and manages the burn-to-mint bridge onto Solana.
3. **Trebuchet** — the launcher that takes minted tokens and deploys them into the market with locked liquidity, Fee Key NFTs, and no middleman.

Each human is a node.

**Mine it in Signal. Prove it in RATi. Launch it with Trebuchet.**

## The pipeline principle: labor, identity, liquidity

Every token in this system passes through three stages, and each stage is owned by a different tool:

### Stage 1 — Labor (Signal)

Tokens don't appear from nowhere. In Signal, ore is mined by players fracturing asteroids, towing fragments, smelting ingots, and delivering contract cargo across sovereign station zones. The game simulates a real economy with per-station ledgers, dynamic pricing, and content-addressed provenance that chains every finished good back to the asteroid it came from.

When Signal's #480 on-chain anchoring work lands, the signed chain logs that prove what was mined — every smelt event, every fragment's lineage, every ingot's `parent_merkle` — become verifiable on Solana. The game's simulated labor becomes cryptographically legible. The tokens minted in response are not airdrops or allocations. They are proof of work, in the most literal sense: proof that someone flew a ship, fractured rocks, hauled cargo, and built something.

### Stage 2 — Identity (RATi)

The RATi registry is the canonical definition of what RATi, Kyro, and Ruby actually are. It owns the mint addresses, the metadata, the authority state, and the scam-token warnings. The burn-to-mint migration program accepts verified source tokens — including whatever mints Signal's anchored proofs authorize — and converts them into canonical destination tokens through explicit registry-published rate modes.

RATi's job is identity and validation. It should not be concerned with launch tooling, NFT minting mechanics, or liquidity deployment. Those are Trebuchet's domain. RATi says what is real. Trebuchet puts it into the world.

### Stage 3 — Liquidity (Trebuchet)

Trebuchet is the unified launch surface for the entire pipeline. It handles:

- SPL token minting and deployment
- CLMM pool creation with locked liquidity and Burn & Earn Fee Key NFTs
- NFT collection creation (Metaplex Core, Token Metadata)
- NFT pack minting with provably fair reveal mechanics
- Card and asset burning mechanics
- Wallet-signed checkout flows
- Durable metadata upload (Arweave, Irys)
- Launch reports with full transaction provenance

Trebuchet doesn't judge what it launches. The RATi registry validates identity. Trebuchet handles deployment. The separation is structural: identity lives in RATi, deployment lives in Trebuchet.

## Migration: consolidating launch into Trebuchet

Currently, launch and mint tooling is scattered across repos. Each has a partial, janky version of what Trebuchet already does cleanly — or could do with targeted expansion:

| Source repo | What it has | What should move to Trebuchet |
|-------------|------------|-------------------------------|
| **Kyro** (solana-program) | Burn-and-mint program (884 lines), bonding curve, Metaplex CPI, wallet limits | Burn-to-mint migration as a Trebuchet launch mode; bonding curve configuration; Metaplex metadata setup |
| **Ruby High** (app-ruby-high) | Metaplex Core NFT minting (~4,300 lines across core-pack-nfts, hall-pass-nfts, card catalog, reveal provenance, Arweave metadata) | NFT pack creation and reveal; card minting and burning; wallet-signed checkout; Arweave upload; Core collection management |
| **RATi** (registry) | Source-mint registry, migration specs, address manifest | Should NOT move — RATi keeps identity. Trebuchet reads the registry to validate before launching. |

### What Trebuchet gains

**Burn-to-mint migration mode.** Trebuchet already creates tokens and deploys liquidity. With the Kyro program's bonding-curve logic and the RATi registry's source-mint validation, Trebuchet can offer "migrate existing token → deploy liquidity" as a first-class launch path. You bring a source token, Trebuchet validates it against the RATi registry, runs the burn-to-mint migration, deploys CLMM pools with Burn & Earn, and hands you Fee Keys. One tool, end to end.

**NFT pack launching.** Ruby High's Metaplex Core NFT system (~4,300 lines of TypeScript) handles pack minting, provably fair reveal, card burning, wallet-signed checkout, and Arweave metadata upload. This is exactly the kind of launch mechanics Trebuchet is built for — except Trebuchet currently only handles fungible tokens. Moving the NFT surface into Trebuchet gives it a second launch product: NFT pack creation with the same zero-middleman, self-custody, offline-report principles as the token launcher.

**Unified metadata pipeline.** Both Kyro and Ruby High have ad-hoc metadata upload systems (Irys for Kyro, Arweave for Ruby High). Trebuchet can offer a single metadata upload surface — logo, collection artwork, card art — with durable storage, content hashes, and provenance recorded in the launch report.

### What RATi keeps

RATi retains the registry, the address manifest, the program ID and PDA mint definitions, the scam-token warnings, and the authority policy. RATi is the source of truth about what is canonical. Trebuchet reads from RATi's registry to validate source mints before launching. The burn-to-mint program itself lives in RATi (it's on-chain, tied to the program ID), but the *launch experience* — the UI, the step wizard, the wallet generation, the funding flow, the deployment, the report — moves to Trebuchet.

### What Ruby High keeps

Ruby High keeps the school: the daily class loop, the faculty, the cohort, the yearbook, the Hall Pass economy. NFTs are how packs and cards are represented on-chain, but the *mechanics* of creating, revealing, and burning those NFTs are launch tooling. Ruby High should call Trebuchet (or share Trebuchet's libraries) for NFT operations rather than maintaining its own parallel mint stack.

## The human layer: each human is a node

The pipeline is not just a sequence of tool invocations. It describes a topology where every participant is a sovereign node in a network, not a user of a platform.

In Signal, the game is designed so that different people can run different stations under different Ed25519 keypairs. A station operator runs their own chain log, signs their own events, sets their own prices. The player who mines ore and hauls cargo is not a "user" of the game — they are a node in an economy, carrying value between sovereign currency zones.

In RATi, the agents have wallets, identities, and memories. A human who operates a RATi agent — running Ratibot, managing an avatar swarm — is not logging into a service. They are running a node in an agent economy. The registry doesn't grant permission. It publishes truth.

In Trebuchet, the launcher runs on your machine, signs with your keypair, and deploys against your RPC. There is no Trebuchet server that could hold your liquidity. The person who launches a token or an NFT collection is a node — a sovereign actor who owns every parameter, every key, every fee stream.

The three tools together describe a system where no one needs permission to create value, prove its provenance, or deploy it to a market. The network is the humans. The tools are what they use to act.

## Shared philosophy across the pipeline

The connective tissue runs deeper than a pipeline diagram. All three projects share a structural conviction: **decentralization is not a feature you add. It is what you get when you build systems designed to not need a center.**

### No extractive middleman, at any stage

Signal has no game-master wallet taxing mining rewards. RATi's migration program takes zero protocol fee and has no fee-recipient account. Trebuchet takes no supply cut and charges no launch fee. At every stage of the value chain — creation, validation, deployment — the tools refuse to insert themselves as rentiers.

### Every claim is independently verifiable

Signal's chain log lets anyone with the log file and a station pubkey replay and verify every smelt, craft, and transfer event. RATi's registry is the machine-readable source of truth that every bot and app consults. Trebuchet's launch report is a self-contained HTML document with every address, transaction signature, lock proof, pack reveal commitment, and metadata content hash — you keep it offline, share it by email, print it to PDF.

### Authority is structural, not delegated

Signal stations derive their keypairs deterministically from operator-held secrets — the private key is never serialized, never sent over the wire. RATi's mint authority is a PDA, not a human hot wallet. Trebuchet generates an ephemeral keypair on your machine, signs everything locally, then sweeps all assets to your wallet and renounces the mint, freeze, and metadata authorities. For NFT launches, the collection authority and mint authority follow the same pattern: ephemeral keypair, local signing, sweep to destination.

### Boring infrastructure, expressive surface

Signal's sim is fixed-step at 120 Hz, deterministic, identical for everyone. RATi's on-chain program is native Rust with fixed-size account layouts and manual instruction discriminants — no Anchor, no macros, no framework indirection. Trebuchet's server is a straightforward Express API; the frontend is vanilla JS. The plumbing stays boring so the surface can be trustworthy.

### Every tool is designed to be used and then closed

You mine in Signal, close it. You migrate through RATi, close it. You launch with Trebuchet, close it. The Fee Keys earn fees regardless of whether Trebuchet exists. The chain log is verifiable regardless of whether the game server is running. The NFTs and their metadata are on-chain and on Arweave — they outlive the tool that created them.

## The pipeline in detail

| Stage | Tool | What happens | What's produced | Who owns it |
|-------|------|-------------|-----------------|-------------|
| Labor | Signal | Mine ore, smelt ingots, deliver contracts | Provenance-tracked cargo units with signed chain-log events | The player (cargo) and station operator (chain log) |
| Identity | RATi | Registry validates source, migration program burns source, mints canonical | Canonical RATi/Kyro/Ruby SPL tokens | The token holder |
| Liquidity | Trebuchet | Mints SPL tokens, deploys CLMM pools, locks with Burn & Earn; mints NFT packs and cards with provably fair reveal | Locked liquidity positions, Fee Key NFTs, NFT collections, launch reports | The creator |

The handoff between stages is explicit:
- Signal → RATi: on-chain anchoring (#480) commits chain-tip hashes and makes cargo units wrappable assets
- RATi → Trebuchet: the canonical mint address from the registry is what Trebuchet validates and deploys liquidity for; the registry's source-mint entries are what Trebuchet's migration mode reads
- Trebuchet → Market: locked CLMM pools, Fee Key NFTs, and NFT collections are permanent on-chain infrastructure

## What this means as a thesis

This pipeline is an argument about how value should move through a digital economy — and about where humans belong in it:

**Value is created by labor in a simulated world, not by speculation on a launchpad.** The mining, hauling, and construction that produce tokens in Signal are real gameplay with real time investment. The provenance chain proves it.

**Identity is conferred by a registry that anyone can audit, not by a platform that can revoke it.** The RATi token exists because the registry says it exists, and the registry is a signed JSON file plus on-chain accounts. No company, no login, no terms of service.

**Liquidity — of tokens and of NFTs — is deployed by a tool that takes nothing and leaves behind locked positions and permanent collections.** Trebuchet is not a platform you return to. It is a tool you use once and then close. The Fee Keys and the NFT metadata are yours regardless.

**Launch tooling should not be scattered across products.** Every project that mints tokens or NFTs eventually builds a parallel, partial launch stack. Trebuchet exists so they don't have to. The registry, the game, and the school each do one thing well. The launcher handles everything that touches deployment.

**The human is the node, not the user.** There is no platform to log into, no account to maintain, no dashboard to check. You run the tool. You own the keys. You are the station, the agent operator, the launcher. The network is made of people running tools that answer to them.

**At no point in the pipeline does any tool charge for access, extract a percentage, hold custody, or gate the ability to walk away.** This is not an accident. It is the unifying design rule across all three projects.

## A note on the builder

All three projects are MIT-licensed, open-source, and built by the same person. The authorial voice is consistent across the codebases: precise, unsentimental, comfortable with negative space, and allergic to hype. The READMEs describe what each tool does by describing what it refuses to do. The docs are reference-grade. The invariants are stated explicitly. The tests enforce them.

This is what credible software looks like when the builder takes their own work seriously — and when they've built a pipeline where every stage answers to the same principles, and every human who uses it is a node, not a captive.

## Reading order

### Signal
- [README.md](/Users/ratimics/develop/signal/README.md) — what the game is and how to play
- [CLAUDE.md](/Users/ratimics/develop/signal/CLAUDE.md) — architecture and working context
- [docs/decentralization.md](/Users/ratimics/develop/signal/docs/decentralization.md) — the identity stack, chain log, and federation model
- [docs/cargo-architecture.md](/Users/ratimics/develop/signal/docs/cargo-architecture.md) — the three-state matter model and provenance DAG
- [docs/sector-x-whitepaper.md](/Users/ratimics/develop/signal/docs/sector-x-whitepaper.md) — the post-MVP endgame vision

### RATi
- [README.md](/Users/ratimics/develop/rati/README.md) — project map and tooling surface
- [SCOPE.md](/Users/ratimics/develop/rati/SCOPE.md) — what lives here and what doesn't
- [WHITEPAPER.md](/Users/ratimics/develop/rati/WHITEPAPER.md) — the full thesis, economics, and architecture
- [ROADMAP.md](/Users/ratimics/develop/rati/ROADMAP.md) — phase-gated progression with proof gates
- [MODULE_ARCHITECTURE.md](/Users/ratimics/develop/rati/MODULE_ARCHITECTURE.md) — module boundaries and composition rules
- [research/kyro-substrate.md](/Users/ratimics/develop/rati/research/kyro-substrate.md) — audit of the Kyro burn-and-mint program

### Trebuchet
- [README.md](/Users/ratimics/develop/trebuchet/README.md) — what the tool does and how to launch
- [docs/thesis.md](/Users/ratimics/develop/trebuchet/docs/thesis.md) — the Trebuchet-specific philosophy
