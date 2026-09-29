import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { quoteAcquisitionChain } from './fixtures/quote-acquisition-chain.mjs';
import { acquireProfileOwner } from '../src/owner.js';
import { openRuntimeStore, RecoveryStorageError } from '../src/store.js';
import { createSolanaSigner, SOLANA_GENESIS_HASHES } from '../src/solana.js';
import { createQuoteAcquisitionService } from '../src/quote-acquisition.js';
import { createSwapService } from '../src/swap.js';
import { swapWallet, wallet } from './fixtures/swap-chain.mjs';

async function fixture(t, { combined = true } = {}) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'trebuchet-acquisition-'));
  const owner = acquireProfileOwner(profile), store = openRuntimeStore(profile);
  t.after(() => { store.close(); owner.release(); fs.rmSync(profile, { recursive: true, force: true }); });
  const chain = quoteAcquisitionChain({ combined }), { ledgers, purchases, connection } = chain;
  let clock = 1000;
  const options = { owner, store, connection, signer: createSolanaSigner({ getSigners: async () => [swapWallet] }), network: 'mainnet',
    expectedGenesisHash: SOLANA_GENESIS_HASHES.mainnet, authorize: async () => true, now: () => clock, timeoutMs: 0 };
  const input = { scopeId: 'launch', key: 'quotes', walletPublicKey: wallet.toBase58(), purchases };
  const service = () => createQuoteAcquisitionService(options), preview = await service().preview(input);
  const approval = { id: 'batch-approval', scopeId: input.scopeId, key: input.key, walletPublicKey: input.walletPublicKey,
    network: options.network, genesisHash: options.expectedGenesisHash, planDigest: preview.digest, maxSpendLamports: preview.plan.maxSpendLamports, expiresAtMs: 2000 };
  input.approval = approval;
  return { profile, owner, store, chain, ledgers, connection, options, service, input, preview, approval, setNow: (value) => { clock = value; } };
}

test('two quote mints share a durable reservation through original receipt recovery', async (t) => {
  const f = await fixture(t), job = await f.service().prepare(f.input);
  f.ledgers[0].state.afterSend = () => { throw new Error('lost response'); };
  await assert.rejects(f.service().execute({ id: job.id, approval: f.approval }), /lost response/);
  assert.equal(f.store.getWalletWorkflow(f.input.walletPublicKey).id, job.id);
  assert.equal(f.ledgers[1].state.sends.length, 0);
  f.ledgers[0].state.afterSend = null;
  f.ledgers[1].state.beforeSend = () => {
    assert.equal(f.store.getWalletWorkflow(f.input.walletPublicKey).id, job.id);
    assert.equal(f.service().get(job.id).progress.purchases[0].state, 'confirmed');
    assert.throws(() => f.store.reserveWalletWorkflow({ id: 'other', walletPublicKey: f.input.walletPublicKey, kind: 'other', context: {} }), { code: 'OPERATION_IN_FLIGHT' });
  };
  const result = await f.service().execute({ id: job.id, approval: f.approval });
  assert.equal(result.status, 'confirmed'); assert.equal(result.feeLamports, 10000);
  assert.equal(result.purchases.length, 2); assert.ok(result.purchases.every((item) => item.result.receivedRaw === '1250'));
  assert.equal(f.store.getWalletWorkflow(f.input.walletPublicKey), null);
  assert.deepEqual(f.ledgers.map((ledger) => ledger.state.sends.length), [1, 1]);
  f.connection.getGenesisHash = () => { throw new Error('offline'); };
  assert.deepEqual(await f.service().execute({ id: job.id }), result);
});

for (const field of ['scopeId', 'key', 'walletPublicKey', 'network', 'genesisHash', 'planDigest', 'maxSpendLamports', 'expiresAtMs']) {
  test(`acquisition approval binds ${field} before reserving funds`, async (t) => {
    const f = await fixture(t); f.approval[field] = ['maxSpendLamports', 'expiresAtMs'].includes(field) ? 0 : 'changed';
    await assert.rejects(f.service().prepare(f.input), { code: 'EXECUTION_APPROVAL_REQUIRED' });
    assert.equal(f.store.getWalletWorkflow(f.input.walletPublicKey), null); assert.ok(f.ledgers.every((ledger) => ledger.state.sends.length === 0));
  });
}

test('expiry recovers the accepted first purchase and waits before the second', async (t) => {
  const f = await fixture(t), job = await f.service().prepare(f.input);
  f.ledgers[0].state.afterSend = () => { f.setNow(2000); throw new Error('lost response'); };
  await assert.rejects(f.service().execute({ id: job.id, approval: f.approval }), /lost response/);
  f.ledgers[0].state.afterSend = null;
  await assert.rejects(f.service().execute({ id: job.id, approval: f.approval }), { code: 'EXECUTION_APPROVAL_REQUIRED' });
  assert.equal(f.service().get(job.id).progress.purchases[0].state, 'confirmed');
  assert.equal(f.ledgers[1].state.sends.length, 0);
  const approval = { ...f.approval, id: 'renewed', expiresAtMs: 3000 };
  assert.equal((await f.service().execute({ id: job.id, approval })).status, 'confirmed');
});

test('competing acquisition clients share the owner guard', async (t) => {
  const f = await fixture(t), job = await f.service().prepare(f.input);
  let enter, release; const entered = new Promise((r) => { enter = r; }), gate = new Promise((r) => { release = r; });
  f.ledgers[0].state.beforeSend = async () => { enter(); await gate; };
  const running = f.service().execute({ id: job.id, approval: f.approval }); await entered;
  try { await assert.rejects(f.service().execute({ id: job.id, approval: f.approval }), { code: 'OPERATION_IN_FLIGHT' }); }
  finally { release(); }
  await running; assert.deepEqual(f.ledgers.map((ledger) => ledger.state.sends.length), [1, 1]);
});

test('failed second purchase keeps prior costs and ends after approved cleanup', async (t) => {
  const f = await fixture(t), job = await f.service().prepare(f.input); f.ledgers[1].state.failAt = 0;
  await assert.rejects(f.service().execute({ id: job.id, approval: f.approval }), { code: 'TRANSACTION_FAILED' });
  assert.equal(f.service().get(job.id).state, 'recovery_required');
  assert.equal(f.service().get(job.id).progress.feeLamports, 10000);
  const recovery = await f.service().prepareCleanup({ id: job.id });
  const approval = { ...f.approval, id: 'cleanup', recoveryDigest: recovery.digest };
  const result = await f.service().cleanup({ id: job.id, approval });
  assert.equal(result.status, 'recovered'); assert.equal(result.feeLamports, 10000);
  assert.equal(result.purchases[0].result.receivedRaw, '1250'); assert.equal(result.purchases[1].result.purchaseStatus, 'failed');
  assert.equal(f.store.getWalletWorkflow(f.input.walletPublicKey), null);
  f.connection.getGenesisHash = () => { throw new Error('offline'); };
  assert.deepEqual(await f.service().cleanup({ id: job.id }), result);
});

test('an omitted parent approval cannot start a new purchase', async (t) => {
  const f = await fixture(t), job = await f.service().prepare(f.input);
  await assert.rejects(f.service().execute({ id: job.id }), { code: 'EXECUTION_APPROVAL_REQUIRED' });
  assert.ok(f.ledgers.every((ledger) => ledger.state.sends.length === 0));
});

test('a child requires its exact parent plan and approval binding', async (t) => {
  const f = await fixture(t), job = await f.service().prepare(f.input), child = job.plan.purchases[0];
  const service = createSwapService(f.options), input = { ...f.input.purchases[0], scopeId: child.plan.scopeId, key: child.plan.key, workflowId: job.id };
  const approval = { ...f.approval, id: 'child', key: child.plan.key, bundleDigest: child.plan.review.digest, maxSpendLamports: child.plan.maxSpendLamports };
  await assert.rejects(service.prepare({ ...input, approval }), { code: 'EXECUTION_APPROVAL_REQUIRED' });
  approval.workflowId = job.id; approval.maxSpendLamports += 10000;
  await assert.rejects(service.prepare({ ...input, feeCeilingLamports: 20000, approval }), { code: 'OPERATION_CONFLICT' });
});

test('a failed final parent commit retains both receipts and its reservation', async (t) => {
  const f = await fixture(t), job = await f.service().prepare(f.input), finish = f.store.finishWalletWorkflow;
  f.store.finishWalletWorkflow = () => { throw new RecoveryStorageError('failed parent commit'); };
  await assert.rejects(f.service().execute({ id: job.id, approval: f.approval }), { code: 'RECOVERY_STORAGE_UNAVAILABLE' });
  assert.equal(f.service().get(job.id).state, 'prepared'); assert.ok(f.service().get(job.id).progress.purchases.every((item) => item.state === 'confirmed'));
  assert.equal(f.store.getWalletWorkflow(f.input.walletPublicKey).id, job.id); f.store.finishWalletWorkflow = finish;
  assert.equal((await f.service().execute({ id: job.id })).status, 'confirmed');
  assert.deepEqual(f.ledgers.map((ledger) => ledger.state.sends.length), [1, 1]);
});

test('a saved acquisition with changed child evidence pauses recovery', async (t) => {
  const f = await fixture(t), job = await f.service().prepare(f.input);
  await f.service().execute({ id: job.id, approval: f.approval });
  const records = f.store.collection('runtime-quote-acquisitions/v1'), saved = records.load();
  saved[0].result.feeLamports++; records.save(saved);
  assert.throws(() => f.service().get(job.id), { code: 'RECOVERY_STORAGE_UNAVAILABLE' });
});

test('the complete acquisition is funded before any purchase starts', async (t) => {
  const f = await fixture(t); f.ledgers[0].state.walletLamports = f.preview.plan.maxSpendLamports - 1;
  await assert.rejects(f.service().prepare(f.input), { code: 'INSUFFICIENT_FUNDS' });
  assert.equal(f.store.getWalletWorkflow(f.input.walletPublicKey), null);
  assert.ok(f.ledgers.every((ledger) => ledger.state.sends.length === 0));
});

test('parent storage and wallet reservation commit as one change', async (t) => {
  const f = await fixture(t), collection = f.store.collection;
  f.store.collection = (name) => {
    const records = collection(name);
    return name === 'runtime-quote-acquisitions/v1' ? { ...records, save() { throw new RecoveryStorageError('failed plan commit'); } } : records;
  };
  await assert.rejects(f.service().prepare(f.input), { code: 'RECOVERY_STORAGE_UNAVAILABLE' });
  f.store.collection = collection;
  assert.equal(f.store.getWalletWorkflow(f.input.walletPublicKey), null);
  assert.equal(f.service().get(f.preview.id), null);
});

test('a later child waits for the preceding approved purchase', async (t) => {
  const f = await fixture(t), job = await f.service().prepare(f.input), child = job.plan.purchases[1];
  const approval = { ...f.approval, id: 'later-child', workflowId: job.id, key: child.plan.key,
    bundleDigest: child.plan.review.digest, maxSpendLamports: child.plan.maxSpendLamports };
  await assert.rejects(createSwapService(f.options).prepare({ ...f.input.purchases[1], workflowId: job.id, scopeId: child.plan.scopeId, key: child.plan.key, approval }), { code: 'OPERATION_CONFLICT' });
  assert.ok(f.ledgers.every((ledger) => ledger.state.sends.length === 0));
});

test('identical setup signatures stay with their original purchase until a new blockhash', async (t) => {
  const f = await fixture(t, { combined: false }); f.chain.state.advanceBlockhash = false;
  const job = await f.service().prepare(f.input);
  await assert.rejects(f.service().execute({ id: job.id, approval: f.approval }), { code: 'OPERATION_CONFLICT' });
  assert.deepEqual(f.ledgers.map((ledger) => ledger.state.sends.length), [3, 0]);
  assert.equal(f.service().get(job.id).progress.purchases[0].state, 'confirmed');
  f.chain.state.advanceBlockhash = true; f.chain.state.blockhash = wallet.toBase58();
  const result = await f.service().execute({ id: job.id, approval: f.approval });
  assert.equal(result.status, 'confirmed'); assert.equal(result.feeLamports, 30000);
});

test('failed recovery fees remain in the parent budget and a new plan completes cleanup', async (t) => {
  const f = await fixture(t, { combined: false }), job = await f.service().prepare(f.input); f.ledgers[0].state.failAt = 1;
  await assert.rejects(f.service().execute({ id: job.id, approval: f.approval }), { code: 'TRANSACTION_FAILED' });
  const recovery = await f.service().prepareCleanup({ id: job.id }); f.ledgers[0].state.failAt = 2;
  await assert.rejects(f.service().cleanup({ id: job.id, approval: { ...f.approval, id: 'failed-cleanup', recoveryDigest: recovery.digest } }), { code: 'TRANSACTION_FAILED' });
  assert.equal(f.service().get(job.id).progress.feeLamports, 15000);
  const renewed = await f.service().prepareCleanup({ id: job.id });
  assert.notEqual(renewed.digest, recovery.digest); assert.equal(renewed.maxSpendLamports, recovery.maxSpendLamports + 5000);
  const result = await f.service().cleanup({ id: job.id, approval: { ...f.approval, id: 'renewed-cleanup', recoveryDigest: renewed.digest } });
  assert.equal(result.feeLamports, 20000); assert.equal(result.purchases[1].state, 'pending');
  assert.equal(f.store.getWalletWorkflow(f.input.walletPublicKey), null);
});

for (const field of ['planDigest', 'recoveryDigest', 'expiresAtMs', 'maxSpendLamports']) {
  test(`acquisition cleanup approval binds ${field}`, async (t) => {
    const f = await fixture(t, { combined: false }), job = await f.service().prepare(f.input); f.ledgers[0].state.failAt = 1;
    await assert.rejects(f.service().execute({ id: job.id, approval: f.approval }), { code: 'TRANSACTION_FAILED' });
    const recovery = await f.service().prepareCleanup({ id: job.id });
    const approval = { ...f.approval, id: 'cleanup', recoveryDigest: recovery.digest, [field]: ['expiresAtMs', 'maxSpendLamports'].includes(field) ? 0 : 'changed' };
    await assert.rejects(f.service().cleanup({ id: job.id, approval }), { code: 'EXECUTION_APPROVAL_REQUIRED' });
    assert.equal(f.ledgers[0].state.sends.length, 2); assert.equal(f.ledgers[1].state.sends.length, 0);
    assert.equal(f.store.getWalletWorkflow(f.input.walletPublicKey).id, job.id);
  });
}

test('a changed saved parent reservation pauses before the first spend', async (t) => {
  const f = await fixture(t), job = await f.service().prepare(f.input), records = f.store.collection('runtime-wallet-workflows/v1'), all = records.load();
  all[0].context.digest = 'changed'; records.save(all);
  await assert.rejects(f.service().execute({ id: job.id, approval: f.approval }), { code: 'OPERATION_CONFLICT' });
  assert.ok(f.ledgers.every((ledger) => ledger.state.sends.length === 0));
});

test('cached acquisitions stay bound to their original host network', async (t) => {
  const f = await fixture(t), job = await f.service().prepare(f.input);
  await f.service().execute({ id: job.id, approval: f.approval });
  await assert.rejects(createQuoteAcquisitionService({ ...f.options, network: 'devnet', expectedGenesisHash: SOLANA_GENESIS_HASHES.devnet }).execute({ id: job.id }), { code: 'NETWORK_MISMATCH' });
});

test('a stable acquisition identity preserves its original set of purchases', async (t) => {
  const f = await fixture(t), job = await f.service().prepare(f.input);
  await assert.rejects(f.service().prepare({ ...f.input, purchases: [f.input.purchases[0]] }), { code: 'OPERATION_CONFLICT' });
  assert.deepEqual(f.service().get(job.id), job);
  await assert.rejects(f.service().preview({ ...f.input, purchases: [f.input.purchases[0], f.input.purchases[0]] }), /each quote mint/);
});
