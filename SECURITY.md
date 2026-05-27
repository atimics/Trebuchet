# Security Notes

## npm audit residuals

`npm audit --audit-level=high` currently reports high-severity findings in transitive Solana/Irys dependencies:

- `bigint-buffer` through `@solana/spl-token` and `@raydium-io/raydium-sdk-v2`.
- `elliptic` through `@metaplex-foundation/umi-uploader-irys` and its Irys upload stack.

`tmp <0.2.6` was also reported through `@metaplex-foundation/umi-uploader-irys -> @irys/sdk -> arbundles -> tmp-promise`.
That path is pinned with an npm override to `tmp ^0.2.6`, because npm reported a non-force fix path for this package and it does not require changing the Metaplex/Irys API surface.

The npm force fixes are not safe to apply blindly:

- The `bigint-buffer` force fix downgrades `@solana/spl-token` to `0.1.8`, which removes APIs this app needs for current SPL/Token-2022 compatibility checks.
- The `elliptic` force fix moves the Irys uploader to the Umi `1.5.x` stack, while this app's Metaplex token metadata stack is still on the `0.9.x` Umi line.

Do not run `npm audit fix --force` without validating token minting, metadata upload, and Raydium CLMM creation end to end. Keep these residuals visible until compatible upstream Solana, Raydium, and Metaplex releases allow a non-breaking upgrade.

## SDK compatibility matrix

| Package | Current constraint | Why it matters | Upgrade blocker |
| --- | --- | --- | --- |
| `@solana/web3.js` | `^1.98.4` | Core wallet, token, and transaction RPC primitives. | Must remain compatible with `@solana/spl-token` and Raydium SDK transaction builders. |
| `@solana/spl-token` | `^0.4.14` | SPL minting, token accounts, authority revocation, and Token-2022 compatibility checks. | npm's `bigint-buffer` force fix downgrades this to `0.1.8`, which removes APIs used by Trebuchet. |
| `@raydium-io/raydium-sdk-v2` | `0.1.144-alpha` | CLMM pool creation, position opens, locks, and route/swap support. | Needs live CLMM validation before changing because failed pool transactions can spend real SOL. |
| `@metaplex-foundation/umi` | `^0.9.2` | Umi identity and transaction execution for token metadata. | Must stay aligned with MPL Token Metadata and the Irys uploader plugin line. |
| `@metaplex-foundation/mpl-token-metadata` | `^3.2.1` | Metadata account creation and update-authority revocation. | Umi major-line changes need token metadata create/update validation. |
| `@metaplex-foundation/umi-uploader-irys` | `^0.9.2` | Arweave/Irys logo and metadata upload. | npm's `elliptic` force fix moves this to `1.5.0`, crossing the Umi `1.x` boundary. |

## Upgrade workflow

Dependency changes touching token minting, metadata upload, or Raydium CLMM creation should:

- Run `npm audit --audit-level=high` before and after the change.
- Avoid `npm audit fix --force` unless the resulting dependency graph is validated.
- Run `npm run check:syntax` and `npm test`.
- Exercise metadata upload through `metadataUploadService.js` tests before attempting a full launch.
- For Solana/Raydium SDK upgrades, run an explicit live-RPC smoke on a low-risk wallet before shipping.
