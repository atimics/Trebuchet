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

### Base UI changes retained in feature sources

Base changes through `17ed596` are integrated. Its 24 renderer edits now live in the eight matching feature files. The rebuilt renderer matches the merged renderer byte for byte, so the build retains the updated wallet, launch, recovery, history, and coin views. All 115 renderer and shared-browser tests passed. This resolves the CI bundle drift caused by merging the newer base's direct renderer edits with this branch's feature build.

### Swap message review stage

`swap-instruction` reads Raydium exact-input SDK messages and Jupiter V6 `route` and `shared_accounts_route` messages. Jupiter field coverage is pinned to the official `jupiter-amm-implementation` IDL at `cc068c9d1df0060c62f9a8a4fc37ea13ea7b9b39`. Independent wire fixtures cover all 90 swap variants in that schema, including PumpSwap and dynamic account slices. New instruction formats require a reviewed schema before signing.

`swap-bundle` reviews the complete setup, trade, and cleanup sequence. It binds one wallet, input amount, minimum output, output token account, network, funding ceiling, and rent ceiling. It checks wrapped-SOL funding separately from rent, validates seeded and associated account creation, and pins cleanup to the wallet. Saved templates retain their instructions while normalizing the blockhash. The review digest also covers the resolved lookup-table addresses and all approved limits.

The 41 focused tests cover real Raydium SDK bytes, all pinned Jupiter variants, malformed and appended fields, wrong accounts, extra transfers, duplicate funding, changed lookup tables, and altered limits. This stage provides message review for the planned durable purchase adapter. Production acquisition still needs finalized account and fee checks, durable jobs, engine execution, and crash recovery. The complete architecture critique and target diagram are in [architecture-review.md](architecture-review.md).

Validation for this stage: all 316 architecture tests passed. All 41 focused swap tests also passed on Node 22.23.3. Package coverage passed for 102 required runtime files, and syntax checks passed for 395 files. The preceding head, `fc9611e`, passed all six GitHub checks.

### Durable swap execution stage

`@trebuchet/runtime/swap` saves an immutable purchase job in SQLite before spending. One wallet reservation covers setup, trade, and cleanup. The saved job binds the complete reviewed bundle, resolved lookup-table addresses, launch key, wallet, network and genesis hash, fee ceiling, rent ceiling, and signed-request approval. Each step uses the shared transaction engine. Signed bytes and approval commit before submission. Recovery resolves the original signature, and an expired transaction keeps the saved instructions and account identities.

The adapter reads finalized mint and account data before execution. It verifies token programs, wallet ownership, account authority, native-token rent, and every transaction fee. Account changes follow the provider's exact instruction order. Separate funding and native sync steps are supported. Final receipts must match the saved message, exact input, minimum output, account balances, payer cost, fee, and returned funds. A cleanup step can return more SOL than its fee; the prepared-transaction service now supports an explicit refund bound and still requires the action-specific receipt check.

Completed results come from the saved operation receipts. The final job update and wallet release commit together. Damaged job identities, bundle digests, receipts, approvals, or cached results pause execution and preserve the stored records. Failed writes before submission stop spending. Failed writes after acceptance recover the same receipt. Finalized chain failures retain the wallet reservation for review before further spending.

The tests cover Raydium and Jupiter, classic and Token-2022 output accounts, one-transaction and multi-transaction purchases, split funding and sync, approval expiry, changed account or receipt data, failed commits, competing clients, and blockhash replacement. Three child-process tests kill the caller after setup, trade, or cleanup acceptance at a local RPC fixture. A fresh process completes each purchase with three distinct submissions. A third process returns the saved result with zero network requests. These tests use real signed messages and a fixture ledger.

All 363 architecture tests passed. The 109 focused swap and prepared-transaction tests also passed on Node 22.23.3. Package coverage passed for 102 required runtime files, and syntax checks passed for 401 files. The base merge at `8d9b0f7` includes the coin-image fallback from PR #60; rebuilding matched the merged renderer exactly, 129 selected renderer tests passed, and all six GitHub checks passed for that head.

Production acquisition still needs its API/service connection and durable management of purchases across quote mints. The later balance reconciliation stage covers outside transfers and approved account creation. The later validator stage covers the real Raydium trade with host-built SPL setup and cleanup. The later API-bundle stage covers the current Raydium setup and cleanup instructions. Failed purchase cleanup is covered by the later recovery stage below. Launch-wide budgeting, live CLI and runner execution, and the other open requirements remain in the full completion checklist.

### HTTP admission between workflow transactions

The live API now checks durable wallet reservations as well as active transactions. A saved swap or upload can be between transactions when a new process starts. Token creation, airdrops, asset sweeps, and saved-journal resume now return its recovery identity before another wallet action begins. The workflow stays available for its matching recovery adapter.

Two real runtime startup tests verify this state for swaps and uploads. Both use saved reservations with no active transaction. All four API requests stop before any RPC request, and the reservation stays intact. All 22 selected runtime and wallet-host tests passed. The two new HTTP cases also passed on Node 22.23.3.


### Failed swap fees and approved cleanup

The swap adapter now saves a full finalized failure witness alongside the original immutable engine operation. The witness verifies the signed message, every signature and account address, the exact failure and slot, the fee ceiling, unchanged token balances, and SOL changes limited to the payer fee. A missing or changed witness keeps the wallet reserved. Previously saved failed operations can gain this evidence during recovery.

A host calls `prepareCleanup({ id })` after recovering the failure. The saved cleanup plan identifies the wallet, source account, account snapshot, failed transaction, network, chain genesis hash, and fee ceiling. Its cumulative spending ceiling includes successful steps and every failed fee. The host then calls `cleanup({ id, approval })` with a fresh approval containing `id`, `scopeId`, `key`, `walletPublicKey`, `network`, `genesisHash`, `bundleDigest`, `recoveryDigest`, `expiresAtMs`, and `maxSpendLamports`. The host approval callback receives the job and `recoveryPlan` for verification.

Cleanup closes the saved wrapped-SOL source to its owner. A memo binds the cleanup transaction to the recovery digest, giving each approved attempt a distinct identity even when the chain returns the same blockhash. Signed bytes and approval commit before submission. Receipt recovery uses the original signature. A finalized cleanup failure has its own fee witness; another attempt needs a new plan and approval. An absent source completes through a finalized account read. The final source check, recovery result, and wallet release preserve the same transaction boundary. Results distinguish a failed purchase from a confirmed purchase followed by recovered cleanup. Cached cleanup plans and results remain bound to their saved host network.

All 403 architecture tests passed. The final 86 swap adapter and process tests passed on Node 22.23.3; the wider 148-test swap and prepared-transaction run also passed before the final cached-network guard. Seven child-process cases cover successful steps, failed setup/trade/cleanup, and process death after recovery cleanup submission. Fresh workers recover the same accepted transactions, then replay completed results with zero RPC requests. Other cases cover failure fees, recovery approval fields, receipt corruption, failed commits, expiry replacement, repeated cleanup failure, and legacy failed operations. Syntax checks passed for 403 files, and package coverage passed.

This stage uses real signed messages with local RPC fixtures. The later balance reconciliation stage covers outside transfers. The later validator stage covers the real Raydium router. Production quote acquisition, the remaining host integrations, live CLI and runner execution, and the full completion checklist remain open.


### Swap balances at execution and recovery

Swap receipts now measure the approved trade from their exact finalized starting balances. SOL and token transfers can arrive between preparation, signing, and execution. The saved bundle still fixes every instruction, account, exact input, minimum output, fee ceiling, and spending ceiling. Receipt evidence retains only the accounts covered by that transaction. Purchased output is the destination token delta, so outside transfers keep their own value.

Preflight recovery compares account identity and mint rules while allowing balance changes. An approved idempotent associated-account creation can adopt the same account if another transaction created it first. System-account prefunding reduces the rent debit. Changed account ownership, frozen state, missing accounts, or changed mint rules pause execution for review.

For a reviewed source-account close, the prepared-transaction service binds the refund account in its saved payload. The refund bound uses that writable account's actual starting SOL balance in the finalized receipt. The swap result check verifies the exact refund, destination, fee, and payer change. Recovery cleanup therefore returns funds received after its plan was saved. Cached recovery keeps the original refund policy and network.

All 438 architecture tests passed. All 184 focused swap and prepared-transaction tests also passed on Node 22.23.3. Nine child-process crash cases recover original signed transactions, including transfers received before normal cleanup and failure cleanup. Tests cover atomic and split bundles, classic and Token-2022 outputs, outside transfers, prefunded accounts, existing approved associated accounts, damaged receipt balances, and changed refund policies. Syntax checks passed for 403 files, and package coverage passed for 102 required runtime files.

The later validator stage covers the real Raydium router. Production quote acquisition remains in the completion checklist. The later API-bundle stage covers current Raydium messages. Account removal or authority changes still require explicit recovery review.


### Real Raydium router recovery on a private validator

`npm run test:e2e:runtime-swap:localnet` reads a public SOL-to-USDC quote and its unsigned Raydium trade instruction. It copies the required pool accounts, lookup tables, router program, and pool programs into a private Solana validator. It records the source slot and SHA-256 hashes of account data. Exact 64-bit rent fields survive fixture export. The public RPC interface allows only genesis and account reads; a fixed fixture wallet receives one local test SOL from the private validator.

The host builds reviewed SPL setup and cleanup around the provider's trade instruction. The runtime saves the full three-transaction bundle and approval. The proxy kills the worker after each transaction is accepted. Fresh workers recover the original signatures. Each crash also delays one known status reply, forcing a resend of the saved bytes. The validator returns its real `AlreadyProcessed` error. The shared Solana adapter now treats that precise SDK response as a reason to continue signature recovery. Finality and the action-specific receipt checks still determine completion. Other send errors preserve their original failure.

The final Node 22.23.3 run passed on Solana test validator 2.3.13. At copied slot `451549688`, it verified three unique finalized transactions, three duplicate preflight replies, 1,171,827 raw USDC units, 15,000 lamports in fees, and 2,039,280 lamports returned by cleanup. A completed replay made zero RPC requests. The prior Node 25.8.2 run also passed the three crashes with a two-hop route at slot `451548474`. The final fault-injection version also passed on Node 25.8.2 at slot `451550062`: three unique finalized transactions, three duplicate replies, 1,174,949 raw USDC units, and the same fee and rent totals. All 443 architecture tests passed, and all 40 focused Solana and prepared-transaction tests passed on both Node versions.

This drill identified Raydium's current router opcodes 5 and 6 for SOL setup and cleanup. The following API-bundle stage adds their reviewed contract. Durable purchase management across quote mints, production acquisition routes, whole-launch budgeting, live CLI and runner execution, and the other open requirements remain in the completion checklist.


### Complete Raydium API bundles and temporary account refunds

The message review now accepts Raydium's current SOL wrap and close helpers. It checks their exact data length, six account identities, signer flags, wallet ownership, canonical wrapped-SOL account, token programs, network, and funding ceiling. The original provider bundle stays in the saved plan and approval digest. Implicit output and intermediate token-account creation contributes to the approved rent cost.

A real multi-hop receipt showed that the router closes intermediate accounts it creates during the trade. The saved action plan now includes those refunds. Accounts that existed before the trade retain their token balances and rent. Explicit setup instructions also preserve their created accounts. The finalized result check verifies every account, exact payer change, fee, input, and output. The prepared-transaction service saves a fixed list of writable refund accounts; their finalized starting balances bound the combined credit. Existing single-account refund records remain readable.

Run `npm run test:e2e:runtime-swap:localnet -- --provider-bundle` for the complete Trade API bundle. `--funded-source` adds existing wrapped SOL. `--via-usdt` builds a route from two public quotes, then asks the API to construct that route. Add `--existing-intermediate` or `--prefunded-intermediate` to check the starting account state. Each drill uses a private validator and local test SOL. It kills the worker after acceptance, recovers the original signature through a duplicate preflight response, verifies the finalized result, and replays the saved result with zero RPC requests.

The complete bundle passed on Node 25.8.2 with existing wrapped SOL at source slot `451552776`, and on Node 22.23.3 with fresh accounts at slot `451553679`. The multi-hop case passed at slot `451556070`: one finalized transaction, one duplicate reply, 1,183,868 raw USDC units, 6,001 lamports in fees, and 4,078,560 lamports returned. The Node 22 prefunded intermediate case passed at slot `451557933`: 1,190,329 raw USDC units, the same fee, and 102,039,280 lamports returned. The existing intermediate account case passed on Node 25 at slot `451558263`: 1,187,276 raw USDC units, 6,001 lamports in fees, 2,039,280 lamports returned, and the intermediate account retained. A captured signed multi-hop receipt provides a fixed regression fixture.

All 497 architecture tests passed. All 239 focused swap and prepared-transaction tests passed on Node 22.23.3. The tests cover strict helper fields, combined funding, rent limits, account preservation, System-account prefunding, combined refund bounds, changed saved policies, and altered receipt balances. The production acquisition service and its durable job across quote mints remain the next integration step.


### Durable acquisition across quote mints

`@trebuchet/runtime/quote-acquisition` saves one approved plan for up to 16 distinct quote mints. Its stable parent identity binds the launch, wallet, network, ordered purchases, complete reviewed child bundles, and total spending ceiling. The plan and wallet reservation commit together. Preparation verifies funding for the full ceiling before the first purchase. Each child keeps its own operation records and receipts; the parent retains the wallet until the complete result commits.

Purchases run in saved order. The child approval binds the parent workflow, and the reservation names the exact child plan. An interrupted client can recover the original receipt before continuing. Expired approval permits receipt recovery and pauses the next spend. A duplicate setup signature stays attached to its original operation; the next purchase can resume with a new blockhash. Saved jobs and completed results remain bound to their original host network.

A finalized purchase failure stops later purchases. The parent records all successful and failed fees, gross payments, and returned funds. A separate cleanup plan binds the failed child, original parent plan, and cumulative cost. Fresh approval is required for cleanup. Failed cleanup fees remain in the next recovery plan. Once cleanup is verified, the result preserves completed purchases and marks later purchases as pending; the wallet release commits with that result.

Four child-process tests kill the client after the first or second atomic purchase, after the first purchase's cleanup in a split bundle, and during recovery cleanup after a failed trade. Fresh processes recover the saved signatures and complete the parent result. Cached replay makes zero RPC requests. Unit tests cover funding for the full plan, competing clients, purchase order, changed approvals, failed commits, recovery fees, damaged evidence, changed reservations, and signature reuse. A real HTTP startup test verifies that an acquisition reservation blocks competing wallet actions before any RPC request.

All 529 architecture tests passed. All 271 affected acquisition, swap, and prepared-transaction tests passed on Node 22.23.3. The HTTP admission test also passed. The process drills use signed transactions and a local RPC fixture. The production quote builder, HTTP job routes, and recovery controls still need to adopt this service. The whole-launch budget, remaining spending adapters, live CLI and runner, desktop process separation, and other completion requirements remain in the full checklist.


### Production quote drafts and recovery controls

`createQuotePlanBuilder` groups allocations for the same mint and checks finalized mint and wallet-token accounts. It obtains a bounded unsigned provider response, reviews its complete instruction bundle and lookup tables, and calculates input, fee, and rent ceilings. A fallback provider can be chosen during this preparation. The saved plan fixes the chosen messages and limits for later execution.

`quoteAcquisition.js` persists the draft, request identity, full plan, and digest before returning a job ID. Approval names the saved wallet, network, digest, and exact ceiling. A completed zero-purchase plan has a durable result. The host shares planning and execution guards across clients. It retains a paused purchase after an uncertain response and resumes its original child receipts. Cleanup requires a separately reviewed digest and cumulative spending ceiling. Archiving preserves the saved records.

`quoteAcquisitionRoutes.js` is the HTTP adapter. Preparing a quote spends zero funds. Execute and cleanup hold the existing wallet request guard until their background work settles. The durable reservation remains across restart. The active-wallet route lets a new client find that reservation and job. The real HTTP test verifies the session requirement, changed-approval rejection, competing requests, busy state, restart, original receipt recovery, archive rules, and approved cleanup with pending purchases preserved.

Classic and v2 now confirm the saved wallet, network, token minimum, swap amount, fee ceiling, rent ceiling, and total. Cancel retains the draft. Resume and Recover funds use the same saved job. Classic's automatic purchase retry has been replaced by an explicit action. Both clients read active jobs after reconnecting. Eight behavior tests cover exact approval, cancellation, cleanup, and a wallet change during confirmation. The actual dialogs were also inspected through local fixture pages in the in-app browser.

The private-validator drill supports `--production-plan`. It feeds the captured public unsigned provider response into the production planner, then executes the resulting plan on a funded private validator. On Node 22.23.3, source slot 451572841 passed: one finalized transaction, one process death after acceptance, one duplicate-preflight response, 1,193,015 raw USDC received, 6,001 lamports in fees, and 2,039,280 lamports returned. Cached replay made zero RPC calls. The plan reserved 4,078,560 lamports for created accounts and 11,001 lamports for its fee ceiling. Public services supplied read-only data; the validator used local test SOL.

All 560 architecture tests passed on Node 25.8.2. All 324 affected quote, swap, prepared-transaction, host, HTTP, and approval-screen tests passed on Node 22.23.3. All 118 affected HTTP, admission, and v2 tests passed, along with eight new approval-screen tests and the generated-bundle checks. Package coverage passed for 114 required files. The earlier committed head `b39d6a8` passed all six GitHub checks. Full repository and current-head CI results are recorded in PR #52.

Whole-launch spending reservations, remaining production adapters, live CLI execution, durable runner hosting, desktop process separation, and further service and renderer module boundaries remain in the full completion checklist.

### Durable wallet position withdrawal

The wallet withdrawal route now calls an ordinary runtime service. Preparation reads finalized Raydium position, pool, mint, vault, and NFT accounts. It saves the full unsigned message, position liquidity, token return minima, output accounts, fee ceiling, and account-rent ceiling before review. Approval binds that saved plan, wallet, network, expiry, and total spending limit. One wallet reservation remains active through receipt verification.

The transaction creates any required output accounts, removes all position liquidity, collects fees and rewards, burns the position NFT, closes its accounts, and returns temporary wrapped SOL in one atomic operation. Classic and Token-2022 NFT layouts are checked. Transfer fees reduce token minima before slippage. An existing wallet wrapped-SOL account stays separate from the temporary withdrawal account.

Completion requires the original finalized signature and exact message. A saved receipt witness verifies the NFT burn, closed position accounts, each token minimum, native-vault payout, returned rent, paid fee, and full wallet balance equation. Later wallet transfers preserve the original receipt. A failed atomic transaction retains its full fee witness before wallet admission is released. A replacement attempt has its own reviewed plan and keeps the earlier failure record.

The coin page prepares the saved plan before the typed confirmation. It shows the wallet, network, position, pool, token minima, fee and rent ceilings, and total. Saved reviews and paused withdrawals remain available through a separate history read, including when the position has closed or the position RPC read fails. The old SDK withdrawal retry and missing-position adoption path has been removed.

Validation uses real signed Solana messages with local RPC fixtures. Three process drills kill the worker after chain acceptance and recover classic NFT, Token-2022 NFT, and failed-transaction receipts. Each completes with one send; a third process replays the saved result with zero RPC requests. The real HTTP host test covers session access, changed approvals, wallet admission, restart, and original receipt recovery. Browser checks cover typed review and the saved recovery action. The following private-validator stage covers real CLMM withdrawals.

The withdrawal change also preserves exact display amounts for tokens with 19 decimal places. Package coverage checks 119 runtime files. All 69 withdrawal tests passed on supported Node 22.23.3, and all 624 architecture tests passed on Node 25.8.2. Current CI is recorded in PR #52. Whole-launch spending, support-position creation, the remaining production adapters, live CLI and runner execution, desktop process separation, and the other full-scope requirements remain open.


### Real CLMM withdrawal recovery on a private validator

`npm run test:e2e:runtime-withdrawal:localnet` copies the public Raydium CLMM program and fee configuration into a private validator. The classic NFT case also copies the metadata program. It records source slots and SHA-256 account-data hashes, then creates a fresh local token, pool, and position with local test SOL. The public RPC interface permits only genesis and account reads.

The production withdrawal service saves its plan, approval, wallet reservation, and signed message before the validator accepts the transaction. The test kills that worker before the response. A fresh worker recovers the original signature after a delayed status reply and the validator's real duplicate-preflight response. A third worker reads the saved result with zero RPC calls. The test verifies closed position accounts, the NFT burn or mint close, output token balances, pool liquidity, the existing wrapped-SOL account, and the exact wallet balance change.

Use `--nft2022` for a Token-2022 position NFT. `--transfer-fee-output` creates a Token-2022 pool token with a 250-basis-point transfer fee. `--fresh-output` closes the wallet's output account before withdrawal; `--prefunded-output` also places one million local lamports at that account address. These cases compare the vault debit with received tokens and the withheld fee, then verify the actual rent paid. Failed drills preserve their temporary profile, database, copied accounts, and validator log.

The classic NFT case passed on Node 22.23.3 at source slot 451584989: one finalized withdrawal, one duplicate reply, 4,987,272 raw units from each pool side, 75,000 lamports in fees, and 4,885,920 lamports returned from closed position accounts. The Token-2022 NFT case passed at slot 451585804 with the same outputs and fee; its closed position and mint accounts returned 7,217,520 lamports.

The Token-2022 NFT and fresh transfer-fee output case passed on Node 22.23.3 at slot 451586409. It received 4,862,590 raw token units after 124,682 units were withheld, plus 4,987,272 native lamports. The transaction used 4,196,880 lamports for temporary and new output account rent, and paid 75,000 lamports in fees. Each of these three cases recovered one finalized withdrawal after process death and replayed the saved result with zero RPC calls.

The classic NFT and prefunded transfer-fee output case passed on Node 25.8.2 at slot 451587028. It verified the same 4,862,590 raw tokens and 124,682-unit withheld fee. The existing one million lamports reduced the paid account rent to 3,196,880 lamports. One original withdrawal finalized, one duplicate preflight reply was recovered, and cached replay made zero RPC calls. All four drills used Solana test validator 2.3.13.

The previous implementation head `9717dbc` passed all six GitHub checks. Current-head checks are recorded in PR #52. Whole-launch budgets, support-position creation, the remaining production adapters, live CLI and runner execution, desktop process separation, and the other completion requirements remain open.


### Durable support-position service

`@trebuchet/runtime/support-position` prepares a fixed-liquidity SOL-only position, saves the complete unsigned message, and binds review to the NFT identity, pool, range, deposit, fee, and account-rent ceilings. The host supplies the recoverable wallet and NFT signers. One atomic transaction creates the temporary SOL account, funds the deposit, opens the position, and returns its unused SOL. The wallet's existing wrapped-SOL account stays separate.

The planner checks finalized pool, mint, vault, token, and tick-array accounts. It supports both pool token orders, classic and Token-2022 position NFTs, and the current indexed pool address format. Existing arrays and account prefunding reduce actual rent. Before a fresh send, it checks that the saved range still takes only SOL and that account identities and rent fit the approved plan. The full deposit, fee, and rent ceiling must be funded.

The service reserves the wallet with approval and saves signed bytes before submission. Completion verifies the exact original message and both signatures, the NFT mint, new position accounts, exact native-vault deposit, unchanged balances of the other token, every rent payment, and the full wallet balance equation. The receipt records the original creation, so a later position closure or wallet transfer preserves that result. A failed atomic transaction retains its paid fee before wallet admission is released.

All 77 focused tests passed on Node 22.23.3. These include four child-process crash cases: classic NFT, Token-2022 NFT, reversed pool order, and finalized transaction failure. Each recovers one submitted signature and replays its saved result with zero RPC calls. Storage, approval, concurrency, expiry, malformed account, changed receipt, and complete funding checks pass. All 701 architecture tests passed on Node 25.8.2.

`npm run test:e2e:runtime-support:localnet` uses the real CLMM program with local test SOL. Each run creates its own pool, kills the worker after submission, recovers the original receipt through a real duplicate-preflight reply, and replays the saved result with zero RPC calls. Three cases passed on Solana test validator 2.3.13:

| Case | Node | Public source slot | Deposit | Paid account rent | Fee | Returned temporary rent |
| --- | --- | --- | --- | --- | --- | --- |
| Classic position NFT | 22.23.3 | 451591936 | 10,000,000 | 152,709,360 | 80,000 | 2,039,280 |
| Token-2022 NFT and fresh transfer-fee token account | 22.23.3 | 451592406 | 10,000,000 | 155,736,960 | 80,000 | 2,039,280 |
| Reversed pool order and prefunded transfer-fee token account | 25.8.2 | 451593251 | 10,000,000 | 154,736,960 | 80,000 | 2,039,280 |

All amounts in the table are lamports. Paid account rent includes the temporary account; its rent is returned by the same transaction. The large tick-array rent is separately bounded in the saved plan. Every case created liquidity `228409972`, finalized one support transaction, and recovered one duplicate reply.

The following stage connects the production buy-support HTTP route and its client review and recovery controls to this service. The wider completion checklist stays open.


### Production support review and recovery

The live buy-support route now uses the owned runtime. Preparation saves the fixed unsigned plan and its public review fields. Execution requires the exact saved job, wallet, digest, and total spending ceiling. The host uses the existing wallet-based liquidity signer derivation to recover the same NFT identity after restart. The earlier direct SDK support submission has been removed.

The client shows the saved wallet, network, position, pool, range, deposit, fee, rent, and total before typed approval. Saved support reviews and paused jobs remain visible when the client reconnects. A cancelled review keeps its saved draft. Polling preserves an active review, competing clicks share that review, and late responses preserve a newly selected wallet view. Finalized failures display the actual paid fee. The coin activity entry uses the saved job ID to keep receipt replay from adding duplicate entries.

The real HTTP host test verifies session access, preparation with zero sends, changed approval rejection, competing wallet actions, runtime busy state, restart after a lost send reply, recovery of the original NFT and receipt, and cached replay while RPC is offline. A finalized failure retains its fee and terminal state. Nine client tests cover exact review, cancellation, recovery, wallet changes, late responses, competing clicks, recovery button dispatch, and practice mode.

All 155 affected support, withdrawal, HTTP, and client tests passed on Node 25.8.2 and Node 22.23.3. The first Node 22 run timed out in three tests during a long pause; the complete rerun passed in 3.9 seconds. Package coverage passed for 124 required runtime files. The real client review and recovery controls were inspected in the in-app browser with local fixture data: cancellation retained the job, and typed approval displayed its receipt and fee. Public funds were untouched. The preceding service head `279dcd3` passed all six GitHub checks; the integration head's checks are recorded in PR #52.

Remaining work includes the full-launch budget, production token creation and storage connections, other wallet actions, live CLI and runner execution, durable runner custody, desktop process separation, and full recovered-launch qualification. The completion checklist above remains active.


### Shared launch budget ledger and engine contract

`@trebuchet/runtime/launch-budget` saves the full launch scope, wallet, chain, plan digest, spending ceiling, and bound approval. Every operation reserves its exact ceiling before signing. Expired transaction replacements retain that reservation. The ledger releases unused reservation only after a host cost reader verifies the original finalized transaction. Failed transactions retain the actual fee. A failed settlement commit keeps the reservation available for recovery.

The ledger keeps reserved funds, gross spending, returns, fees, net spending, and remaining approval separate. Its initial `report-only` return policy charges gross spending and reports returned funds separately. Approval expiry permits original receipt settlement; each new spending attempt requires current approval. Reads validate budget identities, approvals, operation bindings, proof digests, and exact totals. Damaged records remain available for recovery.

The engine accepts a budget interface and calls its reservation check before signing and every broadcast. Completion settles the terminal receipt's cost. A later recovery of a terminal operation repeats pending settlement before returning the saved result. Tests cover lost send replies, interrupted settlement, expiry after signing, approval renewal before a first signature, failed fees, separate clients, changed bindings, corrupted costs, failed database commits, and owner loss.

Production adapters still need their cost readers and exact ceilings connected to this interface. Whole-launch review must bind one approved limit across uploads, minting, swaps, liquidity, and final transfer. The full budget requirement remains open until those hosts and recovery drills pass.

Validation for this stage: all 734 architecture tests passed on supported Node 22.23.3. The budget suite has 33 focused ledger and engine integration tests. The earlier Node 25 run passed 733 architecture tests before the final approval-renewal regression was added; all 33 budget tests then passed on Node 25. The complete v2 API-backed E2E flow also passed after correcting practice support refresh to use the practice coin identity.
