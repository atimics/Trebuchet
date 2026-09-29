import { Connection } from '@solana/web3.js';
import { createQuoteAcquisitionService } from '../../src/quote-acquisition.js';
import { openRuntimeStore } from '../../src/store.js';
import { acquireProfileOwner } from '../../src/owner.js';
import { createSolanaSigner, SOLANA_GENESIS_HASHES } from '../../src/solana.js';
import { swapWallet, wallet } from './swap-chain.mjs';
import { quoteAcquisitionChain } from './quote-acquisition-chain.mjs';

const [profile, rpcUrl, split] = process.argv.slice(2), owner = acquireProfileOwner(profile), store = openRuntimeStore(profile);
try {
  const service = createQuoteAcquisitionService({ owner, store, connection: new Connection(rpcUrl, 'finalized'), network: 'mainnet',
    expectedGenesisHash: SOLANA_GENESIS_HASHES.mainnet, signer: createSolanaSigner({ getSigners: async () => [swapWallet] }), authorize: async () => true, timeoutMs: 0 });
  let job = store.collection('runtime-quote-acquisitions/v1').load()[0];
  const input = { scopeId: 'process-launch', key: 'quotes', walletPublicKey: wallet.toBase58(), purchases: quoteAcquisitionChain({ combined: split !== 'true' }).purchases };
  const preview = job || await service.preview(input);
  const approval = { id: 'process-acquisition', scopeId: input.scopeId, key: input.key, walletPublicKey: input.walletPublicKey,
    network: 'mainnet', genesisHash: SOLANA_GENESIS_HASHES.mainnet, planDigest: preview.digest, expiresAtMs: 4102444800000, maxSpendLamports: preview.plan.maxSpendLamports };
  if (!job) job = await service.prepare({ ...input, approval });
  let result;
  try { result = await service.execute({ id: job.id, approval }); }
  catch (error) {
    if (error.code !== 'TRANSACTION_FAILED') throw error;
    const recovery = await service.prepareCleanup({ id: job.id });
    result = await service.cleanup({ id: job.id, approval: { ...approval, id: `cleanup-${recovery.digest}`, recoveryDigest: recovery.digest,
      maxSpendLamports: Math.max(approval.maxSpendLamports, recovery.maxSpendLamports) } });
  }
  process.stdout.write(JSON.stringify(result) + '\n');
} finally { store.close(); owner.release(); }
