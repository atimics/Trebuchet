# Design Review — May 2026

## What exists

**Code (2,215 lines C, all compiles, all tests pass):**

| Component | Lines | Status |
|-----------|-------|--------|
| Burn-to-mint SBF program | 1,277 | Moved to Signal, compiles via Solana C SDK |
| Packnft catalog | 191 | 36 card profiles, lookup, deterministic hash |
| Packnft reveal | 101 | SHA-256 commit-reveal algorithm |
| Packnft metadata | 121 | Full Metaplex Core JSON generation |
| Packnft CLI | 199 | 8 operations over stdin/stdout JSON |
| Packnft tests | 170 | 15 tests, all passing |

**Design docs (16 documents across 3 repos):**

| Doc | Lines | Maturity |
|-----|-------|----------|
| `.launch` SPEC | 608 | v1 draft — solid core, over-specified agent modules |
| Build plan | 537 | Detailed — sequential, doesn't reflect two-track reality |
| Asset relationships | 344 | Good — clear separation of pack economy vs ingot economy |
| Packnft architecture | 325 | Solid — correct call on library location |
| Yield-split design | 253 | Strongest design — ingot IS cargo unit |
| Furnace design | ~250 | New — needs reconciliation with station-tokens doc |
| Station tokens | ~250 | New — three-token economy, good but overlaps furnace doc |
| RATi tokenomics | 228 | Good — duplicated in both RATi and Trebuchet |
| Signal↔Solana bridge | ~300 | New — signed association ceremony, solid |
| Pipeline thesis | 160 | Good framing — mostly stable now |
| Trebuchet thesis | 82 | Solid — standalone Trebuchet philosophy |
| `.launch` README | ~120 | Good — Mermaid diagrams |

## What's strong

**The architecture split is right and earned.** Signal owns execution (programs,
packnft, transaction building). RATi owns identity (registry, manifest). Trebuchet
owns launch UX. The `.launch` file is the right handoff artifact. These boundaries
are real — you can point at specific files in each repo.

**The yield-split design is the single best idea.** The ingot IS Signal's cargo
unit. `cargo_unit.pub` IS the NFT content identity. `parent_merkle = fragment_pub`
IS the provenance chain. No new abstraction — just putting Signal's existing
identity system on-chain.

**The furnace closes the economic loop.** Memecoins in, RATi/KYRO/RUBY out.
Dead speculative capital converted to productive assets. The furnace is the
entry point for external value into the Signal economy.

**Phase 1 shipped clean.** 2,200 lines of C, compiles, tests pass. The packnft
library is small (900 lines) and self-contained. It ports 4,300 lines of Ruby
High TypeScript NFT code into C that links against Signal's existing crypto.

**The three-token model gives the economy depth.** RUBY for entry/packs, KYRO
for industry/ships, RATi for sovereignty/operators. Each station is a nation
with its own currency, furnace, and economic policy. Players progress through
tiers.

## What needs attention

### 1. The critical blocker: transaction building (Phase 2)

Packnft does catalog, reveal, and metadata. It cannot build Solana transactions.
Without transaction building, nothing downstream works:
- Furnace can't build burn transactions
- Yield-split can't build mint/compose/harvest transactions
- Trebuchet can't use packnft for NFT launches
- Ruby High can't drop its TypeScript NFT code

Phase 2 is the hardest piece of work in the build plan — ~400 lines of precise
binary layout (compact-u16, message format, Metaplex Core instruction builders)
plus integration with Signal's Ed25519 for signing. It's tedious, error-prone,
and must be cross-validated against the Metaplex SDK byte-for-byte.

**This is the next thing to build.** Everything else can design around it,
but nothing can ship without it.

### 2. Doc duplication and drift

`rati-tokenomics.md` exists in both `trebuchet/docs/` and `rati/docs/`. The
RATi copy is canonical; the Trebuchet copy should be a reference link.

The furnace design and station-tokens docs were written hours apart and overlap
significantly. They should be merged into one "station economy" document.

The build plan was written before the furnace, station-tokens, and Signal-Solana
bridge designs existed. It needs updating to include these new work items and
to reflect a two-track schedule.

### 3. The .launch spec has scope creep

The core modules (token, pools, yield, migration, NFT catalog, signatures) are
solid and implementable. The agent modules (identity, persona, network, secrets)
describe a RATi Operating System that has no repo, no spec, and no build plan.
These should be in a separate spec document — "Agent Bootstrap Extensions" —
so they can evolve independently without breaking launch tool compatibility.

### 4. The RATi Operating System is undefined

Mentioned throughout the docs, diagrammed in the `.launch` README, but has no
repo. It's described as the thing that reads `.launch` files and operates
avatars on social media, monitors markets, and coordinates mining fleets via
Signal gossip. Until this has a spec and a repo, the diagrams that show it
are aspirational. That's fine for vision — but the build plan should call it
"Phase 8: RATi OS" so it's acknowledged as deferred.

### 5. Docs need a home

Currently design docs for the pipeline live in Trebuchet's `docs/`. That made
sense when Trebuchet was the starting point, but now the system spans four repos.
The pipeline-level docs should move to a central location — either the RATi repo
(as the identity/coordination repo) or a new `docs/` repo. Per-project docs
(thesis.md, releasing.md, SPEC.md) stay where they are.

## What to build next

### Immediate (this week): Phase 2 — transaction building

Write `signal/tools/packnft/txn.c`:
- Compact-u16 encode/decode
- Solana message layout (header, accounts, instructions)
- Ed25519 signing via `shared/signal_crypto.h`
- Metaplex Core instruction builders: CreateAsset, CreateCollection, Burn, Update
- Base64 encoding for RPC submission

The CLI gains: `build-pack-mint`, `build-card-mint`, `build-card-burn`,
`build-collection-create`, `build-furnace-convert`, `build-furnace-boost`.

Validation: cross-check output against Metaplex SDK transactions byte-for-byte
on a known test vector.

### Short-term (next 2 weeks): Close the circuit

Once transaction building works:

1. **Furnace UI in Signal client** — `client/furnace_ui.c`. Station module panel
   that calls packnft CLI for burn transactions, shows linked wallet balances,
   displays active boosts.

2. **Solana bridge in Signal server** — `server/solana_bridge.c`. Read-only RPC
   client for balance checks and burn verification.

3. **Wallet linking ceremony** — Client and server flows for associating Signal
   identity with Solana wallet. Uses the signed association protocol from
   `signal-solana-bridge.md`.

### Medium-term (next month): Deploy and iterate

4. **Yield-split SBF program** — `signal/programs/yield-split/`. Initialize,
   mint ingot, compose, harvest, claim. Test on devnet with mock chain-log
   proofs.

5. **Trebuchet .launch consumer** — Open `.launch` files, validate signatures,
   pre-fill launch wizard. First cut: token + pools only. Second cut: NFT
   packs + yield-split.

6. **Ruby High migration** — Replace `core-pack-nfts.ts` and `hall-pass-nfts.ts`
   with packnft CLI calls. Delete ~4,300 lines of TypeScript.

### Deferred (explicitly out of scope for now)

- #480 on-chain anchoring (needed for full provenance, but furnace works without it)
- RATi Operating System (needs its own spec, repo, and build plan)
- Agent modules in `.launch` spec (split into separate extension spec)
- Cross-chain furnace (EVM, SVM — Solana first)
- Multi-operator Signal federation with cross-station furnace arbitration

## What to stop doing

**Stop writing new design docs.** The design surface is large enough. We have
16 documents. More docs won't clarify the path — building the transaction layer
will. Any new design questions should be answered in code, not in markdown.

**Stop elaborating the agent OS in the .launch spec.** It's a legitimate concept
but it's pulling the spec away from its implementable core. Split it.

**Stop treating the build plan as sequential.** Phase 2 (txn building) blocks
the furnace and yield-split, but Trebuchet's .launch consumer and Ruby High's
migration can be developed in parallel by different people.

## The state of the thesis

The central thesis holds: **value is created by labor in Signal, identity is
conferred by the RATi registry, liquidity is deployed by Trebuchet, and the
.launch file is the contract between them.** Every design choice — where the
code lives, what each repo owns, how the furnace bridges memecoins to RATi —
follows from this.

The three-project split has survived scrutiny. The yield-split design connects
Signal's cargo identity to on-chain NFTs without inventing anything new. The
furnace closes the economic loop by giving external memecoins a productive use.

The risk is not that the design is wrong. The risk is that we keep designing
instead of building. The gap between what exists (catalog, reveal, metadata)
and what's needed (transaction building) is narrow and well-defined. Close it.
