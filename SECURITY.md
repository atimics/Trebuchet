# Security notes

## Scope and threat model

Trebuchet is a local desktop application that can sign irreversible Solana
transactions. Its primary security boundaries are:

- local wallet-secret storage;
- the Electron renderer ↔ loopback API boundary;
- untrusted RPC/indexer/upload responses;
- launch configuration and destination confirmation;
- partial-failure recovery;
- dependency and release supply chain.

Local-first does not mean automatically safe. A compromised machine, insecure
local secret backend, malicious dependency, forged proof file, unsafe RPC
response, or operator-approved wrong destination can still cause loss.

## Dependency audit

The audit policy is enforced by `scripts/audit-gate.mjs` (run in CI): **any** critical fails the build, and so does
any high-severity finding that is not on the script's reviewed allowlist. Allowlisted residuals print with the reason
they cannot be fixed. Keep `ALLOWED_HIGH` in that script and this section in sync.

`npm audit` currently reports 7 high-severity dependency nodes, all in one unpatched transitive chain:

- `bigint-buffer` through `@solana/spl-token` -> `@solana/buffer-layout-utils` (and `@raydium-io/raydium-sdk-v2`).
- `elliptic` through `@metaplex-foundation/umi-uploader-irys` and its Irys upload stack.
- `@irys/upload-solana`, `@irys/web-upload-solana`, and `@metaplex-foundation/umi-uploader-irys` report high only
  because they carry `@solana/spl-token` (the bigint-buffer chain above).

Three findings that DID have safe fix paths were resolved by override/version bumps rather than left as residuals
(release audit, August 2026). Each stays within its current major, so no API surface changed:

| Package | Was | Now | Advisory |
| --- | --- | --- | --- |
| `multer` (direct) | `^2.1.1` | `^2.3.0` | DoS via deeply nested field names; DoS via incomplete cleanup of aborted uploads. Directly reachable — this is the logo-upload endpoint. |
| `axios` (override) | `^1.16.1` | `^1.20.0` | Prototype pollution, request and proxy handling, and denial of service advisories. Reached via Raydium SDK and the Irys stack. |
| `tmp` (override) | `^0.2.6` | `^0.2.7` | Type-confusion path traversal via non-string prefix/postfix. Reached via `arbundles -> tmp-promise`. |
| `form-data` (override) | `^4.0.5` | `^4.0.6` | CRLF injection via unescaped multipart field names. |
| `tar` (override) | `^7.5.15` | `^7.5.21` | **Critical** — six advisories incl. file smuggling via PAX header confusion and parser DoS. Build-time only (electron-builder), but it is the packaging toolchain. Was the finding that failed CI. |
| `electron` (dev) | 42.2.0 | 42.9.2 | `ProtocolResponse.url` session-cache confusion. In-major bump; lockfile only, spec unchanged at `^42.2.0`. |
| `electron-builder` + toolchain (dev) | 26.8.1 | 26.15.3 | AppImage search-path, credential leak on cross-origin redirect, `extract-zip` symlink traversal, `js-yaml` / `brace-expansion` / `undici` DoS. In-major; lockfile only. |

`bigint-buffer` has **no patched release at all** (latest published is the vulnerable `1.1.5`), so it cannot be
fixed in place at any version — it is an ecosystem-wide residual affecting every Solana app on the current
`@solana/spl-token` line. Mitigating detail: the vulnerability is in the *native* binding's `toBigIntLE()`, and
this app logs `bigint: Failed to load bindings, pure JS will be used` at startup, so the affected native path is
not the one in use. Revisit when `@solana/buffer-layout-utils` drops the dependency.

## Local API boundary

`main.js` and `serverMiddleware.js` provide:

- explicit bind to `127.0.0.1`;
- Host allowlist for `127.0.0.1` and `localhost`;
- process-random API session token;
- timing-safe session comparison on protected `/api/*` routes;
- Content Security Policy;
- `X-Frame-Options: DENY`;
- `X-Content-Type-Options: nosniff`;
- HTTPS-only external URL opening.

Exempt API routes must remain narrow. `/api/session` bootstraps same-origin
access; `/api/proxy-image` is read-only for HTML image loading; the Vanity CA
stream is an intentional browser-stream exception. Do not add a mutation
exception merely because attaching the session header is inconvenient.

## Local secrets and Recovery PIN

`secretStore.js` recognizes three storage prefixes:

| Prefix | Protection |
| --- | --- |
| `pin:` | Recovery-PIN data key held only while unlocked. |
| `enc:` | Electron safeStorage / operating-system secret backend. |
| `plain:` | Plaintext fallback when secure storage is unavailable. |

The four-digit Recovery PIN is an access factor, not high-entropy key material
by itself. `secretPinStore.js` combines it with a random device secret and
memory-hard derivation; the device secret is wrapped by safeStorage when the
platform offers a secure backend.

Important limitations:

- `npm run web` has no Electron safeStorage.
- Linux safeStorage may report the insecure `basic_text` backend.
- The code can retain a secret as `plain:` rather than silently discard
  recoverable funds.
- Anyone with local file access can read a plaintext fallback record.
- A Recovery PIN reset intentionally destroys access to PIN-encrypted pending
  wallets and Vanity CA secrets; the UI must enumerate the impact.

Production UI and docs must disclose the active protection state. Never describe
all local records as “OS-keychain encrypted” without checking the backend.

List APIs return metadata such as `hasSecretKey`/`hasMnemonic`, not bulk secret
material. Secret reveal requires an explicit route and unlocked policy.

## Transaction safety

- Fresh live execution is blocked on known public RPC endpoints.
- The renderer cannot authorize a transaction by setting a pass flag.
- The server rebuilds plan/readiness from the selected managed wallet, launch
  config, funding estimate, balances, quote safety, and journal.
- Long-running launch mutations are serialized by wallet.
- Retry logic distinguishes transient RPC failure, insufficient funds,
  deterministic errors, and unsafe unknown state.
- Every irreversible phase should have an idempotency check and durable journal
  checkpoint.
- Sweep destinations are validated and shown in full during typed
  confirmation.
- Browser `prompt()`, `confirm()`, and `alert()` are not accepted security UI in
  Electron.

## Proof and release integrity

App-generated proof is useful for operator workflow but is not self-authenticating.
For a `v2+` release, the production gate:

- recomputes the launch proof fingerprint independently;
- recomputes the terminal-sweep evidence hash;
- validates exact token, authority, pool, position, lock, Fee Key, recipient,
  airdrop, report, and sweep records;
- requires the full retained Classic comparison input and proof-derived rows;
- hashes the exact evidence file bytes and trimmed Classic input;
- verifies a recent, separate, two-person release attestation;
- requires the field-run commit to be an ancestor of the release commit;
- requires signed/notarized macOS and signed Windows build plans.

This protects against stale, mutually consistent, hand-thinned, or hand-edited
release packets. It does not replace human review of public transaction links.

## Funded devnet E2E

`.github/workflows/devnet-e2e.yml` is a manual, protected transaction test. It
must not run on `pull_request` or `pull_request_target`; GitHub intentionally
withholds secrets from fork pull requests, and untrusted pull-request code must
never receive a signing key.

Configure the `devnet-e2e` GitHub environment with required reviewers and:

| Name | Kind | Value |
| --- | --- | --- |
| `DEVNET_RPC_URL` | Environment secret | Dedicated Solana devnet RPC URL. |
| `DEVNET_FUNDING_WALLET_SECRET_B64` | Environment secret | Base64 of the wallet's 64-byte JSON keypair array. |
| `DEVNET_FUNDING_WALLET_PUBLIC_KEY` | Environment variable | Expected public key for the secret. |

Use a devnet-only wallet and keep mainnet assets off the same keypair. The
harness verifies the Solana devnet genesis hash before signing, refuses a
secret/public-key mismatch, caps the permitted treasury spend at 0.1 SOL,
serializes runs, funds a fresh child signer, and sweeps recoverable SOL back.
The child performs real mint, mint-to, authority-revocation, burn, token-account
close, and confirmation operations.

Raydium CLMM creation is intentionally excluded: Trebuchet's Raydium runtime is
currently mainnet-only. Adding a devnet LP test requires a separately reviewed
cluster abstraction and verified devnet program/config addresses.

## Upload and remote-content handling

Logo upload is constrained by:

- renderer normalization for oversized PNG/JPEG inputs and byte-preserving animated GIF handling;
- multipart memory storage;
- server 100 KB file limit;
- PNG/JPEG/GIF MIME allowlist;
- byte-signature sniffing;
- dimension validation;
- proxy and CSP controls for displayed remote images.

Never trust filename extension or renderer MIME alone. Remote token metadata,
logos, RPC data, and indexer responses are untrusted display inputs and must be
escaped/normalized before rendering.

## Dependency audit snapshot

Snapshot date: 2026-08-08
Command: `npm audit --audit-level=high --json`

| Severity | Package entries |
| --- | ---: |
| Critical | 0 |
| High | 7 |
| Moderate | 0 |
| Low | 17 |
| Total | 24 |

CI runs `npm run check:audit` and blocks every critical or high advisory except
the explicitly pinned upstream `bigint-buffer` advisory
`GHSA-3GC7-FJRX-P6MG`. A registry failure also fails the gate. Production
approval still needs an explicit disposition for this residual rather than
assuming a green CI job means zero high-risk advisories.

### Compatible updates applied

The reviewed dependency updates moved `multer` to `2.3.0`, `tmp` to `0.2.7`,
`form-data` to `4.0.6`, `tar` to `7.5.20`, `js-yaml` to `4.3.0`, Electron to
`42.8.1`, its `undici` path to `7.29.0`, and legacy `brace-expansion` paths to
`1.1.18`/`2.1.4`. The coordinated Metaplex/Umi uploader stack is on the
compatible `1.5.x` line. Package, upload, Electron, and launch tests remain
required whenever these pins move.

### Coupled or major-line residuals

`bigint-buffer` remains high severity through:

```text
@solana/spl-token
  └─ @solana/buffer-layout-utils
      └─ bigint-buffer
```

npm proposes `@solana/spl-token@0.1.8`, which is a functional downgrade from
the current `^0.4.14` line and removes APIs Trebuchet uses. Do not accept that
force fix without redesign and full compatibility validation.

The Irys uploader remains a coupled stack and is pinned together:

```text
@metaplex-foundation/umi-uploader-irys@1.5.0
  └─ @irys/sdk
      └─ metadata upload transport
```

Do not update one Umi/MPL/Irys package in isolation. Future moves require a
coordinated version change plus live metadata-upload validation.

Do not run `npm audit fix --force` and assume the result is safe.

## SDK compatibility matrix

| Package | Current constraint | Security/upgrade requirement |
| --- | --- | --- |
| `@solana/web3.js` | `^1.98.4` | Keep compatible with SPL Token, Raydium builders, and transaction/version APIs. |
| `@solana/spl-token` | `^0.4.14` | Do not accept the audit-proposed `0.1.8` downgrade; validate Token-2022 and authority flows for any move. |
| `@raydium-io/raydium-sdk-v2` | `0.1.144-alpha` | Exact alpha pin; any change requires CLMM create/open/lock/route validation. |
| `@metaplex-foundation/umi` | `^1.5.1` | Coordinate with MPL Token Metadata and uploader plugin. |
| `@metaplex-foundation/mpl-token-metadata` | `^3.4.0` | Revalidate metadata create and update-authority revocation. |
| `@metaplex-foundation/umi-uploader-irys` | `^1.5.0` | Keep the Umi/MPL/Irys stack coordinated and revalidate live upload behavior. |
| `multer` | `^2.3.0` | Rerun upload-limit, signature, MIME, and dimension tests on update. |

## Dependency upgrade workflow

- Prefer a narrow direct/override update, and inspect `npm ls` for the affected path.
- Run `node scripts/audit-gate.mjs` before and after the change.
- Avoid `npm audit fix --force` unless the resulting dependency graph is validated.
- Run `npm run check:syntax` and `npm test`.
- Exercise metadata upload through `metadataUploadService.js` tests before attempting a full launch.
- For Solana/Raydium SDK upgrades, run an explicit live-RPC smoke on a low-risk wallet before shipping.
- Run `npm run check:package` and the relevant API/Electron/UI/package tests.

## Security reporting

Do not post wallet secrets, Recovery PIN state files, unpublished field evidence
containing unintended sensitive data, signing certificates, or notarization
credentials in a public issue. Use the repository owner's private security
contact/channel where available and provide only the minimum reproduction data.

## Production security checklist

- [ ] No critical audit findings.
- [ ] Compatible high-advisory fixes applied.
- [ ] Remaining high advisories explicitly accepted/mitigated/deferred.
- [ ] Dedicated RPC used for field launch.
- [ ] Active secret backend protection verified.
- [ ] Field proof reviewed for accidental secrets.
- [ ] Distinct field operator and release reviewer.
- [ ] macOS identity and notarization credentials loaded.
- [ ] Windows signing identity loaded.
- [ ] Checksums and trust metadata verified after publication.
