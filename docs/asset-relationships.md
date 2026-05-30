# Packs, Cards, Tokens, and Ingots: The Asset Graph

## The assets

Five kinds of things exist in this system. Each has a different origin and purpose.

| Asset | Type | Origin | Purpose |
|-------|------|--------|---------|
| **RATi / Kyro / Ruby** | SPL fungible token | RATi registry + burn-to-mint program | Currency. Spent on packs, earned from yield, burned for deflation. |
| **Pack NFT** | Metaplex Core NFT | Purchased with tokens | Sealed container. Holds N face-down card slots. One-way open → destroys pack, reveals cards. |
| **Card NFT** | Metaplex Core NFT | Revealed from pack | Collectible. Has character, rarity, role, subject. Can be burned for tokens (Hall Passes). |
| **Ingot NFT** | Metaplex Core NFT | Mined in Signal, proven via chain log | Yield stream. Represents 1/N of LP fee share. Can be composed into frames/modules. |
| **Fee Key NFT** | Metaplex Core NFT | Trebuchet Burn & Earn lock | Fee stream. Holder earns all fees from one locked LP position. Single-owner, not split. |

Fee Key NFTs are the existing Trebuchet primitive — one key, one fee stream. Ingot NFTs are the new primitive — one pool, N chunks, each chunk is an ingot from Signal.

## The two economies

There are two separate value cycles. They touch at the token, but they have different mechanics.

### Economy 1: Purchase → Open → Burn (Packs and Cards)

```
         SPEND RATi
             │
             ▼
        ┌─────────┐
        │  PACK   │  sealed NFT, unknown contents
        └────┬────┘
             │ open (one-way, destroys pack)
             ▼
     ┌───┬───┬───┬───┬───┐
     │ C │ C │ C │ C │ C │  5 face-down card slots
     └─┬─┴─┬─┴─┬─┴─┬─┴─┬─┘
       │   │   │   │   │
       ▼   ▼   ▼   ▼   ▼   reveal (deterministic, one per slot)
     ┌───┬───┬───┬───┬───┐
     │ S │ T │ R │ I │ L │  cards: student, teacher, rare, item, location
     └─┬─┴───┴───┴───┴───┘
       │
       ▼  burn card
     ┌──────────┐
     │   RATi   │  tokens returned (or Hall Pass credits)
     └──────────┘
```

This is a closed loop: tokens buy packs, packs produce cards, cards burn back to tokens. The token supply decreases when packs are purchased (tokens are burned or held by the protocol). The token supply increases when cards are burned (tokens are minted or credited). The net effect depends on the relative rates.

The loop creates a reason to buy packs: you want the cards. The cards have rarity, character identity, and game utility. Burning a card you don't want returns tokens, which you can use to buy more packs. The house keeps the spread.

### Economy 2: Mine → Prove → Earn (Ingots and Yield)

```
    SIGNAL LABOR
         │
         ▼  mine, smelt, prove
    ┌──────────┐
    │  INGOT   │  NFT, 1/N of LP yield, provenance from fragment_pub
    └────┬─────┘
         │
         ├──► HOLD    → claim yield (quote tokens) each harvest cycle
         │
         ├──► COMPOSE → burn N ingots, mint 1 frame (N× yield, one NFT)
         │                  │
         │                  └──► COMPOSE → burn N frames, mint 1 module
         │
         └──► SELL    → transfer on secondary market
```

This is an open loop: labor creates ingots, ingots earn yield from LP fees, yield comes from trading activity. No tokens are burned or minted in this cycle (except the token side of harvested fees, which is burned — deflationary for RATi). The yield is in quote tokens (SOL, USDC), not in RATi. The ingot holder earns real value from trading volume without selling their position.

## How they connect

```
                         ┌──────────────────────────┐
                         │       RATi TOKEN         │
                         │   (fungible, canonical)  │
                         └─────┬────────────┬───────┘
                               │            │
              ┌────────────────┘            └────────────────┐
              │  spend tokens                               │  LP fees accrue
              ▼  to buy packs                               ▼  in token + quote
    ┌──────────────────┐                          ┌──────────────────┐
    │  PACK ECONOMY    │                          │  INGOT ECONOMY   │
    │                  │                          │                  │
    │  Packs → Cards   │                          │  Mine → Ingot    │
    │  Cards → Burn    │                          │  Ingot → Frame   │
    │  Burn → Tokens   │                          │  Earn → Harvest  │
    │                  │                          │                  │
    │  Closed loop:    │                          │  Open loop:      │
    │  tokens in,      │                          │  labor in,       │
    │  tokens out      │                          │  yield out       │
    └──────────────────┘                          └──────────────────┘
```

The token is the bridge. Packs consume tokens (removing them from circulation). Ingot yield burns the token side of fees (also removing tokens from circulation). Both create deflationary pressure. The difference is who benefits:

- **Pack economy:** the protocol or treasury holds the spent tokens. They can be redistributed (card burns return them) or permanently removed.
- **Ingot economy:** the token side of fees is burned — permanently removed. The quote side goes to ingot holders. All token holders benefit from the burn; ingot holders also get the quote yield.

## The Signal provenance layer

Both economies can carry Signal provenance, but in different ways:

### Cards carry pack provenance

A card's metadata records:
- Which pack it came from (pack asset address)
- The pack's commitment + reveal seed (provably fair)
- The slot index (which position in the pack)
- The catalog hash (which set it's from)

This proves the card was fairly drawn from a real pack. It does NOT prove game labor — the pack was purchased, not mined.

### Ingots carry game provenance

An ingot's metadata records:
- `fragment_pub` — the asteroid fragment it was smelted from
- `rock_pub` — the original asteroid
- `station_pubkey` — which Signal station smelted it
- `smelt_epoch` — when in the sim it happened
- Chain log proof — signed event from the station

This proves the ingot represents real game labor. Someone flew a ship, fractured a rock, towed a fragment, smelted an ingot. The chain log witnessed it.

A composed frame or module carries `parent_merkle` linking back to every input ingot, and through them to every fragment and asteroid. The full provenance DAG is walkable.

## What a player does

A player in this system has multiple paths:

### The miner path
1. Play Signal — mine asteroids, smelt ingots
2. Submit chain-log proofs → get ingot NFTs
3. Hold ingots → earn yield from LP fees (quote tokens)
4. Compose ingots → frames → modules (higher yield concentration)
5. Sell ingots on secondary market if they want immediate value instead of yield

### The collector path
1. Buy RATi tokens
2. Spend tokens on packs
3. Open packs → reveal cards
4. Keep rare cards, burn common cards for tokens
5. Repeat — the tokens from burning fund more packs

### The hybrid path
1. Mine ingots in Signal → earn yield in quote tokens
2. Use quote tokens to buy RATi on the open market
3. Spend RATi on packs → collect cards
4. Labor produces yield, yield buys access to the collection game

## The burning question: what happens to spent tokens?

This is the key economic design choice. When someone buys a pack, where do the tokens go?

| Option | Effect | Used by |
|--------|--------|---------|
| **Burn them** | Permanent deflation. Token supply decreases. All holders benefit. | Cleanest, aligns with "no extractive middleman" |
| **Protocol treasury** | Tokens held by DAO/governance. Can be redistributed as grants, bounties, card-burn rewards. | Gives the ecosystem a budget |
| **Yield-split pool** | Spent tokens go to the LP pool. Increases liquidity depth. Ingot holders get more yield. | Aligns pack purchasers with ingot holders |
| **Split** | X% burned, Y% to treasury, Z% to yield pool | Most flexible, most complex |

The recommendation is: **burn the token side, keep the quote side for ingot yield.** This is consistent across both economies:

- When packs are purchased: tokens are burned. The protocol doesn't hold a treasury of spent tokens.
- When LP fees are harvested: token side burned, quote side distributed to ingot holders.
- When cards are burned for Hall Passes: Hall Passes are credits, not tokens. They're a separate accounting system.

The protocol never accumulates tokens. Tokens flow in one direction: from minting (burn-to-mint, bonding curve) to burning (pack purchases, fee harvest). The only way new tokens enter circulation is through labor — mining in Signal, proving it, minting through the burn-to-mint program.

## The relationship table

| From | To | Mechanism | Effect on RATi supply |
|------|----|-----------|----------------------|
| Burn-to-mint program | Holder wallet | Mint canonical RATi after proven labor | Increases |
| Holder wallet | Pack purchase | Spend RATi, receive pack NFT | Decreases (burn) |
| Pack NFT | Card slots | Open pack (one-way) | No effect |
| Card slot | Card NFT | Reveal (deterministic) | No effect |
| Card NFT | Holder wallet | Burn card, receive Hall Passes | No effect (Hall Pass is credit, not token) |
| CLMM pool | Yield-split contract | Harvest LP fees | Decreases (token side burned) |
| Yield-split contract | Ingot holder | Claim yield (quote tokens) | No effect on RATi |
| Ingot holder | Frame NFT | Compose N ingots | No effect |
| Ingot holder | Secondary buyer | Sell ingot NFT | No effect on RATi |

The only two operations that change RATi supply are **minting** (burn-to-mint program, after proven Signal labor) and **burning** (pack purchases, fee harvest). Everything else — opening packs, revealing cards, composing ingots, claiming yield, transferring NFTs — leaves the RATi supply unchanged.

## The full closed loop: Signal → RATi → Ruby High

The system is a single closed circuit. RATi has exactly one entry point and multiple exit points.

```
                         ┌─────────────────────────┐
                         │        SIGNAL           │
                         │                         │
                         │  Mine asteroid           │
                         │  Smelt ingot             │
                         │  Chain log proves labor  │
                         └───────────┬─────────────┘
                                     │
                                     │  proof of labor
                                     ▼
                         ┌─────────────────────────┐
                         │    BURN-TO-MINT         │
                         │    (Signal program)     │
                         │                         │
                         │  Validate chain log      │
                         │  Mint canonical RATi     │
                         └───────────┬─────────────┘
                                     │
                                     │  RATi enters circulation
                                     ▼
                         ┌─────────────────────────┐
                         │      RATi TOKEN         │
                         │   (only supply source)  │
                         └─────┬─────────────┬─────┘
                               │             │
              ┌────────────────┘             └────────────────┐
              │  spend RATi                                   │  LP fees accrue
              ▼  on packs                                     ▼  from trading
    ┌──────────────────┐                          ┌──────────────────┐
    │   RUBY HIGH      │                          │  YIELD-SPLIT     │
    │                  │                          │                  │
    │  Buy pack NFT    │                          │  Harvest fees    │
    │  Open pack       │                          │  Token side:     │
    │  Reveal cards    │                          │    BURNED        │
    │  Collect + burn  │                          │  Quote side:     │
    │                  │                          │    to ingot      │
    │  RATi spent on   │                          │    holders       │
    │  packs is BURNED │                          │                  │
    └──────────────────┘                          └──────────────────┘
```

The only way RATi exists is if someone played Signal. Every RATi token traces back to a specific asteroid, a specific fragment, a specific smelt event signed by a specific station. The provenance chain is complete: rock → fragment → ingot → token → pack → card.

This means:

- **Ruby High packs cannot be bought without Signal miners.** No mining, no RATi, no packs.
- **Miners fund the collection economy.** The RATi a miner earns buys packs. The cards from packs are the reward for the miner's labor (or for whoever the miner sells RATi to).
- **Card collectors depend on miners.** If you want cards but don't want to mine, you buy RATi from miners on the open market. The miner gets quote tokens (SOL/USDC). You get RATi. You buy packs. This is a natural labor market.
- **The token is fully backed by gameplay.** Every unit of RATi in circulation corresponds to proven game labor. No premine. No team allocation that can dump. No VC unlock schedule. You want tokens, you mine. You want cards, you buy tokens from miners.

### The "no free cards" invariant

Ruby High cards should be desirable — rare characters, alternate art, teacher specials. But you should not be able to get them without someone, somewhere, having played Signal. The invariant is:

> Every Ruby High card in existence was paid for with RATi that was mined in Signal.

This means Ruby High pack purchases must require RATi (or RUBY, which is minted through the same burn-to-mint program). Fiat purchases (Stripe) can exist for Hall Passes — they're separate credits, not cards. But cards require RATi, and RATi requires Signal.

### Ruby High's current payment paths vs. the new model

| Current | New |
|---------|-----|
| Stripe → Hall Passes (fiat) | **Keep.** Hall Passes are utility credits, not collectibles. |
| Solana SPL token → pack NFT | **Change.** Accept only canonical RATi/RUBY. Validate against RATi registry. |
| Burn card → Hall Passes | **Keep.** Card burning returns utility credits, not RATi. This is fine — the card was already paid for with mined RATi. |
| Free-to-play (BYOK) | **Keep.** Playing Ruby High doesn't require tokens. Collecting cards does. |

### What this means for the launch

The launch sequence matters. You cannot launch Ruby High packs before RATi exists. You cannot launch RATi before the burn-to-mint program is deployed. You cannot deploy the burn-to-mint program before Signal's #480 on-chain anchoring is live. The dependencies are:

```
Signal #480 (chain-log anchoring)
    │
    ▼
Burn-to-mint program (Signal programs/burn-to-mint/)
    │
    ▼
Canonical RATi mint (RATi registry declares, Trebuchet deploys)
    │
    ▼
CLMM pool + yield-split (Trebuchet launch, Signal yield-split program)
    │
    ▼
Ruby High pack sales (accept RATi, mint packs via packnft CLI)
```

Each stage depends on the one before it. You can deploy them incrementally (devnet → RC → mainnet), but you cannot reorder them.

## Captain Null: the bridge character

Captain Null is the in-world representation of the Signal → RATi → Ruby High pipeline. He is not a metaphor. He is a card.

```
┌─────────────────────────────────────────────────────────┐
│                    CAPTAIN NULL                          │
│                                                         │
│  Ruby High card:         Signal entity:                 │
│  ─────────────           ──────────────                  │
│  Role: special           Trace resolver target           │
│  Rarity: ultra-rare      Appears in Sector X lore        │
│  Title: "Page 10         Moves between stations          │
│          Shadow Pass"    without signal                  │
│  Blurb: "Find page 10    "Find page 10 and the           │
│          and the hallway  hallway forgets your name"      │
│          forgets your                                   │
│          name."                                         │
│                                                         │
│  Getting this card means:                               │
│  1. Someone mined RATi in Signal                         │
│  2. That RATi bought a Ruby High pack                    │
│  3. The pack was opened                                  │
│  4. The reveal proof landed on Captain Null's slot       │
│  5. The provenance chain goes: rock → fragment → ingot   │
│     → RATi → pack → card → Captain Null                 │
│                                                         │
│  The card literally contains the pipeline.               │
└─────────────────────────────────────────────────────────┘
```

### What "page 10" is

The First Bell set has 36 profiles. The provably fair reveal algorithm uses `sha256(version + commitment + revealSeed + assetAddress + slotIndex)`. Page 10 could be:

- The tenth slot in a pack (packs have 5 slots, so this would be across two packs)
- The tenth card revealed by a specific commitment seed
- A literal reference to a document — the tenth in a series of proofs

The ambiguity is the point. Captain Null is findable but not predictable. You know he exists. You know the algorithm that determines when he appears. You cannot force him to appear. You can only play, mine, buy packs, and hope.

### Why ultra-rare matters

Captain Null is the only ultra-rare in the First Bell set. He appears less often than super-rares (Eliza, Rati). He is harder to find than any teacher or student card. The rarity encodes the pipeline: most cards come from common labor (students, items), some from exceptional labor (rare teachers), very few from touching the bridge between worlds.

Getting a Captain Null card means your specific RATi — your specific mined ingot, your specific fragment, your specific asteroid — was the one that crossed into the shadow. The provenance chain on that card traces back to YOUR rock. You didn't just buy a pack. You completed the circuit.

### The narrative function

The three projects are technically connected through contract blocks, stamps, and RPC submissions. But for a player, that's invisible. Captain Null makes the connection visible. He says: "There is something that moves between the mining world and the school world. It leaves a trace. You can find it. It's on page 10."

This is the same function Sector X serves in Signal's lore — the dark sectors, the megastructures, the signal that went silent. Sector X says "there is something beyond the network you built." Captain Null says "there is something between the network you built and the school you attend." Same narrative technique, different boundary.

### Where Captain Null lives in the code

| Location | What | Role |
|----------|------|------|
| Ruby High `hall-pass-card-catalog.ts` | Card catalog entry | Ultra-rare special card, First Bell set |
| Ruby High `DESIGN.md` | "Ruby High 2.0 C wedge" section | Captain Null trace resolver in gameplay tests |
| Signal | (to be implemented) | NPC, trace entity, or Sector X encounter |
| Packnft `catalog.c` | Card catalog data | Ported from Ruby High TS to Signal C |
| RATi registry | (narrative only) | Not in the registry — Captain Null is a card, not a token |

Captain Null is the only entity that exists in both the Ruby High card catalog and the Signal game world. Every other character is confined to one: Ruby stays in the school, Prospect Refinery stays in the belt. Captain Null crosses.
