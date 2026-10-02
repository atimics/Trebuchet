import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireProfileOwner } from '../packages/runtime/src/owner.js';
import { openRuntimeStore } from '../packages/runtime/src/store.js';
import { createQuoteAcquisitionRuntime } from '../quoteAcquisition.js';
import { quoteAcquisitionChain } from '../packages/runtime/test/fixtures/quote-acquisition-chain.mjs';
import { swapWallet, wallet } from '../packages/runtime/test/fixtures/swap-chain.mjs';

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'trebuchet-quotes-http-'));
process.env.TREBUCHET_CONFIG_DIR = profile;
fs.writeFileSync(path.join(profile, 'userPrefs.json'), JSON.stringify({ demoMode: false }));
const { createLocalApiApp, createLocalApiServer } = await import('../server.js');
const walletPublicKey = wallet.toBase58(), tempWalletSecretKey = Array.from(swapWallet.secretKey);

async function waitFor(read, check) {
  for (let i = 0; i < 100; i++) { const value = await read(); if (check(value)) return value; await new Promise((resolve) => setTimeout(resolve, 20)); }
  assert.fail('Quote state did not settle');
}

test('HTTP quote approval, shared admission, restart recovery, and cleanup use durable jobs', { timeout: 30000 }, async (t) => {
  let owner, host, application, token, url, chain, autoSwapPlan, release, builds = 0;
  const seed = (scopeId) => {
    const store = openRuntimeStore(profile);
    try { store.collection('journals').save([{ id: scopeId, walletPublicKey, status: 'active', stage: 'funding' }]); }
    finally { store.close(); }
  };
  const start = async () => {
    owner = acquireProfileOwner(profile);
    application = createLocalApiApp({ runtimeOwner: owner, quoteRuntimeFactory: (options) => createQuoteAcquisitionRuntime({ ...options,
      createConnection: () => chain.connection, networkForRequest: () => 'mainnet', timeoutMs: 0,
      createPlanner: () => ({ build: async () => { builds++; return { purchases: chain.purchases, rows: autoSwapPlan.map((row) => ({ ...row,
        allocationIndices: [row.allocationIndex], observedSlot: 200, alreadyHadRaw: '0', state: 'purchase' })) }; } }) }) });
    host = createLocalApiServer({ application, port: 0, onStarted: () => {} }); url = (await host.start()).url;
    token = (await (await fetch(`${url}/api/session`)).json()).token;
  };
  const stop = async () => { await host?.stop(); owner?.release(); };
  t.after(async () => { release?.(); await stop(); fs.rmSync(profile, { recursive: true, force: true }); });
  const request = async (suffix, body, method = 'POST', authenticated = true) => {
    const response = await fetch(`${url}${suffix}`, { method, headers: { 'content-type': 'application/json', ...(authenticated ? { 'x-trebuchet-session': token } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  const route = '/api/acquire-quote-tokens';
  const prepare = (requestId) => request(route, { walletPublicKey, tempWalletSecretKey, autoSwapPlan, requestId });
  const approval = (job) => ({ walletPublicKey, tempWalletSecretKey, planDigest: job.planDigest, maxSpendLamports: job.maxSpendLamports });
  const read = async (id) => (await request(`${route}/${id}`, null, 'GET')).body;
  const resetChain = (combined) => {
    chain = quoteAcquisitionChain({ combined });
    autoSwapPlan = chain.purchases.map(({ intent }, allocationIndex) => ({ allocationIndex, quoteMint: intent.outputMint, quoteDecimals: 6,
      quoteSymbol: `Q${allocationIndex}`, targetRaw: '1250', minRaw: '1000', maxInputLamports: '50000' }));
  };

  resetChain(true); seed('http-launch-one'); await start();
  assert.equal((await request(route, { walletPublicKey, tempWalletSecretKey, autoSwapPlan }, 'POST', false)).status, 403);
  const prepared = await prepare('first'); assert.equal(prepared.status, 200);
  const draft = prepared.body; assert.equal(draft.status, 'review_required'); assert.equal(builds, 1);
  assert.deepEqual(chain.ledgers.map((ledger) => ledger.state.sends.length), [0, 0]);
  for (const field of ['planDigest', 'maxSpendLamports']) {
    const rejected = await request(`${route}/${draft.jobId}/execute`, { ...approval(draft), [field]: field === 'planDigest' ? 'changed' : 0 });
    assert.equal(rejected.status, 409); assert.equal(rejected.body.code, 'EXECUTION_APPROVAL_REQUIRED');
  }
  let entered;
  const arrived = new Promise((resolve) => { entered = resolve; }), gate = new Promise((resolve) => { release = resolve; });
  chain.ledgers[0].state.beforeSend = async () => { entered(); await gate; };
  chain.ledgers[0].state.afterSend = () => { throw new Error('HTTP fixture lost the send response'); };
  const started = await request(`${route}/${draft.jobId}/execute`, approval(draft));
  assert.equal(started.status, 200); assert.equal(started.body.status, 'running'); await arrived;
  assert.equal(application.locals.runtimeBusy(), true);
  const duplicate = await request(`${route}/${draft.jobId}/execute`, approval(draft));
  assert.equal(duplicate.status, 409); assert.equal(duplicate.body.code, 'OP_IN_FLIGHT');
  assert.equal((await request(`${route}/${draft.jobId}`, null, 'DELETE')).status, 409);
  const competingBody = { tempWalletSecretKey, name: 'Pending', symbol: 'PEND', description: 'Local test', totalSupply: '1000' };
  const competing = await request('/api/create-token', competingBody);
  assert.equal(competing.status, 409); assert.equal(competing.body.workflowId, draft.jobId);
  assert.equal((await request(`${route}/active/${walletPublicKey}`, null, 'GET')).body.job.jobId, draft.jobId);
  release(); await waitFor(() => read(draft.jobId), (job) => job.status === 'paused');
  await waitFor(async () => application.locals.runtimeBusy(), (busy) => !busy);
  await stop(); chain.ledgers[0].state.beforeSend = null; chain.ledgers[0].state.afterSend = null; await start();
  const saved = (await request(`${route}/active/${walletPublicKey}`, null, 'GET')).body.job;
  assert.equal(saved.jobId, draft.jobId); assert.equal(saved.status, 'paused');
  assert.equal((await prepare('another-request')).body.jobId, draft.jobId); assert.equal(builds, 1);
  assert.equal((await request('/api/create-token', competingBody)).body.workflowId, draft.jobId);
  assert.equal((await request(`${route}/${draft.jobId}/execute`, approval(draft))).status, 200);
  const done = await waitFor(() => read(draft.jobId), (job) => job.status === 'done');
  assert.equal(done.completed, 2); assert.deepEqual(chain.ledgers.map((ledger) => ledger.state.sends.length), [1, 1]);
  await waitFor(async () => application.locals.runtimeBusy(), (busy) => !busy);
  assert.equal((await request(`${route}/${draft.jobId}`, null, 'DELETE')).body.deleted, true);
  assert.equal((await read(draft.jobId)).archived, true);

  // A new saved launch fails after setup. Cleanup has its own approval.
  await stop(); resetChain(false); seed('http-launch-two'); await start();
  const failedDraft = (await prepare('failed-trade')).body;
  chain.ledgers[0].state.failAt = 1;
  assert.equal((await request(`${route}/${failedDraft.jobId}/execute`, approval(failedDraft))).status, 200);
  await waitFor(() => read(failedDraft.jobId), (job) => job.status === 'recovery_required');
  const recovery = (await request(`${route}/${failedDraft.jobId}/cleanup/prepare`, { walletPublicKey, tempWalletSecretKey })).body;
  assert.ok(recovery.recoveryDigest); assert.ok(recovery.cleanupFeeCeilingLamports > 0);
  assert.equal((await request(`${route}/${failedDraft.jobId}/cleanup`, approval(failedDraft))).status, 409);
  assert.equal((await request(`${route}/${failedDraft.jobId}/cleanup`, { ...approval(failedDraft),
    recoveryDigest: recovery.recoveryDigest, maxSpendLamports: recovery.recoveryMaxSpendLamports })).status, 200);
  const recovered = await waitFor(() => read(failedDraft.jobId), (job) => job.status === 'done');
  assert.equal(recovered.results[0].success, false); assert.equal(recovered.pendingMints.length, 1);
  assert.equal(recovered.feeLamports, 15000); assert.equal(recovered.results.length, 1);
  assert.equal((await request(`${route}/active/${walletPublicKey}`, null, 'GET')).body.job, null);
});
