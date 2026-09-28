import { randomUUID } from 'node:crypto';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { openRuntimeStore } from '@trebuchet/runtime/store';
import { createSolanaSigner, SOLANA_GENESIS_HASHES } from '@trebuchet/runtime/solana';
import { createSolSweepService } from '@trebuchet/runtime/sol-sweep';
import { createTokenTransferService } from '@trebuchet/runtime/token-transfer';
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { getNetwork, getRpcUrl } from './rpcConfig.js';
import { samplePriorityFeeMicroLamports, priorityFeeLamports, CU_SOL_TRANSFER, CU_TOKEN_TRANSFER, SWEEP_FEE_PAD_LAMPORTS } from './priorityFees.js';

// Called after the launch service verifies the transfer request and return
// wallet. The local API session authorizes this bounded sweep. The shared
// service records that approval and every signed transaction before sending.
export function createWalletExecutionRuntime({
  owner, getScopeId,
  createConnection = () => new Connection(getRpcUrl(), 'finalized'),
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
    try {
      const network = networkForRequest();
      const genesisHash = SOLANA_GENESIS_HASHES[network];
      if (!genesisHash) throw new Error('Choose mainnet or devnet for this local runtime');
      const connection = createConnection();
      const pending = store.getActiveOperation(walletPublicKey);
      const operationKind = method === 'recover' ? pending?.kind : method === 'transfer' ? 'token-transfer' : 'sol-sweep';
      if (!['sol-sweep', 'token-transfer'].includes(operationKind)) throw new Error('Resume the saved wallet operation with its matching adapter');
      const tokenInput = operationKind === 'token-transfer' ? (method === 'recover' ? pending.payload : {
        mint: new PublicKey(input.mint).toBase58(), programId: new PublicKey(input.programId).toBase58(),
        sourceTokenAccount: input.sourceTokenAccount ? new PublicKey(input.sourceTokenAccount).toBase58()
          : getAssociatedTokenAddressSync(new PublicKey(input.mint), wallet.publicKey, false, new PublicKey(input.programId)).toBase58(),
        amountRaw: String(input.amountRaw), decimals: input.decimals,
      }) : null;
      const current = await connection.getBalanceAndContext(wallet.publicKey, { commitment: 'finalized' });
      if (!Number.isSafeInteger(current?.value) || current.value < 0) throw new Error('Read a complete wallet balance before approving the transfer');
      const approval = {
        id: randomUUID(), source: 'local-transfer-request', walletPublicKey, destinationWallet,
        network, genesisHash, expiresAtMs: now() + 10 * 60_000,
        maxSpendLamports: Math.max(current.value, pending ? (pending.payload.amountLamports || pending.payload.rentCeilingLamports || 0) + pending.payload.feeCeilingLamports : 0),
        ...(tokenInput ? { token: { mint: tokenInput.mint, programId: tokenInput.programId, sourceTokenAccount: tokenInput.sourceTokenAccount, amountRaw: tokenInput.amountRaw, decimals: tokenInput.decimals } } : {}),
      };
      const createService = operationKind === 'token-transfer' ? createTokenTransferService : createSolSweepService;
      const service = createService({
        owner, store, connection, network, expectedGenesisHash: genesisHash, now, timeoutMs,
        signer: createSolanaSigner({ getSigners: async ({ launch }) => {
          if (launch.walletPublicKey !== walletPublicKey) throw new Error('The signer must match the saved wallet');
          return [wallet];
        } }),
        authorize: async ({ approval: candidate }) => candidate === approval && networkForRequest() === network,
        feePolicy: async () => {
          const microLamports = await samplePriorityFeeMicroLamports(connection);
          const computeUnitLimit = operationKind === 'token-transfer' ? CU_TOKEN_TRANSFER : CU_SOL_TRANSFER;
          return {
            reserveLamports: operationKind === 'sol-sweep' ? await connection.getMinimumBalanceForRentExemption(0, 'finalized') : 0,
            feeCeilingLamports: 5000 + priorityFeeLamports(computeUnitLimit, microLamports) + SWEEP_FEE_PAD_LAMPORTS,
            computeUnitLimit, microLamports,
          };
        },
      });
      const scopeId = getScopeId(walletPublicKey);
      if (typeof scopeId !== 'string' || !scopeId) throw new Error('Save the launch recovery record before transferring assets');
      return await service[method]({ ...tokenInput, scopeId, walletPublicKey, destinationWallet, approval });
    } catch (cause) {
      if (cause.code === 'RECOVERY_STORAGE_UNAVAILABLE') throw cause;
      throw Object.assign(new Error('Resume the asset transfer to verify its saved operation.', { cause }), {
        code: 'EXECUTION_RECOVERY_REQUIRED', statusCode: 409,
        operationId: cause.operationId || store.getActiveOperation(walletPublicKey)?.id,
        errorDetails: { code: cause.code || 'EXECUTION_INTERRUPTED', message: cause.message },
      });
    } finally { store.close(); }
  };
  return {
    active,
    getTransferReceipts: (walletPublicKey) => withStore((store) => store.transaction(() => {
      const scopeId = getScopeId(walletPublicKey), network = networkForRequest();
      if (typeof scopeId !== 'string' || !scopeId) throw new Error('Read the saved launch before building its transfer report');
      return store.listWalletOperations(walletPublicKey).filter((operation) => {
        if (operation.kind !== 'token-transfer' || operation.state !== 'confirmed') return false;
        const launch = store.getLaunch(operation.launchId);
        return launch?.config.scopeId === scopeId && launch.network === network && launch.config.genesisHash === SOLANA_GENESIS_HASHES[network];
      }).map((operation) => {
        const receipt = operation.evidence?.chain;
        if (!receipt?.signature || !Number.isInteger(receipt.decimals) || !receipt.programId || !receipt.amountRaw) throw new Error('Read the complete saved transfer receipt');
        return { ...receipt, operationId: operation.id, txId: receipt.signature,
          programName: receipt.programId === TOKEN_2022_PROGRAM_ID.toBase58() ? 'token-2022' : 'classic' };
      });
    })),
    recover: (input) => execute('recover', input),
    sweepSolToDestination: (input) => execute('sweep', input),
    transferTokenWithProgram: async ({ ownerKeypair, destination, mint, programId, sourceTokenAccount, amount, decimals }) => {
      const result = await execute('transfer', { tempWalletSecretKey: Array.from(ownerKeypair.secretKey), destinationWallet: destination.toBase58(),
        mint: mint.toBase58(), programId: programId.toBase58(), sourceTokenAccount, amountRaw: amount.toString(), decimals });
      return result.txId;
    },
  };
}
