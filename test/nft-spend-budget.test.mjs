import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionMessage, VersionedTransaction,
} from '@solana/web3.js';
import { TransactionBuilder } from '@metaplex-foundation/umi';
import { fromWeb3JsTransaction } from '@metaplex-foundation/umi-web3js-adapters';
import bs58 from 'bs58';
import {
  createNftSpendBudget, installNftUploadBudget, sendNftTransaction, spendCapLamports,
} from '../nftSpendBudget.js';

const payer = Keypair.generate().publicKey;
const recipient = Keypair.generate().publicKey;
const umi = { payer: { publicKey: payer.toBase58() } };
const transfer = (cost) => SystemProgram.transfer({ fromPubkey: payer, toPubkey: recipient, lamports: cost });
const parsedTransfer = (cost) => ({
  programId: SystemProgram.programId,
  parsed: { type: 'transfer', info: { source: payer.toBase58(), destination: recipient.toBase58(), lamports: cost } },
});
function simulation(instructions) {
  return { context: { slot: 1 }, value: { err: null, innerInstructions: [{ index: 0, instructions }] } };
}
function mintFixture({ cost = 400, fee = 100, send = async () => ({ signature: new Uint8Array(64) }) } = {}) {
  const transaction = new VersionedTransaction(new TransactionMessage({
    payerKey: payer, recentBlockhash: PublicKey.default.toBase58(), instructions: [],
  }).compileToV0Message());
  const builder = {
    async setLatestBlockhash() { return this; },
    build() { return fromWeb3JsTransaction(transaction); },
    sendAndConfirm: send,
  };
  const connection = {
    async simulateTransaction(_, config) {
      assert.equal(config.innerInstructions, true);
      return simulation([parsedTransfer(cost)]);
    },
    async getFeeForMessage() { return { value: fee }; },
  };
  return { builder, connection };
}

test('spend caps require a finite amount of whole lamports', () => {
  for (const value of [Infinity, NaN, 0, -1, 0.0000000001, 1e10]) {
    assert.throws(() => spendCapLamports(value), /valid spend cap/);
  }
  assert.equal(spendCapLamports(0.001), 1_000_000);
});

test('concurrent mint workers reserve rent and fees before they send', async () => {
  let sends = 0;
  const fixture = mintFixture({ send: async () => { sends++; } });
  const budget = createNftSpendBudget({ maxSpendSol: 0.000001, balanceLamports: 10_000 });
  const results = await Promise.allSettled(Array.from({ length: 4 }, () => sendNftTransaction(fixture.builder, umi, fixture.connection, budget)));
  assert.equal(sends, 2);
  assert.equal(budget.reservedLamports, 1000);
  assert.equal(results.filter((result) => result.status === 'rejected' && result.reason.code === 'NFT_SPEND_CAP').length, 2);
});

test('a failed send keeps its reservation for a transaction that may have landed', async () => {
  let sends = 0;
  const fixture = mintFixture({ send: async () => { sends++; throw new Error('confirmation timed out'); } });
  const budget = createNftSpendBudget({ maxSpendSol: 0.0000005, balanceLamports: 10_000 });
  await assert.rejects(sendNftTransaction(fixture.builder, umi, fixture.connection, budget), /confirmation timed out/);
  await assert.rejects(sendNftTransaction(fixture.builder, umi, fixture.connection, budget), { code: 'NFT_SPEND_CAP' });
  assert.equal(sends, 1);
});

test('raw System Program creation instructions contribute rent to the budget', async () => {
  let sends = 0;
  const fixture = mintFixture({ send: async () => { sends++; } });
  const create = SystemProgram.createAccount({ fromPubkey: payer, newAccountPubkey: recipient, lamports: 600, space: 100, programId: recipient });
  fixture.connection.simulateTransaction = async () => simulation([{
    programId: create.programId, accounts: create.keys.map((key) => key.pubkey), data: bs58.encode(create.data),
  }, parsedTransfer(400)]);
  const budget = createNftSpendBudget({ maxSpendSol: 0.000001, balanceLamports: 10_000 });
  await assert.rejects(sendNftTransaction(fixture.builder, umi, fixture.connection, budget), { code: 'NFT_SPEND_CAP' });
  assert.equal(sends, 0);
});

test('missing simulation costs or fees stop the transaction before send', async () => {
  let sends = 0;
  const fixture = mintFixture({ send: async () => { sends++; } });
  const budget = createNftSpendBudget({ maxSpendSol: 1, balanceLamports: 10_000 });
  fixture.connection.simulateTransaction = async () => ({ value: { err: null } });
  await assert.rejects(sendNftTransaction(fixture.builder, umi, fixture.connection, budget), /cost is unavailable/);
  fixture.connection.simulateTransaction = async () => simulation([parsedTransfer(400)]);
  fixture.connection.getFeeForMessage = async () => ({ value: null });
  await assert.rejects(sendNftTransaction(fixture.builder, umi, fixture.connection, budget), /fee is unavailable/);
  assert.equal(sends, 0);
});

test('storage funding and automatic upload top-ups share the approved budget', async () => {
  let sends = 0;
  const driver = { async sendTx() { sends++; } };
  const funding = () => driver.sendTx(new Transaction({ feePayer: payer, recentBlockhash: PublicKey.default.toBase58() }).add(transfer(500)));
  const uploader = {
    async irys() { return { utils: { tokenConfig: driver } }; },
    fund: funding,
    async upload() { await funding(); return ['uri']; },
  };
  const budget = createNftSpendBudget({ maxSpendSol: 0.000001, balanceLamports: 10_000 });
  await installNftUploadBudget({ ...umi, uploader }, { async getFeeForMessage() { return { value: 100 }; } }, budget);
  await uploader.fund();
  await assert.rejects(uploader.upload(), { code: 'NFT_SPEND_CAP' });
  assert.equal(sends, 1);
  assert.equal(budget.reservedLamports, 600);
});

test('a storage funding fee can put the first upload over the cap', async () => {
  let sends = 0;
  const driver = { async sendTx() { sends++; } };
  const budget = createNftSpendBudget({ maxSpendSol: 0.0000005, balanceLamports: 10_000 });
  await installNftUploadBudget({ ...umi, uploader: { async irys() { return { utils: { tokenConfig: driver } }; } } },
    { async getFeeForMessage() { return { value: 100 }; } }, budget);
  await assert.rejects(driver.sendTx(new Transaction({ feePayer: payer, recentBlockhash: PublicKey.default.toBase58() }).add(transfer(500))), { code: 'NFT_SPEND_CAP' });
  assert.equal(sends, 0);
});

test('collection creation waits for enough approved budget', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'trebuchet-nft-budget-'));
  const previousDir = process.env.TREBUCHET_CONFIG_DIR;
  const previousUploader = process.env.TREBUCHET_NFT_LOCAL_UPLOADER;
  process.env.TREBUCHET_CONFIG_DIR = dir;
  process.env.TREBUCHET_NFT_LOCAL_UPLOADER = '1';
  t.after(async () => {
    if (previousDir === undefined) delete process.env.TREBUCHET_CONFIG_DIR;
    else process.env.TREBUCHET_CONFIG_DIR = previousDir;
    if (previousUploader === undefined) delete process.env.TREBUCHET_NFT_LOCAL_UPLOADER;
    else process.env.TREBUCHET_NFT_LOCAL_UPLOADER = previousUploader;
    await rm(dir, { recursive: true, force: true });
  });
  const store = await import('../nftCollectionStore.js');
  const service = await import('../nftService.js');
  const wallet = Keypair.generate();
  const key = await service.grindOneKey({ mode: 'none' });
  const record = store.create({ name: 'Capped', symbol: 'CAP', creators: [], royaltyBps: 0 });
  store.update(record.id, (r) => {
    r.collectionKey = store.keyRecord(key);
    r.collectionMetadataUri = 'https://local.invalid/collection';
  });
  let sends = 0;
  t.mock.method(Connection.prototype, 'getGenesisHash', async () => PublicKey.default.toBase58());
  t.mock.method(Connection.prototype, 'getBalance', async () => 1_000_000_000);
  t.mock.method(Connection.prototype, 'getRecentPrioritizationFees', async () => []);
  t.mock.method(Connection.prototype, 'getAccountInfo', async () => null);
  t.mock.method(Connection.prototype, 'getLatestBlockhash', async () => ({ blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 100 }));
  t.mock.method(Connection.prototype, 'getFeeForMessage', async () => ({ value: 10_000 }));
  t.mock.method(Connection.prototype, 'simulateTransaction', async () => simulation([{
    programId: SystemProgram.programId,
    parsed: { type: 'transfer', info: { source: wallet.publicKey.toBase58(), lamports: 1_951_840 } },
  }]));
  t.mock.method(TransactionBuilder.prototype, 'sendAndConfirm', async () => { sends++; return { signature: new Uint8Array(64) }; });
  service.startRun(record.id, { rpcUrl: 'http://localhost:8899', payerSecretKey: wallet.secretKey, maxSpendSol: 0.001 });
  for (let i = 0; i < 100 && service.jobStatus(record.id).status === 'running'; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  const job = service.jobStatus(record.id);
  assert.equal(job.status, 'failed');
  assert.match(job.error, /spend cap/);
  assert.equal(sends, 0);
  assert.equal(store.get(record.id).collectionSignature, null);
});
