import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireProfileOwner } from '../packages/runtime/src/owner.js';
import { createSupportPositionRuntime } from '../supportPosition.js';
import { deriveLiquidityAccount } from '../liquidityExecution.js';
import { supportChain, supportWallet } from '../packages/runtime/test/fixtures/support-position-chain.mjs';

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'trebuchet-support-http-'));
process.env.TREBUCHET_CONFIG_DIR = profile;
fs.writeFileSync(path.join(profile, 'userPrefs.json'), JSON.stringify({ demoMode: false }));
const walletPublicKey = supportWallet.publicKey.toBase58();
fs.writeFileSync(path.join(profile, 'pendingWallets.json'), JSON.stringify([{ publicKey: walletPublicKey,
  secretKeyEnc: 'plain:' + JSON.stringify(Array.from(supportWallet.secretKey)), createdAt: new Date().toISOString() }]));
const { createLocalApiApp, createLocalApiServer } = await import('../server.js');
const coinStore = await import('../coinStore.js');

test('HTTP support saves exact review, holds admission, and recovers the original NFT and receipt after restart', { timeout: 30000 }, async (t) => {
  const makeChain = (id) => supportChain({ nftPublicKey: deriveLiquidityAccount(supportWallet, `wallet/${walletPublicKey}`, `support/${id}`).publicKey });
  let chain = makeChain('http-one'), owner, host, application, token, url, release, previews = 0;
  const start = async () => {
    owner = acquireProfileOwner(profile);
    application = createLocalApiApp({ runtimeOwner: owner, supportRuntimeFactory: (options) => createSupportPositionRuntime({ ...options,
      createConnection: () => chain.connection, networkForRequest: () => 'mainnet', timeoutMs: 0,
      planSupport: async () => { previews++; return { ...chain.input, token: { mint: chain.mint.toBase58(), symbol: 'FIX', decimals: 6 },
        depthPct: 50, currentPriceSol: 1, topPriceSol: 0.99, bottomPriceSol: 0.9, ceiling: null, warnings: [], walletLamports: '1000000000' }; } }) });
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
  const base = '/api/v2/support';
  const input = { walletPublicKey, poolId: chain.input.poolId, solAmount: '0.01', depthPct: 50, requestId: 'http-one' };
  await start();
  assert.equal((await request(`${base}/prepare`, input, 'POST', false)).status, 403);
  const prepared = await request(`${base}/prepare`, input); assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
  const job = prepared.body.job; assert.equal(job.status, 'review_required'); assert.equal(chain.state.sends.length, 0);
  assert.equal(job.nftMint, chain.input.nftMint); assert.equal(job.depositLamports, '10000000');
  assert.equal(job.maxSpendLamports, Number(job.plan.totalLamports));
  assert.equal(job.maxSpendLamports, job.feeCeilingLamports + job.rentCeilingLamports + Number(job.depositLamports));
  assert.deepEqual((await request(`${base}/prepare`, input)).body.job, job); assert.equal(previews, 1);
  const changed = await request(`${base}/prepare`, { ...input, solAmount: '0.02' }); assert.equal(changed.body.code, 'OPERATION_CONFLICT');
  assert.equal((await request(`${base}/open`, input)).body.code, 'EXECUTION_APPROVAL_REQUIRED');
  const approved = { jobId: job.jobId, walletPublicKey, planDigest: job.planDigest, maxSpendLamports: job.maxSpendLamports };
  for (const field of ['planDigest', 'maxSpendLamports', 'walletPublicKey']) {
    const rejected = await request(`${base}/open`, { ...approved, [field]: field === 'maxSpendLamports' ? 0 : 'changed' });
    assert.equal(rejected.status, 409); assert.equal(rejected.body.code, 'EXECUTION_APPROVAL_REQUIRED');
  }
  let enter;
  const entered = new Promise((r) => { enter = r; }), gate = new Promise((r) => { release = r; });
  chain.state.beforeSend = async () => { enter(); await gate; };
  chain.state.afterSend = () => { throw new Error('lost HTTP response'); };
  const running = request(`${base}/open`, approved); await entered;
  assert.equal(application.locals.runtimeBusy(), true);
  assert.equal((await request(`${base}/open`, approved)).status, 409);
  const blocked = await request('/api/create-token', { walletPublicKey, name: 'Blocked', symbol: 'BLK', description: 'Local fixture', totalSupply: '1000' });
  assert.equal(blocked.status, 409); assert.equal(blocked.body.workflowId, job.jobId);
  release(); const interrupted = await running; assert.equal(interrupted.body.jobId, job.jobId); assert.equal(chain.state.sends.length, 1);
  await stop(); chain.state.beforeSend = null; chain.state.afterSend = null; await start();
  assert.equal((await request(`${base}/jobs/${job.jobId}`, null, 'GET')).body.job.status, 'paused');
  const list = await request(`${base}/jobs?walletPublicKey=${walletPublicKey}`, null, 'GET');
  assert.equal(list.body.jobs.length, 1); assert.equal(list.body.jobs[0].jobId, job.jobId);
  const done = await request(`${base}/open`, approved); assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.result.status, 'confirmed'); assert.equal(done.body.result.depositedRaw, '10000000');
  assert.equal(done.body.result.nftMint, job.nftMint); assert.equal(chain.state.sends.length, 1);
  chain.connection.getGenesisHash = () => { throw new Error('offline'); };
  assert.deepEqual((await request(`${base}/open`, approved)).body.result, done.body.result);
  assert.equal(coinStore.get(job.tokenMint).events.filter((event) => event.jobId === job.jobId).length, 1);
  await stop(); chain = makeChain('http-failed'); await start();
  const failedJob = (await request(`${base}/prepare`, { ...input, requestId: 'http-failed' })).body.job;
  chain.state.fail = true;
  const failedApproval = { walletPublicKey, jobId: failedJob.jobId, planDigest: failedJob.planDigest, maxSpendLamports: failedJob.maxSpendLamports };
  assert.equal((await request(`${base}/open`, failedApproval)).body.code, 'TRANSACTION_FAILED');
  const savedFailure = (await request(`${base}/jobs/${failedJob.jobId}`, null, 'GET')).body.job;
  assert.equal(savedFailure.status, 'failed'); assert.equal(savedFailure.result.feeLamports, 80000);
  chain.connection.getGenesisHash = () => { throw new Error('offline'); };
  assert.equal((await request(`${base}/open`, failedApproval)).body.result.status, 'failed');
  assert.equal(chain.state.sends.length, 1);
});
