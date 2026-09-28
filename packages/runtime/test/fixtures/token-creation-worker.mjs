import { Connection } from '@solana/web3.js';
import { acquireProfileOwner } from '../../src/owner.js';
import { openRuntimeStore } from '../../src/store.js';
import { createSolanaSigner, SOLANA_GENESIS_HASHES } from '../../src/solana.js';
import { createTokenCreationService } from '../../src/token-creation.js';
import { tokenCreationChain, sweepWallet, mintSigner } from './token-creation-chain.mjs';

const [profile, rpcUrl, format, target] = process.argv.slice(2);
const owner = acquireProfileOwner(profile), store = openRuntimeStore(profile);
const walletPublicKey = sweepWallet.publicKey.toBase58(), plan = tokenCreationChain({ inline: format === 'inline' }).plan;
const service = createTokenCreationService({ owner, store, connection: new Connection(rpcUrl, 'finalized'), network: 'devnet', expectedGenesisHash: SOLANA_GENESIS_HASHES.devnet,
  signer: createSolanaSigner({ getSigners: async ({ operation }) => operation.payload.result.type === 'mint-create' ? [sweepWallet, mintSigner] : [sweepWallet] }),
  authorize: async () => true, feePolicy: async () => ({ computeUnitLimit: 500000, microLamports: 10000, feeCeilingLamports: 50000 }), timeoutMs: 0 });
const approval = { id: 'fixture-process-approval', scopeId: 'journal-a', walletPublicKey, network: 'devnet', genesisHash: SOLANA_GENESIS_HASHES.devnet,
  planDigest: service.planDigest(plan), expiresAtMs: 4102444800000, maxSpendLamports: 100000000 };
try {
  let result;
  await service.recover({ walletPublicKey, approval });
  for (const type of ['mint-create', 'metadata-create', 'supply-finalize']) {
    result = await service.execute({ scopeId: 'journal-a', walletPublicKey, plan, approval, type });
    if (type === target) break;
  }
  process.stdout.write(JSON.stringify(result) + '\n');
} finally { store.close(); owner.release(); }
