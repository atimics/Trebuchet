// Fixture signer and loopback RPC only. The parent owns the private validator.
import fs from 'node:fs';
import path from 'node:path';
import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import { createSwapService } from '../../src/swap.js';
import { openRuntimeStore } from '../../src/store.js';
import { acquireProfileOwner } from '../../src/owner.js';
import { createSolanaSigner, SOLANA_GENESIS_HASHES } from '../../src/solana.js';

const [profile, rpcUrl] = process.argv.slice(2), url = new URL(rpcUrl);
if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error('Use the private validator proxy');
const config = JSON.parse(fs.readFileSync(path.join(profile, 'swap.json'), 'utf8'));
if (Object.values(SOLANA_GENESIS_HASHES).includes(config.genesisHash)) throw new Error('Use the private validator genesis hash');
const owner = acquireProfileOwner(profile), store = openRuntimeStore(profile);
try {
  const wallet = Keypair.fromSeed(new Uint8Array(32).fill(43));
  const connection = new Connection(rpcUrl, 'finalized');
  const service = createSwapService({ owner, store, connection, network: 'localnet', expectedGenesisHash: config.genesisHash,
    signer: createSolanaSigner({ getSigners: async () => [wallet] }), authorize: async () => true, timeoutMs: 60000 });
  let job = store.collection('runtime-swaps/v1').load()[0];
  if (!job) job = await service.prepare({ scopeId: config.approval.scopeId, key: config.approval.key,
    transactions: config.transactions.map((wire) => VersionedTransaction.deserialize(Buffer.from(wire, 'base64'))),
    intent: config.intent, feeCeilingLamports: config.feeCeilingLamports, approval: config.approval });
  const result = await service.execute({ id: job.id, approval: config.approval });
  process.stdout.write(JSON.stringify(result) + '\n');
} finally { store.close(); owner.release(); }
