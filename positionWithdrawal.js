import { randomUUID } from 'node:crypto';
import { Connection } from '@solana/web3.js';
import { openRuntimeStore, publicJson } from '@trebuchet/runtime/store';
import { createPositionWithdrawalService } from '@trebuchet/runtime/position-withdrawal';
import { createSolanaSigner, SOLANA_GENESIS_HASHES } from '@trebuchet/runtime/solana';
import { getNetwork, getRpcUrl } from './rpcConfig.js';

const fail = (code, message, statusCode = 409) => Object.assign(new Error(message), { code, statusCode });
const owners = new WeakMap();

export function createPositionWithdrawalRuntime({ owner, createConnection = () => new Connection(getRpcUrl(), 'finalized'),
  networkForRequest = getNetwork, genesisForNetwork = (network) => SOLANA_GENESIS_HASHES[network], now = Date.now, timeoutMs = 60000 }) {
  if (!owners.has(owner)) owners.set(owner, new Set());
  const running = owners.get(owner);
  const service = (store, extras = {}) => {
    const network = networkForRequest(), expectedGenesisHash = genesisForNetwork(network);
    return createPositionWithdrawalService({ owner, store, connection: createConnection(), network, expectedGenesisHash, authorize: async () => false, now, timeoutMs, ...extras });
  };
  const view = (job) => ({ jobId: job.id, walletPublicKey: job.plan.walletPublicKey, poolId: job.plan.poolId, nftMint: job.plan.nftMint,
    network: job.plan.network, genesisHash: job.plan.genesisHash, planDigest: job.digest, liquidity: job.plan.liquidity,
    status: job.state === 'prepared' ? 'review_required' : job.state === 'approved' ? running.has(job.plan.walletPublicKey) ? 'running' : 'paused' : job.state,
    tokens: job.plan.tokens.map(({ mint, decimals, minimumRaw, native, destination }) => ({ mint, decimals, minimumRaw, native, destination: native ? job.plan.walletPublicKey : destination })),
    feeCeilingLamports: job.plan.feeCeilingLamports, rentCeilingLamports: job.plan.rentCeilingLamports, maxSpendLamports: job.plan.maxSpendLamports, result: job.result });
  const withStore = (fn) => { owner.assertActive(); const store = openRuntimeStore(owner.profile); try { return fn(store); } finally { store.close(); } };
  const checkHost = (job) => {
    owner.assertActive();
    if (job.plan.network !== networkForRequest() || job.plan.genesisHash !== genesisForNetwork(job.plan.network)) throw fail('NETWORK_MISMATCH', 'Select the saved withdrawal network before continuing');
  };
  return {
    get(id) { return withStore((store) => { const job = service(store).get(id); return job ? view(job) : null; }); },
    list(wallets, tokenMint) { return withStore((store) => {
      const execution = service(store);
      return wallets.flatMap((wallet) => execution.list(wallet)).filter((job) => !tokenMint || job.plan.tokens.some((row) => row.mint === tokenMint)).map(view);
    }); },
    async prepare({ walletPublicKey, poolId, nftMint, expected, requestId = randomUUID(), lookupTables = [] }) {
      if (running.has(walletPublicKey)) throw fail('OPERATION_IN_FLIGHT', 'Wait for the active withdrawal request');
      owner.assertActive(); const store = openRuntimeStore(owner.profile); running.add(walletPublicKey);
      try {
        const execution = service(store), saved = execution.list(walletPublicKey).find((job) => job.state === 'approved');
        if (saved) { checkHost(saved); return view(saved); }
        const job = await execution.prepare({ scopeId: `wallet/${walletPublicKey}`, key: `position/${requestId}`, walletPublicKey,
          poolId, nftMint, expectedLiquidity: String(expected?.liquidity ?? ''), requestId, lookupTables });
        checkHost(job); return view(job);
      } finally { running.delete(walletPublicKey); store.close(); }
    },
    async execute({ id, ownerKeypair, planDigest, maxSpendLamports }) {
      const walletPublicKey = ownerKeypair.publicKey.toBase58();
      if (running.has(walletPublicKey)) throw fail('OPERATION_IN_FLIGHT', 'Wait for the active withdrawal request');
      owner.assertActive(); const store = openRuntimeStore(owner.profile); running.add(walletPublicKey);
      try {
        const job = service(store).get(id);
        if (!job || job.plan.walletPublicKey !== walletPublicKey) throw fail('OPERATION_UNKNOWN', 'Use the saved withdrawal and its wallet', 404);
        checkHost(job);
        if (planDigest !== job.digest || maxSpendLamports !== job.plan.maxSpendLamports) throw fail('EXECUTION_APPROVAL_REQUIRED', 'Confirm the saved withdrawal and exact spending ceiling');
        const approval = { id: randomUUID(), scopeId: job.plan.scopeId, key: job.plan.key, walletPublicKey, network: job.plan.network,
          genesisHash: job.plan.genesisHash, planDigest, maxSpendLamports, expiresAtMs: now() + 10 * 60000 };
        const signer = createSolanaSigner({ getSigners: async ({ launch }) => {
          checkHost(job); if (launch.walletPublicKey !== walletPublicKey) throw fail('SIGNER_MISMATCH', 'Sign the saved withdrawal wallet'); return [ownerKeypair];
        } });
        return await service(store, { signer, authorize: async ({ approval: candidate }) => { checkHost(job); return publicJson(candidate) === publicJson(approval); } }).execute({ id, approval });
      } finally { running.delete(walletPublicKey); store.close(); }
    },
  };
}
