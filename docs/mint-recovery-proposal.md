# Mint recovery change for review

The runtime will save the chosen mint and its encrypted signer before an upload or chain transaction. A retry will use that same mint, including a random, vanity, or split-key mint.

## Proposed files and behavior

- `packages/runtime/src/signer-store.js`: add a private `signers.sqlite` database under the active profile. Each row holds an ID, wallet, role, ciphertext, and creation time. The encrypted content binds those fields to the signer material. The existing protected encryption backend supplies encryption and decryption. A verified round trip is required before commit. Records stay immutable, and read or write failures pause execution.
- `mintIdentity.js`: bind the name, symbol, supply, logo digest, mint format, metadata-authority choice, network, launch ID, and mint address in the public operation store. Save the signer first, then the public plan, then the journal checkpoint. A retry repairs an interrupted checkpoint and retains the same signer.
- `tokenService.js` and `server.js`: call identity preparation before upload. Record the address as `plannedMint` until mint creation is verified on chain.
- Package files and ignore rules: ship the new modules and keep local signer databases out of Git.

## Security boundary

This adds persistent private-key material to the runtime's custody. Only ciphertext is stored in the signer database. The existing OS-backed or protected PIN encryption backend controls access. The public operation database holds public identities and plan fields. This proposal keeps the current desktop process and keychain backend arrangement.

## Required verification

Test seed and split-key recovery after restart; a crash between signer and plan commits; damaged or swapped ciphertext; unavailable encryption; changed plans; concurrent callers; owner loss; and failures before upload. Inspect the database bytes and packed runtime. Run the full repository checks and CI before delivery.

Automatic approval review rejected applying this change because persistent private-key custody needs specific user approval. The implementation has not been applied. Approval is requested for this exact change through the existing draft PR #52.
