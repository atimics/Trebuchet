import { Connection } from '@solana/web3.js';
import { acquireProfileOwner } from '@trebuchet/runtime/owner';
import { openRuntimeStore, publicJson } from '@trebuchet/runtime/store';
import { createSolanaSigner, SOLANA_GENESIS_HASHES } from '@trebuchet/runtime/solana';
import { createStoragePaymentService } from '@trebuchet/runtime/storage-payment';
import { createUploadService } from '@trebuchet/runtime/upload';
import { uploadDigest } from '@trebuchet/runtime/upload-store';
import { uploadChain, sweepWallet, uploadNodeUrl } from './upload-chain.mjs';

const [profile, rpcUrl, network = 'devnet', suppliedGenesis, suppliedTimeout = '0', uploadKey = 'sealed/metadata'] = process.argv.slice(2);
const expectedGenesisHash = suppliedGenesis || SOLANA_GENESIS_HASHES[network];
const owner = acquireProfileOwner(profile), store = openRuntimeStore(profile);
const fixture = uploadChain(), walletPublicKey = sweepWallet.publicKey.toBase58();
const bytes = Buffer.from(JSON.stringify({ name: 'Durable Token', case: uploadKey })), tags = [{ name: 'Content-Type', value: 'application/json' }];
const approval = { id: 'process-upload-approval', scopeId: 'journal-a', walletPublicKey, network, genesisHash: expectedGenesisHash,
  uploadKey, tagsDigest: uploadDigest(publicJson(tags)), contentDigest: uploadDigest(bytes), nodeUrl: uploadNodeUrl, expiresAtMs: 4102444800000, maxUploadLamports: 100000 };
const call = async (method, ...params) => {
  const response = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(10000) });
  const body = await response.json(); if (body.error) throw new Error(body.error.message); return body.result;
};
const transport = { ...fixture.transport,
  identity: () => call('storage_identity'), quote: (value) => call('storage_quote', value), balance: (wallet) => call('storage_balance', wallet),
  acknowledge: (signature) => call('storage_acknowledge', signature), findReceipt: (...args) => call('storage_receipt', ...args),
  upload: (wire) => call('storage_upload', Buffer.from(wire).toString('base64')),
};
const payment = createStoragePaymentService({ owner, store, connection: new Connection(rpcUrl, 'finalized'), network, expectedGenesisHash,
  signer: createSolanaSigner({ getSigners: async () => [sweepWallet] }), authorize: async () => true, timeoutMs: Number(suppliedTimeout),
  feePolicy: async () => ({ computeUnitLimit: 1000, microLamports: 1000, feeCeilingLamports: 10000 }) });
const service = createUploadService({ owner, store, transport, network, expectedGenesisHash, authorize: async () => true,
  pay: ({ job, plan }) => payment.execute({ scopeId: 'journal-a', walletPublicKey, plan, workflowId: job.id, approval: {
    ...approval, id: 'process-funding-approval', planDigest: payment.planDigest(plan), maxSpendLamports: 100000,
  } }) });
try {
  await service.recover({ walletPublicKey, approval });
  const result = await service.upload({ scopeId: 'journal-a', walletPublicKey, key: uploadKey, bytes, tags, approval });
  process.stdout.write(JSON.stringify(result) + '\n');
} finally { store.close(); owner.release(); }
