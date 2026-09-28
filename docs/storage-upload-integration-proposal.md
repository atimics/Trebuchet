# Storage upload connection for approval

This approval covers a code change in draft PR #52. Each live launch will still use its existing authenticated request and saved launch inputs.

The tested implementation is available in `packages/runtime/src/storage-payment.js`, `packages/runtime/src/upload.js`, `packages/runtime/src/upload-store.js`, and `irysUploadTransport.js`. The local fixture tests cover real Solana-signed data items, signed storage receipts, process death after payment and upload acceptance, lost replies, failed commits, changed input, damaged files, and receipt ID formats. Payment tests also verify exact credits, payer debit, fee limits, and approval renewal.

## Payload and destination

The proposed connection handles the existing sealed-identity reveal. Its payload is the committed token logo and JSON metadata: name, symbol, description, image URI, and mint address. The current reveal rule continues to require every planned pool and liquidity lock. A local check will verify the saved identity commitment before the first upload payment.

The configured storage destinations stay `https://node1.irys.xyz` for mainnet and `https://devnet.irys.xyz` for devnet. Before paying, the runtime saves the selected node origin, its Solana payment address, and its public receipt key. Recovery requires the same node identity. The final asset URI uses the current Arweave or Irys gateway for the selected network.

## Spending rule

For each signed asset:

- Save its exact bytes, content hash, upload ID, node identity, and quoted price before payment. The approval also binds the upload action key and content-type tags.
- Reserve the wallet in the same database transaction as the upload job. Keep that reservation through payment acknowledgement and upload receipt recovery. Release it in the same transaction as the verified final receipt.
- Pay `max(0, quoted price - existing storage credit)` lamports once through the shared engine.
- Save the exact transfer and its approval before broadcast. Verify the finalized recipient credit and payer debit, including the bounded transaction fee.
- Bound the request by the available launch-wallet funds and storage credit. Use the existing sampled fee policy: base signature fee plus the compute fee and sweep fee pad.
- A higher upload price or insufficient credited funds pauses recovery. Reuse the original payment and signed upload bytes on retry.
- Keep the operation pending until the storage receipt matches the signed upload and saved receipt key.

The whole-launch budget remains a separate completion requirement. This connection will add the durable records needed for that budget.

## Exact production connection

1. Add `uploadExecution.js` with `createUploadExecutionRuntime({owner, getScopeId, ...hostInterfaces})`. It exposes `active`, `upload`, and `recover`. It supplies the current wallet signer, saved launch ID, selected Solana genesis hash, bounded local request approval, fee policy, and Irys transport to the tested runtime modules. It wraps pending results as `EXECUTION_RECOVERY_REQUIRED` with the saved operation ID.
2. In `metadataUploadService.js`, add the optional `uploadExecution` callback and stable `uploadKey`. The logo uses `<uploadKey>/logo`; the JSON document uses `<uploadKey>/document`. Each callback receives the exact bytes and content-type tags. The existing path remains available to callers outside this host connection. Pass the selected RPC URL as the uploader's provider URL.
3. In `tokenService.js`, let `uploadSealedIdentity` accept that callback. Recompute and check the saved identity commitment locally before uploading. Use `sealed/<mint>` as its stable upload key.
4. In `server.js`, construct the upload runtime under the existing profile owner. Pass its upload callback from `revealSealedMetadataForJournal`. A pending upload holds wallet admission across restart. The reveal, liquidity recovery, saved-launch recovery, and final transfer paths reconcile it before another action. Other wallet actions receive the saved recovery ID.
5. Add both new host modules to the package file lists.

## Checks before delivery

Run production-host and HTTP recovery tests with local RPC and storage fixtures. Kill the client after payment acceptance and after upload acceptance. Verify the same funding signature, signed upload, and stored receipt after restart. Test competing clients, changed networks, changed node keys, approval expiry, failed journal commits, and local commitment mismatch before spending. Run Node 22 checks, package coverage, the full repository suite, and CI. Commit and push the changes through draft PR #52.

Automatic approval review rejected applying this production connection because it changes sensitive data delivery and payment execution. The requested approval is for the payload, configured destinations, spending rule, and code connection described above.
