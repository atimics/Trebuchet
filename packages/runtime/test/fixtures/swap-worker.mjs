import { Connection } from '@solana/web3.js';
import { createSwapService } from '../../src/swap.js';
import { reviewSwapBundle } from '../../src/swap-bundle.js';
import { openRuntimeStore } from '../../src/store.js';
import { acquireProfileOwner } from '../../src/owner.js';
import { createSolanaSigner, SOLANA_GENESIS_HASHES } from '../../src/solana.js';
import { swapWallet, intent, swapTransactions } from './swap-chain.mjs';

const [profile, rpcUrl, recoverFailure] = process.argv.slice(2), owner = acquireProfileOwner(profile), store = openRuntimeStore(profile);
try {
  const service = createSwapService({ owner, store, connection: new Connection(rpcUrl, 'finalized'), network: 'mainnet', expectedGenesisHash: SOLANA_GENESIS_HASHES.mainnet,
    signer: createSolanaSigner({ getSigners: async () => [swapWallet] }), authorize: async () => true, timeoutMs: 0 });
  let job = store.collection('runtime-swaps/v1').load()[0];
  const transactions = swapTransactions(), review = await reviewSwapBundle({ transactions, intent });
  const approval = { id: 'process-purchase', scopeId: 'process-launch', key: 'purchase/0', walletPublicKey: intent.walletPublicKey,
    network: 'mainnet', genesisHash: SOLANA_GENESIS_HASHES.mainnet, bundleDigest: review.digest, expiresAtMs: 4102444800000, maxSpendLamports: 6000000 };
  if (!job) job = await service.prepare({ scopeId: approval.scopeId, key: approval.key, transactions, intent, feeCeilingLamports: 10000, approval });
  let result;
  try { result = await service.execute({ id: job.id, approval }); }
  catch (error) {
    if (recoverFailure !== 'true' || error.code !== 'TRANSACTION_FAILED') throw error;
    const attempt = await service.prepareCleanup({ id: job.id }), plan = attempt.plan;
    result = await service.cleanup({ id: job.id, approval: { id: 'process-cleanup', scopeId: plan.scopeId, key: plan.key, walletPublicKey: plan.walletPublicKey,
      network: plan.network, genesisHash: plan.genesisHash, bundleDigest: plan.bundleDigest, recoveryDigest: attempt.digest, expiresAtMs: 4102444800000, maxSpendLamports: plan.maxSpendLamports } });
  }
  process.stdout.write(JSON.stringify(result) + '\n');
} finally { store.close(); owner.release(); }
