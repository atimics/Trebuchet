import { randomUUID } from 'node:crypto';
import { Connection, Keypair } from '@solana/web3.js';
import { openRuntimeStore } from '@trebuchet/runtime/store';
import { createSolanaSigner, SOLANA_GENESIS_HASHES } from '@trebuchet/runtime/solana';
import { createSolSweepService } from '@trebuchet/runtime/sol-sweep';
import { getNetwork, getRpcUrl } from './rpcConfig.js';
import { samplePriorityFeeMicroLamports, priorityFeeLamports, CU_SOL_TRANSFER, SWEEP_FEE_PAD_LAMPORTS } from './priorityFees.js';

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
  const execute = async (method, { tempWalletSecretKey, destinationWallet }) => {
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
      const current = await connection.getBalanceAndContext(wallet.publicKey, { commitment: 'finalized' });
      if (!Number.isSafeInteger(current?.value) || current.value < 0) throw new Error('Read a complete wallet balance before approving the transfer');
      const approval = {
        id: randomUUID(), source: 'local-transfer-request', walletPublicKey, destinationWallet,
        network, genesisHash, expiresAtMs: now() + 10 * 60_000,
        maxSpendLamports: Math.max(current.value, pending?.kind === 'sol-sweep' ? pending.payload.amountLamports + pending.payload.feeCeilingLamports : 0),
      };
      const service = createSolSweepService({
        owner, store, connection, network, expectedGenesisHash: genesisHash, now, timeoutMs,
        signer: createSolanaSigner({ getSigners: async ({ launch }) => {
          if (launch.walletPublicKey !== walletPublicKey) throw new Error('The signer must match the saved wallet');
          return [wallet];
        } }),
        authorize: async ({ approval: candidate }) => candidate === approval && networkForRequest() === network,
        feePolicy: async () => {
          const microLamports = await samplePriorityFeeMicroLamports(connection);
          return {
            reserveLamports: await connection.getMinimumBalanceForRentExemption(0, 'finalized'),
            feeCeilingLamports: 5000 + priorityFeeLamports(CU_SOL_TRANSFER, microLamports) + SWEEP_FEE_PAD_LAMPORTS,
            computeUnitLimit: CU_SOL_TRANSFER, microLamports,
          };
        },
      });
      const scopeId = getScopeId(walletPublicKey);
      if (typeof scopeId !== 'string' || !scopeId) throw new Error('Save the launch recovery record before transferring SOL');
      return await service[method]({ scopeId, walletPublicKey, destinationWallet, approval });
    } catch (cause) {
      if (cause.code === 'RECOVERY_STORAGE_UNAVAILABLE') throw cause;
      throw Object.assign(new Error('Resume the asset transfer to verify its saved SOL operation.', { cause }), {
        code: 'EXECUTION_RECOVERY_REQUIRED', statusCode: 409,
        operationId: cause.operationId || store.getActiveOperation(walletPublicKey)?.id,
        errorDetails: { code: cause.code || 'EXECUTION_INTERRUPTED', message: cause.message },
      });
    } finally { store.close(); }
  };
  return {
    active,
    recover: (input) => execute('recover', input),
    sweepSolToDestination: (input) => execute('sweep', input),
  };
}
