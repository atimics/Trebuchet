import fs from 'node:fs';
import path from 'node:path';
import { Connection, Keypair } from '@solana/web3.js';
import { createPositionWithdrawalService } from '../../src/position-withdrawal.js';
import { acquireProfileOwner } from '../../src/owner.js';
import { openRuntimeStore } from '../../src/store.js';
import { createSolanaSigner } from '../../src/solana.js';
const [profile, rpcUrl] = process.argv.slice(2), owner = acquireProfileOwner(profile), store = openRuntimeStore(profile);
try {
  const config = JSON.parse(fs.readFileSync(path.join(profile, 'withdrawal.json'), 'utf8'));
  const service = createPositionWithdrawalService({ owner, store, connection: new Connection(rpcUrl, 'finalized'), network: 'localnet',
    expectedGenesisHash: config.genesisHash, signer: createSolanaSigner({ getSigners: async () => [Keypair.fromSeed(new Uint8Array(32).fill(43))] }),
    authorize: async () => true, timeoutMs: 60000 });
  const job = store.collection('runtime-position-withdrawals/v1').load()[0] || await service.prepare(config.input);
  const approval = { id: 'validator-withdrawal', scopeId: job.plan.scopeId, key: job.plan.key, walletPublicKey: job.plan.walletPublicKey,
    network: job.plan.network, genesisHash: config.genesisHash, planDigest: job.digest, maxSpendLamports: job.plan.maxSpendLamports, expiresAtMs: config.expiresAtMs };
  const result = await service.execute({ id: job.id, approval });
  process.stdout.write(JSON.stringify(result) + '\n');
} finally { store.close(); owner.release(); }
