# V2 production field evidence

This directory holds the mainnet evidence that unlocks a `v2.0.0` or newer production release. The evidence is release input, not a fixture, screenshot, or sample.

The expected production file is deliberately absent until a field launch is complete:

- `field-verification.json` — exact full JSON bytes exported by v2 **Download proof**.

Never put a wallet secret, recovery phrase, private key, PIN, credential, or access token in this directory.

## Preconditions

Before spending funds or generating evidence:

1. Use the release-candidate code.
2. Use `mainnet-beta`, a dedicated RPC endpoint, a fresh launch wallet, bounded funds, and a controlled destination wallet.
3. Complete a test-mode or low-risk rehearsal without reusing its proof as production evidence.
4. Confirm macOS signing/notarization and Windows signing credentials are available for the release workflow. The evidence does not waive artifact trust.

## Field launch

Run the candidate exactly as a user would:

1. Configure the token and all intended launch parameters. Verify addresses in full before funding or signing.
2. Fund the launch wallet to the estimated requirement plus an explicit safety buffer.
3. Execute one non-test launch through:
   - token creation and metadata;
   - mint, freeze, and metadata authority finalization;
   - every planned pool and position;
   - every planned Burn & Earn lock;
   - Fee Key creation and delivery;
   - any configured airdrop;
   - proof-bound report generation; and
   - the terminal token, NFT, and SOL sweep to the controlled destination wallet.
4. Let any interrupted step resume from its saved state. Do not restart from an ambiguous state.
5. Confirm the report-parity audit passes at 100%, without warnings or missing rows.
6. Confirm the field-verification packet passes its three requirements (live launch, report, proof audit), shows `READY`, `nextAction: "none"`, and zero blockers.
7. After the terminal wallet-empty sweep is recorded, use **Download proof** again. The final local proof-download record must be bound to that sweep; an export made before sweeping is invalid.

The proof must show concrete transaction evidence. A configured plan, optimistic UI state, test result, compact HTML report, or explorer screenshot cannot replace the full JSON export.

## Preserve exact bytes

Check the downloaded JSON for accidental secrets without changing it. The export is designed to contain public chain proof and non-secret launch configuration. If a secret appears, stop: treat it as exposed, recover as appropriate, and fix the export path before making new evidence.

Do not pretty-print, minify, reorder, redact, hand-fill, copy selected fields, or “repair” the proof. Save the unmodified download as:

```text
release-evidence/v2/field-verification.json
```

and commit it on the release pull request.

## Run the production gate

Load the release-signing environment, then run from the release candidate:

```bash
npm run release:gate -- v2.0.0
```

The command reports the evidence file and its SHA-256, the independently derived field-proof fingerprint, and `macOS signed and notarized; Windows signed`.

The tag workflow runs the same gate before any v2+ desktop build. A missing, test, stale (more than 30 days old), partially passing, compact, hand-thinned, sweep-unbound, or unsigned packet fails closed. The gate recomputes the proof fingerprint and terminal-sweep hash itself and checks the concrete mint, authority state, pool and position transactions, locks, Fee Keys, airdrop, report and sweep records; it does not trust pass flags in the file.

## If something is wrong

If a mismatch is discovered after the evidence is committed:

1. stop the release or mark the release candidate invalid;
2. do not patch the JSON;
3. check whether funds, secrets, or release trust are affected; and
4. export new evidence from a valid completed launch when safe.

If 30 days pass before the release workflow runs, run a new field launch. Changing the system clock, timestamp fields, or gate constants is not a valid renewal.
