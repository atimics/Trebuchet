# Shared execution runtime

This work implements the architecture requested in the attached review. The target is one execution engine shared by desktop, CLI, and an operator-owned runner.

## Completion requirements

- [ ] Journal commits succeed before spending; damaged input stays available for recovery.
- [ ] SQLite holds durable launches, operations, receipts, and recovery state. Existing JSON journals migrate with their original files preserved.
- [ ] One local process owns each profile. Desktop and CLI attach to it through an authenticated connection.
- [ ] Stable operation IDs survive restart. Transaction status and chain state determine recovery after an interrupted submission.
- [ ] ExecutionEngine exposes prepare, executeNext, resume, and getStatus. HTTP routes call ordinary engine methods.
- [ ] Desktop starts a separate runtime process. Closing a client has defined behavior for active work.
- [ ] Core exposes browser-safe plans, costs, validation, and proof rules. Hosts supply storage and signer interfaces.
- [x] Browser and CLI share calculations. Renderer source is split into launch, wallet, recovery, discovery, and proof features.
- [ ] Fresh funded wallets require encrypted recovery storage. Existing recovery material survives migration.
- [ ] Runner retains durable state and operator-controlled recovery material through final sweep verification.
- [x] Packet paths and entry types are checked before extraction, with bounds on size and entry count.
- [x] Every packet input is covered by the manifest. Rebuilt configuration matches the plan.
- [x] Signed spending approval binds the complete manifest, operator, network, wallet, expiry, and spending ceiling.
- [ ] Live CLI and runner use the shared engine and its recovery checks.
- [ ] Tests cover competing clients, interrupted submission before receipt storage, and liquidity recovery.
- [ ] Relevant repository checks and CI pass. Work is committed and delivered through a PR.

## Delivery order

1. Journal and packet boundaries, with regression tests.
2. Durable operation storage and runtime ownership.
3. Shared engine, platform interfaces, browser rules, renderer modules, and live command adapters.

The checklist records the full requested scope. Each completion claim must cite a test or a current runtime result.

## Current evidence

The journal now throws `RECOVERY_STORAGE_UNAVAILABLE` on a failed read or commit. Corrupt bytes are preserved. A successful commit syncs the temporary file before rename and the directory afterward on POSIX. Transaction-level recording remains in the next stage.

`packages/core/test/launch-journal.test.mjs` covers corrupt input and interrupted commits. `packages/runner/test/packet-boundary.test.mjs` covers parent paths, link entries, duplicate names, expansion limits, required files, unlisted files, and config-plan agreement. The runner uses a private staging directory for each upload.

### Durable storage stage

The local API journal and saved-launch adapters now use `execution.sqlite`. Saved-launch CLI commands use the same store through the owned runtime. Legacy JSON import commits as one transaction, and the source files are preserved. The database also has immutable launch identities, operation IDs, signed transaction bytes, and receipts for the engine to adopt.

`packages/runtime/test/` covers separate writers, process death, ownership release, migration, rollback, and transaction records after a simulated broadcast. The owner module holds a real exclusive SQLite write transaction. The local API acquires it during startup. Engine and chain integration remain open requirements above.

Node 22.13 is the minimum for built-in SQLite without an extra runtime flag. CI is pinned to Node 22.23.3, and the runtime process tests were also run on that version.

### Shared browser rules stage

`@trebuchet/core/browser` now exposes planning, costs, validation, execution-context decisions, and proof checks. The browser uses the same SHA-256 code and image byte validation as Node. Existing plan digests match Node crypto, including PNG, JPEG, and GIF inputs.

The v2 page loads a generated Core bundle. Its Quick Launch costs, airdrop costs, and vanity estimates call Core. The renderer source is grouped into 46 files under `public/v2/features/`; these files retain the existing shared page scope and startup order. CI compares both shipped bundles with their source builds.

`test/web-bundle.test.mjs` exercises the actual shipped Core bundle using browser globals. It compares plans, image validation, recovery decisions, proof checks, and displayed cost values with Node. The API-backed browser smoke passed through session setup, wallet creation, the secure dialog, and a complete practice launch. The 89 architecture contract tests and package coverage also pass. Signer interfaces and engine wiring remain in the checklist above.

### Local host and CLI connection stage

Production local API startup now acquires the profile owner before creating routes. The CLI can start, inspect, and stop a real runtime. Native clients verify the owner identity and authenticate each request. An idle stop closes admission before releasing the lock. Active launch requests and background jobs hold it busy.

`test/local-runtime.test.mjs` starts two separate CLI processes together. Both attach to one real server. The server remains available after those clients exit. The test verifies token rejection, kills the owner process, attaches to a fresh owner, and stops it through the CLI. `packages/runtime/test/control.test.mjs` verifies that active requests and background jobs hold stop requests until work finishes.

The desktop process split has a prepared source edit. Automatic approval review requires explicit user approval for the change to desktop processes, IPC, and OS-keychain custody. That edit remains outside the worktree while approval is pending. The existing desktop still owns its runtime in its main process; CLI clients can attach to that owner.

### Signed packet approval stage

`trebuchet packet approve` signs `trebuchet-packet-approval/v1` with the encrypted operator key. It checks the exact plan file listed in the manifest. The envelope binds the complete manifest digest, plan digest, configured operator key, launch wallet, network, expiry, and integer lamport ceiling. The runner re-verifies the packet and the approval before accepting it as execution input.

Core tests cover signature changes, every required binding, missing trusted context, malformed signatures, expiry boundaries, and spending ceilings. Runner tests cover a configured operator, wrong keys and wallets, network changes, expired approval, and a manifest changed after approval. The CLI test signs through the real binary with an encrypted test keyfile and rejects a plan whose file bytes changed.

The wider suite also exposed a lock lifetime bug: garbage collection could close an unused SQLite owner handle. Active handles now stay referenced until explicit release. The process test forces garbage collection, verifies exclusive ownership, kills the owner, and verifies takeover by a new process.


### Transaction engine stage

`@trebuchet/runtime/engine` now exports `ExecutionEngine.prepare`, `executeNext`, `resume`, and `getStatus`. One operation holds one atomic transaction. The engine requires the profile owner, a durable store, a signer, a chain adapter, an approval check, and an operation builder with a chain result check.

The engine commits the signed bytes before broadcast. Recovery reads the saved signature first. It resends the same bytes while that transaction remains valid. A replacement requires an expired transaction plus a fresh check of the operation result. Finalized chain failures remain terminal. Failed storage writes and uncertain chain reads pause execution. Multiple engine clients share the owner's wallet admission guard.

The Solana adapter verifies every Ed25519 signature, the exact wire bytes, the fee payer, and the expected chain genesis hash. It searches transaction history during recovery. It checks finalized height and blockhash validity before expiry, then reads history again to catch a late receipt. Completion requires a finalized transaction and the operation's chain result check.

`packages/runtime/test/engine-process.test.mjs` uses a real signed Solana transaction and a local HTTP RPC fixture. The fixture accepts the bytes, kills the caller before replying, and exposes the finalized receipt to the next process. Recovery completes with exactly one send. Unit tests cover failed writes before send and after broadcast, pending results, lost ownership, competing engine clients, renewed approval at resume, and replacement after expiry.

Existing token and liquidity retry paths now propagate failed chain checks. Position and lock queries require complete responses, and lock queries use finalized state. This closes an existing path that could send again after a failed recovery read.

The engine interfaces are ready for host integration. The existing live token, upload, liquidity, and sweep services still need transaction adapters and durable spending approval. The desktop process split still awaits the pending approval described above. Live CLI and runner wiring remain in the completion checklist.


### Ordinary live service methods

Token creation, interrupted token recovery, metadata reveal, liquidity creation, liquidity recovery, and asset transfer now live in `launchExecution.js`. Each method takes an ordinary input object and explicit host interfaces. Classic HTTP routes translate success or typed errors. The v2 live dispatcher calls these same methods directly.

The service tests exercise all six methods. They verify shared wallet admission, validation before signing, liquidity failure details, saved authority choices, airdrop recovery, and recovery-key retention. A concurrent rejected request preserves the active request's lock and progress. The final sweep record commits before the wallet recovery key is removed. A failed final commit therefore preserves the key.

The runtime process test also sends invalid live HTTP requests. It verifies their error status and payload before any chain call. Browser practice launch and package coverage pass after extraction. Production transaction adapters, durable approval, and engine integration remain in the completion checklist.


### Recovery errors stop the next spend

Journal callbacks now propagate storage failures through token creation, token recovery, metadata reveal, and liquidity execution. Nested retries and phase-level error handlers preserve `RECOVERY_STORAGE_UNAVAILABLE` and `CHAIN_STATE_UNAVAILABLE`. Asset sweeps and airdrops apply the same rule. The sweep gate also requires its recovery event to commit.

Injected failure tests reproduced continued execution in the earlier code. They now verify that a failed logo receipt stops the metadata upload, a failed token checkpoint stops the next step, a failed lock receipt stops further locks, and a failed airdrop receipt stops later sweeps. Asset-loop tests count exactly one attempted transfer when that transfer or its receipt reports a recovery error. An uncertain lock lookup stops before building a transaction. Failed writes with timeout text also stop the retry loop.

These checks cover the existing callbacks and error paths. Production adapters must still save each signed transaction and spending reservation through the engine before broadcast. That full requirement remains open above.


### Saved launches use the profile owner

CLI saved-launch commands now attach to the local runtime, or start it under the profile lock. The runtime handles save, list, and remove through the same API used by the desktop. CLI output retains the database path and saved-launch fields. The integration test checks that the app can read a CLI save and that the same owner remains active across all three commands.

### Live SOL transfer through the engine

The final SOL transfer now calls `createSolSweepService` through the local wallet host. The host supplies its active profile owner, signer, connection, and fee policy. The service saves a bounded request approval with the operation, then commits the signed bytes before sending. The saved approval includes the wallet, destination, full chain genesis hash, expiry, and maximum spend in lamports. Schema version two adds immutable approval records and preserves version one recovery data.

The service verifies the exact signed message against the saved transfer intent. Completion requires a finalized receipt with the same signature and message, the expected destination balance increase, and the exact payer decrease including its bounded fee. A pending operation retains wallet admission across restart. Asset-transfer retries reconcile it before another asset send. Other live wallet actions return its operation ID through the API and native client.

`test/wallet-execution.test.mjs` exercises the production host with real Solana signing. Its process test accepts a transaction at a local HTTP RPC fixture, kills the caller before the response, then starts the same host with the saved profile. The next process adopts the finalized receipt with one send in total. The fixture also checks that approval and signed bytes were durable when the first send arrived. The tests use local RPC fixtures and temporary profiles.

`packages/runtime/test/sol-sweep.test.mjs` covers receipt integrity, failed approval and transaction commits, fee and message changes, expiry during RPC calls, owner release, concurrent clients, and approved rebroadcast of identical saved bytes. `test/local-runtime.test.mjs` verifies that a saved pending transfer holds token creation and airdrops through the real HTTP runtime. The architecture suite passes 129 tests, and package coverage checks 93 required files.

Token creation, metadata, and liquidity transaction adapters still need engine integration. Full launch and runner spending limits remain separate requirements from the bounded local transfer request implemented here.

### Wallet recovery file preservation

Wallet recovery updates now keep each original record beside its decoded in-memory form. Saving or removing one wallet preserves another wallet's unreadable ciphertext and extra recovery fields. Replacement of an encrypted key requires encrypted custody. Encoding verifies a complete decrypt round trip before saving.

Recovery file reads require valid records and distinct public keys. Damaged bytes remain at their original path, and a recovery error stops further work. Updates sync a private temporary file before atomic rename and sync the directory on POSIX. Migration saves an exact private backup of the source bytes before replacing the active file.

`test/pending-wallets.test.mjs` covers mixed readable and unreadable records, encrypted key repair, exact migration backups, file permissions, interrupted rename and sync, backup failure, and preservation of damaged input. The fresh-wallet custody policy is described below. Runner custody remains part of the full completion checklist.


### Fresh local wallets require encrypted recovery

A new pending wallet now uses the strict recovery encryption interface. Its key and mnemonic must round-trip through the protected host backend before a private file commit. Device encryption can be supplied directly by the desktop, or by an unlocked Recovery PIN whose device secret has OS protection. An unavailable backend, Linux basic-text backend, keychain error, or changed decrypt result returns `RECOVERY_ENCRYPTION_REQUIRED` before the API returns a wallet for funding. The existing recovery-read interface retains access to legacy material.

The PIN state file now syncs its temporary contents before rename and syncs its directory on POSIX. An interrupted rotation preserves the previous key and PIN. Tests cover both generation endpoints and wallet import through the real headless API, protected PIN storage, legacy reads, backend errors, and interrupted PIN commits. Demo wallets continue to use the practice ledger. The runner will need its own encrypted host backend when live execution is connected.


### Token and NFT transfers through the engine

The asset sweep now uses durable operations for classic tokens, Token-2022 tokens, and Fee Key NFTs. Each operation records the exact mint, token program, source account, destination, raw amount, decimals, account rent limit, and transaction fee limit. The service signs a fixed message, saves its bytes, and verifies finalized token and SOL balance changes. Token-2022 transfer fees use the explicit expected fee instruction. Tokens with transfer hooks, private transfers, or a nontransferable mint require a dedicated adapter.

The final launch report reads all confirmed transfer receipts for the wallet, launch journal, and network. It includes transfers completed in an earlier process and keeps exact raw amounts, each signature, fees, and actual destinations. Receipt reads and the final journal commit both complete before recovery keys are removed.

The production host tests kill the token and NFT sweep processes after the local RPC fixture accepts their signed transactions. The next process recovers each receipt with one send in total. A third process rebuilds the same report from the durable receipt. Tests also cover competing clients, renewed approval before an identical rebroadcast, approval expiry during RPC, changed source ownership, fee changes, missing receipt data, failed storage writes, and exact large token amounts.

The adapter covers the final asset sweep. Liquidity's direct Fee Key distribution and airdrops will join it as their launch-wide recovery paths move into the engine.
