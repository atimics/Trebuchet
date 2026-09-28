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


### Metadata handoff and sealed reveal through the engine

The local runtime now handles metadata authority handoff and sealed reveal through `metadata-update` operations. Each saved intent binds the mint, new authority, content fields, immutable state, network, fee limit, and added account rent. The adapter supports classic Metaplex fungible metadata and Token-2022 inline metadata. A sealed inline reveal writes its fields and retires authority in one atomic transaction. The Metaplex update keeps the existing creator and fee data.

Completion requires the exact finalized transaction, bounded fee and rent changes, and matching metadata at or after the receipt slot. An already completed handoff can be saved as an observed result with zero spending. Metadata receipt identities survive an interrupted final journal checkpoint. Liquidity retries reconcile a pending metadata reveal before the next liquidity action.

The production host crash tests cover both a Metaplex handoff and an inline reveal. The RPC fixture accepts the real signed transaction, kills its caller, and allows a new process to recover with one send in total. Service tests verify the sealed document before execution, preserve authority after a failed initial checkpoint, and recover a completed receipt after a failed final checkpoint. Other tests cover changed signing bytes, stale account reads, exact approvals, renewed approval for saved bytes, and competing clients.

Metadata upload payments and token creation still need their own durable operations. Launch-wide spending limits, remaining liquidity and airdrop work, and runner execution remain in the full completion checklist.


### Saved-journal wallet admission

The saved-journal resume endpoint now uses the same wallet admission guard as the ordinary launch services. It reconciles a pending metadata reveal before liquidity work, preserves storage and chain-recovery errors, and releases only the request's own admission. The real HTTP runtime test holds a chain read open while a second saved-journal request and a token-creation request arrive. Both receive the busy response, and the journal stays unchanged. Pending SOL, token, and metadata operations also hold this endpoint across runtime restart.

Receipt lookups resolve the host journal scope before entering the SQLite transaction. The journal uses its own connection, so this order prevents the receipt reader from blocking its own journal lookup. Production crash tests now use the real profile journal adapter for SOL, token, NFT, metadata handoff, and metadata reveal recovery. The saved-journal HTTP test exposed this lock conflict before the fix.

### Pool, position, and lock execution through the engine

The local launch path now submits pool creation, main slices, ladder bands, support positions, bootstrap positions, and their locks through durable prepared transactions. The runtime saves the exact public message, pool and NFT account identities, launch plan, fee ceiling, and bounded local approval. A transaction replacement keeps the message and account identities while changing its expired blockhash. Position and Fee Key account keys use separate HMAC derivation contexts under the protected launch wallet; their public identities and derivation context survive restart.

Completion checks the finalized receipt and exact signed message, payer debit, fee, lookup table addresses, and the expected pool, position, or lock accounts. Position checks bind the NFT mint, pool, range, and positive liquidity. Lock checks bind the personal position address and Fee Key. The new path recovers exact saved identities before considering another action. Saved receipts replay their journal events once by operation ID. Legacy position-range recovery remains available to older direct service callers.

SDK-backed phase tests run pool creation, two main slices, a ladder band, support, bootstrap, and all five locks through the engine. Four process tests accept real signed Raydium instructions at a local RPC fixture and kill their caller before the response. A new process recovers with one send in total; a third reads the same receipt. Other tests cover classic and Token-2022 position NFTs, expired transactions, lost replies, failed journal checkpoints, changed plans, approval bindings, failed commits, altered messages and receipts, lookup table changes, owner loss, and competing clients.

These tests exposed an older lock lookup error. Lock queries now select the SDK's program for the current network and derive the personal position address from the NFT mint. The account's `positionId` field holds that derived address. Lock builders use the same program, authority, and pool program selection.

This stage covers the launch's Raydium pool, position, and lock transactions. Direct Fee Key distribution, quote-token acquisition, airdrops, token creation, and upload payments still need their remaining engine integration. The full launch budget, runner custody and hosting, desktop process split, live CLI execution, and full validator recovery drill remain in the completion checklist.


### Direct Fee Key distribution through the engine

Direct Fee Key distribution now uses the token transfer engine. Each main position has one stable action key. The action binds the launch scope, network, complete liquidity plan digest, pool, position NFT, Fee Key mint, slice, and planned recipient. The host checks the finalized lock account and its Fee Key before preparing the transfer. The token adapter saves the exact source, destination, amount, fee bounds, approval, signed bytes, and finalized balance evidence.

A repeated action returns the same saved receipt, including after the source account closes. Changed action context or transfer intent stops before spending. A pending direct distribution can resume through the liquidity flow or before a final asset sweep. Ordinary asset sweeps keep their own recovery path. Journal progress replays once per operation ID, and final transfer reports retain the original recipient and signature.

The production Fee Key process test accepts its signed transfer at a local RPC fixture and kills the caller before the response. The next process recovers; a third reads the same receipt. The ledger sees one send. The real HTTP saved-journal test holds receipt recovery while competing launch requests arrive. It verifies wallet admission, the confirmed operation, and the restored recipient and signature. This test exposed an error path that replaced newly recovered journal results with an empty array after a later token read failed. That path now reads the latest durable journal results.

The focused tests also cover changed recipients, position identities, Fee Key mints, allocation and slice indexes, finalized lock fields, approval scope and action bindings, lost replies, failed journal checkpoints, changed plans, and replay after source-account removal. The saved-journal path refreshes its journal after recovery and merges recovered pool records by allocation.

The full completion checklist remains open for token creation, upload payments, quote-token acquisition, airdrops, wallet position management, the whole-launch budget, runner custody and execution, the desktop process split, live CLI execution, and the validator recovery drill.


### Airdrop payments through the engine

Airdrops now use the shared token transfer engine. The runtime saves the complete recipient plan before sending. Each recipient has one stable action ID bound to the wallet, launch, network, plan digest, mint, token program, decimals, recipient, and exact amount. Each signed payment and its approval commit before broadcast. Each finalized receipt commits before the next recipient starts. Recovery uses the saved signature and exact balance changes. Token-2022 receipts retain gross, net, and withheld amounts.

The Core amount rules use exact decimal text. Numeric UI amounts use the existing nearest-unit rule once, before the plan and approval are saved. Browser and Node tests verify the same resulting base units. A changed recipient, amount, token program, or mint pauses execution. A retry can select a subset of the saved plan. The final transfer restores the full saved plan when its request omits the airdrop, so remaining recipients complete before the token sweep. Airdrop receipts remain in their report section; sweep totals use sweep receipts.

Older journal deliveries now require a finalized signature, a verified original signer and complete message, and exact token and lamport changes. An observed operation preserves the original journal row and signed transaction bytes. Classic token receipts require the full recipient credit. Existing destination accounts require their prior token balance in the receipt. An uncertain old receipt retains wallet admission across restart. Its verification can resume through the airdrop API or final transfer path.

The ordinary launch service now exposes `runAirdrop`; the HTTP handler translates its input and result. Both classic and v2 airdrop requests use the saved token format. Process-death tests accept the first signed payment at a local RPC fixture and kill the caller before the response. Later processes recover and finish the list with one payment per recipient. Real HTTP tests cover recovery for both new operations and older receipts while competing requests arrive. Other tests cover changed plans, pre-existing recipient balances, failed journal commits, cache replay, receipt corruption, finalization, network changes, and Token-2022 transfer fees.

The completion checklist still includes token creation, upload payments, quote-token acquisition, wallet position management, the budget for the whole launch, runner custody and execution, the desktop process split, live CLI execution, and the validator recovery drill.


### Token creation transaction adapter

The runtime now has a token creation adapter for classic SPL tokens and Token-2022 inline metadata. It uses the host-supplied signer interface. Three saved actions create the mint, create its metadata, and issue the supply. Supply issuance and mint-authority retirement share one atomic transaction. Each action records the exact mint, token program, decimals, metadata fields, content hash, and raw supply. Later actions compare that full plan with earlier saved actions. A changed plan pauses before spending.

Each signed message and its approval commit before broadcast. Mint creation and inline metadata funding require the exact planned rent in the receipt. Classic metadata creation uses a bounded rent ceiling. Supply receipts require the exact saved starting balance, final balance, and issued amount. All account balances, receipt signatures, metadata fields, mint authority, and finalized account slots are checked. An underfunded wallet retains its operation for recovery after funding. A saved terminal receipt remains available while the RPC is offline.

The new tests exposed two recovery network gaps in the shared prepared-transaction service. It now compares both the saved network and genesis hash before recovery. It also verifies the RPC genesis hash before reading a full receipt when transaction finality was already saved. This check applies to the existing liquidity adapter too. Finalized receipts must contain every original transaction signature, including the mint signer.

Six process tests cover all three actions in both token formats. A local RPC fixture accepts a real signed transaction and kills the caller before replying. A second process resumes the active action; a third reads the same saved result. Each action has one accepted send. Six expiry tests verify that a replacement keeps all saved instructions and accounts while changing its expired blockhash. Other tests cover changed plans, failed commits, lost replies, competing clients, missing signing material, altered receipts, insufficient funding, and stale account reads.

Production token creation still needs host integration and durable custody of the chosen mint signer. The [mint recovery proposal](mint-recovery-proposal.md) records the exact key-storage change awaiting user approval after automatic approval review rejected its application. The adapter and tests use the existing supplied signer interface. Upload payment recovery, metadata-authority policy, the budget for the full launch, remaining transaction adapters, live CLI and runner execution, desktop process separation, and validator recovery drills remain in the completion checklist.

Validation for this adapter stage: all 244 architecture tests passed. All 93 affected adapter, liquidity, and wallet tests passed on Node 22.23.3. Package coverage passed for 102 required runtime files. The tests use temporary profiles and local RPC fixtures.

### Token-2022 recovery on a local validator

`npm run test:e2e:runtime-token:localnet` starts a private loopback validator and funds a fixture wallet with local test SOL. It runs all three Token-2022 creation actions against the real program. For each action, an RPC proxy verifies the committed signed bytes and approval, then kills the test client after submission. A fresh process recovers the finalized result. A third process replays the same saved receipt.

The drill passed on Solana test validator 2.3.13 with both Node 25.8.2 and Node 22.23.3. It verified three distinct finalized transactions, the exact supply, and retired mint authority. A receipt can become visible after a new process has started; in that case the runtime resubmits the identical signed bytes. The test verifies the original signature and a single finalized effect for each action. It also removes its test processes and ledger when finished. Classic Metaplex metadata and the wider liquidity, upload, and runner validator drills remain part of the full completion scope.


### Durable storage payments and signed uploads

The runtime now has separate adapters for an exact SOL storage deposit and its signed public asset. The upload adapter saves the signed data item, its SHA-256 digest, content and tags, node origin, payment address, receipt key, quote, and existing credit before payment. It stores public bytes in private files with a synced atomic write. Missing or damaged bytes pause recovery and stay available for inspection. Signing remains with the host-supplied SDK instance.

Each pending upload reserves its wallet in the same SQLite transaction as its job. Its funding transaction must match that reservation's launch scope, wallet, network, genesis hash, upload ID, content, amount, node, payment address, and receipt key. Other engine actions wait until the upload receipt and reservation release commit together. This keeps wallet ownership across the gap between a finalized deposit and a verified upload.

Storage payments use the shared prepared-transaction engine. Approval and exact signed bytes commit before broadcast. The finalized receipt must show the exact node credit, payer debit plus fee, and unchanged balances for every other account. Recovery reuses the saved signature. Expiry and approval renewal keep the same payment plan and saved bytes where they remain valid.

Upload recovery uses the original funding receipt and signed data item. It checks the node identity again, acknowledges the saved deposit, and verifies available credit before upload. A price increase or missing credit pauses the job. A signed receipt must match the original raw data-item ID and pinned node key. The transport accepts both base58 SDK IDs and equivalent base64url receipt IDs. When an ID has two valid byte interpretations, the saved signed item selects the correct one. A completed upload can replay its saved result while the node is offline.

`test/upload-process.test.mjs` kills a real worker process after a local fixture accepts the deposit, funding acknowledgement, or upload. Each fresh process recovers the same job, payment, and signed asset. A third process reads the cached receipt with zero remote calls. All three cases verify one deposit and one upload. Other tests cover competing clients, approval expiry during a price read, owner loss, approval renewal, damaged files, failed commits, uncertain receipt lookup, and exact funding bindings. The storage receipts use real RSA signatures verified by the installed Irys SDK; the data items use real Solana signatures.

The [storage upload connection proposal](storage-upload-integration-proposal.md) records the production payload, node destinations, payment bounds, and host changes awaiting explicit approval after automatic approval review rejected that connection. The current stage supplies the adapters, transport, and isolated recovery tests. Production sealed-reveal wiring, initial metadata uploads, storage-credit recovery, and the full launch budget remain in the completion checklist.

Validation for the upload adapter stage: all 275 architecture tests and all 105 affected upload, payment, store, and prepared-transaction tests passed on Node 22.23.3. The focused Node 25 run passed all 76 upload and payment tests. Package coverage passed for 102 required runtime files, and syntax passed for 389 files. These checks use temporary profiles and local fixtures.

### Upload funding recovery on a local validator

`npm run test:e2e:runtime-upload:localnet` starts a private loopback Solana validator and a local storage fixture. The fixture uses real Solana-signed data items and RSA-signed storage receipts. Each of three cases kills the client after the validator accepts a deposit, the storage fixture acknowledges that deposit, or the fixture accepts the upload. Fresh clients recover each case, then replay the saved receipt with zero remote requests.

The drill passed on Node 25.8.2 and Node 22.23.3. It verified three distinct finalized deposits, three verified uploads, the exact storage-recipient credits, and payer debits including fees. On Node 22 the first recovery resubmitted the same signed deposit while its receipt became visible; it still produced one finalized payment. The test cleans up its clients, validator, and ledger. Production Irys-node delivery and the pending host connection remain separate requirements.
