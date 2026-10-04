import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Keypair, PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { feeNftPlan, recipientList } from '../feeNftPlan.js';
import { initializeFeeVault, feeVaultAddress, decodeFeeVault, feeEntitlement, FEE_VAULT_HEADER, FEE_VAULT_ENTRY } from '../feeVaultClient.js';
import * as store from '../feeNftStore.js';
import { sendStep } from '../feeNftService.js';

const address = () => Keypair.generate().publicKey.toBase58();
const source = { venue: 'meteora', pool: address(), position: address(), nativeNftMint: address(), mints: [address(), address()], tokenPrograms: [TOKEN_PROGRAM_ID.toBase58(), TOKEN_PROGRAM_ID.toBase58()] };
test('sample list preserves all KOL wallets and both added wallets', () => {
  const sample = JSON.parse(fs.readFileSync(new URL('../docs/airdrop-lists/sample.json', import.meta.url)));
  assert.equal(recipientList(sample.wallets).length, 54);
  for (const wallet of ['Gn8MyzZYdhzsPQsTR1tbig9CrHttX7vjPVf1YsaT6CvZ', 'FFbmkRPrxkStUerKMg56taouQFG2YSkQ4p8m2Zb2Y4hY']) assert.ok(sample.wallets.includes(wallet));
});
test('fee shares use exact integers and carry rounding into later income', () => {
  assert.equal(feeEntitlement('107', '1', '54'), '1');
  assert.equal(feeEntitlement('108', '1', '54', '1'), '1');
  assert.equal(feeEntitlement('18446744073709551615', '1', '1'), '18446744073709551615');
  assert.throws(() => feeEntitlement('1', '1', '1', '2'));
});
test('plan binds recipients, NFT assets, backing and one fixed share per NFT', () => {
  const collection = { id: 'test', config: { name: 'Brand' }, collectionKey: { address: address() }, collectionSignature: 'confirmed', items: [0, 1].map((i) => ({ name: `Brand #${i}`, mintSignature: 'confirmed', key: { address: address() } })) };
  const input = { collection, source, recipients: [address(), address()], creator: address(), seed: Array(32).fill(7), programId: address(), network: 'local' };
  const p = feeNftPlan(input);
  assert.equal(p.totalWeight, '2'); assert.equal(p.shares[0].weight, '1');
  assert.notEqual(p.digest, feeNftPlan({ ...input, recipients: [address(), input.recipients[1]] }).digest);
  assert.throws(() => feeNftPlan({ ...input, recipients: [input.recipients[0]] }));
  assert.throws(() => recipientList([input.recipients[0], input.recipients[0]]));
});
test('wire format matches the Rust contract account layout', () => {
  const creator = address(); const seed = Array(32).fill(7); const programId = address(); const collection = address();
  const ix = initializeFeeVault({ programId, creator, seed, collection, source, count: 54, totalWeight: 54 });
  assert.equal(ix.data.length, 300); assert.equal(ix.data.readUInt16LE(33), 54);
  assert.equal(ix.keys[1].pubkey.toBase58(), feeVaultAddress(programId, creator, seed).toBase58());
  const d = Buffer.alloc(FEE_VAULT_HEADER + 54 * FEE_VAULT_ENTRY); d.write('TFEEV001');
  for (const [at, key] of [[8, creator], [72, collection], [105, source.pool], [137, source.position], [169, source.nativeNftMint], [201, source.mints[0]], [233, source.mints[1]], [265, source.tokenPrograms[0]], [297, source.tokenPrograms[1]]]) new PublicKey(key).toBuffer().copy(d, at);
  Buffer.from(seed).copy(d, 40); d.writeUInt16LE(54, 329); d.writeBigUInt64LE(54n, 333);
  const decoded = decodeFeeVault(d); assert.equal(decoded.count, 54); assert.equal(decoded.creator, creator); assert.deepEqual(decoded.source.mints, source.mints);
  assert.throws(() => decodeFeeVault(d.subarray(0, -1)));
});
test('public records keep signed bytes private', () => {
  assert.deepEqual(store.publicView({ id: 'x', operations: { step: { bytes: 'signed-private', signature: 'sig', status: 'prepared' } } }).operations.step, { signature: 'sig', status: 'prepared', spentLamports: undefined });
});
test('uncertain sends keep bytes and reservations; resume broadcasts the same signature', async () => {
  const before = process.env.TREBUCHET_CONFIG_DIR; const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fee-send-')); process.env.TREBUCHET_CONFIG_DIR = dir;
  try {
    const signer = Keypair.generate(); const record = store.create({}); record.maxSpendLamports = 5000;
    let broadcasts = []; let statuses = null;
    const connection = {
      getLatestBlockhash: async () => ({ blockhash: address(), lastValidBlockHeight: 100 }), getFeeForMessage: async () => ({ value: 5000 }),
      simulateTransaction: async () => ({ value: { err: null } }), sendRawTransaction: async (bytes) => { broadcasts.push(Buffer.from(bytes)); throw new Error('reply lost'); },
      getSignatureStatuses: async () => ({ value: [statuses] }), getBlockHeight: async () => 50,
      getTransaction: async () => ({ meta: { preBalances: [10000], postBalances: [5000] } }),
    };
    await assert.rejects(() => sendStep(record, connection, signer, 'one', []), /reply lost/);
    assert.equal(record.operations.one.reservedLamports, 5000);
    const saved = store.get(record.id); assert.equal(saved.operations.one.bytes, broadcasts[0].toString('base64'));
    await assert.rejects(() => sendStep(saved, connection, signer, 'one', []), /reply lost/);
    assert.ok(broadcasts[0].equals(broadcasts[1]));
    await assert.rejects(() => sendStep(saved, connection, signer, 'two', []), /spend cap/);
    statuses = { confirmationStatus: 'finalized', err: null };
    await sendStep(saved, connection, signer, 'one', []);
    assert.equal(saved.operations.one.status, 'confirmed'); assert.equal(saved.operations.one.spentLamports, 5000);
    assert.equal(broadcasts.length, 2);
  } finally { process.env.TREBUCHET_CONFIG_DIR = before; if (before === undefined) delete process.env.TREBUCHET_CONFIG_DIR; fs.rmSync(dir, { recursive: true, force: true }); }
});
