import { createHash, createHmac, randomUUID } from 'node:crypto';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { PoolInfoLayout, PositionInfoLayout, LockClPositionLayoutV2, CLMM_PROGRAM_ID, CLMM_LOCK_PROGRAM_ID, DEVNET_PROGRAM_ID, getPdaPersonalPositionAddress, getPdaLockClPositionIdV2 } from '@raydium-io/raydium-sdk-v2';
import { unpackAccount, unpackMint, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { openRuntimeStore, publicJson } from '@trebuchet/runtime/store';
import { createPreparedTransactionService } from '@trebuchet/runtime/prepared-transaction';
import { createSolanaSigner, SOLANA_GENESIS_HASHES } from '@trebuchet/runtime/solana';
import { getNetwork, getRpcUrl } from './rpcConfig.js';
import { createExecutionConnection } from './rpcConnection.js';

export const LIQUIDITY_OPERATION_KIND = 'liquidity-transaction';
const hash = (value) => createHash('sha256').update(publicJson(value)).digest('hex');
const paused = (message) => Object.assign(new Error(message), { code: 'CHAIN_STATE_UNAVAILABLE' });
const lockProgram = (network) => (network === 'devnet' ? DEVNET_PROGRAM_ID.CLMM_LOCK_PROGRAM_ID : CLMM_LOCK_PROGRAM_ID).toBase58();
const address = (value) => new PublicKey(value).toBase58();
const clmmProgram = (network) => (network === 'devnet' ? DEVNET_PROGRAM_ID.CLMM_PROGRAM_ID : CLMM_PROGRAM_ID).toBase58();

// Separate keys for each saved action. Only the public derivation context is
// stored; the protected launch wallet is sufficient to resume after expiry.
export function deriveLiquidityAccount(wallet, scopeId, key) {
  const seed = createHmac('sha256', wallet.secretKey.subarray(0, 32)).update(publicJson({
    domain: 'trebuchet/liquidity-account/v1', wallet: wallet.publicKey.toBase58(), scopeId, key,
  })).digest();
  return Keypair.fromSeed(seed);
}

export function liquidityPlan(input) {
  return { tokenMint: input.tokenMint, tokenDecimals: input.tokenDecimals ?? 9, tokenTotalSupply: String(input.tokenTotalSupply),
    targetMarketCapUsd: input.targetMarketCapUsd, allocations: input.allocations, lockPositions: input.lockPositions !== false };
}

export function saveLiquidityPlan(store, { scopeId, walletPublicKey, network, plan }) {
  return store.saveLaunch({ id: hash({ scopeId, walletPublicKey, network, kind: 'liquidity-plan' }), walletPublicKey, network,
    planDigest: hash(plan), config: { scopeId, plan, genesisHash: SOLANA_GENESIS_HASHES[network] } });
}

export async function checkLiquidityResult(connection, network, { operation, launch, minContextSlot }) {
  const result = operation.payload.result;
  const keys = [result.targetAddress];
  if (result.type !== 'pool') keys.push(result.poolId, result.nftMint, result.nftAccount);
  const response = await connection.getMultipleAccountsInfoAndContext(keys.map((key) => new PublicKey(key)), { commitment: 'finalized', minContextSlot });
  if (!Number.isSafeInteger(response?.context?.slot) || response.context.slot < minContextSlot || !Array.isArray(response.value) || response.value.length !== keys.length) throw paused('Read complete finalized liquidity accounts');
  const [target, pool, mint, holding] = response.value;
  if (!target) {
    if (result.type !== 'pool' && (mint || holding)) throw paused('Recover the saved liquidity account identities');
    return { state: 'absent', slot: response.context.slot };
  }
  const decode = (account, layout, owner) => {
    if (!account || account.executable || account.owner.toBase58() !== owner || account.data.length !== layout.span) throw paused('Verify the liquidity account owner and layout');
    try { return layout.decode(account.data); } catch { throw paused('Decode the saved liquidity account'); }
  };
  const poolData = decode(result.type === 'pool' ? target : pool, PoolInfoLayout, clmmProgram(network));
  if (poolData.mintA.toBase58() !== result.mintA || poolData.mintB.toBase58() !== result.mintB || poolData.ammConfig.toBase58() !== result.ammConfig) throw paused('Verify the saved pool mints and configuration');
  if (result.type === 'pool') {
    if (poolData.vaultA.toBase58() !== result.vaultA || poolData.vaultB.toBase58() !== result.vaultB) throw paused('Verify the saved pool vaults');
  } else {
    const data = decode(target, result.type === 'position' ? PositionInfoLayout : LockClPositionLayoutV2, result.type === 'position' ? clmmProgram(network) : lockProgram(network));
    if (data.poolId.toBase58() !== result.poolId) throw paused('Verify the saved position pool');
    if (result.type === 'position') {
      if (data.nftMint.toBase58() !== result.nftMint || data.tickLower !== result.tickLower || data.tickUpper !== result.tickUpper || data.liquidity.isZero()) throw paused('Verify the exact position mint, range, and liquidity');
    } else if (data.positionId.toBase58() !== result.positionAddress || data.lockNftMint.toBase58() !== result.nftMint || data.lockOwner.toBase58() !== launch.walletPublicKey) throw paused('Verify the exact position lock and Fee Key mint');
    try {
      if (![TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()].includes(mint?.owner.toBase58())) throw new Error();
      const decodedMint = unpackMint(new PublicKey(result.nftMint), mint, mint.owner);
      const token = unpackAccount(new PublicKey(result.nftAccount), holding, mint.owner);
      if (!decodedMint.isInitialized || decodedMint.decimals !== 0 || decodedMint.supply !== 1n || (result.type === 'position' && decodedMint.mintAuthority)
          || token.owner.toBase58() !== launch.walletPublicKey || token.mint.toBase58() !== result.nftMint || token.amount !== 1n) throw new Error();
    } catch { throw paused('Verify the launch wallet owns the saved position or Fee Key NFT'); }
  }
  return { state: 'present', slot: response.context.slot, evidence: { targetAddress: result.targetAddress } };
}

export function createLiquidityExecutionRuntime({ owner, getScopeId, recordProgress,
  createConnection = () => createExecutionConnection(), networkForRequest = getNetwork,
  now = Date.now, timeoutMs = 60_000,
}) {
  if (!owner || typeof getScopeId !== 'function' || typeof recordProgress !== 'function') throw new TypeError('Liquidity execution requires the profile owner and journal interfaces');
  const adapter = async (wallet, plan, scopeId, run) => {
    owner.assertActive();
    const network = networkForRequest(), connection = createConnection();
    const walletPublicKey = wallet.publicKey.toBase58();
    const store = openRuntimeStore(owner.profile);
    try {
      const genesisHash = SOLANA_GENESIS_HASHES[network];
      if (!genesisHash) throw paused('Choose the saved launch network');
      saveLiquidityPlan(store, { scopeId, walletPublicKey, network, plan });
      const pending = store.getActiveOperation(walletPublicKey);
      const balance = await connection.getBalanceAndContext(wallet.publicKey, { commitment: 'finalized' });
      if (!Number.isSafeInteger(balance?.value) || balance.value < 0) throw paused('Read the complete launch wallet balance');
      const approval = { id: randomUUID(), source: 'local-liquidity-request', walletPublicKey, network, genesisHash, scopeId,
        planDigest: hash(plan), expiresAtMs: now() + 10 * 60_000, maxSpendLamports: Math.max(balance.value, pending?.payload.maxSpendLamports || 0) };
      const service = createPreparedTransactionService({ owner, store, connection, network, expectedGenesisHash: genesisHash,
        kind: LIQUIDITY_OPERATION_KIND, now, timeoutMs,
        signer: createSolanaSigner({ getSigners: async ({ launch, operation }) => {
          if (launch.walletPublicKey !== walletPublicKey || launch.config.scopeId !== scopeId) throw paused('Use the saved launch wallet to sign liquidity');
          const derived = deriveLiquidityAccount(wallet, scopeId, operation.payload.key);
          return operation.payload.result.type === 'pool' ? [wallet] : [wallet, derived];
        } }),
        authorize: async ({ approval: value }) => value === approval && networkForRequest() === network && getScopeId(walletPublicKey) === scopeId,
        checkResult: (context) => checkLiquidityResult(connection, network, context),
      });
      return await run({ store, service, approval, connection, network, walletPublicKey });
    } catch (cause) {
      if (cause.code === 'RECOVERY_STORAGE_UNAVAILABLE') throw cause;
      // Say why: the saved operation is re-checked on every resume, so a bare "resume" message loops.
      console.error(`[liquidity] ${cause.code || 'LIQUIDITY_INTERRUPTED'}: ${cause.message}`);
      throw Object.assign(new Error(`A pool step could not be confirmed (${cause.message || 'interrupted'}). Nothing after it was sent.`, { cause }), {
        code: 'EXECUTION_RECOVERY_REQUIRED', statusCode: 409, operationId: cause.operationId || store.getActiveOperation(walletPublicKey)?.id,
        errorDetails: { code: cause.code || 'LIQUIDITY_INTERRUPTED', message: cause.message },
      });
    } finally { store.close(); }
  };
  const checkpoint = (walletPublicKey, result) => recordProgress(walletPublicKey, { ...result.event, txId: result.txId || result.signature || null, operationId: result.operationId });
  return {
    // The liquidity plan saved when this launch first prepared liquidity, if any. A resume follows
    // it: the screen may have changed since (a toggle, a fix that carries more fields), and the
    // saved plan is immutable, so rebuilding from the screen can only conflict or diverge.
    savedPlan(input) {
      owner.assertActive();
      const walletPublicKey = Keypair.fromSecretKey(Uint8Array.from(input.tempWalletSecretKey)).publicKey.toBase58();
      const scopeId = getScopeId(walletPublicKey);
      if (!scopeId) return null;
      const db = openRuntimeStore(owner.profile);
      try {
        const saved = db.getLaunch(hash({ scopeId, walletPublicKey, network: networkForRequest(), kind: 'liquidity-plan' }));
        return saved?.config?.plan || null;
      } finally { db.close(); }
    },
    forLaunch(input) {
      const wallet = Keypair.fromSecretKey(Uint8Array.from(input.tempWalletSecretKey));
      const walletPublicKey = wallet.publicKey.toBase58(), scopeId = getScopeId(walletPublicKey), plan = liquidityPlan(input);
      if (!scopeId) throw paused('Save the launch journal before preparing liquidity');
      return {
        execute: ({ key, action, build }) => adapter(wallet, plan, scopeId, async ({ service, approval, connection, network }) => {
          const derived = deriveLiquidityAccount(wallet, scopeId, key);
          const result = await service.execute({ scopeId, walletPublicKey, key, plan, approval, build: async () => {
            const sdk = await build({ getEphemeralSigners: async (count) => {
              if (count !== 1) throw paused('Review the SDK account signer requirements');
              return [derived.publicKey.toBase58()];
            } });
            if (!sdk.transaction?.message || !Array.isArray(sdk.signers) || sdk.signers.some((value) => !value.publicKey.equals(wallet.publicKey))) throw paused('Verify the SDK transaction and saved signer identities');
            const ext = sdk.extInfo;
            let captured;
            if (action.type === 'pool') {
              const value = ext.address;
              captured = { ...action, poolId: address(value.id), targetAddress: address(value.id), mintA: address(value.mintA.address), mintB: address(value.mintB.address),
                ammConfig: address(value.config.id), vaultA: address(value.vault.A), vaultB: address(value.vault.B) };
            } else {
              const info = await connection.getAccountInfo(new PublicKey(action.poolId), 'finalized');
              if (!info || info.owner.toBase58() !== clmmProgram(network) || info.data.length !== PoolInfoLayout.span) throw paused('Verify the pool before preparing its position');
              const pool = PoolInfoLayout.decode(info.data);
              captured = { ...action, mintA: address(pool.mintA), mintB: address(pool.mintB), ammConfig: address(pool.ammConfig),
                targetAddress: address(action.type === 'position' ? ext.personalPosition : ext.lockPositionId),
                nftMint: address(action.type === 'position' ? ext.nftMint : ext.lockNftMint),
                nftAccount: address(action.type === 'position' ? ext.positionNftAccount : ext.lockNftAccount),
                ...(action.type === 'lock' ? { positionAddress: address(ext.positionId) } : {}) };
              if (captured.nftMint !== derived.publicKey.toBase58()) throw paused('Use the saved account signer for this liquidity action');
              const position = getPdaPersonalPositionAddress(new PublicKey(clmmProgram(network)), new PublicKey(action.type === 'position' ? captured.nftMint : action.positionNftMint)).publicKey.toBase58();
              const target = action.type === 'position' ? position : getPdaLockClPositionIdV2(new PublicKey(lockProgram(network)), new PublicKey(captured.nftMint)).publicKey.toBase58();
              if (captured.targetAddress !== target || (action.type === 'lock' && captured.positionAddress !== position)) throw paused('Verify the derived position and lock account addresses');
            }
            captured.event = { ...action.event, poolId: captured.poolId,
              ...(action.type === 'position' ? { nftMint: captured.nftMint, tickLower: action.tickLower, tickUpper: action.tickUpper } : {}),
              ...(action.type === 'lock' ? { feeKeyNftMint: captured.nftMint } : {}) };
            const fee = await connection.getFeeForMessage(sdk.transaction.message, 'finalized');
            if (!Number.isSafeInteger(fee?.value) || fee.value < 0) throw paused('Read the complete liquidity transaction fee');
            return { transaction: sdk.transaction, result: JSON.parse(publicJson(captured)), allowExisting: action.type === 'pool',
              feeCeilingLamports: fee.value + 10_000, maxSpendLamports: approval.maxSpendLamports };
          } });
          checkpoint(walletPublicKey, result);
          return { skipped: false, value: { tx: { txId: result.txId }, res: { extInfo: { nftMint: result.type === 'position' ? new PublicKey(result.nftMint) : undefined,
            lockNftMint: result.type === 'lock' ? new PublicKey(result.nftMint) : undefined } }, saved: result } };
        }),
      };
    },
    async recover({ tempWalletSecretKey, tokenMint }) {
      owner.assertActive();
      const wallet = Keypair.fromSecretKey(Uint8Array.from(tempWalletSecretKey)), walletPublicKey = wallet.publicKey.toBase58();
      const scopeId = getScopeId(walletPublicKey);
      const db = openRuntimeStore(owner.profile);
      let pending, launch, completed;
      try {
        pending = db.getActiveOperation(walletPublicKey);
        launch = pending?.kind === LIQUIDITY_OPERATION_KIND ? db.getLaunch(pending.launchId) : null;
        completed = db.listWalletOperations(walletPublicKey).filter((op) => {
          const saved = db.getLaunch(op.launchId);
          return op.kind === LIQUIDITY_OPERATION_KIND && op.state === 'confirmed' && saved.config.scopeId === scopeId
            && (!tokenMint || saved.config.plan.tokenMint === tokenMint) && saved.network === networkForRequest();
        });
      } finally { db.close(); }
      if (launch) {
        if (launch.config.scopeId !== scopeId || (tokenMint && launch.config.plan.tokenMint !== tokenMint)) throw paused('Resume liquidity for the saved launch and token');
        const result = await adapter(wallet, launch.config.plan, scopeId, ({ service, approval }) => service.recover({ walletPublicKey, approval }));
        // Replay earlier receipts first, then the recovered action.
        for (const op of completed) checkpoint(walletPublicKey, { ...op.evidence.chain, operationId: op.id });
        checkpoint(walletPublicKey, result);
        return result;
      }
      for (const op of completed) checkpoint(walletPublicKey, { ...op.evidence.chain, operationId: op.id });
      return null;
    },
  };
}
