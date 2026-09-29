import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createQuoteAcquisitionRuntime } from '../quoteAcquisition.js';
import { acquireProfileOwner } from '../packages/runtime/src/owner.js';
import { openRuntimeStore } from '../packages/runtime/src/store.js';
import { quoteAcquisitionChain } from '../packages/runtime/test/fixtures/quote-acquisition-chain.mjs';
import { swapWallet, wallet } from '../packages/runtime/test/fixtures/swap-chain.mjs';

async function fixture(t, { combined = true, held = false } = {}) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'trebuchet-quote-host-')), owner = acquireProfileOwner(profile), chain = quoteAcquisitionChain({ combined });
  t.after(() => { owner.release(); fs.rmSync(profile, { recursive: true, force: true }); });
  let now = 1000, network = 'mainnet', scopeId = 'launch', builds = 0;
  const autoSwapPlan = chain.purchases.map((purchase, index) => ({ allocationIndex: index, quoteMint: purchase.intent.outputMint, quoteDecimals: 6,
    quoteSymbol: `Q${index}`, targetRaw: '1250', minRaw: '1000', maxInputLamports: '50000' }));
  const options = { owner, getScopeId: () => scopeId, createConnection: () => chain.connection, networkForRequest: () => network, now: () => now, timeoutMs: 0,
    createPlanner: () => ({ build: async () => {
      builds++; return { purchases: held ? [] : chain.purchases, rows: autoSwapPlan.map((row) => ({ ...row, allocationIndices: [row.allocationIndex], observedSlot: 200,
        alreadyHadRaw: held ? '1250' : '0', state: held ? 'held' : 'purchase' })) };
    } }) };
  const runtime = () => createQuoteAcquisitionRuntime(options), input = { walletPublicKey: wallet.toBase58(), autoSwapPlan, requestId: 'request-one' };
  const draft = await runtime().prepare(input);
  const approve = (job = draft) => ({ id: job.jobId, ownerKeypair: swapWallet, planDigest: job.planDigest, maxSpendLamports: job.maxSpendLamports });
  return { profile, owner, chain, options, input, draft, runtime, approve, setNow: (value) => { now = value; }, setNetwork: (value) => { network = value; },
    setScope: (value) => { scopeId = value; }, builds: () => builds };
}

test('a quote draft survives a new adapter and requires exact approval before spending', async (t) => {
  const f = await fixture(t);
  assert.equal(f.draft.status, 'review_required'); assert.equal(f.draft.maxSpendLamports, 10120000);
  assert.deepEqual(f.runtime().get(f.draft.jobId), f.draft); assert.ok(f.chain.ledgers.every((ledger) => ledger.state.sends.length === 0));
  assert.equal((await f.runtime().prepare(f.input)).jobId, f.draft.jobId); assert.equal(f.builds(), 1);
  const started = await f.runtime().start(f.approve()); assert.equal(started.job.status, 'running');
  await started.completion;
  const result = f.runtime().get(f.draft.jobId); assert.equal(result.status, 'done'); assert.equal(result.completed, 2);
  assert.ok(result.results.every((row) => row.success && row.swappedRaw === '1250' && row.finalBalanceRaw === '1250'));
  assert.equal(result.feeLamports, 10000); assert.deepEqual(f.chain.ledgers.map((ledger) => ledger.state.sends.length), [1, 1]);
  f.chain.connection.getGenesisHash = () => { throw new Error('offline'); };
  assert.deepEqual(f.runtime().get(f.draft.jobId), result);
  const store = openRuntimeStore(f.profile);
  try { assert.equal(store.getWalletWorkflow(f.input.walletPublicKey), null); assert.equal(store.collection('local-quote-drafts/v1').load().length, 1); }
  finally { store.close(); }
});

for (const field of ['planDigest', 'maxSpendLamports']) {
  test(`local quote approval requires the saved ${field}`, async (t) => {
    const f = await fixture(t);
    await assert.rejects(f.runtime().start({ ...f.approve(), [field]: field === 'planDigest' ? 'changed' : 1 }), { code: 'EXECUTION_APPROVAL_REQUIRED' });
    assert.ok(f.chain.ledgers.every((ledger) => ledger.state.sends.length === 0));
  });
}

test('a lost purchase response resumes the same plan and preserves its original receipt', async (t) => {
  const f = await fixture(t); f.chain.ledgers[0].state.afterSend = () => { throw new Error('lost response'); };
  const first = await f.runtime().start(f.approve()); await assert.rejects(first.completion, /lost response/);
  const paused = f.runtime().get(f.draft.jobId); assert.equal(paused.status, 'paused'); assert.match(paused.error, /lost response/);
  assert.equal((await f.runtime().prepare({ ...f.input, requestId: 'other' })).jobId, f.draft.jobId); assert.equal(f.builds(), 1);
  assert.throws(() => f.runtime().archive(f.draft.jobId), { code: 'EXECUTION_RECOVERY_REQUIRED' });
  f.chain.ledgers[0].state.afterSend = null;
  const resumed = await f.runtime().start(f.approve()); await resumed.completion;
  assert.equal(f.runtime().get(f.draft.jobId).status, 'done'); assert.deepEqual(f.chain.ledgers.map((ledger) => ledger.state.sends.length), [1, 1]);
});

test('concurrent local clients preserve the active request and its reservation', async (t) => {
  const f = await fixture(t); let entered, release;
  const ready = new Promise((resolve) => { entered = resolve; }), gate = new Promise((resolve) => { release = resolve; });
  f.chain.ledgers[0].state.beforeSend = async () => { entered(); await gate; };
  const first = await f.runtime().start(f.approve()); await ready;
  try {
    await assert.rejects(f.runtime().start(f.approve()), { code: 'OPERATION_IN_FLIGHT' });
    assert.throws(() => f.runtime().archive(f.draft.jobId), { code: 'OPERATION_IN_FLIGHT' });
    assert.equal(f.runtime().get(f.draft.jobId).status, 'running');
  } finally { release(); }
  await first.completion;
});

for (const changed of ['network', 'scope', 'expiry']) {
  test(`quote approval preserves its saved ${changed}`, async (t) => {
    const f = await fixture(t);
    if (changed === 'network') f.setNetwork('devnet'); else if (changed === 'scope') f.setScope('another-launch'); else f.setNow(f.draft.expiresAtMs);
    await assert.rejects(f.runtime().start(f.approve()), { code: changed === 'network' ? 'NETWORK_MISMATCH' : changed === 'scope' ? 'OPERATION_CONFLICT' : 'QUOTE_EXPIRED' });
    assert.ok(f.chain.ledgers.every((ledger) => ledger.state.sends.length === 0));
  });
}

test('failed quotes retain fees, require cleanup approval, and preserve pending rows', async (t) => {
  const f = await fixture(t, { combined: false }); f.chain.ledgers[0].state.failAt = 1;
  const started = await f.runtime().start(f.approve()); await assert.rejects(started.completion, { code: 'TRANSACTION_FAILED' });
  assert.equal(f.runtime().get(f.draft.jobId).status, 'recovery_required');
  const recovery = await f.runtime().prepareCleanup(f.draft.jobId);
  await assert.rejects(f.runtime().startCleanup(f.approve()), { code: 'EXECUTION_APPROVAL_REQUIRED' });
  const cleanup = await f.runtime().startCleanup({ ...f.approve(), recoveryDigest: recovery.recoveryDigest, maxSpendLamports: recovery.recoveryMaxSpendLamports });
  await cleanup.completion;
  const result = f.runtime().get(f.draft.jobId); assert.equal(result.status, 'done'); assert.equal(result.feeLamports, 15000);
  assert.equal(result.results[0].success, false); assert.equal(result.pendingMints.length, 1);
  assert.equal(f.runtime().archive(f.draft.jobId).deleted, true); assert.equal(f.runtime().get(f.draft.jobId).archived, true);
});

test('held quotes finish with a durable zero-spend result', async (t) => {
  const f = await fixture(t, { held: true }); assert.equal(f.draft.maxSpendLamports, 0); assert.equal(f.draft.completed, 2);
  const started = await f.runtime().start(f.approve()); await started.completion;
  assert.equal(f.runtime().get(f.draft.jobId).status, 'done'); assert.ok(f.chain.ledgers.every((ledger) => ledger.state.sends.length === 0));
});

test('an archived unsigned draft stays available and requires a new quote', async (t) => {
  const f = await fixture(t); assert.deepEqual(f.runtime().archive(f.draft.jobId), { deleted: true });
  assert.equal(f.runtime().get(f.draft.jobId).archived, true);
  await assert.rejects(f.runtime().start(f.approve()), { code: 'QUOTE_EXPIRED' });
  const fresh = await f.runtime().prepare({ ...f.input, requestId: 'fresh' }); assert.notEqual(fresh.jobId, f.draft.jobId);
});

test('a changed request under the same request identity preserves the original draft', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.runtime().prepare({ ...f.input, autoSwapPlan: [f.input.autoSwapPlan[0]] }), { code: 'OPERATION_CONFLICT' });
  assert.deepEqual(f.runtime().get(f.draft.jobId), f.draft);
});

test('changed stored quote bytes stop before wallet reservation', async (t) => {
  const f = await fixture(t), store = openRuntimeStore(f.profile);
  try { const records = store.collection('local-quote-drafts/v1'), saved = records.load(); saved[0].preview.plan.maxSpendLamports++; records.save(saved); }
  finally { store.close(); }
  assert.throws(() => f.runtime().get(f.draft.jobId), { code: 'RECOVERY_STORAGE_UNAVAILABLE' });
  await assert.rejects(f.runtime().start(f.approve()), { code: 'RECOVERY_STORAGE_UNAVAILABLE' });
});
