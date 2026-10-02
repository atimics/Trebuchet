import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireProfileOwner } from '../packages/runtime/src/owner.js';
import { createPositionWithdrawalRuntime } from '../positionWithdrawal.js';
import { withdrawalChain, enableWithdrawalExecution, withdrawalWallet } from '../packages/runtime/test/fixtures/position-withdrawal-chain.mjs';

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'trebuchet-withdrawal-http-'));
process.env.TREBUCHET_CONFIG_DIR = profile;
fs.writeFileSync(path.join(profile, 'userPrefs.json'), JSON.stringify({ demoMode: false }));
const walletPublicKey = withdrawalWallet.publicKey.toBase58();
fs.writeFileSync(path.join(profile, 'pendingWallets.json'), JSON.stringify([{ publicKey: walletPublicKey,
  secretKeyEnc: 'plain:' + JSON.stringify(Array.from(withdrawalWallet.secretKey)), createdAt: new Date().toISOString() }]));
const { createLocalApiApp, createLocalApiServer } = await import('../server.js');

test('HTTP position withdrawal saves review, holds admission, and resumes its original receipt', { timeout: 30000 }, async (t) => {
  const chain = enableWithdrawalExecution(withdrawalChain()); let owner, host, application, token, url, release;
  const start = async () => {
    owner = acquireProfileOwner(profile);
    application = createLocalApiApp({ runtimeOwner: owner, withdrawalRuntimeFactory: (options) => createPositionWithdrawalRuntime({ ...options,
      createConnection: () => chain.connection, networkForRequest: () => 'mainnet', timeoutMs: 0 }) });
    host = createLocalApiServer({ application, port: 0, onStarted: () => {} }); url = (await host.start()).url;
    token = (await (await fetch(`${url}/api/session`)).json()).token;
  };
  const stop = async () => { await host?.stop(); owner?.release(); };
  t.after(async () => { release?.(); await stop(); fs.rmSync(profile, { recursive: true, force: true }); });
  const request = async (route, body, method = 'POST', authenticated = true) => {
    const response = await fetch(`${url}${route}`, { method, headers: { 'content-type': 'application/json', ...(authenticated ? { 'x-trebuchet-session': token } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  const input = { walletPublicKey, poolId: chain.input.poolId, nftMint: chain.input.nftMint, expected: { liquidity: chain.input.expectedLiquidity }, requestId: 'http-one' };
  const base = '/api/v2/positions/withdraw';
  await start();
  assert.equal((await request(`${base}/prepare`, input, 'POST', false)).status, 403);
  const prepared = await request(`${base}/prepare`, input); assert.equal(prepared.status, 200);
  const job = prepared.body.job; assert.equal(job.status, 'review_required'); assert.equal(chain.state.sends.length, 0);
  assert.equal((await request(base, input)).body.code, 'EXECUTION_APPROVAL_REQUIRED');
  const approved = { jobId: job.jobId, walletPublicKey, planDigest: job.planDigest, maxSpendLamports: job.maxSpendLamports };
  for (const field of ['planDigest', 'maxSpendLamports']) {
    const rejected = await request(base, { ...approved, [field]: field === 'planDigest' ? 'changed' : 0 });
    assert.equal(rejected.status, 409); assert.equal(rejected.body.code, 'EXECUTION_APPROVAL_REQUIRED');
  }
  let enter;
  const entered = new Promise((r) => { enter = r; }), gate = new Promise((r) => { release = r; });
  chain.state.beforeSend = async () => { enter(); await gate; };
  chain.state.afterSend = () => { throw new Error('lost HTTP response'); };
  const running = request(base, approved); await entered;
  assert.equal(application.locals.runtimeBusy(), true);
  assert.equal((await request(base, approved)).status, 409);
  const blocked = await request('/api/create-token', { walletPublicKey, name: 'Blocked', symbol: 'BLK', description: 'Local fixture', totalSupply: '1000' });
  assert.equal(blocked.status, 409); assert.equal(blocked.body.workflowId, job.jobId);
  release(); const interrupted = await running; assert.equal(interrupted.body.jobId, job.jobId); assert.equal(chain.state.sends.length, 1);
  await stop(); chain.state.beforeSend = null; chain.state.afterSend = null; await start();
  const restored = await request(`/api/v2/positions/withdrawals/${job.jobId}`, null, 'GET');
  assert.equal(restored.body.job.status, 'paused');
  const list = await request(`/api/v2/positions/withdrawals?tokenMint=${chain.mint.toBase58()}`, null, 'GET');
  assert.equal(list.body.withdrawals.length, 1); assert.equal(list.body.withdrawals[0].jobId, job.jobId);
  const done = await request(base, approved); assert.equal(done.status, 200); assert.equal(done.body.result.status, 'confirmed');
  assert.equal(done.body.result.nativeReceivedLamports, 5100000); assert.equal(chain.state.sends.length, 1);
  chain.connection.getGenesisHash = () => { throw new Error('offline'); };
  assert.deepEqual((await request(base, approved)).body.result, done.body.result);
});
