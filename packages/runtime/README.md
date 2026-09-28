# Trebuchet runtime

The runtime package provides durable operation storage and exclusive ownership of a local profile. It uses Node's built-in SQLite module. Node 22.13 or later is required; CI uses 22.23.3.

`openRuntimeStore(profile)` stores immutable launch identities, stable operation IDs, signed transaction bytes, and receipts in `execution.sqlite`. A wallet has one unfinished operation. Public records and encrypted custody material use separate stores.

`createProfileJournalStore` and `createProfileLaunchStore` are the storage adapters used by the local API and saved-launch CLI commands. They import existing JSON records in a transaction. The original files stay byte-for-byte intact. A failed migration requires recovery before new writes.

`acquireProfileOwner(profile)` holds an exclusive SQLite transaction in `runtime-owner.sqlite`. The OS releases ownership when the process exits. The owner publishes a private `runtime.json` descriptor after its API is listening. A client must authenticate and verify the runtime identity before attaching.

The process tests cover competing writers, owner death, and signed-byte recovery after a simulated broadcast followed by process death. The engine and chain adapters will use these contracts for live execution. See `docs/execution-runtime.md` for the full integration checklist.
