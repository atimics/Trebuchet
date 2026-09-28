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

The local API journal and saved-launch adapters now use `execution.sqlite`. Saved-launch CLI commands use the same store. Legacy JSON import commits as one transaction, and the source files are preserved. The database also has immutable launch identities, operation IDs, signed transaction bytes, and receipts for the engine to adopt.

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
