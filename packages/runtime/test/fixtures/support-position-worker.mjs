import { Connection } from '@solana/web3.js';
import { createSupportPositionService } from '../../src/support-position.js';
import { acquireProfileOwner } from '../../src/owner.js';
import { openRuntimeStore } from '../../src/store.js';
import { createSolanaSigner, SOLANA_GENESIS_HASHES } from '../../src/solana.js';
import { supportChain, supportWallet, supportNft } from './support-position-chain.mjs';
const [profile, rpcUrl, mode] = process.argv.slice(2), owner = acquireProfileOwner(profile), store = openRuntimeStore(profile);
try {
  const service = createSupportPositionService({ owner, store, connection: new Connection(rpcUrl, 'finalized'), network: 'mainnet',
    expectedGenesisHash: SOLANA_GENESIS_HASHES.mainnet, signer: createSolanaSigner({ getSigners: async () => [supportWallet, supportNft] }), authorize: async () => true, timeoutMs: 0 });
  const source = supportChain({ nft2022: ['nft2022', 'native-b'].includes(mode), mintSeed: mode === 'native-b' ? 58 : 60 });
  const job = store.collection('runtime-support-positions/v1').load()[0] || await service.prepare({ ...source.input, lookupTables: [], scopeId: 'crash-test', key: 'support' });
  const approval = { id: 'crash-approval', scopeId: job.plan.scopeId, key: job.plan.key, walletPublicKey: job.plan.walletPublicKey, network: job.plan.network,
    genesisHash: job.plan.genesisHash, planDigest: job.digest, expiresAtMs: 4102444800000, maxSpendLamports: job.plan.maxSpendLamports };
  let result;
  try { result = await service.execute({ id: job.id, approval }); }
  catch (error) { if (error.code !== 'TRANSACTION_FAILED') throw error; result = await service.execute({ id: job.id }); }
  process.stdout.write(JSON.stringify(result) + '\n');
} finally { store.close(); owner.release(); }
