# LP engineering for v2: dynamic fees, DLMM, and a modular fee claimer

Status: proposal for review. Nothing here sends a transaction.

This document is the design for the pre-release v2 LP surface:

1. **Dynamic fee support** on Raydium CLMM and Meteora DAMM v2 (currently
   filtered out / hardcoded flat).
2. **Meteora DLMM as a launch venue** (currently read-only).
3. **A modular fee claiming and routing daemon** that runs in either
   Trebuchet or a hosted sealed runner, over a shared `@trebuchet/claimer`
   core.
4. An honest **fee-income surface** (actuals, not projections).
5. Landing the in-flight **airdrop-batch** work.
6. **Support-position lifecycle** (cap-aware at launch, manual redeploy).

It is written after a review of the current code. Every claim below cites the
module it comes from; where a capability does not exist, that is stated
explicitly.

---

## 1. Review summary (what is actually in the tree)

### 1.1 Raydium CLMM launch venue — mature

`lpService.js` + `lpMath.js` + `lpFeeTiers.js` + `lpDistribution.js` +
`lpMintCompat.js` implement the full launch: pool creation, main/ladder
positions, single-sided support layers, Burn & Earn locking
(`lockAllPositions`, Phase 3), Fee Key transfer (Phase 4), resume via
on-chain reconciliation, Token-2022 compatibility checks, and a funding
estimator. `liquidityExecution.js` wraps pool/position/lock actions in the
prepared-transaction runtime (plan hash → approval → execute → check → journal),
with derived signer keys per action.

Fee tiers come from `api-v3.raydium.io/main/clmm-config`
(`getClmmFeeTiers()`), normalized by `normalizeFeeTierList(lpFeeTiers.js)`.

### 1.2 Meteora DAMM v2 launch venue — locked pool, claim code already written but dead

`dammV2Service.js` creates a permanently locked, single-sided pool
(`isLockLiquidity: true`), always collects fees in the quote side
(`CollectFeeMode.OnlyB`), and exposes:

- `claimFees({ connection, owner, position, commitment, receiver })` —
  claims accrued SOL fees from a locked position; returns
  `{ signature, lamportsReceived }`.
- `listPositions({ connection, owner })` — positions with
  `unclaimedQuoteLamports`.

**These two functions have no callers anywhere in `src`, `server.js`, or the
packages** (verified by grep). The capability to harvest a large part of the
fleet's fees already exists and is unreachable. `packages/core/src/damm-v2-plan.js`
carries the pure planning (price range, cost).

### 1.3 Raydium CLMM fee claiming — SDK supports it, Trebuchet does not

The pinned `raydium-sdk-v2` exports `Clmm.harvestLockPosition(props)` and the
`LockClPositionLayoutV2` layout. `clmmLockEvidence.js` already finds a locked
position's lock account (`findClmmPositionLock`) and decodes it
(`decodeClmmLock`), including the Fee Key mint. So the on-chain identity for a
harvest exists; there is no claim/harvest execution anywhere in the app.

### 1.4 Fee tier model — dynamic configs are actively excluded

`normalizeFeeTierList` filters out dynamic-fee configs
(`isDynamicFeeConfig`, Raydium CLMM upgrade, May 2026). The code comments and
the glossary state the reason precisely: every downstream consumer — the
picker, the funding estimate, the "Fee Key income projection", the fee-tier
glossary — treats `tradeFeeRate` as the pool's **fixed** fee. Offering a
dynamic config as if it were static would misstate the fee and misprice the
estimate. That is the right instinct; this design keeps the honesty property
and adds the model to support it.

### 1.5 Flywheel policy — milestone 0 exists, the executor does not

`packages/core/src/flywheel-schedule.js` is a pure, tested `decideCrank`
with `mode: static | rotating`, per-crank/per-day spend ceilings, slippage,
cooldown, kill switch, and drift trigger. It has **no `fee-routing` mode** and
no executor. `docs/flywheel-rotation.md` is the authoritative plan for what a
running flywheel must look like (fee routing first, rotation later; no `add`
output; no rotation of locked positions; disclosure). Milestones 1b+ are open.

### 1.6 Sealed runner — packet transport live, execution gated

`packages/runner` verifies hash-pinned packets and answers `503 NOT_READY`
for launch execution until the Core custody gate opens. It depends only on
`@trebuchet/core` + `tar`, runs per-operator on fly.io with no volumes.
It is the natural future host for a crank daemon, but nothing crank-shaped
exists in it.

### 1.7 Venue reading — broad and read-only

`venuePoolService.js` decodes Orca, Meteora DLMM, Meteora DAMM v2 pools
on-chain; `onChainPriceService.js` prices tokens from on-chain pools;
`hubPoolService.js` finds SOL pairs via DexScreener/GeckoTerminal/Helius.
DLMM today is a read-only venue: no `@meteora-ag/dlmm` dependency, no bin
math, no launch planner, nothing that builds a DLMM transaction.

### 1.8 Airdrop batching — nearly done, uncommitted

On `airdrop-batch` there is uncommitted work: a new
`packages/runtime/src/token-transfer-batch.js`, `airdropExecution.js` and
`walletExecution.js` using it, plus `test/e2e/runtime-airdrop-batch-localnet.mjs`
and fixture updates. It is close but not landed.

### 1.9 Support positions — openable and withdrawable, not self-maintaining

`packages/runtime/src/support-position-plan.js` and
`position-withdrawal-plan.js` give single-sided quote support with full
plan/approve/execute/recover discipline. `lpMath.js` has
`computeCappedSupportTicks` (arbitrage-aware support cap) but it is only used
for buy-support on *existing* pools, not for launch support layering. There is
no redeploy path: when price falls through a support band, the unspent quote
sits withdrawable and nothing repositions it.

---

## 2. Design principles

From ENG.md, the flywheel doc, and the existing runtime discipline:

1. **Locked stays locked; moving is a different product.** Anything that moves
   liquidity (rotation, compounding, dynamic re-weighting) is opt-in,
   disclosed in plan + report, and scoped to the quote/flywheel side only.
   Fee routing never touches the launched mint, metadata, or supply.
2. **Policy and execution are separate contracts.** `decideCrank` runs
   immediately before acting; ceilings are enforced at the signer, not
   displayed. Static is the default and the safe state.
3. **Every irreversible phase persists a checkpoint; resume, never blind
   retry.** The `alreadyDone` discipline from the launch applies to claims and
   cranks exactly as it does to pools and locks.
4. **The renderer proposes; the server normalizes, revalidates, authorizes,
   executes, journals, proves.** All claim/route authority lives server-side
   (Electron) or runner-side (hosted), never in a browser.
5. **Estimate = estimate, actual = actual.** A dynamic fee tier is never
   presented as a fixed number. Where income is measured (after the claimer
   exists), the report shows realized fees.
6. **Engineered surfaces must be testable without a validator or an indexer.**
   Pure math/policy in `@trebuchet/core`, chain work injected, fixtures for
   account layouts, localnet e2e for real transactions.

---

## 3. The modular claimer — `@trebuchet/claimer` (centerpiece)

One package, two hosts. All fee logic — inventory, valuation, claim, routing,
scheduling, journaling, proof — lives in `packages/claimer`, usable by:

- **Trebuchet desktop**: local HTTP routes under `/api/v2/claims/*` and
  `/api/v2/flywheel/*`, driven by the operator's wallet + PIN. Manual single
  claims and schedule-driven cranks both route through the same core.
- **Sealed runner**: a hosted daemon. The runner already has the packet
  trust model; it gains a crank surface (`/v1/cranks*`) and a loop entry point.
  The keeper key is generated inside the runner like launch wallets are.

Nothing in `packages/claimer` may import Electron, Express, or the runner
server. Dependencies: `@solana/web3.js`, the pinned Raydium SDK, the pinned
`@meteora-ag/cp-amm-sdk`, later `@meteora-ag/dlmm` (see §5), and
`@trebuchet/runtime` primitives (store, prepared transactions).

### 3.1 Module map

```text
packages/claimer/src/
  index.js            public façade, feature flags
  inventory.js        position discovery per venue, normalized rows
  unclaimed.js        per-position claimable fee readers (venue adapters)
  policy.js           fee-routing schedule mode (extends flywheel-schedule)
  claim.js            claim execution per venue (prepared-tx discipline)
  route.js            outputs after a claim: buyback-burn / transfer / holders
  store.js            crank journal + schedule + kill switch (runtime store)
  proof.js            per-crank proof rows, reconciles against balances
  venues/
    clmm.js           Raydium CLMM: locked-position findings + harvest
    damm.js           Meteora DAMM v2: move claim/listPositions here
    dlmm.js           Meteora DLMM: claim + unclaimed (lands with §5)
packages/claimer/test/  unit + fixture tests (no validator)
```

### 3.2 Inventory — one normalized row per claimable position

```jsonc
{
  "venue": "raydium-clmm" | "meteora-damm-v2" | "meteora-dlmm",
  "poolId": "…",
  "positionId": "…",
  "positionNftMint": "…",
  "feeKeyMint": "…",            // CLMM lock NFT, DAMM position NFT
  "owner": "…",                 // wallet that holds the NFT / lock owner
  "locked": true
}
```

Sources:

- CLMM: scan the lock program for `LockClPositionLayoutV2` matching known
  position accounts (`findClmmPositionLock` per position, or a
  program-account scan filtered by the collection of launch position
  accounts from launch journals / Fee Key mints under the operator's
  wallet). Also enumerate the operator's held Fee Key NFTs → locks.
- DAMM v2: `listPositions` (already written; moved here).
- DLMM: after §5, the DLMM position listing + lock state.

Inventory is a read: it writes nothing and can always be recomputed from the
chain. It is the single data source for both the dashboard (§6) and the
crank loop.

### 3.3 Unclaimed fees — the actuals reader

The dashboard and the crank trigger both need "how much is claimable now."

- CLMM: standard Uniswap-v3 fee-growth math over the decoded pool + position
  (`feeGrowthGlobalX64` per side, `feeGrowthInsideLastX64`, in-range
  liquidity) using the SDK's `TickMath`/`SqrtPriceMath`/`LiquidityMath`
  primitives already pinned; value in SOL via `onChainPriceService`.
- DAMM v2: `listPositions` `unclaimedQuoteLamports` (exists).
- DLMM: position `feeX`/`feeY` accumulators (with §5).

Output per position: `{ unclaimedLamports, unclaimedUsd, lastClaimedAt? }`,
plus pool TVL/volume context for the report.

### 3.4 Policy — add `fee-routing` mode (flywheel milestone 1b)

Extend `flywheel-schedule.js`:

```jsonc
{
  "schema": "trebuchet-flywheel-schedule/v1",
  "mode": "fee-routing",                 // new
  "outputs": [
    { "type": "buyback-burn", "pct": 60 },
    { "type": "transfer",     "pct": 20, "wallet": "…" },
    { "type": "holders",      "pct": 20 }
  ],
  "claimThresholdSol": 0.02,             // trigger: claimable fees ≥ this
  "minIntervalSec": 900,
  "maxSpendSolPerCrank": 0.05,           // swap spend bound, enforced at signer
  "maxSpendSolPerDay": 0.5,
  "maxCranksPerDay": 12,
  "slippageBps": 100,
  "cooldownAfterFailureSec": 1800,
  "killSwitch": false
}
```

`decideCrank` gains a fee-routing branch: mode requires `outputs` summing to
100, no `add` output type exists (rotation stays out of scope), and the
trigger is `claimableGloballyUsd >= claimThresholdSol` rather than drift
(drift only exists for `rotating`). Every knob is range-clamped exactly like
the existing one; `static` remains the default. Missing/unknown mode →
`static`, unchanged.

**Keeper custody**: fee-routing requires the keeper (desktop operator or
runner) to hold the Fee Key NFTs. Fee keys transferred to third parties are
not part of a keeper schedule. The plan and report name the keeper and the
fee-key holders (milestone 1 of the flywheel doc).

### 3.5 Claim — prepared-transaction discipline per venue

A claim is a mutation with real money, so it uses the same contract as
`liquidityExecution.js` / `position-withdrawal.js`:

1. `buildClaimPlan({ venue, positionId, minContextSlot, expectedGenesisHash })`
   — read finalized position/pool/lock state, prove the position identity and
   lock state, derive the exact receiver ATA, compute fee ceiling;
2. reserve wallet (`OPERATION_IN_FLIGHT` mutex), save plan hash + approval
   with `maxSpendLamports` bound;
3. execute:
   - CLMM: `raydium.clmm.harvestLockPosition({ lockData, ... })` with the
     decoded lock from `clmmLockEvidence`;
   - DAMM v2: `claimFees` (moved into the claimer, same code path);
   - DLMM: its claim instruction (with §5);
4. verify: after-balance delta ≥ expected-minus-fees, signature recorded,
   journal row `claim/{venue}/{positionId}` with receipts;
5. on failure: classify transient vs deterministic vs unknown; never retry
   blind — the prior tx may have landed (the `checkResult`/`allowExisting`
   pattern from the liquidity runtime).

A claim that succeeds leaves the fees in the operator wallet (or receiver).
Nothing is routed automatically unless a schedule says so and the signer
enforces the caps.

### 3.6 Route — the three allowed outputs

After a successful claim, `route.js` executes the schedule's outputs in
declared order. Each output is one bounded operation, journaled separately
(down to `route/{crankId}/{output}` granularity), so a failure mid-crank
resumes rather than re-executes.

- **buyback-burn**: swap quote/fee tokens into the launched token via the
  existing swap machinery (`swapService.discoverSwapRoute` /
  `discoverJupiterRoute`, slippage bound from the schedule) then burn the
  received amount (add a small burn helper; none exists today). Burn proof =
  burn signature + supply pre/post. Never swaps near the launched mint's
  authority (already revoked post-launch) and never uses locked liquidity.
- **transfer**: reuse `@trebuchet/runtime` token transfer with exact output.
- **holders**: reuse the airdrop rows/batch machinery (which §8 lands first)
  with a snapshot taken at crank time; per-recipient delivery proof.

**No `add` output.** Adding liquidity is rotation and waits for the
rotational-vs-locked milestone (flywheel doc, deferred).

### 3.7 Journal, proof, budget

- Crank journal in the runtime SQLite store (`runtime-flywheel/v1`): schedule
  id + digest, decision, claimed fees, outputs, tx ids, balances before/after,
  failure receipts. Idempotent at every boundary.
- Every crank appends to the launch proof trail and the report
  (`launchReportService.js` + `proof-integrity`), fed into the same
  fingerprint/audit machinery; the release gate's evidence list grows a
  "claim records" clause.
- Spend goes through the shared launch budget ledger (per
  `docs/architecture-review.md`): reserve before signing, settle after
  terminal receipts, funds returned on failure.

### 3.8 Host A — desktop

- `GET /api/v2/claims/positions` → inventory + unclaimed (screen state, no
  action).
- `POST /api/v2/claims/execute` → manual single-position claim (plan →
  review modal → approval → execute → receipt).
- `POST /api/v2/flywheel/schedule` → save schedule (validated, digest-ed).
- `POST /api/v2/flywheel/crank` → run one crank now (respects limits).
- `POST /api/v2/flywheel/kill` → kill switch.
- Routes behind `apiSessionMiddleware`; nothing claim-related is exempt.

### 3.9 Host B — sealed runner

The runner already verifies packets; a crank is a *very small packet*:

- `POST /v1/cranks` uploads `crank-packet/v1` (schedule JSON + fee-key
  inventory manifest, hash-pinned like launch packets); `POST /v1/cranks/:id/run`
  runs one due crank; `GET /v1/cranks/:id` / `…/proof` return status and the
  proof bundle.
- Journal and keys stay in the machine's ephemeral filesystem (consistent
  with the no-volumes model); the proof bundle is the only durable output and
  the operator pulls it back, exactly like a launch packet's return proof.
- Kill switch is a runner env/config toggle (`TREBUCHET_CRANK_KILL=1`),
  polled before each step.
- Keeper key generation matches the runner's existing wallet generation (in
  the ephemeral state dir, never exported on disk outside it).

---

## 4. Dynamic fees (Raydium CLMM + Meteora DAMM v2)

The blocker today is model honesty (§1.4). Fix the model, then the venues.

### 4.1 Fee tier model becomes `feeModel`-aware

`normalizeFeeTierList` keeps dynamic configs but tags them:

```jsonc
{ "index": 6, "tradeFeeRate": 250, "tickSpacing": 60,   // base bps
  "feeModel": "dynamic", "dynamicControl": true }
```

- Absent `dynamicControl` → `feeModel: "fixed"` (backward compatible).
- `isDynamicFeeConfig` stays, but now it classifies instead of filters.
- Consumers change per their contract:
  - **Picker**: dynamic tiers show `"dynamic · base 0.025%"` with a
    disclosure line; never a bare number.
  - **Funding estimate**: fee component rendered as a range
    (`base` … `base × worst-case multiplier`) where the multiplier is
    disclosed as an assumption; a one-number projection for a dynamic tier
    is a bug.
  - **Fee Key income projection**: for dynamic tiers, replace the single
    number with `"realized after launch; claimable via the claimer"` once
    §3 exists — which is the honest successor: measure, don't project.
- Pool creation passes the dynamic `AmmConfig` index like any other; the
  on-chain dynamic configs are pinned candidate indexes (mirroring
  `FALLBACK_FEE_TIERS`), cross-checked against `getClmmConfigs()` at build
  time so a removed index fails the same way a missing fee tier fails.

### 4.2 Meteora DAMM v2 — real fee schedulers

`buildLockedPoolTransaction` currently hardcodes
`BaseFeeMode.FeeTimeSchedulerLinear` with `startingFeeBps == endingFeeBps`
(flat fee pretending to be a scheduler). Make the fee surface a plan
parameter through `meteoraPoolParams` and `alloc.damm`:

- `feeModel: "fixed"` (default, exactly today's curve),
- `feeModel: "ramp"` — scheduler: elevated `startingFeeBps` decaying to
  `endingFeeBps` over `totalDuration` (captures launch-window volume,
  decays to long-run fee; the memecoin launch pattern),
- `feeModel: "marketcap"` — fee scales with pool market cap
  (`FeeMarketCapSchedulerLinear/Exponential`; cheap early, normal late, or
  the operator's chosen direction — must be disclosed per direction),
- `feeModel: "rate-limiter"` — MEV/spam cooling (`RateLimiter`).

Disclosure rules: the plan and published report state the full fee schedule
(params, not just a bps number); the estimator integrates the schedule over
the horizon for projected income (still a range under volatility).
`CollectFeeMode` stays `OnlyB` for v2 — fees in SOL is what the claimer
harvests; `Compounding` is a different economic promise and is explicitly out
of scope for v2 (flagged in §11 decisions).

---

## 5. Meteora DLMM as a launch venue

DLMM is concentrated liquidity in discrete bins — a natural fit for meme
volatility bands and the only major venue the launcher cannot open today.

### 5.1 Verification spike first

Before promising "locked", verify on-chain what a DLMM position's lock story
is (Meteora DLMM positions are NFTs; is there a lock/vesting option the same
way Burn & Earn locks Raydium CLMM, or a perpetual-lock parameter?). **The
product must not claim locked liquidity for a venue that cannot prove it.**
The spike answer decides whether DLMM launches are (a) locked, (b) locked via
a supported mechanism, or (c) disclosed as a non-locked complementary venue.
This is a gate for §5.3, not for the planner work.

### 5.2 Planner (pure, `@trebuchet/core`)

`packages/core/src/dlmm-plan.js`, mirroring `damm-v2-plan.js` and `lpMath`:

- Inputs: supply, supply percent, start price or target mcap, `binStep`
  (the fee-tier analog — DLMM price granularity per bin), range multipliers,
  quote mint, fee config.
- Outputs: bin IDs (lower/upper around start bin), per-bin active liquidity
  allocation, participation/base/variable fee selection with the dynamic-fee
  toggle disclosed, rent/cost estimate, and **fee estimate as a range**.
- All bin math mirrored from the pinned `@meteora-ag/dlmm` SDK helpers (like
  `lpMath.js` mirrors the Raydium SDK) with unit tests; never hand-rolled
  formulas.

### 5.3 Execution (runtime)

- Add `@meteora-ag/dlmm` (verify peer compatibility with the pinned
  `cp-amm-sdk` version).
- `packages/runtime/src/dlmm-position-plan.js` + claim/withdraw adapters
  following the `support-position` / `position-withdrawal` shape
  (plan → approve → execute → recover, exact unsigned amounts, ATA and rent
  checks).
- Extend the launch flow: a fourth venue option alongside SOL / hub / stable
  pairs. `createPoolsAndPositions` gains a DLMM branch; the launch journal,
  report, and proof record DLMM positions with the same row discipline
  (position NFT, bin range, amounts, lock state).
- The claimer's DLMM adapter (§3) consumes the same planner outputs, so fee
  harvesting works for DLMM launches the day the venue lands.

---

## 6. Fee income surface (state, not progress)

Per DESIGN.md, the surface shows facts, each with evidence:

- Per pool/venue row: `claimed X SOL · unclaimed Y SOL · last claim <txid> ·
  schedule <static|fee-routing> · next <crank due/off>`.
- Values come from the claimer's inventory + unclaimed readers (§3.2/§3.3);
  there is no local "projection" number in this view.
- Income projection stays in the planning flow only, and for dynamic tiers it
  is a range or a "measure after launch" statement (§4.1).
- Only the single next authorized action is offered (a claim button, a crank
  button, or nothing).

---

## 7. Airdrop batching (land first)

The `airdrop-batch` branch is the base for this design branch's review but is
a separate change. Plan:

1. Finish `token-transfer-batch.js` (already committed? no — the working tree
   held it; it is stashed on `airdrop-batch`), complete
   `test/e2e/runtime-airdrop-batch-localnet.mjs`, run the localnet e2e.
2. PR + merge. It unblocks the holders output of §3.6 (batch transfers to
   snapshot rows) and de-bottlenecks large airdrop distributions.

---

## 8. Support-position lifecycle

Two bounded improvements; neither moves locked liquidity.

### 8.1 Cap-aware support at launch

Reuse `computeCappedSupportTicks` (arbitrage-aware cap, currently used only
for buy-support on existing pools) for *launch* support layering:

- At plan time, discover the cheapest other pool selling the token
  (`venuePoolService`/`onChainPriceService`) and clamp the support top to the
  arbitrage cap, matching the existing pool behavior.
- If no other pool exists (fresh launch), the cap is the current launch
  price band; support below it is normal.
- Plan + estimator show the cap and refuse a support band that would be
  drained at once.

### 8.2 Manual redeploy runbook

When price falls through a support band, the unspent quote is withdrawable
(`position-withdrawal` already does this). Add a **manual** redeploy flow:

- `withdraw` the exhausted band (existing runtime), then
- `re-open` a new single-sided quote position at the new current price band
  (existing support-position runtime), journaled as one lifecycle row.

Explicitly not automatic: unattended re-weighting is rotation and waits for
the flywheel milestones. The redeploy action is offered only when the band is
fully below current price and the unspent quote is verified present.

---

## 9. Suggested sequence

| Phase | Work | Depends on | Exit criteria |
|---|---|---|---|
| P0 | Land `airdrop-batch` (§7) | — | merged; localnet e2e green |
| P1 | Fee tier model `feeModel` + Raydium dynamic tiers in picker/estimator/projection (§4.1) | P0 | unit tests; estimator shows ranges for dynamic; CI green |
| P2 | Meteora DAMM v2 fee schedulers in plan + report (§4.2) | P1 | localnet pool creation with ramp fee; report prints full schedule |
| P3 | Claimer core: policy `fee-routing` + inventory + unclaimed + CLMM harvest + DAMM claim (§3.1–3.5) | P1 | unit + fixture tests; localnet claim end-to-end for both venues; devnet drills |
| P4 | Route outputs: buyback-burn, transfer, holders (§3.6 + §3.7) | P3, P0 | localnet crank with all outputs; resume drill interrupted between claim and route |
| P5 | Desktop hosts: claim routes + schedule/crank/kill + fee-income surface (§3.8, §6) | P3, P4 | e2e flows in app; dashboard rows show actuals |
| P6 | Runner host: `/v1/cranks*` + crank packet + loop (§3.9) | P4 | runner test suite; crank packet verified; proof bundle returned |
| P7 | DLMM venue: verification spike → planner → execution → claimer adapter (§5) | P5 | spike answer recorded; localnet DLMM launch + claim; report/proof rows |
| P8 | Support lifecycle: cap-aware launch support + manual redeploy (§8) | P2 | unit + localnet drills; redeploy never touches locked positions |
| P9 | Mainnet field evidence per flywheel milestone 4 + release gate updates | P6 | live crank with proof trail and reconciled balances; gate checks claim records |

P0–P2 are the "final polish" items and can ship before the claimer; P3–P6 are
the daemon (modular — desktop and runner reuse the same package); P7/P8 are
the larger venue/lifecycle work.

---

## 10. Test strategy

- **Pure policy**: `flywheel-schedule` fee-routing mode — mode/output
  validation, sum-to-100, `claimThresholdSol` trigger, kill switch, ceilings,
  `static` default (extend existing test file).
- **Model**: fee tier `feeModel` normalization incl. backward compatibility;
  estimator range output for dynamic tiers; Meteora scheduler param
  translation.
- **Fixtures**: `LockClPositionLayoutV2` decode, CLMM fee-growth
  computations, DAMM v2 `listPositions` payloads, DLMM bin planner outputs.
- **Localnet e2e** (following `runtime-*-localnet.mjs`): CLMM harvest after a
  real swap; DAMM v2 claim; crank with buyback-burn + transfer + holders;
  interrupted-claim resume; exhausted support withdraw → redeploy.
- **Runner**: crank packet hash verification, `503`-style gates for missing
  schedule, proof bundle shape, kill switch honored mid-crank.
- **Devnet drills** (flywheel doc acceptance): two consecutive cranks with the
  second refused by `minIntervalSec`; interrupted claim+route resume without
  double-claim; slippage abort leaves funds intact; daily spend/crank ceilings
  `pause`; kill switch stops.
- **Mainnet**: funded transaction tests require explicit human authorization
  (policy + repo rule) — schedule as P9 with the human.

---

## 11. Open decisions for the operator

1. **Dynamic-tier exposure**: allow operators to *choose* dynamic tiers on
   Raydium (yes per this design, with ranges) — or restrict dynamic tiers to
   launches that already run the claimer, where income is measured? (Default:
   allow with disclosure.)
2. **Meteora `CollectFeeMode.Compounding`** is excluded from v2; confirm it
   stays out (it changes the locked-liquidity promise).
3. **DLMM locking promise**: run the §5.1 verification spike before deciding
   whether DLMM venues market themselves as "locked". Review the spike result
   together.
4. **Keeper custody for fee routing**: when schedules exist, fee keys must
   stay with the keeper (desktop operator or runner). Confirm that transferring
   fee keys to third parties and scheduling cranks over them are mutually
   exclusive in the UI.
5. **Runner durability**: crank journals on the ephemeral runner FS with proof
   bundles pulled back — acceptable, or do you want the runner to gain a
   single volume for journals? (Default: ephemeral, no volumes.)

---

## 12. File map (where each change lands)

| Change | Files |
|---|---|
| fee model | `lpFeeTiers.js` (normalize), `packages/core/src/lp-constants.js`, picker/glossary/projection in `public/v2/app.js`, `v2LaunchPlan.js` |
| Meteora fee schedulers | `dammV2Service.js`, `packages/core/src/damm-v2-plan.js`, `lpService.js` (`meteoraPoolParams`), plan serializer |
| claimer core | new `packages/claimer/` (§3.1 map), `packages/core/src/flywheel-schedule.js` (fee-routing mode) |
| claim execution | reuse `liquidityExecution.js` prepared-tx pattern; move `dammV2Service.claimFees/listPositions`; new CLMM harvest via `clmmLockEvidence.js` + SDK |
| desktop hosts | `server.js` routes, `public/v2/app.js` (fee income surface), runtime store collection |
| runner host | `packages/runner/src/server.mjs` (+`crank-loop.mjs`), crank packet builder in `scripts/` |
| DLMM | `package.json` dep, `packages/core/src/dlmm-plan.js`, `packages/runtime/src/dlmm-position-plan.js`, `lpService.js` venue branch, claimer `venues/dlmm.js` |
| support lifecycle | `lpMath.js` (launch-time cap use), `supportPosition*.js`, new redeploy orchestration route |
| landing airdrop-batch | `token-transfer-batch.js`, `airdropExecution.js`, `walletExecution.js`, tests (on the `airdrop-batch` branch) |
| docs | ENG.md source map, `docs/flywheel-rotation.md` (1b/3 milestones), GAP_ANALYSIS.md, README |