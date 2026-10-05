# Fee NFT security review pack

Status: internal code review and tests. Independent review and funded devnet venue tests are the next release steps. New mainnet backing is gated in the app.

## Review scope

Review `programs/fee-vault/src/lib.rs`, `security_tests.rs`, `feeVaultClient.js`, `feeNftSafety.js`, `feeNftService.js`, `feeNftRoutes.js`, `feeNftPlan.js` and `feeNftStore.js`. Include `server.js` wallet admission, the PIN and secret store, and the Wallet Standard claim path in `public/v2/fee-nfts.js`.

The v2 vault permanently holds one native locked position NFT or Fee Key. Core NFT ownership grants the right to claim a fixed share of both trading-fee tokens. Paid amounts remain attached to the asset address. Each vault has separate token accounts and accounting. All vaults on a network share the same program code.

Use the PR's final commit as the review baseline. The state magic is `TFEEV002` and the proof schema is `trebuchet.fee-nfts.v2`. Registration, activation and claims now include the collection account. Record the commit and regenerated binary hash in the audit report. The package lock and Cargo lock belong to that same baseline.

## Authority policy

- The app and contract check the raw Core plugin registry on assets and their collection. Permanent transfer, burn and freeze powers, execution plugins, compression, unknown types and external plugins are refused. Parsing checks lengths, offsets, duplicate types and plugin bytes. SDK decoders can hide unknown registry types, so the checks retain raw types.
- Claims check the NFT's current owner, signature, original collection, collection controls and recorded asset address. The owner receives funds into their own token accounts.
- Fee currencies require revoked freeze authority. SPL and metadata-only Token-2022 transfers are supported. Transfer fees, hooks and permanent token delegates need a separate implementation.
- Native position NFTs use venue-specific controls. Meteora's native NFT may retain its verified pool account as freeze authority. That exception applies to the backing NFT alone. Its supply is one and decimals are zero. Raydium's native Fee Key uses SPL Token. Backing mint extensions accept metadata and native MintCloseAuthority only.
- Activation checks native custody, the source and pool program owners, discriminators, position address, pool mints and fixed shares. DAMM token flags bind its token programs. Claims and harvest bind the vault's canonical token accounts.
- Vault signing reaches only fixed fee-claim instructions in the known venue programs. Review every native account and nested program in these calls. Venue upgrades remain an upstream trust boundary.
- The app requires an immutable vault deployment with matching binary hash. Source, compiler and lockfile must match the reviewed release. The mainnet setup gate uses actual genesis hash and applies before any setup send.

## Invariants for the auditor

1. Total claims for each currency remain at or below lifetime receipts, including donations and rounded amounts.
2. A transfer changes future claim authority and keeps the asset's paid history.
3. Every share and its weight stays fixed after activation.
4. A creator can recover native backing during setup. Active custody follows the permanent share rules.
5. Account substitution, collection changes, fake signers and malicious native calls preserve funds and state.
6. A failed token transfer rolls back accounting and both payouts. Inspect frozen destinations and malformed token data.
7. Unknown send results retain the signed bytes, wallet reservation and spend cap. A retry uses the original transaction until finality or expiry is resolved.
8. Proof imports verify the network, configured program, source, raw NFT controls and exact on-chain state.

## Verification

Use Node 22, Rust and Solana/Agave with `cargo-build-sbf`.

```sh
npm run build:c
node --test test/fee-nft-safety.test.mjs test/fee-nfts.test.mjs
npm run test:fee-vault
npm run build:fee-vault
node scripts/fee-vault-hash.mjs
npm run check:package
```

The Rust tests include malformed instructions, Core registry mutations, permanent delegates, freeze authorities, unsafe token extensions, unsigned registration, share bounds and 10,000 interleaved claims. The JavaScript tests compare Core base formats with official SDK serializers and check mainnet gating, extensions and transaction recovery.

Run the Core/Meteora validator test and the Raydium validator test using the commands in `fee-nfts.md`. Record upstream binary hashes and the wrapper hash. The Meteora test creates genuine local pool trades. The Raydium test copies public state and seeds owed fees in local genesis. These are separate forms of test evidence.

Saved local results are in `docs/validation/fee-nfts/security/`. The wrapper build hash is `1ed4ef396f1cb33bcc64fa92855e8f7d22503ba1d69477964b2bbae46add476a`. The build used Agave 2.3.13, platform-tools 1.48 and SBF Rust 1.84.1. Changes to the source or compiler require fresh evidence.

## Release review

Before enabling new mainnet backing, record an independent audit for the exact source and binary, resolve its findings, run funded devnet tests for each venue, and inspect the proposed deployment. Retain program IDs, network genesis, compiler versions, lockfile and binary hashes, public test signatures and spending receipts. Use a fresh program address for this v2 format.

Permanent deployment fixes the code and custody rules. A serious shared-code bug could trap fee access across collections. Any migration or recovery design needs its own reviewed holder authority rules. The mainnet release decision must account for this risk.

Local wallet security also depends on the active secret backend, the signed app build and dependency review. See `SECURITY.md` for these app-wide boundaries. Treat green CI as test evidence. The independent audit is a separate result.

## Questions for the independent reviewer

- Check retained collection update authority and owner delegates. A later plugin or membership change can stop a share's claims. Decide whether the release needs an authority revocation step before permanent backing.
- Review every account forwarded to the native venue instruction. Include nested program checks, token program selection, frozen destinations and full transaction rollback.
- Check the RPC trust boundary. The app reads genesis, program bytes and authority state through its configured RPC. Verify the release policy for that endpoint and the holder's displayed network.
- Review upgrade and recovery limits. The app's mainnet gate covers its own setup path. The contract accepts calls from other clients after deployment. Deployment and audit approval therefore need their own release controls.
- Reproduce the recorded local tests, then run funded devnet tests for both venues. Keep copied state and seeded fees clearly marked in the test report.

The requested audit deliverables are a finding list with severity and source lines, a check of each invariant above, test evidence, the reviewed commit and binary hash, and a written release decision. Add resolved findings and any accepted risks to this pack before a mainnet release.

## Layout references

- [Metaplex Core program and clients](https://github.com/metaplex-foundation/mpl-core)
- [Core plugin authority rules](https://www.metaplex.com/docs/smart-contracts/core/plugins)
- [Solana token authorities](https://solana.com/docs/tokens/basics)
- Meteora account discriminators and offsets are checked against the installed `CpAmmIdl`.
- Raydium account offsets and native harvest order are checked against the pinned Raydium SDK and public lock state.
