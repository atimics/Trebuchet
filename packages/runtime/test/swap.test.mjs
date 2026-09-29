import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSwapService } from '../src/swap.js';
import { reviewSwapBundle } from '../src/swap-bundle.js';
import { acquireProfileOwner } from '../src/owner.js';
import { openRuntimeStore, RecoveryStorageError } from '../src/store.js';
import { createSolanaSigner, SOLANA_GENESIS_HASHES } from '../src/solana.js';
import { swapWallet, wallet, destination, intent, swapTransactions, swapChain } from './fixtures/swap-chain.mjs';

async function fixture(t, { combined = false, token2022 = false, provider = 'jupiter' } = {}) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'trebuchet-swap-'));
  const owner = acquireProfileOwner(profile), store = openRuntimeStore(profile), ledger = swapChain({ token2022 });
  const transactions = swapTransactions(combined, { token2022, provider }), review = await reviewSwapBundle({ transactions, intent: ledger.intent });
  let now = 1000;
  const approval = { id: 'purchase-1', scopeId: 'launch-a', key: 'purchase/0', walletPublicKey: wallet.toBase58(), network: 'mainnet', genesisHash: SOLANA_GENESIS_HASHES.mainnet,
    bundleDigest: review.digest, expiresAtMs: 2000, maxSpendLamports: 6000000 };
  const options = { owner, store, connection: ledger.connection, signer: createSolanaSigner({ getSigners: async () => [swapWallet] }), network: 'mainnet',
    expectedGenesisHash: SOLANA_GENESIS_HASHES.mainnet, authorize: async () => true, now: () => now, timeoutMs: 0 };
  const input = { scopeId: approval.scopeId, key: approval.key, transactions, intent: ledger.intent, feeCeilingLamports: 10000, approval };
  t.after(() => { store.close(); owner.release(); fs.rmSync(profile, { recursive: true, force: true }); });
  return { profile, owner, store, ...ledger, input, approval, options, service: () => createSwapService(options), setNow: (n) => { now = n; } };
}

for (const combined of [false, true]) for (const token2022 of [false, true]) for (const provider of ['jupiter', 'raydium']) {
  test(`${provider} ${token2022 ? 'Token-2022' : 'classic'} ${combined ? 'atomic' : 'three-step'} swap saves one purchase and exact receipts through cleanup`, async (t) => {
    const f = await fixture(t, { combined, token2022, provider }), service = f.service(), job = await service.prepare(f.input);
    assert.equal(f.state.sends.length, 0); assert.equal(f.store.getWalletWorkflow(job.walletPublicKey).id, job.id);
    f.state.beforeSend = (tx) => {
      const active = f.store.getActiveOperation(job.walletPublicKey);
      assert.equal(f.store.getTransactions(active.id)[0].wire, tx.wire);
      assert.equal(service.get(job.id).plan.review.digest, f.approval.bundleDigest);
      assert.ok(f.store.getOperationApprovals(active.id).length);
    };
    const result = await service.execute({ id: job.id, approval: f.approval });
    assert.equal(result.receivedRaw, '1250'); assert.equal(result.feeLamports, combined ? 5000 : 15000);
    assert.equal(result.returnedLamports, f.rent(165)); assert.equal(f.state.source, null);
    assert.equal(f.state.destination.amount, 1250n); assert.equal(f.store.getWalletWorkflow(job.walletPublicKey), null);
    assert.equal(f.state.sends.length, combined ? 1 : 3);
    f.connection.getGenesisHash = () => { throw new Error('offline'); };
    assert.deepEqual(await service.execute({ id: job.id }), result);
  });
}

for (const index of [0, 1, 2]) {
  test(`lost response after swap step ${index} recovers its saved signature and keeps one purchase`, async (t) => {
    const f = await fixture(t), job = await f.service().prepare(f.input);
    f.state.afterSend = () => { if (f.state.sends.length === index + 1) throw new Error('lost response'); };
    await assert.rejects(f.service().execute({ id: job.id, approval: f.approval }), /lost response/);
    assert.equal(f.service().get(job.id).receipts.length, index);
    f.state.afterSend = null;
    const result = await f.service().recover({ walletPublicKey: job.walletPublicKey, approval: f.approval });
    assert.equal(result.receivedRaw, '1250'); assert.equal(f.state.sends.length, 3); assert.equal(f.state.receipts.size, 3);
  });
}

for (const field of ['scopeId', 'key', 'walletPublicKey', 'network', 'genesisHash', 'bundleDigest', 'expiresAtMs', 'maxSpendLamports']) {
  test(`purchase approval binds ${field} before reserving the wallet`, async (t) => {
    const f = await fixture(t); f.approval[field] = ['expiresAtMs', 'maxSpendLamports'].includes(field) ? 0 : 'changed';
    await assert.rejects(f.service().prepare(f.input), { code: 'EXECUTION_APPROVAL_REQUIRED' });
    assert.equal(f.state.sends.length, 0); assert.equal(f.store.getWalletWorkflow(wallet.toBase58()), null);
  });
}

for (const method of ['recordOperationApproval', 'recordSignedTransaction', 'recordReceipt']) {
  test(`failed ${method} stops spending and preserves swap recovery`, async (t) => {
    const f = await fixture(t), service = f.service(), job = await service.prepare(f.input), original = f.store[method];
    f.store[method] = () => { throw new RecoveryStorageError('fixture failed commit'); };
    await assert.rejects(service.execute({ id: job.id, approval: f.approval }), { code: 'RECOVERY_STORAGE_UNAVAILABLE' });
    assert.equal(f.state.sends.length, method === 'recordReceipt' ? 1 : 0);
    f.store[method] = original;
    await f.service().execute({ id: job.id, approval: f.approval });
    assert.equal(f.state.sends.length, 3);
  });
}

test('a changed purchase under the same stable key preserves the original plan', async (t) => {
  const f = await fixture(t), service = f.service(), job = await service.prepare(f.input);
  await assert.rejects(service.prepare({ ...f.input, feeCeilingLamports: 20000 }), { code: 'OPERATION_CONFLICT' });
  assert.deepEqual(service.get(job.id), job);
});

test('competing clients and another wallet workflow wait for the saved purchase', async (t) => {
  const f = await fixture(t), job = await f.service().prepare(f.input);
  assert.throws(() => f.store.reserveWalletWorkflow({ id: 'other', walletPublicKey: job.walletPublicKey, kind: 'other', context: {} }), { code: 'OPERATION_IN_FLIGHT' });
  let release, arrived; const gate = new Promise((r) => { release = r; }), started = new Promise((r) => { arrived = r; });
  f.state.beforeSend = async () => { arrived(); await gate; };
  const first = f.service().execute({ id: job.id, approval: f.approval }); await started;
  try { await assert.rejects(f.service().execute({ id: job.id, approval: f.approval }), { code: 'OPERATION_IN_FLIGHT' }); }
  finally { release(); }
  await first; assert.equal(f.state.sends.length, 3);
});

test('approval expiry permits receipt recovery and pauses the next spending step', async (t) => {
  const f = await fixture(t), job = await f.service().prepare(f.input);
  f.state.afterSend = () => { throw new Error('lost'); };
  await assert.rejects(f.service().execute({ id: job.id, approval: f.approval }), /lost/);
  f.state.afterSend = null; f.setNow(2000);
  await assert.rejects(f.service().recover({ walletPublicKey: job.walletPublicKey, approval: f.approval }), { code: 'EXECUTION_APPROVAL_REQUIRED' });
  assert.equal(f.service().get(job.id).receipts.length, 1); assert.equal(f.state.sends.length, 1);
  f.approval.id = 'renewed'; f.approval.expiresAtMs = 3000;
  await f.service().execute({ id: job.id, approval: f.approval }); assert.equal(f.state.sends.length, 3);
});

test('expiry replaces only the saved blockhash and keeps the original trade', async (t) => {
  const f = await fixture(t, { combined: true }), job = await f.service().prepare(f.input);
  f.state.drop = true;
  await assert.rejects(f.service().execute({ id: job.id, approval: f.approval }), { code: 'CHAIN_STATE_UNAVAILABLE' });
  const first = f.state.sends[0]; f.state.drop = false; f.state.valid = false; f.state.height = 500;
  f.state.blockhash = destination.toBase58();
  const result = await f.service().execute({ id: job.id, approval: f.approval });
  assert.notEqual(result.txId, first.signature); assert.equal(f.state.receipts.size, 1); assert.equal(result.receivedRaw, '1250');
});

for (const change of ['fee', 'input', 'output', 'owner', 'refund', 'message', 'signature']) {
  test(`changed ${change} receipt pauses the purchase before the next step`, async (t) => {
    const f = await fixture(t, { combined: true }), job = await f.service().prepare(f.input);
    f.state.receiptTransform = (r) => {
      if (!r) return r;
      const meta = { ...r.meta, preBalances: [...r.meta.preBalances], postBalances: [...r.meta.postBalances], postTokenBalances: structuredClone(r.meta.postTokenBalances) };
      if (change === 'fee') meta.fee = 10001;
      if (change === 'input') meta.preBalances[0]++;
      if (change === 'output') meta.postTokenBalances[0].uiTokenAmount.amount = '1';
      if (change === 'owner') meta.postTokenBalances[0].owner = destination.toBase58();
      if (change === 'refund') meta.postBalances[0]++;
      const transaction = { ...r.transaction };
      if (change === 'message') transaction.message = { serialize: () => Buffer.from('changed') };
      if (change === 'signature') transaction.signatures = ['changed'];
      return { ...r, transaction, meta };
    };
    await assert.rejects(f.service().execute({ id: job.id, approval: f.approval }), { code: 'CHAIN_STATE_UNAVAILABLE' });
    assert.equal(f.state.sends.length, 1); assert.ok(f.store.getWalletWorkflow(job.walletPublicKey));
    f.state.receiptTransform = (r) => r;
    await f.service().execute({ id: job.id, approval: f.approval }); assert.equal(f.state.sends.length, 1);
  });
}

test('separate destination creation, funding, and native sync preserve the provider action order', async (t) => {
  const { compileSwap, swapSetup, swapCleanup } = await import('./fixtures/swap-chain.mjs');
  const { jupiter } = await import('./fixtures/swap-instructions.mjs');
  const f = await fixture(t), setup = swapSetup();
  f.input.transactions = [compileSwap([setup[1]]), compileSwap([setup[0], setup[2]]), compileSwap([setup[3], jupiter()]), compileSwap([swapCleanup()])];
  f.approval.bundleDigest = (await reviewSwapBundle({ transactions: f.input.transactions, intent })).digest;
  const job = await f.service().prepare(f.input), result = await f.service().execute({ id: job.id, approval: f.approval });
  assert.equal(result.receivedRaw, '1250'); assert.equal(f.state.receipts.size, 4); assert.equal(f.state.source, null);
});

test('all transaction fees are checked before setup funding', async (t) => {
  const f = await fixture(t); let fees = 0;
  f.connection.getFeeForMessage = async () => ({ context: { slot: 200 }, value: ++fees === 2 ? 10001 : 5000 });
  await assert.rejects(f.service().prepare(f.input), { code: 'SPEND_LIMIT_EXCEEDED' });
  assert.equal(f.state.sends.length, 0); assert.equal(f.store.getWalletWorkflow(wallet.toBase58()), null);
});

test('failed swap job receipt writes recover from the same operation receipts', async (t) => {
  for (const after of [1, 3]) {
    const f = await fixture(t), service = f.service(), job = await service.prepare(f.input), original = f.store.collection;
    let failed = false;
    // The collection factory supplies all future service instances. Fail once
    // after the selected chain receipt has already been committed by the engine.
    f.store.collection = (name) => {
      const collection = original(name);
      if (name !== 'runtime-swaps/v1') return collection;
      const save = collection.save;
      collection.save = (jobs) => {
        if (!failed && jobs[0].receipts.length === after) { failed = true; throw new RecoveryStorageError('job receipt commit failed'); }
        return save(jobs);
      };
      return collection;
    };
    await assert.rejects(f.service().execute({ id: job.id, approval: f.approval }), { code: 'RECOVERY_STORAGE_UNAVAILABLE' });
    assert.equal(f.state.receipts.size, after); f.store.collection = original;
    await f.service().execute({ id: job.id, approval: f.approval });
    assert.equal(f.state.receipts.size, 3); assert.equal(f.state.sends.length, 3);
  }
});

test('the final job commit and wallet release succeed together', async (t) => {
  const f = await fixture(t), service = f.service(), job = await service.prepare(f.input), finish = f.store.finishWalletWorkflow;
  f.store.finishWalletWorkflow = () => { throw new RecoveryStorageError('final workflow commit failed'); };
  await assert.rejects(service.execute({ id: job.id, approval: f.approval }), { code: 'RECOVERY_STORAGE_UNAVAILABLE' });
  assert.equal(service.get(job.id).state, 'prepared'); assert.equal(service.get(job.id).receipts.length, 3);
  assert.equal(f.store.getWalletWorkflow(wallet.toBase58()).id, job.id);
  f.store.finishWalletWorkflow = finish; f.connection.getGenesisHash = () => { throw new Error('offline'); };
  const result = await f.service().execute({ id: job.id });
  assert.equal(result.receivedRaw, '1250'); assert.equal(f.state.sends.length, 3); assert.equal(f.store.getWalletWorkflow(wallet.toBase58()), null);
});

test('damaged saved jobs preserve their records and pause new spending', async (t) => {
  for (const field of ['digest', 'identity', 'receipt']) {
    const f = await fixture(t), service = f.service(), job = await service.prepare(f.input);
    const records = f.store.collection('runtime-swaps/v1'), jobs = records.load();
    if (field === 'digest') jobs[0].plan.review.digest = '0'.repeat(64);
    if (field === 'identity') jobs[0].walletPublicKey = destination.toBase58();
    if (field === 'receipt') jobs[0].receipts.push({ operationId: 'missing' });
    records.save(jobs);
    await assert.rejects(service.execute({ id: job.id, approval: f.approval }), { code: 'RECOVERY_STORAGE_UNAVAILABLE' });
    assert.deepEqual(records.load(), jobs); assert.equal(f.state.sends.length, 0);
  }
});

test('wallet reservation rolls back when the initial swap job commit fails', async (t) => {
  const f = await fixture(t), original = f.store.collection;
  f.store.collection = (name) => {
    const collection = original(name);
    if (name === 'runtime-swaps/v1') collection.save = () => { throw new RecoveryStorageError('initial job commit failed'); };
    return collection;
  };
  await assert.rejects(f.service().prepare(f.input), { code: 'RECOVERY_STORAGE_UNAVAILABLE' });
  assert.equal(f.store.getWalletWorkflow(wallet.toBase58()), null); assert.equal(f.state.sends.length, 0);
});

test('cached swap results retain the exact verified output amount', async (t) => {
  const f = await fixture(t), service = f.service(), job = await service.prepare(f.input);
  await service.execute({ id: job.id, approval: f.approval });
  const records = f.store.collection('runtime-swaps/v1'), jobs = records.load(); jobs[0].result.receivedRaw = '999999'; records.save(jobs);
  await assert.rejects(service.execute({ id: job.id }), { code: 'RECOVERY_STORAGE_UNAVAILABLE' });
  assert.deepEqual(records.load(), jobs); assert.equal(f.state.sends.length, 3);
});

for (const step of [0, 1, 2]) {
  test(`a finalized failure at swap step ${step} retains its wallet reservation for recovery`, async (t) => {
    const f = await fixture(t), service = f.service(), job = await service.prepare(f.input); f.state.failAt = step;
    await assert.rejects(service.execute({ id: job.id, approval: f.approval }), { code: 'TRANSACTION_FAILED' });
    assert.equal(f.state.sends.length, step + 1); assert.equal(service.get(job.id).receipts.length, step);
    assert.equal(f.store.getWalletWorkflow(wallet.toBase58()).id, job.id);
    await assert.rejects(f.service().execute({ id: job.id, approval: f.approval }), { code: 'TRANSACTION_FAILED' });
    assert.equal(f.state.sends.length, step + 1);
  });
}
