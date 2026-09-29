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

for (const combined of [false, true]) for (const token2022 of [false, true]) for (const provider of ['jupiter', 'raydium', 'raydium-api']) {
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

const cleanupApproval = (attempt, id = 'cleanup-approval') => ({ id, scopeId: attempt.plan.scopeId, key: attempt.plan.key,
  walletPublicKey: attempt.plan.walletPublicKey, network: attempt.plan.network, genesisHash: attempt.plan.genesisHash,
  bundleDigest: attempt.plan.bundleDigest, recoveryDigest: attempt.digest, expiresAtMs: 3000, maxSpendLamports: attempt.plan.maxSpendLamports });

for (const combined of [false, true]) for (const failedStep of combined ? [0] : [0, 1, 2]) {
  test(`cleanup after ${combined ? 'atomic' : `step ${failedStep}`} failure returns native funds and preserves the purchase outcome`, async (t) => {
    const f = await fixture(t, { combined }), service = f.service(), job = await service.prepare(f.input); f.state.failAt = failedStep;
    await assert.rejects(service.execute({ id: job.id, approval: f.approval }), { code: 'TRANSACTION_FAILED' });
    const saved = service.get(job.id); assert.equal(saved.state, 'recovery_required'); assert.equal(saved.failure.feeLamports, 5000);
    const sourceLamports = f.state.source?.lamports || 0, attempt = await service.prepareCleanup({ id: job.id }), before = f.state.walletLamports;
    const result = await service.cleanup({ id: job.id, approval: cleanupApproval(attempt) });
    assert.equal(result.status, 'recovered'); assert.equal(result.purchaseStatus, failedStep === 2 ? 'confirmed' : 'failed');
    assert.equal(result.receivedRaw, failedStep === 2 ? '1250' : '0'); assert.equal(f.state.source, null);
    assert.equal(result.feeLamports, (failedStep + 1 + (sourceLamports ? 1 : 0)) * 5000);
    assert.equal(f.state.walletLamports - before, sourceLamports ? sourceLamports - 5000 : 0);
    assert.equal(f.store.getWalletWorkflow(job.walletPublicKey), null); assert.equal(service.active(job.walletPublicKey), null);
    assert.equal(new Set(f.state.sends.map((item) => item.signature)).size, f.state.sends.length);
    f.connection.getGenesisHash = () => { throw new Error('offline'); };
    assert.deepEqual(await service.execute({ id: job.id }), result);
    assert.deepEqual(await service.cleanup({ id: job.id }), result);
  });
}

for (const field of ['scopeId', 'key', 'walletPublicKey', 'network', 'genesisHash', 'bundleDigest', 'recoveryDigest', 'expiresAtMs', 'maxSpendLamports']) {
  test(`cleanup approval binds ${field} to the saved recovery`, async (t) => {
    const f = await fixture(t), job = await f.service().prepare(f.input); f.state.failAt = 1;
    await assert.rejects(f.service().execute({ id: job.id, approval: f.approval }), { code: 'TRANSACTION_FAILED' });
    const attempt = await f.service().prepareCleanup({ id: job.id }), approval = cleanupApproval(attempt);
    approval[field] = ['expiresAtMs', 'maxSpendLamports'].includes(field) ? 0 : 'changed';
    await assert.rejects(f.service().cleanup({ id: job.id, approval }), { code: 'EXECUTION_APPROVAL_REQUIRED' });
    assert.equal(f.state.sends.length, 2); assert.ok(f.store.getWalletWorkflow(job.walletPublicKey));
  });
}

for (const changed of ['fee', 'payer', 'account', 'token', 'message', 'signature', 'slot', 'error']) {
  test(`changed failed ${changed} evidence holds the wallet for receipt recovery`, async (t) => {
    const f = await fixture(t), job = await f.service().prepare(f.input); f.state.failAt = 1;
    f.state.receiptTransform = (receipt) => {
      if (!receipt?.meta.err) return receipt;
      const result = { ...receipt, transaction: { ...receipt.transaction }, meta: structuredClone(receipt.meta) };
      if (changed === 'fee') result.meta.fee = 10001;
      if (changed === 'payer') result.meta.postBalances[0]++;
      if (changed === 'account') result.meta.postBalances[1]++;
      if (changed === 'token') result.meta.postTokenBalances[0].uiTokenAmount.amount = '1';
      if (changed === 'message') result.transaction.message = { serialize: () => Buffer.from('changed'), staticAccountKeys: [] };
      if (changed === 'signature') result.transaction.signatures = ['changed'];
      if (changed === 'slot') result.slot++;
      if (changed === 'error') result.meta.err = null;
      return result;
    };
    await assert.rejects(f.service().execute({ id: job.id, approval: f.approval }), { code: 'CHAIN_STATE_UNAVAILABLE' });
    assert.equal(f.service().get(job.id).state, 'prepared'); assert.equal(f.state.sends.length, 2);
    await assert.rejects(f.service().prepareCleanup({ id: job.id }), { code: 'SWAP_FAILURE_REQUIRED' });
    f.state.receiptTransform = (receipt) => receipt;
    await assert.rejects(f.service().execute({ id: job.id, approval: f.approval }), { code: 'TRANSACTION_FAILED' });
    assert.equal(f.service().get(job.id).failure.feeLamports, 5000); assert.equal(f.state.sends.length, 2);
  });
}

test('a failed cleanup needs a fresh plan and approval, accounts for both failed fees, and keeps the purchase terminal', async (t) => {
  const f = await fixture(t), service = f.service(), job = await service.prepare(f.input); f.state.failAt = 1;
  await assert.rejects(service.execute({ id: job.id, approval: f.approval }), { code: 'TRANSACTION_FAILED' });
  const first = await service.prepareCleanup({ id: job.id }); f.state.failAt = 2;
  await assert.rejects(service.cleanup({ id: job.id, approval: cleanupApproval(first) }), { code: 'TRANSACTION_FAILED' });
  assert.equal(service.get(job.id).cleanupAttempts[0].failure.feeLamports, 5000);
  await assert.rejects(service.cleanup({ id: job.id, approval: cleanupApproval(first) }), { code: 'TRANSACTION_FAILED' });
  assert.equal(f.state.sends.length, 3);
  const second = await service.prepareCleanup({ id: job.id });
  assert.equal(second.plan.maxSpendLamports, first.plan.maxSpendLamports + 5000);
  await assert.rejects(service.cleanup({ id: job.id, approval: cleanupApproval(first) }), { code: 'EXECUTION_APPROVAL_REQUIRED' });
  const result = await service.cleanup({ id: job.id, approval: cleanupApproval(second, 'cleanup-2') });
  assert.equal(result.failedReceipts.length, 2); assert.equal(result.feeLamports, 20000); assert.equal(result.purchaseStatus, 'failed');
  assert.equal(f.state.destination.amount, 0n); assert.equal(f.state.source, null); assert.equal(f.state.sends.length, 4);
});

test('lost cleanup response recovers the same transaction with an expired approval', async (t) => {
  const f = await fixture(t), service = f.service(), job = await service.prepare(f.input); f.state.failAt = 1;
  await assert.rejects(service.execute({ id: job.id, approval: f.approval }), { code: 'TRANSACTION_FAILED' });
  const attempt = await service.prepareCleanup({ id: job.id }), approval = cleanupApproval(attempt);
  f.state.afterSend = () => { throw new Error('lost cleanup response'); };
  await assert.rejects(service.cleanup({ id: job.id, approval }), /lost cleanup response/);
  f.state.afterSend = null; f.setNow(3000);
  const result = await f.service().cleanup({ id: job.id, approval });
  assert.equal(result.purchaseStatus, 'failed'); assert.equal(f.state.sends.length, 3); assert.equal(f.state.source, null);
});

test('cleanup completion and wallet release commit together after a storage failure', async (t) => {
  const f = await fixture(t), service = f.service(), job = await service.prepare(f.input); f.state.failAt = 2;
  await assert.rejects(service.execute({ id: job.id, approval: f.approval }), { code: 'TRANSACTION_FAILED' });
  const attempt = await service.prepareCleanup({ id: job.id }), finish = f.store.finishWalletWorkflow;
  f.store.finishWalletWorkflow = () => { throw new RecoveryStorageError('cleanup finish commit failed'); };
  await assert.rejects(service.cleanup({ id: job.id, approval: cleanupApproval(attempt) }), { code: 'RECOVERY_STORAGE_UNAVAILABLE' });
  assert.equal(service.get(job.id).state, 'recovery_required'); assert.ok(f.store.getWalletWorkflow(job.walletPublicKey));
  assert.equal(f.state.source, null); f.store.finishWalletWorkflow = finish;
  const result = await f.service().cleanup({ id: job.id });
  assert.equal(result.purchaseStatus, 'confirmed'); assert.equal(f.state.sends.length, 4); assert.equal(result.feeLamports, 20000);
});

test('cleanup verifies finalized source closure before releasing the wallet', async (t) => {
  const f = await fixture(t), service = f.service(), job = await service.prepare(f.input); f.state.failAt = 1;
  await assert.rejects(service.execute({ id: job.id, approval: f.approval }), { code: 'TRANSACTION_FAILED' });
  const attempt = await service.prepareCleanup({ id: job.id });
  f.state.afterSend = () => { f.state.source = { amount: 0n, lamports: f.rent(165) }; };
  await assert.rejects(service.cleanup({ id: job.id, approval: cleanupApproval(attempt) }), { code: 'CHAIN_STATE_UNAVAILABLE' });
  assert.ok(f.store.getWalletWorkflow(job.walletPublicKey)); assert.equal(f.state.sends.length, 3);
  f.state.source = null;
  await service.cleanup({ id: job.id }); assert.equal(f.state.sends.length, 3);
});

for (const change of ['fee', 'failure identity', 'cleanup plan', 'completion']) {
  test(`damaged ${change} in saved swap recovery preserves the original records`, async (t) => {
    const f = await fixture(t), service = f.service(), job = await service.prepare(f.input); f.state.failAt = 1;
    await assert.rejects(service.execute({ id: job.id, approval: f.approval }), { code: 'TRANSACTION_FAILED' });
    const attempt = await service.prepareCleanup({ id: job.id });
    if (change === 'completion') await service.cleanup({ id: job.id, approval: cleanupApproval(attempt) });
    const records = f.store.collection('runtime-swaps/v1'), all = records.load();
    if (change === 'fee') all[0].failure.feeLamports++;
    if (change === 'failure identity') all[0].failure.operationId = 'missing';
    if (change === 'cleanup plan') all[0].cleanupAttempts[0].plan.maxSpendLamports++;
    if (change === 'completion') all[0].cleanupAttempts[0].completion.source.lamports = 1;
    records.save(all);
    await assert.rejects(service.cleanup({ id: job.id }), { code: 'RECOVERY_STORAGE_UNAVAILABLE' });
    assert.deepEqual(records.load(), all);
  });
}

for (const target of ['failure', 'plan', 'approval', 'cleanup receipt']) {
  test(`a failed ${target} commit preserves the same failed purchase and cleanup identity`, async (t) => {
    const f = await fixture(t), job = await f.service().prepare(f.input); f.state.failAt = 1;
    if (target !== 'failure') await assert.rejects(f.service().execute({ id: job.id, approval: f.approval }), { code: 'TRANSACTION_FAILED' });
    let attempt;
    if (['approval', 'cleanup receipt'].includes(target)) attempt = await f.service().prepareCleanup({ id: job.id });
    const original = f.store.collection;
    f.store.collection = (name) => {
      const collection = original(name), save = collection.save;
      if (name === 'runtime-swaps/v1') collection.save = (jobs) => {
        const saved = jobs[0], cleanup = saved.cleanupAttempts?.at(-1);
        if (target === 'failure' && saved.failure || target === 'plan' && cleanup || target === 'approval' && cleanup?.approvals.length || target === 'cleanup receipt' && cleanup?.receipt) {
          throw new RecoveryStorageError(`fixture ${target} commit failed`);
        }
        return save(jobs);
      };
      return collection;
    };
    if (target === 'failure') await assert.rejects(f.service().execute({ id: job.id, approval: f.approval }), { code: 'RECOVERY_STORAGE_UNAVAILABLE' });
    else if (target === 'plan') await assert.rejects(f.service().prepareCleanup({ id: job.id }), { code: 'RECOVERY_STORAGE_UNAVAILABLE' });
    else await assert.rejects(f.service().cleanup({ id: job.id, approval: cleanupApproval(attempt) }), { code: 'RECOVERY_STORAGE_UNAVAILABLE' });
    assert.equal(f.state.sends.length, target === 'cleanup receipt' ? 3 : 2);
    assert.ok(f.store.getWalletWorkflow(job.walletPublicKey)); f.store.collection = original;
    await assert.rejects(f.service().execute({ id: job.id, approval: f.approval }), { code: 'TRANSACTION_FAILED' });
    attempt = await f.service().prepareCleanup({ id: job.id });
    const result = await f.service().cleanup({ id: job.id, approval: cleanupApproval(attempt) });
    assert.equal(result.feeLamports, 15000); assert.equal(f.state.sends.length, 3); assert.equal(f.state.destination.amount, 0n);
  });
}

test('expired cleanup bytes keep the saved recovery plan and replace their blockhash', async (t) => {
  const f = await fixture(t), service = f.service(), job = await service.prepare(f.input); f.state.failAt = 1;
  await assert.rejects(service.execute({ id: job.id, approval: f.approval }), { code: 'TRANSACTION_FAILED' });
  const attempt = await service.prepareCleanup({ id: job.id }), approval = cleanupApproval(attempt);
  f.state.drop = true;
  await assert.rejects(service.cleanup({ id: job.id, approval }), { code: 'CHAIN_STATE_UNAVAILABLE' });
  const old = f.state.sends.at(-1); f.state.drop = false; f.state.valid = false; f.state.height = 500; f.state.blockhash = destination.toBase58();
  const result = await f.service().cleanup({ id: job.id, approval });
  assert.notEqual(result.cleanupReceipts[0].txId, old.signature); assert.equal(result.feeLamports, 15000);
  assert.equal(f.state.sends.length, 4); assert.equal(f.state.receipts.size, 3); assert.equal(service.get(job.id).cleanupAttempts.length, 1);
});

test('legacy failed swap operations gain a full receipt while retaining their immutable terminal record', async (t) => {
  const f = await fixture(t), service = f.service(), job = await service.prepare(f.input); f.state.failAt = 1;
  await assert.rejects(service.execute({ id: job.id, approval: f.approval }), { code: 'TRANSACTION_FAILED' });
  const original = service.get(job.id), operation = f.store.getOperation(original.failure.operationId), records = f.store.collection('runtime-swaps/v1');
  const jobs = records.load(); delete jobs[0].failure; delete jobs[0].cleanupAttempts; jobs[0].state = 'prepared'; records.save(jobs);
  await assert.rejects(f.service().execute({ id: job.id }), { code: 'TRANSACTION_FAILED' });
  assert.deepEqual(f.store.getOperation(original.failure.operationId), operation);
  assert.deepEqual(service.get(job.id).failure, original.failure); assert.equal(f.state.sends.length, 2);
});

test('cached cleanup plans and results retain their saved host network', async (t) => {
  const f = await fixture(t), service = f.service(), job = await service.prepare(f.input); f.state.failAt = 0;
  await assert.rejects(service.execute({ id: job.id, approval: f.approval }), { code: 'TRANSACTION_FAILED' });
  const attempt = await service.prepareCleanup({ id: job.id });
  const wrongHost = createSwapService({ ...f.options, network: 'devnet', expectedGenesisHash: SOLANA_GENESIS_HASHES.devnet });
  await assert.rejects(wrongHost.prepareCleanup({ id: job.id }), { code: 'NETWORK_MISMATCH' });
  await assert.rejects(wrongHost.cleanup({ id: job.id }), { code: 'NETWORK_MISMATCH' });
  await service.cleanup({ id: job.id, approval: cleanupApproval(attempt) });
  f.connection.getGenesisHash = () => { throw new Error('offline'); };
  await assert.rejects(wrongHost.prepareCleanup({ id: job.id }), { code: 'NETWORK_MISMATCH' });
  await assert.rejects(wrongHost.cleanup({ id: job.id }), { code: 'NETWORK_MISMATCH' });
});

for (const combined of [true, false]) for (const token2022 of [true, false]) for (const change of [7000, -4000]) {
  test(`${combined ? 'atomic' : 'split'} ${token2022 ? 'Token-2022' : 'classic'} swap measures its own effects after external balance change ${change}`, async (t) => {
    const f = await fixture(t, { combined, token2022 });
    f.state.source = { amount: 20000n, lamports: f.rent(165) + 20000 };
    f.state.destination = { amount: 10000n, lamports: f.rent(token2022 ? 170 : 165) };
    const service = f.service(), job = await service.prepare(f.input), at = combined ? 0 : 1;
    f.state.beforeSend = () => {
      if (f.state.sends.length !== at) return;
      f.state.source.lamports += change; f.state.source.amount += BigInt(change);
      f.state.destination.lamports += 31; f.state.destination.amount += BigInt(change);
      f.state.walletLamports += 123;
    };
    const result = await service.execute({ id: job.id, approval: f.approval });
    assert.equal(result.receivedRaw, '1250'); assert.equal(result.returnedLamports, f.rent(165) + 20000 + change);
    assert.equal(f.state.destination.amount, 10000n + BigInt(change) + 1250n); assert.equal(f.state.source, null);
    assert.equal(result.receipts[at].receiptBefore.accounts[f.intent.destinationTokenAccount].amountRaw, String(10000 + change));
    assert.notDeepEqual(result.receipts[at].receiptBefore.accounts, result.receipts[at].before.accounts);
    assert.equal(f.state.sends.length, combined ? 1 : 3);
  });
}

for (const combined of [true, false]) for (const sourceGift of [5000, 3000000]) {
  test(`SOL prefunding ${sourceGift} before ${combined ? 'atomic swap' : 'setup'} receipt reduces rent paid by the saved wallet`, async (t) => {
    const f = await fixture(t, { combined }), service = f.service(), job = await service.prepare(f.input);
    f.state.beforeSend = () => {
      if (f.state.sends.length) return;
      f.state.source = { system: true, lamports: sourceGift, amount: 0n };
      f.state.destination = { system: true, lamports: 7000, amount: 0n };
    };
    const result = await service.execute({ id: job.id, approval: f.approval });
    assert.equal(result.receivedRaw, '1250'); assert.equal(result.receipts[0].rentLamports, Math.max(0, f.rent(165) - sourceGift) + f.rent(165) - 7000);
    assert.equal(result.returnedLamports, Math.max(sourceGift, f.rent(165))); assert.equal(f.state.sends.length, combined ? 1 : 3);
  });
}

test('a prepared swap keeps its operation and approvals while account balances change before signing', async (t) => {
  const f = await fixture(t), signer = f.options.signer;
  f.state.source = { amount: 20000n, lamports: f.rent(165) + 20000 };
  f.state.destination = { amount: 10000n, lamports: f.rent(165) };
  const job = await f.service().prepare(f.input);
  f.options.signer = { signTransaction: async () => { throw new Error('pause before signing'); } };
  await assert.rejects(f.service().execute({ id: job.id, approval: f.approval }), /pause before signing/);
  const operation = f.store.getActiveOperation(job.walletPublicKey); assert.equal(f.state.sends.length, 0);
  f.state.source.lamports += 9000; f.state.source.amount += 9000n; f.state.destination.amount += 450n;
  f.options.signer = signer;
  const result = await f.service().execute({ id: job.id, approval: f.approval });
  assert.equal(result.receipts[0].operationId, operation.id); assert.equal(result.receivedRaw, '1250');
  assert.equal(result.returnedLamports, f.rent(165) + 29000); assert.equal(f.state.sends.length, 3);
});

for (const timing of ['after plan', 'at submission']) {
  test(`failed swap cleanup returns incoming wrapped SOL ${timing} with the same approved source`, async (t) => {
    const f = await fixture(t), service = f.service(), job = await service.prepare(f.input); f.state.failAt = 1;
    await assert.rejects(service.execute({ id: job.id, approval: f.approval }), { code: 'TRANSACTION_FAILED' });
    const attempt = await service.prepareCleanup({ id: job.id });
    const deposit = () => { f.state.source.lamports += 12345; f.state.source.amount += 12345n; };
    if (timing === 'after plan') deposit(); else f.state.beforeSend = deposit;
    const result = await service.cleanup({ id: job.id, approval: cleanupApproval(attempt) });
    assert.equal(result.returnedLamports, f.rent(165) + 50000 + 12345); assert.equal(result.feeLamports, 15000);
    assert.equal(result.purchaseStatus, 'failed'); assert.equal(f.state.source, null); assert.equal(f.state.sends.length, 3);
    assert.equal(service.get(job.id).cleanupAttempts[0].digest, attempt.digest);
  });
}

for (const change of ['owner', 'frozen', 'existence']) {
  test(`a prepared cleanup pauses after the source ${change} changes`, async (t) => {
    const f = await fixture(t), service = f.service(), job = await service.prepare(f.input); f.state.failAt = 1;
    await assert.rejects(service.execute({ id: job.id, approval: f.approval }), { code: 'TRANSACTION_FAILED' });
    const attempt = await service.prepareCleanup({ id: job.id }), source = { ...f.state.source };
    if (change === 'owner') f.state.source.owner = destination;
    if (change === 'frozen') f.state.source.frozen = true;
    if (change === 'existence') f.state.source = null;
    await assert.rejects(service.cleanup({ id: job.id, approval: cleanupApproval(attempt) }), { code: 'CHAIN_STATE_UNAVAILABLE' });
    assert.equal(f.state.sends.length, 2); assert.ok(f.store.getWalletWorkflow(job.walletPublicKey));
    f.state.source = source;
    await service.cleanup({ id: job.id, approval: cleanupApproval(attempt) }); assert.equal(f.state.sends.length, 3);
  });
}

for (const change of ['source SOL', 'source tokens', 'output tokens']) {
  test(`changed receipt ${change} still requires the exact approved effects after balance reconciliation`, async (t) => {
    const f = await fixture(t), service = f.service(), job = await service.prepare(f.input);
    f.state.receiptTransform = (receipt) => {
      if (!receipt || f.state.receipts.size !== 2) return receipt;
      const altered = { ...receipt, meta: structuredClone(receipt.meta) };
      if (change === 'source SOL') {
        const index = receipt.transaction.message.staticAccountKeys.findIndex((key) => key.toBase58() === intent.sourceTokenAccount);
        altered.meta.preBalances[index]++;
      } else {
        const mint = change === 'source tokens' ? 'So11111111111111111111111111111111111111112' : intent.outputMint;
        const row = altered.meta.preTokenBalances.find((value) => value.mint === mint);
        row.uiTokenAmount.amount = String(BigInt(row.uiTokenAmount.amount) + 100n);
      }
      return altered;
    };
    await assert.rejects(service.execute({ id: job.id, approval: f.approval }), { code: 'CHAIN_STATE_UNAVAILABLE' });
    assert.equal(f.state.sends.length, 2); f.state.receiptTransform = (receipt) => receipt;
    const result = await service.execute({ id: job.id, approval: f.approval }); assert.equal(result.receivedRaw, '1250'); assert.equal(f.state.sends.length, 3);
  });
}

for (const combined of [true, false]) for (const token2022 of [true, false]) for (const timing of ['before signing', 'at submission']) {
  test(`${combined ? 'atomic' : 'split'} ${token2022 ? 'Token-2022' : 'classic'} swap adopts its idempotent accounts created externally ${timing}`, async (t) => {
    const f = await fixture(t, { combined, token2022 }), signer = f.options.signer, job = await f.service().prepare(f.input);
    const createAccounts = () => {
      f.state.source = { amount: 5000n, lamports: f.rent(165) + 5000 };
      f.state.destination = { amount: 2000n, lamports: f.rent(token2022 ? 170 : 165) };
    };
    if (timing === 'before signing') {
      f.options.signer = { signTransaction: async () => { throw new Error('pause before signing'); } };
      await assert.rejects(f.service().execute({ id: job.id, approval: f.approval }), /pause before signing/);
      createAccounts(); f.options.signer = signer;
    } else f.state.beforeSend = () => { if (!f.state.sends.length) createAccounts(); };
    const result = await f.service().execute({ id: job.id, approval: f.approval });
    assert.equal(result.receivedRaw, '1250'); assert.equal(result.receipts[0].rentLamports, 0);
    assert.equal(result.returnedLamports, f.rent(165) + 5000); assert.equal(f.state.destination.amount, 3250n);
    assert.equal(result.receipts[0].receiptBefore.accounts[intent.sourceTokenAccount].exists, true);
    assert.equal(result.receipts[0].before.accounts[intent.sourceTokenAccount].exists, false);
    assert.equal(f.state.sends.length, combined ? 1 : 3);
  });
}


for (const combined of [false, true]) for (const token2022 of [false, true]) for (const existing of ['native', 'prefunded']) {
  test(`Raydium API ${combined ? 'atomic' : 'split'} ${token2022 ? 'Token-2022' : 'classic'} bundle returns its ${existing} source balance`, async (t) => {
    const f = await fixture(t, { combined, token2022, provider: 'raydium-api' }), reserve = f.rent(165), gift = 1000000;
    f.state.source = existing === 'native' ? { amount: BigInt(gift), lamports: reserve + gift } : { system: true, lamports: gift };
    const starting = f.state.walletLamports, result = await f.service().execute({ id: (await f.service().prepare(f.input)).id, approval: f.approval });
    const sourceRent = existing === 'native' ? 0 : reserve - gift, outputRent = f.rent(token2022 ? 170 : 165);
    assert.equal(result.receivedRaw, '1250'); assert.equal(result.returnedLamports, existing === 'native' ? reserve + gift : reserve);
    assert.equal(result.grossDebitLamports, 50000 + sourceRent + outputRent + result.feeLamports);
    assert.equal(starting - f.state.walletLamports, result.grossDebitLamports - result.returnedLamports);
    assert.equal(f.state.source, null); assert.equal(f.state.destination.amount, 1250n);
  });
}

test('implicit Raydium output account rent is approved before the first send', async (t) => {
  const f = await fixture(t, { combined: true, provider: 'raydium-api' });
  f.input.intent = { ...f.input.intent, rentCeilingLamports: f.rent(165) };
  f.approval.bundleDigest = (await reviewSwapBundle({ transactions: f.input.transactions, intent: f.input.intent })).digest;
  await assert.rejects(f.service().prepare(f.input), { code: 'SPEND_LIMIT_EXCEEDED' });
  assert.equal(f.state.sends.length, 0); assert.equal(f.store.getWalletWorkflow(f.input.intent.walletPublicKey), null);
});
