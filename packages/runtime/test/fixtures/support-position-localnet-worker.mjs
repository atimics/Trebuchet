import fs from 'node:fs';
import path from 'node:path';
import { Connection, Keypair } from '@solana/web3.js';
import { createSupportPositionService } from '../../src/support-position.js';
import { acquireProfileOwner } from '../../src/owner.js';
import { openRuntimeStore } from '../../src/store.js';
import { createSolanaSigner } from '../../src/solana.js';
const [profile, rpcUrl] = process.argv.slice(2), owner = acquireProfileOwner(profile), store = openRuntimeStore(profile);
try {
  const config = JSON.parse(fs.readFileSync(path.join(profile, 'support.json'), 'utf8'));
  const service = createSupportPositionService({ owner, store, connection: new Connection(rpcUrl, 'finalized'), network: 'localnet',
    expectedGenesisHash: config.genesisHash, signer: createSolanaSigner({ getSigners: async () => [Keypair.fromSeed(new Uint8Array(32).fill(43)), Keypair.fromSeed(new Uint8Array(32).fill(63))] }),
    authorize: async () => true, timeoutMs: 60000 });
  const job = store.collection('runtime-support-positions/v1').load()[0] || await service.prepare(config.input);
  const approval = { id: 'validator-support', scopeId: job.plan.scopeId, key: job.plan.key, walletPublicKey: job.plan.walletPublicKey,
    network: job.plan.network, genesisHash: config.genesisHash, planDigest: job.digest, maxSpendLamports: job.plan.maxSpendLamports, expiresAtMs: config.expiresAtMs };
  const result = await service.execute({ id: job.id, approval });
  process.stdout.write(JSON.stringify(result) + '\n');
} finally { store.close(); owner.release(); }
