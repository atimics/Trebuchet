import { randomUUID } from 'node:crypto';
import { Connection } from '@solana/web3.js';
import { openRuntimeStore, publicJson } from '@trebuchet/runtime/store';
import { createSupportPositionService } from '@trebuchet/runtime/support-position';
import { createSolanaSigner, SOLANA_GENESIS_HASHES } from '@trebuchet/runtime/solana';
import { deriveLiquidityAccount } from './liquidityExecution.js';
import { previewSolSupport } from './lpService.js';
import { getNetwork, getRpcUrl } from './rpcConfig.js';
import { createExecutionConnection } from './rpcConnection.js';

const fail = (code, message, statusCode = 409) => Object.assign(new Error(message), { code, statusCode });
const owners = new WeakMap();
export function createSupportPositionRuntime({ owner, createConnection = () => createExecutionConnection(),
  networkForRequest = getNetwork, genesisForNetwork = (network) => SOLANA_GENESIS_HASHES[network], planSupport = previewSolSupport, now = Date.now, timeoutMs = 60000 }) {
  if (!owners.has(owner)) owners.set(owner, new Set());
  const running = owners.get(owner);
  const service = (store, extras = {}) => {
    const network = networkForRequest();
    return createSupportPositionService({ owner, store, connection: createConnection(), network, expectedGenesisHash: genesisForNetwork(network), authorize: async () => false, now, timeoutMs, ...extras });
  };
  const view = (job) => {
    const plan = job.plan, review = plan.request.review || {}, rentFor = (...types) => plan.rents.filter((row) => types.includes(row.type)).reduce((sum, row) => sum + row.rentCeilingLamports, 0);
    return { jobId: job.id, walletPublicKey: plan.walletPublicKey, poolId: plan.poolId, nftMint: plan.nftMint,
      network: plan.network, genesisHash: plan.genesisHash, planDigest: job.digest, liquidity: plan.liquidity,
      status: job.state === 'prepared' ? 'review_required' : job.state === 'approved' ? running.has(plan.walletPublicKey) ? 'running' : 'paused' : job.state,
      depositLamports: plan.depositLamports, depositedRaw: plan.depositedRaw, tickLower: plan.tickLower, tickUpper: plan.tickUpper,
      tokenMint: plan.tokenMint, feeCeilingLamports: plan.feeCeilingLamports, rentCeilingLamports: plan.rentCeilingLamports, maxSpendLamports: plan.maxSpendLamports, result: job.result,
      plan: { ...review, poolId: plan.poolId, token: { mint: plan.tokenMint, decimals: plan.tokenDecimals, symbol: review.token?.symbol || null },
        tickLower: plan.tickLower, tickUpper: plan.tickUpper, depositLamports: plan.depositLamports, tickSpacing: plan.tickSpacing,
        newTickArrays: plan.rents.filter((row) => row.type === 'tick-array' && row.created).length,
        newArrayRentLamports: String(rentFor('tick-array')), positionRentLamports: String(rentFor('position', 'nft-mint', 'nft-account')),
        otherRentLamports: String(rentFor('token-account', 'protocol-position') + plan.temporaryRentLamports),
        feeBufferLamports: String(plan.feeCeilingLamports), totalLamports: String(plan.maxSpendLamports), walletLamports: review.walletLamports ?? null,
        enoughSol: null, locked: false } };
  };
  const withStore = (run) => { owner.assertActive(); const store = openRuntimeStore(owner.profile); try { return run(store); } finally { store.close(); } };
  const checkHost = (job) => {
    owner.assertActive();
    if (job.plan.network !== networkForRequest() || job.plan.genesisHash !== genesisForNetwork(job.plan.network)) throw fail('NETWORK_MISMATCH', 'Select the saved support network before continuing');
  };
  return {
    get(id) { return withStore((store) => { const job = service(store).get(id); return job ? view(job) : null; }); },
    list(wallets) { return withStore((store) => { const execution = service(store); return wallets.flatMap((wallet) => execution.list(wallet)).map(view); }); },
    async prepare({ ownerKeypair, poolId, solAmount, depthPct, requestId = randomUUID(), lookupTables = [] }) {
      const walletPublicKey = ownerKeypair.publicKey.toBase58();
      if (running.has(walletPublicKey)) throw fail('OPERATION_IN_FLIGHT', 'Wait for the active support request');
      owner.assertActive(); const store = openRuntimeStore(owner.profile); running.add(walletPublicKey);
      try {
        const execution = service(store), saved = execution.list(walletPublicKey).find((job) => job.state === 'approved');
        if (saved) { checkHost(saved); return view(saved); }
        const scopeId = `wallet/${walletPublicKey}`, key = `support/${requestId}`;
        const request = { poolId, solAmount: String(solAmount), depthPct: depthPct == null ? null : String(depthPct), lookupTables };
        const prior = execution.list(walletPublicKey).find((job) => job.plan.scopeId === scopeId && job.plan.key === key);
        if (prior) { checkHost(prior); if (publicJson(prior.plan.request.review?.request) !== publicJson(request)) throw fail('OPERATION_CONFLICT', 'Recover the original support request before changing it'); return view(prior); }
        const network = networkForRequest(), preview = await planSupport({ walletPublicKey, poolId, solAmount, depthPct });
        if (networkForRequest() !== network) throw fail('NETWORK_MISMATCH', 'Prepare support on the selected network');
        const nft = deriveLiquidityAccount(ownerKeypair, scopeId, key);
        const review = { request, token: preview.token, depthPct: preview.depthPct, currentPriceSol: preview.currentPriceSol, topPriceSol: preview.topPriceSol,
          bottomPriceSol: preview.bottomPriceSol, ceiling: preview.ceiling || null, warnings: preview.warnings || [], walletLamports: preview.walletLamports ?? null };
        const job = await execution.prepare({ scopeId, key, walletPublicKey, poolId: preview.poolId, nftMint: nft.publicKey.toBase58(), requestId, lookupTables,
          depositLamports: String(preview.depositLamports), tickLower: preview.tickLower, tickUpper: preview.tickUpper, review });
        checkHost(job); return view(job);
      } finally { running.delete(walletPublicKey); store.close(); }
    },
    async execute({ id, ownerKeypair, planDigest, maxSpendLamports }) {
      const walletPublicKey = ownerKeypair.publicKey.toBase58();
      if (running.has(walletPublicKey)) throw fail('OPERATION_IN_FLIGHT', 'Wait for the active support request');
      owner.assertActive(); const store = openRuntimeStore(owner.profile); running.add(walletPublicKey);
      try {
        const job = service(store).get(id);
        if (!job || job.plan.walletPublicKey !== walletPublicKey) throw fail('OPERATION_UNKNOWN', 'Use the saved support job and its wallet', 404);
        checkHost(job);
        if (planDigest !== job.digest || maxSpendLamports !== job.plan.maxSpendLamports) throw fail('EXECUTION_APPROVAL_REQUIRED', 'Confirm the saved support position and exact spending ceiling');
        const nft = deriveLiquidityAccount(ownerKeypair, job.plan.scopeId, job.plan.key);
        if (nft.publicKey.toBase58() !== job.plan.nftMint) throw fail('SIGNER_MISMATCH', 'Recover the original support NFT signer');
        const approval = { id: randomUUID(), scopeId: job.plan.scopeId, key: job.plan.key, walletPublicKey, network: job.plan.network,
          genesisHash: job.plan.genesisHash, planDigest, maxSpendLamports, expiresAtMs: now() + 10 * 60000 };
        const signer = createSolanaSigner({ getSigners: async ({ launch }) => { checkHost(job);
          if (launch.walletPublicKey !== walletPublicKey) throw fail('SIGNER_MISMATCH', 'Sign the saved support wallet'); return [ownerKeypair, nft]; } });
        return await service(store, { signer, authorize: async ({ approval: candidate }) => { checkHost(job); return publicJson(candidate) === publicJson(approval); } }).execute({ id, approval });
      } finally { running.delete(walletPublicKey); store.close(); }
    },
  };
}
