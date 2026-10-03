import { Keypair, PublicKey, Connection } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync, unpackMint } from '@solana/spl-token';
import { openRuntimeStore, publicJson } from '@trebuchet/runtime/store';
import { SOLANA_GENESIS_HASHES } from '@trebuchet/runtime/solana';
import { liquidityPlan, saveLiquidityPlan } from './liquidityExecution.js';
import { LockClPositionLayoutV2, CLMM_PROGRAM_ID, CLMM_LOCK_PROGRAM_ID, DEVNET_PROGRAM_ID, getPdaPersonalPositionAddress, getPdaLockClPositionIdV2 } from '@raydium-io/raydium-sdk-v2';
import { normalizeDistribution } from './lpDistribution.js';
import { getNetwork, getRpcUrl } from './rpcConfig.js';
import { createExecutionConnection } from './rpcConnection.js';

const purpose = 'liquidity-fee-key';
const paused = (message, operationId) => Object.assign(new Error(message), { code: 'EXECUTION_RECOVERY_REQUIRED', statusCode: 409, operationId });

// A Fee Key action belongs to a saved main position and its planned recipient.
// The same action returns its durable receipt after a transfer or client restart.
export function createFeeKeyExecutionRuntime({ owner, walletExecution, getJournal, getPosition, recordProgress,
  createConnection = () => createExecutionConnection(), networkForRequest = getNetwork,
}) {
  const withStore = (run) => {
    owner.assertActive();
    const store = openRuntimeStore(owner.profile);
    try { return run(store); }
    catch (cause) {
      if (cause.code === 'RECOVERY_STORAGE_UNAVAILABLE' || cause.code === 'EXECUTION_RECOVERY_REQUIRED') throw cause;
      throw Object.assign(paused('Verify the saved Fee Key action before continuing'), { cause });
    } finally { store.close(); }
  };
  const validate = (walletPublicKey, action, operationId) => {
    const context = action?.context, journal = getJournal(walletPublicKey);
    if (context?.purpose !== purpose || !journal || journal.id !== context.scopeId
        || context.network !== networkForRequest() || !Number.isSafeInteger(context.allocationIndex) || context.allocationIndex < 0
        || !Number.isSafeInteger(context.sliceIndex) || context.sliceIndex < 0) throw paused('Resume the Fee Key action for the saved launch', operationId);
    const plan = liquidityPlan(journal.poolPlan || {});
    const position = getPosition(walletPublicKey, context.allocationIndex, context.sliceIndex);
    const allocation = plan.allocations?.[context.allocationIndex];
    let recipient;
    try { recipient = allocation && normalizeDistribution(allocation.distribution)[context.sliceIndex]?.recipient; }
    catch (cause) { throw Object.assign(paused('Restore the saved Fee Key distribution', operationId), { cause }); }
    if (plan.tokenMint !== context.tokenMint || plan.lockPositions !== true || !allocation
        || recipient !== context.recipient
        || !position?.locked || position.poolId !== context.poolId || position.nftMint !== context.positionNftMint || position.feeKeyNftMint !== context.feeKeyMint
        || position.recipient !== context.recipient || action.key !== `fee-key/${context.positionNftMint}`) {
      throw paused('Verify the saved position, Fee Key mint, and planned recipient', operationId);
    }
    const saved = withStore((store) => saveLiquidityPlan(store, { scopeId: journal.id, walletPublicKey, network: context.network, plan }));
    if (context.planDigest !== saved.planDigest) throw paused('Use the approved liquidity plan for the Fee Key action', operationId);
    return context;
  };
  const pending = (walletPublicKey) => {
    const scopeId = getJournal(walletPublicKey)?.id, network = networkForRequest();
    return withStore((store) => {
      const op = store.getActiveOperation(walletPublicKey);
      if (op?.kind !== 'token-transfer') return null;
      const launch = store.getLaunch(op.launchId), action = launch?.config.action;
      if (action?.context?.purpose !== purpose) return null;
      if (launch.config.scopeId !== scopeId || launch.network !== network || launch.config.genesisHash !== SOLANA_GENESIS_HASHES[network]
          || op.payload.mint !== action.context.feeKeyMint || op.payload.destinationWallet !== action.context.recipient
          || op.payload.amountRaw !== '1' || op.payload.decimals !== 0) throw paused('Recover the original Fee Key transfer intent', op.id);
      return { op, action };
    });
  };
  const checkpoint = (walletPublicKey, result, action) => recordProgress(walletPublicKey, {
    stage: 'main_transfer_done', allocationIndex: action.context.allocationIndex, sliceIndex: action.context.sliceIndex,
    recipient: action.context.recipient, feeKeyNftMint: action.context.feeKeyMint, txId: result.txId, operationId: result.operationId,
  });
  return {
    canRecover(walletPublicKey) {
      const saved = pending(walletPublicKey);
      if (!saved) return false;
      validate(walletPublicKey, saved.action, saved.op.id);
      return true;
    },
    forLaunch(input) {
      const wallet = Keypair.fromSecretKey(Uint8Array.from(input.tempWalletSecretKey)), walletPublicKey = wallet.publicKey.toBase58();
      return async ({ allocationIndex, sliceIndex, poolId, positionNftMint, nftMint, recipient }) => {
        const journal = getJournal(walletPublicKey), scopeId = journal?.id, network = networkForRequest();
        if (!scopeId) throw paused('Save the launch journal before transferring a Fee Key');
        const plan = liquidityPlan(input);
        if (publicJson(plan) !== publicJson(liquidityPlan(journal.poolPlan || {}))) throw paused('Use the saved launch plan before transferring a Fee Key');
        const saved = withStore((store) => saveLiquidityPlan(store, { scopeId, walletPublicKey, network, plan }));
        const action = { key: `fee-key/${positionNftMint}`, context: { purpose, scopeId, network, planDigest: saved.planDigest,
          tokenMint: input.tokenMint, allocationIndex, sliceIndex, poolId, positionNftMint, feeKeyMint: nftMint, recipient } };
        validate(walletPublicKey, action);
        // Completed transfers remain usable even if their source account has
        // since been closed or the recipient has moved the NFT.
        const completed = walletExecution.getTransferReceipts(walletPublicKey).find((receipt) => receipt.action?.key === action.key);
        if (completed) {
          validate(walletPublicKey, completed.action, completed.operationId);
          if (publicJson(completed.action) !== publicJson(action)) throw paused('Use the saved Fee Key transfer action', completed.operationId);
          checkpoint(walletPublicKey, completed, action);
          return completed.txId;
        }
        const connection = createConnection(), mint = new PublicKey(nftMint);
        const lockProgram = network === 'devnet' ? DEVNET_PROGRAM_ID.CLMM_LOCK_PROGRAM_ID : CLMM_LOCK_PROGRAM_ID;
        const poolProgram = network === 'devnet' ? DEVNET_PROGRAM_ID.CLMM_PROGRAM_ID : CLMM_PROGRAM_ID;
        const lockAddress = getPdaLockClPositionIdV2(lockProgram, mint).publicKey;
        const accounts = await connection.getMultipleAccountsInfoAndContext([mint, lockAddress], { commitment: 'finalized' })
          .catch((cause) => { throw Object.assign(paused('Read the finalized Fee Key and lock before continuing'), { cause }); });
        if (!Number.isSafeInteger(accounts?.context?.slot) || accounts.context.slot < 0 || !Array.isArray(accounts.value) || accounts.value.length !== 2) throw paused('Read complete finalized Fee Key accounts');
        const [mintInfo, lockInfo] = accounts.value, program = mintInfo?.owner;
        if (!program || ![TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()].includes(program.toBase58())
            || !lockInfo || !lockInfo.owner.equals(lockProgram) || lockInfo.executable || lockInfo.data.length !== LockClPositionLayoutV2.span) throw paused('Verify the Fee Key mint and lock program');
        let mintState, lock;
        try { mintState = unpackMint(mint, mintInfo, program); lock = LockClPositionLayoutV2.decode(lockInfo.data); }
        catch (cause) { throw Object.assign(paused('Decode the finalized Fee Key mint and lock'), { cause }); }
        const positionAddress = getPdaPersonalPositionAddress(poolProgram, new PublicKey(positionNftMint)).publicKey;
        if (!mintState.isInitialized || mintState.decimals !== 0 || mintState.supply !== 1n
            || !lock.positionId.equals(positionAddress) || !lock.lockNftMint.equals(mint) || lock.poolId.toBase58() !== poolId
            || !lock.lockOwner.equals(wallet.publicKey)) throw paused('Verify the saved lock owns this position and Fee Key');
        const result = await walletExecution.transferToken({ tempWalletSecretKey: input.tempWalletSecretKey, destinationWallet: recipient,
          mint: nftMint, programId: program.toBase58(), sourceTokenAccount: getAssociatedTokenAddressSync(mint, wallet.publicKey, false, program).toBase58(),
          amountRaw: '1', decimals: 0, action });
        checkpoint(walletPublicKey, result, action);
        return result.txId;
      };
    },
    async recover({ tempWalletSecretKey, tokenMint }) {
      const walletPublicKey = Keypair.fromSecretKey(Uint8Array.from(tempWalletSecretKey)).publicKey.toBase58();
      const saved = pending(walletPublicKey);
      let result = null;
      if (saved) {
        const context = validate(walletPublicKey, saved.action, saved.op.id);
        if (tokenMint && tokenMint !== context.tokenMint) throw paused('Resume the saved launch token before transferring Fee Keys', saved.op.id);
        result = await walletExecution.recover({ tempWalletSecretKey, destinationWallet: context.recipient });
      }
      for (const receipt of walletExecution.getTransferReceipts(walletPublicKey)) {
        if (receipt.action?.context?.purpose !== purpose || (tokenMint && receipt.action.context.tokenMint !== tokenMint)) continue;
        validate(walletPublicKey, receipt.action, receipt.operationId);
        checkpoint(walletPublicKey, receipt, receipt.action);
      }
      return result;
    },
  };
}
