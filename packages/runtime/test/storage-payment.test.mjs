import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { acquireProfileOwner } from '../src/owner.js';
import { openRuntimeStore, RecoveryStorageError } from '../src/store.js';
import { createSolanaSigner, SOLANA_GENESIS_HASHES } from '../src/solana.js';
import { createStoragePaymentService, normalizeStoragePaymentPlan, uploadIdCandidates } from '../src/storage-payment.js';
import { solSweepChain, sweepWallet, sweepDestination } from './fixtures/sol-sweep-chain.mjs';

function fixture(t) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'trebuchet-storage-payment-'));
  const owner = acquireProfileOwner(profile), store = openRuntimeStore(profile);
  t.after(() => { store.close(); owner.release(); fs.rmSync(profile, { recursive: true, force: true }); });
  const { connection, state } = solSweepChain(), walletPublicKey = sweepWallet.publicKey.toBase58();
  connection.getMultipleAccountsInfoAndContext = async () => ({ context: { slot: state.slot }, value: [state.balance, 1000].map((lamports) => ({
    lamports, owner: SystemProgram.programId, data: Buffer.alloc(0), executable: false,
  })) });
  const plan = { destinationWallet: sweepDestination, nodeUrl: 'https://storage.example.invalid', amountLamports: 10000,
    uploadId: sweepDestination, contentDigest: 'a'.repeat(64), nodeReceiptKey: 'b'.repeat(342) };
  const options = { owner, store, connection, network: 'devnet', expectedGenesisHash: SOLANA_GENESIS_HASHES.devnet,
    signer: createSolanaSigner({ getSigners: async () => [sweepWallet] }), authorize: async () => true, timeoutMs: 0,
    feePolicy: async () => ({ computeUnitLimit: 1000, microLamports: 1000, feeCeilingLamports: 10000 }) };
  const service = () => createStoragePaymentService(options);
  const approval = { id: 'storage-payment-approval', scopeId: 'journal-a', walletPublicKey, network: 'devnet', genesisHash: SOLANA_GENESIS_HASHES.devnet,
    planDigest: service().planDigest(plan), expiresAtMs: Date.now() + 60000, maxSpendLamports: 20000 };
  const input = { scopeId: 'journal-a', walletPublicKey, plan, approval };
  return { store, owner, connection, state, options, input, service, run: () => service().execute(input), active: () => store.getActiveOperation(walletPublicKey) };
}

test('storage funding commits its exact plan, approval, and signed transfer before spending', async (t) => {
  const f = fixture(t);
  f.state.beforeSend = (signed) => {
    const operation = f.active();
    assert.deepEqual(f.store.getLaunch(operation.launchId).config.plan, f.input.plan);
    assert.equal(f.store.getOperationApprovals(operation.id)[0].maxSpendLamports, 20000);
    assert.equal(f.store.getTransactions(operation.id)[0].wire, signed.wire);
  };
  const result = await f.run();
  assert.equal(result.amountLamports, 10000); assert.equal(result.depositedLamports, 10000);
  assert.equal(result.spentLamports, 16000); assert.equal(result.feeLamports, 6000);
  assert.equal(f.state.balance, 9984000); assert.equal(f.active(), null);
  f.connection.getGenesisHash = async () => { throw new Error('offline'); };
  assert.deepEqual(await f.run(), result); assert.equal(f.state.sends.length, 1);
});

for (const field of ['scopeId', 'walletPublicKey', 'network', 'genesisHash', 'planDigest', 'expiresAtMs', 'maxSpendLamports']) {
  test(`storage funding checks approval ${field} before recording an operation`, async (t) => {
    const f = fixture(t); f.input.approval[field] = ['expiresAtMs', 'maxSpendLamports'].includes(field) ? 0 : 'changed';
    await assert.rejects(f.run(), { code: 'EXECUTION_APPROVAL_REQUIRED' });
    assert.equal(f.active(), null); assert.equal(f.state.sends.length, 0);
  });
}

for (const change of ['recipient-credit', 'payer-debit', 'other-account', 'missing-balances']) {
  test(`storage funding preserves recovery for an uncertain ${change}`, async (t) => {
    const f = fixture(t);
    f.state.receiptTransform = (receipt) => {
      const meta = { ...receipt.meta, postBalances: [...receipt.meta.postBalances] };
      const keys = receipt.transaction.message.staticAccountKeys;
      const destination = keys.findIndex((key) => key.toBase58() === sweepDestination);
      if (change === 'recipient-credit') meta.postBalances[destination]++;
      if (change === 'payer-debit') meta.postBalances[0]--;
      if (change === 'other-account') meta.postBalances[keys.findIndex((_, i) => i !== 0 && i !== destination)]++;
      if (change === 'missing-balances') meta.postBalances.pop();
      return { ...receipt, meta };
    };
    await assert.rejects(f.run(), { code: 'CHAIN_STATE_UNAVAILABLE' });
    const operation = f.active(); assert.ok(operation);
    f.state.receiptTransform = (receipt) => receipt;
    assert.equal((await f.service().recover(f.input)).operationId, operation.id);
    assert.equal(f.state.sends.length, 1);
  });
}

test('storage funding bounds its fee and available payer balance before send', async (t) => {
  for (const change of ['fee', 'balance', 'authorization']) {
    const f = fixture(t);
    if (change === 'fee') f.state.fee = 10001;
    if (change === 'balance') f.state.balance = 19999;
    if (change === 'authorization') f.options.authorize = async () => false;
    await assert.rejects(f.run(), { code: { fee: 'SPEND_LIMIT_EXCEEDED', balance: 'INSUFFICIENT_FUNDS', authorization: 'EXECUTION_APPROVAL_REQUIRED' }[change] });
    assert.equal(f.state.sends.length, 0);
  }
});

for (const change of ['stale-slot', 'missing-account', 'program-account', 'account-data']) {
  test(`storage funding waits for complete system accounts after ${change}`, async (t) => {
    const f = fixture(t), read = f.connection.getMultipleAccountsInfoAndContext;
    if (change === 'stale-slot') {
      f.state.beforeSend = () => { throw new Error('fixture interrupted send'); };
      await assert.rejects(f.run(), /fixture interrupted send/);
      f.state.beforeSend = null;
      f.connection.getBlockHeight = async () => 401;
      f.connection.isBlockhashValid = async () => ({ context: { slot: f.state.slot }, value: false });
    }
    f.connection.getMultipleAccountsInfoAndContext = async () => {
      const result = await read();
      if (change === 'stale-slot') result.context.slot = 1;
      if (change === 'missing-account') result.value.shift();
      if (change === 'program-account') result.value[1].owner = new PublicKey(sweepDestination);
      if (change === 'account-data') result.value[0].data = Buffer.from('unexpected');
      return result;
    };
    await assert.rejects(f.run(), { code: 'CHAIN_STATE_UNAVAILABLE' });
    assert.equal(f.state.sends.length, 0);
  });
}

test('a lost storage payment reply recovers the original transfer after approval expiry', async (t) => {
  const f = fixture(t); f.state.afterSend = () => { throw new Error('reply lost'); };
  await assert.rejects(f.run(), /reply lost/);
  const signed = f.store.getTransactions(f.active().id)[0];
  f.state.afterSend = null; f.input.approval.expiresAtMs = 0;
  assert.equal((await f.service().recover(f.input)).txId, signed.signature);
  assert.equal(f.state.sends.length, 1);
});

test('a renewed storage payment approval reuses the saved signed transfer', async (t) => {
  const f = fixture(t); f.state.beforeSend = () => { throw new Error('transport unavailable'); };
  await assert.rejects(f.run(), /transport unavailable/);
  const signed = f.store.getTransactions(f.active().id)[0];
  f.state.beforeSend = null; f.input.approval.expiresAtMs = 0;
  await assert.rejects(f.service().recover(f.input), { code: 'EXECUTION_APPROVAL_REQUIRED' });
  assert.equal(f.state.sends.length, 0);
  f.input.approval = { ...f.input.approval, id: 'renewed', expiresAtMs: Date.now() + 60000 };
  f.options.signer = { signTransaction: async () => assert.fail('Use the saved signature') };
  assert.equal((await f.service().recover(f.input)).txId, signed.signature);
  assert.equal(f.state.sends[0].wire, signed.wire);
});

test('storage funding preserves signed bytes after an interrupted receipt commit', async (t) => {
  const f = fixture(t), record = f.store.recordReceipt;
  f.store.recordReceipt = () => { throw new RecoveryStorageError('fixture failed receipt'); };
  await assert.rejects(f.run(), { code: 'RECOVERY_STORAGE_UNAVAILABLE' });
  const signed = f.store.getTransactions(f.active().id)[0];
  f.store.recordReceipt = record;
  assert.equal((await f.service().recover(f.input)).txId, signed.signature);
  assert.equal(f.state.sends.length, 1);
});

for (const field of ['scopeId', 'network', 'genesisHash', 'itemId', 'contentDigest', 'fundingLamports', 'nodeUrl', 'paymentAddress', 'receiptKey']) {
  test(`the wallet reservation binds funding ${field}`, async (t) => {
    const f = fixture(t), plan = f.input.plan;
    const context = { scopeId: f.input.scopeId, network: 'devnet', genesisHash: SOLANA_GENESIS_HASHES.devnet,
      itemId: plan.uploadId, contentDigest: plan.contentDigest, fundingLamports: plan.amountLamports,
      node: { nodeUrl: plan.nodeUrl, paymentAddress: plan.destinationWallet, receiptKey: plan.nodeReceiptKey } };
    if (field in context.node) context.node[field] = 'changed'; else context[field] = field === 'fundingLamports' ? 1 : 'changed';
    f.store.reserveWalletWorkflow({ id: 'saved-upload', walletPublicKey: f.input.walletPublicKey, kind: 'storage-upload', context });
    await assert.rejects(f.service().execute({ ...f.input, workflowId: 'saved-upload' }), { code: 'OPERATION_CONFLICT' });
    assert.equal(f.state.sends.length, 0); assert.equal(f.active(), null);
    assert.equal(f.store.getWalletWorkflow(f.input.walletPublicKey).id, 'saved-upload');
  });
}

test('the stored upload bytes resolve IDs valid in both node encodings', () => {
  // This identity has two distinct canonical 32-byte interpretations.
  const id = 'A'.repeat(43), candidates = uploadIdCandidates(id);
  assert.equal(candidates.length, 2); assert.equal(candidates[0].equals(candidates[1]), false);
  for (const value of ['../outside', 'A'.repeat(42), 'A'.repeat(45)]) assert.throws(() => uploadIdCandidates(value));
});

test('storage funding requires a fixed HTTPS node and exact lamport plan', (t) => {
  const f = fixture(t);
  for (const changes of [
    { nodeUrl: 'http://storage.example.invalid' }, { nodeUrl: 'https://storage.example.invalid/extra' },
    { nodeUrl: 'https://storage.example.invalid?token=fixture' }, { amountLamports: 0 }, { amountLamports: 1.5 },
    { amountLamports: Number.MAX_SAFE_INTEGER + 1 }, { contentDigest: 'incomplete' }, { nodeReceiptKey: 'incomplete' },
  ]) assert.throws(() => normalizeStoragePaymentPlan({ ...f.input.plan, ...changes }));
  assert.equal(normalizeStoragePaymentPlan({ ...f.input.plan, destinationWallet: Keypair.fromSeed(new Uint8Array(32).fill(40)).publicKey.toBase58() }).amountLamports, 10000);
});
