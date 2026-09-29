# Trebuchet runtime

The runtime package provides durable operation storage and exclusive ownership of a local profile. It uses Node's built-in SQLite module. Node 22.13 or later is required; CI uses 22.23.3.

`openRuntimeStore(profile)` stores immutable launch identities, stable operation IDs, signed transaction bytes, and receipts in `execution.sqlite`. A wallet has one unfinished operation. Public records and encrypted custody material use separate stores.

`createProfileJournalStore` and `createProfileLaunchStore` are the storage adapters used by the local API and saved-launch CLI commands. They import existing JSON records in a transaction. The original files stay byte-for-byte intact. A failed migration requires recovery before new writes.

`acquireProfileOwner(profile)` holds an exclusive SQLite transaction in `runtime-owner.sqlite`. The OS releases ownership when the process exits. The owner publishes a private `runtime.json` descriptor after its API is listening. A client must authenticate and verify the runtime identity before attaching.

The process tests cover competing writers, owner death, and signed-byte recovery after a simulated broadcast followed by process death. The engine and chain adapters use these contracts for supported live actions. See `docs/execution-runtime.md` for the full integration checklist.

`connectRuntime(profile)` authenticates the private runtime descriptor and checks the process identity. `ensureRuntime(profile, { args })` attaches to that owner or starts a detached local host. The host holds the profile lock before creating API routes. Requests from a native client also carry the owner token, which binds them to that runtime generation.

The CLI provides `runtime start`, `runtime status`, and `runtime stop`, each with `--config-dir`. Closing a CLI client leaves its runtime available. Stop accepts an idle runtime and closes admission before releasing ownership. Active requests and background launch jobs hold it busy. A disconnected request that has yet to finish keeps the runtime busy for recovery.


`npm run test:e2e:runtime-swap:localnet` qualifies the real Raydium router on a private Solana validator. It reads public quotes and account snapshots, then funds a fixed fixture wallet with local test SOL. Host-built SPL setup and cleanup surround the reviewed trade. The drill kills each worker after submission, delays one status reply, recovers the saved signature, and verifies exact receipts and cached replay. It requires public Raydium and Solana read access plus `solana-test-validator` on PATH. The output includes the source slot and account-data hashes. Add `-- --provider-bundle` for the complete Raydium API bundle, `--funded-source` for existing wrapped SOL, or `--via-usdt` for a composed multi-hop route. The route case also supports `--existing-intermediate` and `--prefunded-intermediate`. These cases verify temporary account refunds and preservation of existing token accounts. Run validator drills one at a time. Production acquisition service integration remains in the completion checklist.
