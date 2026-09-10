# Secure Launch Packet (RFC)

Headless, sealed-execution launches: build a launch packet on the dev
laptop, ship it to an isolated host, run it there, and get only a proof
back. Private keys never touch the developer machine's disk after the
packet is sent — they are generated inside the execution environment and
destroyed with it.

## Why

Today a real launch runs in the desktop app on the operator's machine.
That is fine for one person, but it means:

- The mint authority, funding wallet, and vanity CA keys live in the
  same process space as the browser, chat apps, and everything else on
  a daily-driver laptop.
- Launch execution cannot be delegated to a clean, ephemerally
  provisioned machine.
- The CLI is read-only (deliberately) because the custody, journal,
  idempotency, and non-interactive confirmation contracts have not moved
  into Core yet.

The launch packet is the missing middle piece: a sealed, hash-pinned
input that a hardened runner can execute without interactive custody.

## Packet contents

Built by `scripts/build-launch-packet.mjs`:

```text
flybrain-v1/
  manifest.json    per-file SHA-256, plan digest, "no private keys" attestation
  launch.json      the launch config
  plan.json        the verified trebuchet-launch-plan/v1
  logo.png         token art
```

Manifest schema: `trebuchet-launch-packet/v1`. The runner MUST:

1. Recompute every file hash and compare against `manifest.json`.
2. Reject any mismatch or missing file before doing anything else.
3. Recompute the plan digest (`plan.integrity`) and confirm it matches
   the manifest's `planDigest`.

## Execution environment

Recommended shape (matches how we already grind vanity keys on AWS):

- A spot/on-demand EC2 instance (or Firecracker container), created
  fresh per launch and destroyed after.
- Ingress: none for the duration of the run. The packet arrives via a
  one-shot channel (S3 pre-signed PUT, scp, or instance user-data).
- Egress: allow-listed only — Solana RPC endpoints and nothing else.
- Filesystem: work in a tmpfs (or encrypted instance store) that is
  wiped when the instance terminates. No logs, no core dumps.
- The runner process runs as its own user with no shell access.

## Key lifecycle inside the runner

1. Generate the funding wallet, mint authority, and (optional) vanity
   CA inside the container, using the same CSPRNG path as the app
   (`vanity_keygen` already emits VRF-bound grind proofs).
2. Fund the wallet from the operator out-of-band (SOL transfer).
3. Execute the plan stages (mint, metadata, revoke authorities, create
   pools, lock liquidity, sweep) journaling each step locally.
4. Export exactly one artifact: the launch proof
   (`trebuchet proof verify` already validates this format).
5. Destroy the instance. The only outbound copy of key material is
   whatever the operator explicitly chooses to back up (secret key
   printout shown once, then gone).

## What must land before this is allowed to touch mainnet

The CLI README already states the gate: custody, journal, idempotency,
and non-interactive confirmation contracts must move into Trebuchet
Core and pass a complete funded devnet recovery cycle. The runner
additionally needs:

- Devnet rehearsal: the same packet format and runner execute a full
  launch on devnet, twice, including one interrupted-and-recovered run.
- Sign-before-execute: the operator signs the manifest hash (not just
  the plan digest) with their own device before the runner may spend.
- Amount ceiling: the runner refuses `launchSol` above an operator-set
  cap, so a tampered packet cannot drain a funded wallet.
- Redaction: logs exported with the proof go through `logRedaction.js`.

Until those land, the packet builder is a packaging tool only: it
prepares and pins artifacts, it does not execute anything.

## Current status

- `scripts/build-launch-packet.mjs` — builds and pins packets. Done.
- Runner container image — not started, blocked on Core contracts.
- Devnet recovery cycle — not started.