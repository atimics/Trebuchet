# Security Notes

## npm audit residuals

`npm audit --audit-level=high` currently reports high-severity findings in transitive Solana/Irys dependencies:

- `bigint-buffer` through `@solana/spl-token` and `@raydium-io/raydium-sdk-v2`.
- `elliptic` through `@metaplex-foundation/umi-uploader-irys` and its Irys upload stack.

The npm force fixes are not safe to apply blindly:

- The `bigint-buffer` force fix downgrades `@solana/spl-token` to `0.1.8`, which removes APIs this app needs for current SPL/Token-2022 compatibility checks.
- The `elliptic` force fix moves the Irys uploader to the Umi `1.5.x` stack, while this app's Metaplex token metadata stack is still on the `0.9.x` Umi line.

Do not run `npm audit fix --force` without validating token minting, metadata upload, and Raydium CLMM creation end to end. Keep these residuals visible until compatible upstream Solana, Raydium, and Metaplex releases allow a non-breaking upgrade.
