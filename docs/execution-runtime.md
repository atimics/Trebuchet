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
- [ ] Browser and CLI share calculations. Renderer source is split into launch, wallet, recovery, discovery, and proof features.
- [ ] Fresh funded wallets require encrypted recovery storage. Existing recovery material survives migration.
- [ ] Runner retains durable state and operator-controlled recovery material through final sweep verification.
- [x] Packet paths and entry types are checked before extraction, with bounds on size and entry count.
- [x] Every packet input is covered by the manifest. Rebuilt configuration matches the plan.
- [ ] Signed spending approval binds the complete manifest, operator, network, wallet, expiry, and spending ceiling.
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

`packages/runtime/test/` covers separate writers, process death, ownership release, migration, rollback, and transaction records after a simulated broadcast. The owner module holds a real exclusive SQLite write transaction. Runtime hosts still need to acquire it during startup; engine and chain integration remain open requirements above.

Node 22.13 is the minimum for built-in SQLite without an extra runtime flag. CI is pinned to Node 22.23.3, and the runtime process tests were also run on that version.
