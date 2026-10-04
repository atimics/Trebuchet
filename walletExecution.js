import { randomUUID } from 'node:crypto';
import { Connection, Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { openRuntimeStore } from '@trebuchet/runtime/store';
import { createSolanaSigner, SOLANA_GENESIS_HASHES } from '@trebuchet/runtime/solana';
import { createSolSweepService } from '@trebuchet/runtime/sol-sweep';
import { createTokenTransferService } from '@trebuchet/runtime/token-transfer';
import { createMetadataUpdateService } from '@trebuchet/runtime/metadata-update';
import { createTokenAccountCloseService, closableTokenAccount, TOKEN_ACCOUNT_CLOSE_BATCH } from '@trebuchet/runtime/token-account-close';
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { getNetwork, getRpcUrl } from './rpcConfig.js';
import { samplePriorityFeeMicroLamports, priorityFeeLamports, CU_SOL_TRANSFER, CU_TOKEN_TRANSFER, CU_TOKEN_ACCOUNT_CLOSE, CU_METADATA_OPS, SWEEP_FEE_PAD_LAMPORTS } from './priorityFees.js';
import { createExecutionConnection } from './rpcConnection.js';

// Called after the launch service verifies the transfer request and return
// wallet. The local API session authorizes this bounded sweep. The shared
// service records that approval and every signed transaction before sending.
export function createWalletExecutionRuntime({
  owner, getScopeId,
  createConnection = () => createExecutionConnection(),
  networkForRequest = getNetwork,
  now = Date.now,
  timeoutMs = 60_000,
}) {
  if (!owner || typeof getScopeId !== 'function') throw new TypeError('Wallet execution requires the profile owner and launch journal');
  const withStore = (run) => {
    owner.assertActive();
    const store = openRuntimeStore(owner.profile);
    try { return run(store); } finally { store.close(); }
  };
  const active = (walletPublicKey) => withStore((store) => store.getActiveOperation(walletPublicKey));
  const execute = async (method, input) => {
    const { tempWalletSecretKey, destinationWallet } = input;
    owner.assertActive();
    const wallet = Keypair.fromSecretKey(Uint8Array.from(tempWalletSecretKey));
    const walletPublicKey = wallet.publicKey.toBase58();
    if (method === 'recover' && !active(walletPublicKey)) return null;
    const store = openRuntimeStore(owner.profile);
    let operationKind = null;
    try {
      const network = networkForRequest();
      const genesisHash = SOLANA_GENESIS_HASHES[network];
      if (!genesisHash) throw new Error('Choose mainnet or devnet for this local runtime');
      const connection = createConnection();
      const pending = store.getActiveOperation(walletPublicKey);
      operationKind = method === 'recover' ? pending?.kind : method === 'transfer' ? 'token-transfer' : method === 'update' ? 'metadata-update' : method === 'close' ? 'token-account-close' : 'sol-sweep';
      if (!['sol-sweep', 'token-transfer', 'metadata-update', 'token-account-close'].includes(operationKind)) throw new Error('Resume the saved wallet operation with its matching adapter');
      const tokenInput = operationKind === 'token-transfer' ? (method === 'recover' ? pending.payload : {
        mint: new PublicKey(input.mint).toBase58(), programId: new PublicKey(input.programId).toBase58(),
        sourceTokenAccount: input.sourceTokenAccount ? new PublicKey(input.sourceTokenAccount).toBase58()
          : getAssociatedTokenAddressSync(new PublicKey(input.mint), wallet.publicKey, false, new PublicKey(input.programId)).toBase58(),
        amountRaw: String(input.amountRaw), decimals: input.decimals,
      }) : null;
      const metadataInput = operationKind === 'metadata-update' ? (method === 'recover' ? pending.payload : {
        mint: new PublicKey(input.mint).toBase58(), newAuthority: new PublicKey(destinationWallet).toBase58(),
        fields: input.fields || {}, makeImmutable: input.makeImmutable === true,
      }) : null;
      const closeInput = operationKind === 'token-account-close' ? { accounts: method === 'recover' ? pending.payload.accounts.map((account) => account.address) : [...input.accounts].sort() } : null;
      const scopeId = getScopeId(walletPublicKey);
      if (typeof scopeId !== 'string' || !scopeId) throw new Error('Save the launch recovery record before transferring assets');
      const action = method === 'recover' ? store.getLaunch(pending.launchId)?.config.action : input.action;
      const current = await connection.getBalanceAndContext(wallet.publicKey, { commitment: 'finalized' });
      if (!Number.isSafeInteger(current?.value) || current.value < 0) throw new Error('Read a complete wallet balance before approving the transfer');
      const approval = {
        id: randomUUID(), source: 'local-transfer-request', walletPublicKey, destinationWallet, scopeId, ...(action ? { action } : {}),
        network, genesisHash, expiresAtMs: now() + 10 * 60_000,
        maxSpendLamports: Math.max(current.value, pending ? (pending.payload.amountLamports || pending.payload.rentCeilingLamports || pending.payload.rentLamports || 0) + pending.payload.feeCeilingLamports : 0),
        ...(metadataInput ? { metadata: { mint: metadataInput.mint, newAuthority: metadataInput.newAuthority, fields: metadataInput.fields, makeImmutable: metadataInput.makeImmutable } } : {}),
        ...(tokenInput ? { token: { mint: tokenInput.mint, programId: tokenInput.programId, sourceTokenAccount: tokenInput.sourceTokenAccount, amountRaw: tokenInput.amountRaw, decimals: tokenInput.decimals } } : {}),
        ...(closeInput ? { close: { accounts: closeInput.accounts } } : {}),
      };
      const createService = operationKind === 'token-transfer' ? createTokenTransferService : operationKind === 'metadata-update' ? createMetadataUpdateService
        : operationKind === 'token-account-close' ? createTokenAccountCloseService : createSolSweepService;
      const service = createService({
        owner, store, connection, network, expectedGenesisHash: genesisHash, now, timeoutMs,
        signer: createSolanaSigner({ getSigners: async ({ launch }) => {
          if (launch.walletPublicKey !== walletPublicKey) throw new Error('The signer must match the saved wallet');
          return [wallet];
        } }),
        authorize: async ({ approval: candidate }) => candidate === approval && networkForRequest() === network && getScopeId(walletPublicKey) === scopeId,
        feePolicy: async ({ accountCount = 0 } = {}) => {
          const microLamports = await samplePriorityFeeMicroLamports(connection);
          const computeUnitLimit = operationKind === 'token-transfer' ? CU_TOKEN_TRANSFER : operationKind === 'metadata-update' ? CU_METADATA_OPS
            : operationKind === 'token-account-close' ? CU_SOL_TRANSFER + CU_TOKEN_ACCOUNT_CLOSE * accountCount : CU_SOL_TRANSFER;
          return {
            // The sweep drains the launch wallet to zero: nothing is left behind as a rent reserve.
            reserveLamports: 0,
            feeCeilingLamports: 5000 + priorityFeeLamports(computeUnitLimit, microLamports) + SWEEP_FEE_PAD_LAMPORTS,
            computeUnitLimit, microLamports,
          };
        },
      });
      return await service[method]({ ...tokenInput, ...metadataInput, ...closeInput, scopeId, walletPublicKey, destinationWallet, action, approval });
    } catch (cause) {
      if (cause.code === 'RECOVERY_STORAGE_UNAVAILABLE') throw cause;
      // Say what failed and what to press: the same action checks the chain for this transfer first.
      console.error(`[wallet] ${operationKind} ${cause.code || 'EXECUTION_INTERRUPTED'}: ${cause.message}`);
      const what = { 'token-transfer': 'A token transfer', 'sol-sweep': 'The SOL transfer', 'metadata-update': 'The metadata update', 'token-account-close': 'Closing empty token accounts' }[operationKind] || 'A wallet transfer';
      // A transfer that names the wrong token program is refused before anything is signed.
      const message = cause.code === 'TOKEN_PROGRAM_MISMATCH' ? `${what} from the launch wallet was not sent. ${cause.message}.`
        : `${what} from the launch wallet could not be confirmed (${cause.message || 'interrupted'}). Nothing after it was sent.`;
      throw Object.assign(new Error(message, { cause }), {
        code: 'EXECUTION_RECOVERY_REQUIRED', statusCode: 409,
        operationId: cause.operationId || store.getActiveOperation(walletPublicKey)?.id,
        errorDetails: { code: cause.code || 'EXECUTION_INTERRUPTED', message: cause.message },
      });
    } finally { store.close(); }
  };
  return {
    active,
    activeWorkflow: (walletPublicKey) => withStore((store) => store.getWalletWorkflow(walletPublicKey)),
    getTransferReceipts: (walletPublicKey) => {
      owner.assertActive();
      // The journal may use its own SQLite connection. Resolve host data before
      // the receipt transaction takes the database write lock.
      const scopeId = getScopeId(walletPublicKey), network = networkForRequest();
      if (typeof scopeId !== 'string' || !scopeId) throw new Error('Read the saved launch before building its transfer report');
      return withStore((store) => store.transaction(() => store.listWalletOperations(walletPublicKey).filter((operation) => {
        if (operation.kind !== 'token-transfer' || operation.state !== 'confirmed') return false;
        const launch = store.getLaunch(operation.launchId);
        return launch?.config.scopeId === scopeId && launch.network === network && launch.config.genesisHash === SOLANA_GENESIS_HASHES[network];
      }).map((operation) => {
        const receipt = operation.evidence?.chain;
        if (!receipt?.signature || !Number.isInteger(receipt.decimals) || !receipt.programId || !receipt.amountRaw) throw new Error('Read the complete saved transfer receipt');
        return { ...receipt, operationId: operation.id, txId: receipt.signature, ...(store.getLaunch(operation.launchId).config.action ? { action: store.getLaunch(operation.launchId).config.action } : {}),
          programName: receipt.programId === TOKEN_2022_PROGRAM_ID.toBase58() ? 'token-2022' : 'classic' };
      })));
    },
    recover: (input) => execute('recover', input),
    recoverMetadataReveal: ({ tempWalletSecretKey, tokenMint, name, symbol, metadataUri }) => {
      const wallet = Keypair.fromSecretKey(Uint8Array.from(tempWalletSecretKey));
      const walletPublicKey = wallet.publicKey.toBase58();
      const pending = active(walletPublicKey);
      const fields = { name, symbol, uri: metadataUri };
      if (!pending) {
        const scopeId = getScopeId(walletPublicKey), network = networkForRequest();
        if (!scopeId) return null;
        return withStore((store) => store.transaction(() => {
          const completed = store.listWalletOperations(walletPublicKey).findLast((operation) => {
            if (operation.kind !== 'metadata-update' || operation.state !== 'confirmed' || !operation.payload.makeImmutable || operation.payload.mint !== tokenMint
                || Object.entries(fields).some(([key, value]) => value !== undefined && operation.payload.fields[key] !== value)) return false;
            const launch = store.getLaunch(operation.launchId);
            return launch?.config.scopeId === scopeId && launch.network === network && launch.config.genesisHash === SOLANA_GENESIS_HASHES[network];
          });
          return completed ? { ...completed.evidence.chain, operationId: completed.id, txId: completed.evidence.chain.signature } : null;
        }));
      }
      if (pending.kind !== 'metadata-update' || pending.payload.mint !== tokenMint || !pending.payload.makeImmutable
          || pending.payload.newAuthority !== SystemProgram.programId.toBase58()
          || Object.entries(fields).some(([key, value]) => value !== undefined && pending.payload.fields[key] !== value)) {
        throw Object.assign(new Error('Resume the saved metadata intent before another launch action.'), { code: 'EXECUTION_RECOVERY_REQUIRED', statusCode: 409, operationId: pending.id });
      }
      return execute('recover', { tempWalletSecretKey, destinationWallet: pending.payload.newAuthority });
    },
    updateMetadata: ({ tempWalletSecretKey, tokenMint, newAuthority, fields, makeImmutable }) => execute('update', {
      tempWalletSecretKey, mint: tokenMint, destinationWallet: newAuthority, fields, makeImmutable,
    }),
    transferMetadataAuthority: async ({ tempWalletSecretKey, tokenMint, newAuthority }) => ({
      ...await execute('update', { tempWalletSecretKey, mint: tokenMint, destinationWallet: newAuthority }), transferred: true, newAuthority,
    }),
    sweepSolToDestination: (input) => execute('sweep', input),
    // Close every empty token account the launch wallet owns, returning the rent to the wallet so
    // the SOL sweep that follows sends it on. A batch the chain refuses is reported and skipped;
    // an unconfirmed one stops here, held by its saved operation until it is recovered.
    closeEmptyTokenAccounts: async ({ tempWalletSecretKey }) => {
      owner.assertActive();
      const wallet = Keypair.fromSecretKey(Uint8Array.from(tempWalletSecretKey)), walletPublicKey = wallet.publicKey.toBase58();
      const connection = createConnection();
      const found = [];
      for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
        const response = await connection.getTokenAccountsByOwner(wallet.publicKey, { programId }, 'finalized');
        for (const { pubkey, account } of response.value) {
          const row = closableTokenAccount(pubkey.toBase58(), account, walletPublicKey);
          if (row) found.push(row.address);
        }
      }
      const closed = [], errors = [];
      let reclaimedLamports = 0;
      for (let index = 0; index < found.length; index += TOKEN_ACCOUNT_CLOSE_BATCH) {
        const accounts = found.slice(index, index + TOKEN_ACCOUNT_CLOSE_BATCH);
        try {
          const result = await execute('close', { tempWalletSecretKey, accounts });
          closed.push(...result.closed); reclaimedLamports += result.reclaimedLamports;
        } catch (error) {
          if (!['TRANSACTION_FAILED', 'INVALID_INPUT', 'INSUFFICIENT_FUNDS'].includes(error.errorDetails?.code)) throw error;
          errors.push({ accounts, error: error.errorDetails.message });
        }
      }
      return { closed, reclaimedLamports, errors };
    },
    transferToken: (input) => execute('transfer', input),
    transferTokenWithProgram: async ({ ownerKeypair, destination, mint, programId, sourceTokenAccount, amount, decimals }) => {
      const result = await execute('transfer', { tempWalletSecretKey: Array.from(ownerKeypair.secretKey), destinationWallet: destination.toBase58(),
        mint: mint.toBase58(), programId: programId.toBase58(), sourceTokenAccount, amountRaw: amount.toString(), decimals });
      return result.txId;
    },
  };
}
