# Trebuchet Sealed Runner

The operator-owned execution environment for Trebuchet launches. The
public site (trebuchet.ratimics.com / Arweave) is **static** and holds no
keys; each operator deploys their own runner on fly.io and attaches to
it. Wallets are generated inside the runner's ephemeral state and
destroyed with the machine.

**There is no hosted demo/try-it mode anywhere in this architecture.**

## What works today

- `GET /v1/health` — liveness and capability report (public).
- `POST /v1/attach` — operator handshake (bearer token).
- `POST /v1/packets` — upload a `trebuchet-launch-packet/v1` archive;
  the runner recomputes **every** manifest hash, verifies the embedded
  plan against the Core integrity contract, and refuses anything that
  does not match exactly. Verified packets get a `packetId`.
- `POST /v1/launches` — **gated**: answers `503 NOT_READY`. Launch
  execution is wired only after the Core custody gate opens (signed
  confirmation contract, custody backend, idempotency state machine,
  and a complete funded devnet recovery cycle — see
  `docs/secure-launch-packet.md`).

All routes except `/v1/health` require:

```
Authorization: Bearer $TREBUCHET_RUNNER_TOKEN
```

## Deploying your own runner

```bash
cd packages/runner
fly launch --no-deploy          # accepts the fly.toml + Dockerfile here
fly secrets set TREBUCHET_RUNNER_TOKEN="$(openssl rand -hex 32)"
fly deploy
```

The machine scales to zero when idle (`min_machines_running = 0`) and
starts on the first request, so an idle runner costs ~nothing. There are
**no volumes**: packet state, generated wallets, and the launch journal
live in the machine's ephemeral filesystem and vanish with it.

## Attaching from the planner site

The static planner asks for two things: your runner URL
(`https://<your-app>.fly.dev`) and the runner token (kept in your
browser's local storage, sent only to that URL). Uploads go straight
from your browser to your runner — the site only builds and hashes the
packet.

## Security notes

- The bearer token is compared in constant time.
- Packets that fail any hash check are deleted immediately and can
  never be launched.
- Path traversal in manifest entries is rejected (`path.resolve`
  must stay inside the packet directory).
- The runner runs as an unprivileged user in a minimal image
  (node:22-slim + Core source + runner source, nothing else).
## Packet input checks

The runner parses the complete archive before extraction. Limits are 20 MiB compressed, 40 MiB expanded, 10 MiB per file, and 256 entries. Entries must use portable relative paths and regular files or directories. Every input is listed in the manifest, and rebuilding the plan from `launch.json` must reproduce the verified plan digest. The packet builder omits macOS metadata sidecars. Rebuild older archives that include those sidecars.

## Signed packet approval

Set `TREBUCHET_OPERATOR_KEY` to the operator's raw Ed25519 public key in lowercase hex. Set `TREBUCHET_RUNNER_NETWORK` to `devnet`, `mainnet`, or `demo`; its default is `devnet`. These values are trusted host settings.

Build a plan with its launch wallet public key, then create the packet. Sign its exact manifest with the CLI:

```bash
trebuchet packet approve --manifest packet/manifest.json --plan packet/plan.json \
  --keyfile operator.custody.json --network devnet --max-spend-sol 2 \
  --out packet-approval.json --json
```

The command reads `TREBUCHET_CUSTODY_PASSPHRASE`. Store the approval beside the packet so the signed manifest stays fixed. The envelope binds the manifest hash, plan digest, operator public key, launch wallet, network, expiry, and an integer lamport ceiling.

After upload, `POST /v1/packets/:packetId/approval` accepts `{ "approval": <envelope> }`. The runner rechecks the stored files and compares the signature with its configured operator and network. Launch requests to a configured runner pass this same check before reaching the execution gate. The shared engine will enforce the ceiling on transaction submission.
