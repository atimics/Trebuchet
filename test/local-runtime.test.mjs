import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { connectRuntime, ensureRuntime } from '../packages/runtime/src/client.js';
import { readRuntimeDescriptor } from '../packages/runtime/src/owner.js';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const cli = path.join(root, 'packages/cli/bin/trebuchet.js');
const server = path.join(root, 'server.js');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function command(profile, action) {
  const { stdout } = await exec(process.execPath, [cli, 'runtime', action, '--config-dir', profile, '--json'], { cwd: root, timeout: 40_000 });
  const value = JSON.parse(stdout);
  assert.equal(value.ok, true);
  return value.data;
}

async function waitFor(predicate) {
  for (let i = 0; i < 100; i++) {
    if (await predicate()) return;
    await sleep(50);
  }
  assert.fail('runtime state did not settle');
}

test('CLI clients share one production runtime and recover its ownership after process death', { timeout: 90_000 }, async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'trebuchet-runtime-client-'));
  fs.writeFileSync(path.join(profile, 'userPrefs.json'), JSON.stringify({ demoMode: true }));
  const pids = new Set();
  try {
    const [first, second] = await Promise.all([command(profile, 'start'), command(profile, 'start')]);
    pids.add(first.pid); pids.add(second.pid);
    assert.equal(first.id, second.id);
    assert.equal(first.pid, second.pid);
    assert.equal((await command(profile, 'status')).id, first.id);
    const runtime = await connectRuntime(profile);
    assert.equal(runtime.identity.id, first.id);
    // Both CLI clients already exited; the runtime still owns its profile.
    const wallet = await runtime.request('/api/v2/wallets/generate', { method: 'POST', body: {} });
    assert.equal(wallet.success, true);
    assert.ok(wallet.wallet.publicKey);
    const unauthorized = await fetch(`${runtime.url}/api/runtime`);
    assert.equal(unauthorized.status, 403);
    const wrongToken = await fetch(`${runtime.url}/api/runtime/stop`, { method: 'POST', headers: { 'x-trebuchet-owner': 'x'.repeat(43) } });
    assert.equal(wrongToken.status, 403);
    const staleRequest = await fetch(`${runtime.url}/api/demo/status`, { headers: { 'x-trebuchet-owner': 'x'.repeat(43) } });
    assert.equal(staleRequest.status, 403);
    assert.equal((await ensureRuntime(profile, { args: [server] })).identity.id, first.id);

    // Exercise live request translation using inputs rejected before any chain call.
    fs.writeFileSync(path.join(profile, 'userPrefs.json'), JSON.stringify({ demoMode: false }));
    await assert.rejects(
      runtime.request('/api/transfer-assets', { method: 'POST', body: { destinationWallet: 'invalid address' } }),
      (error) => error.statusCode === 400 && /valid Solana address/.test(error.message),
    );
    for (const endpoint of ['/api/create-lp', '/api/resume-launch']) {
      await assert.rejects(
        runtime.request(endpoint, { method: 'POST', body: { allocations: [{}], priorResults: [] } }),
        (error) => error.statusCode === 400 && error.code === 'TOKEN_PLAN_INCOMPLETE',
      );
    }

    process.kill(first.pid, 'SIGKILL');
    await waitFor(async () => (await connectRuntime(profile)) === null);
    const restarted = await ensureRuntime(profile, { args: [server] });
    pids.add(restarted.identity.pid);
    assert.notEqual(restarted.identity.id, first.id);
    assert.equal((await command(profile, 'status')).id, restarted.identity.id);
    const stopped = await command(profile, 'stop');
    assert.equal(stopped.state, 'stopping');
    await waitFor(() => !fs.existsSync(path.join(profile, 'runtime.json')));
    assert.equal((await command(profile, 'status')).state, 'stopped');
  } catch (error) {
    if (fs.existsSync(path.join(profile, 'runtime.log'))) error.message += `\nRuntime log:\n${fs.readFileSync(path.join(profile, 'runtime.log'), 'utf8').slice(-6000)}`;
    throw error;
  } finally {
    try { pids.add(readRuntimeDescriptor(profile).pid); } catch { /* stopped */ }
    for (const pid of pids) {
      try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    fs.rmSync(profile, { recursive: true, force: true });
  }
});

for (const kind of ['sol-sweep', 'token-transfer', 'metadata-update', 'liquidity-transaction', 'airdrop-observed-delivery']) {
test(`a pending durable ${kind} holds later live API wallet actions across runtime startup`, { timeout: 45_000 }, async () => {
  const { openRuntimeStore } = await import('../packages/runtime/src/store.js');
  const { sweepWallet, sweepDestination } = await import('../packages/runtime/test/fixtures/sol-sweep-chain.mjs');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'trebuchet-runtime-pending-'));
  fs.writeFileSync(path.join(profile, 'userPrefs.json'), JSON.stringify({ demoMode: false }));
  const store = openRuntimeStore(profile);
  const walletPublicKey = sweepWallet.publicKey.toBase58();
  let operation;
  try {
    store.saveLaunch({ id: 'pending-sweep', walletPublicKey, network: 'devnet', planDigest: 'b'.repeat(64), config: { purpose: 'sol-sweep' } });
    operation = store.prepareOperation({ launchId: 'pending-sweep', kind, payload: { destinationWallet: sweepDestination, amountLamports: 1000, newAuthority: sweepDestination, makeImmutable: false } });
    store.collection('journals').save([{ id: 'journal-a', walletPublicKey, status: 'active', stage: 'waiting-for-recovery' }]);
  } finally { store.close(); }
  let runtime;
  try {
    runtime = await ensureRuntime(profile, { args: [server] });
    const tempWalletSecretKey = Array.from(sweepWallet.secretKey);
    const requests = [
      ...(kind === 'liquidity-transaction' ? [] : [['/api/launch-journals/resume', { id: 'journal-a' }]]),
      ['/api/create-token', { tempWalletSecretKey, name: 'Pending Test', symbol: 'PEND', description: 'Recovery test', totalSupply: '1000' }],
      ['/api/run-airdrop', { tempWalletSecretKey, tokenMint: sweepDestination, tokenDecimals: 9, recipients: [{ wallet: sweepDestination, tokens: '1' }] }],
    ];
    for (const [endpoint, body] of requests) {
      await assert.rejects(runtime.request(endpoint, { method: 'POST', body }), (error) => {
        assert.equal(error.statusCode, 409);
        assert.equal(error.code, 'EXECUTION_RECOVERY_REQUIRED');
        assert.equal(error.operationId, operation.id);
        return true;
      });
    }
    for (const endpoint of ['/api/generate-wallet', '/api/v2/wallets/generate', '/api/v2/wallets/import']) {
      await assert.rejects(runtime.request(endpoint, { method: 'POST', body: endpoint.endsWith('/import') ? { secretKey: tempWalletSecretKey } : {} }),
        (error) => error.statusCode === 409 && error.code === 'RECOVERY_ENCRYPTION_REQUIRED');
    }
    assert.equal(fs.existsSync(path.join(profile, 'pendingWallets.json')), false);
    const check = openRuntimeStore(profile);
    try {
      assert.equal(check.getActiveOperation(walletPublicKey).id, operation.id);
      assert.deepEqual(check.getTransactions(operation.id), []);
      assert.deepEqual(check.collection('journals').load(), [{ id: 'journal-a', walletPublicKey, status: 'active', stage: 'waiting-for-recovery' }]);
    } finally { check.close(); }
    await runtime.request('/api/runtime/stop', { method: 'POST' });
    await waitFor(() => !fs.existsSync(path.join(profile, 'runtime.json')));
  } finally {
    if (runtime) { try { process.kill(runtime.identity.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    fs.rmSync(profile, { recursive: true, force: true });
  }
});

}


test('saved-journal and launch clients share wallet admission while a chain read is pending', { timeout: 30_000 }, async (t) => {
  const { openRuntimeStore } = await import('../packages/runtime/src/store.js');
  const { sweepWallet, sweepDestination } = await import('../packages/runtime/test/fixtures/sol-sweep-chain.mjs');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'trebuchet-journal-admission-'));
  const walletPublicKey = sweepWallet.publicKey.toBase58(), secretKey = Array.from(sweepWallet.secretKey);
  let arrived, release;
  const started = new Promise((resolve) => { arrived = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  let reads = 0;
  const rpc = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    reads++; arrived(); await gate;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { context: { slot: 200 }, value: null } }));
  });
  rpc.listen(0, '127.0.0.1'); await once(rpc, 'listening');
  const url = `http://127.0.0.1:${rpc.address().port}`;
  fs.writeFileSync(path.join(profile, 'rpcConfig.json'), JSON.stringify({ active: url, activeNetwork: 'devnet', saved: [{ name: 'Local fixture', url, network: 'devnet' }] }));
  fs.writeFileSync(path.join(profile, 'userPrefs.json'), JSON.stringify({ demoMode: false }));
  fs.writeFileSync(path.join(profile, 'pendingWallets.json'), JSON.stringify([{ publicKey: walletPublicKey, secretKeyEnc: 'plain:' + JSON.stringify(secretKey), createdAt: new Date().toISOString() }]));
  const journal = { id: 'journal-a', walletPublicKey, status: 'active', stage: 'lp_started', token: { mint: sweepDestination, totalSupply: '1' },
    poolPlan: { tokenMint: sweepDestination, tokenTotalSupply: '1', targetMarketCapUsd: 1000, allocations: [{ quoteToken: 'SOL', supplyPercent: 100 }] } };
  const db = openRuntimeStore(profile);
  db.collection('journals').save([journal]); db.close();
  let runtime;
  t.after(async () => {
    release();
    if (runtime) { try { process.kill(runtime.identity.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    rpc.closeAllConnections(); await new Promise((resolve) => rpc.close(resolve));
    fs.rmSync(profile, { recursive: true, force: true });
  });
  runtime = await ensureRuntime(profile, { args: [server] });
  const first = runtime.request('/api/launch-journals/resume', { method: 'POST', body: { id: journal.id } }).catch((error) => error);
  await Promise.race([started, first.then((result) => { throw new Error(`Saved-journal request ended before its chain read: ${JSON.stringify({ message: result?.message, code: result?.code, statusCode: result?.statusCode })}`); })]);
  for (const [endpoint, body] of [
    ['/api/launch-journals/resume', { id: journal.id }],
    ['/api/create-token', { tempWalletSecretKey: secretKey, name: 'Pending Test', symbol: 'PEND', description: 'Recovery test', totalSupply: '1000' }],
  ]) await assert.rejects(runtime.request(endpoint, { method: 'POST', body }), (error) => error.statusCode === 409 && error.code === 'OP_IN_FLIGHT');
  const check = openRuntimeStore(profile);
  assert.deepEqual(check.collection('journals').load(), [journal]); check.close();
  assert.equal(reads, 1);
  release();
  assert.equal((await first).statusCode, 500);
  const again = await runtime.request('/api/launch-journals/resume', { method: 'POST', body: { id: journal.id } }).catch((error) => error);
  assert.equal(again.statusCode, 500);
  assert.equal(reads, 2);
  await runtime.request('/api/runtime/stop', { method: 'POST' });
  await waitFor(() => !fs.existsSync(path.join(profile, 'runtime.json')));
});

for (const kind of ['quote-token-swap', 'storage-upload', 'quote-token-acquisition']) {
  test(`a saved ${kind} reservation holds HTTP spending between transactions after startup`, { timeout: 30000 }, async (t) => {
    const { openRuntimeStore } = await import('../packages/runtime/src/store.js');
    const { sweepWallet, sweepDestination } = await import('../packages/runtime/test/fixtures/sol-sweep-chain.mjs');
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'trebuchet-workflow-admission-'));
    const walletPublicKey = sweepWallet.publicKey.toBase58(), tempWalletSecretKey = Array.from(sweepWallet.secretKey);
    let requests = 0, runtime;
    const rpc = http.createServer((req, res) => { requests++; res.writeHead(500); res.end('Wallet reservation must be checked before chain access'); });
    t.after(async () => {
      if (runtime) { try { process.kill(runtime.identity.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
      rpc.closeAllConnections(); await new Promise((resolve) => rpc.close(resolve)); fs.rmSync(profile, { recursive: true, force: true });
    });
    rpc.listen(0, '127.0.0.1'); await once(rpc, 'listening');
    const url = `http://127.0.0.1:${rpc.address().port}`;
    fs.writeFileSync(path.join(profile, 'rpcConfig.json'), JSON.stringify({ active: url, activeNetwork: 'devnet', saved: [{ name: 'Local fixture', url, network: 'devnet' }] }));
    fs.writeFileSync(path.join(profile, 'userPrefs.json'), JSON.stringify({ demoMode: false }));
    const { Keypair } = await import('@solana/web3.js'), { default: nacl } = await import('tweetnacl');
    const proofMessage = 'Stored destination proof for the local admission fixture';
    const signature = Buffer.from(nacl.sign.detached(new TextEncoder().encode(proofMessage), Keypair.fromSeed(new Uint8Array(32).fill(32)).secretKey)).toString('base64');
    fs.writeFileSync(path.join(profile, 'verifiedDestinations.json'), JSON.stringify({ schema: 'trebuchet-verified-destinations/v1',
      destinations: { [sweepDestination]: { verifiedAt: new Date().toISOString(), message: proofMessage, signature } } }));
    const workflow = { id: `saved-${kind}`, walletPublicKey, kind, context: { scopeId: 'journal-workflow', phase: 'between-transactions' } };
    const store = openRuntimeStore(profile);
    store.reserveWalletWorkflow(workflow);
    store.collection('journals').save([{ id: 'journal-workflow', walletPublicKey, status: 'active', stage: 'waiting-for-recovery' }]);
    assert.equal(store.getActiveOperation(walletPublicKey), null); store.close();
    runtime = await ensureRuntime(profile, { args: [server] });
    for (const [endpoint, body] of [
      ['/api/create-token', { tempWalletSecretKey, name: 'Reserved', symbol: 'RSV', totalSupply: '1000', description: 'Local test' }],
      ['/api/run-airdrop', { tempWalletSecretKey, tokenMint: sweepDestination, tokenDecimals: 9, recipients: [{ wallet: sweepDestination, tokens: '1' }] }],
      ['/api/transfer-assets', { tempWalletSecretKey, destinationWallet: sweepDestination, tokenMint: sweepDestination }],
      ['/api/launch-journals/resume', { id: 'journal-workflow' }],
    ]) await assert.rejects(runtime.request(endpoint, { method: 'POST', body }), (error) => {
      assert.equal(error.statusCode, 409, `${endpoint}: ${error.message}`); assert.equal(error.code, 'EXECUTION_RECOVERY_REQUIRED'); assert.equal(error.operationId, workflow.id); return true;
    });
    assert.equal(requests, 0);
    const saved = openRuntimeStore(profile);
    try { assert.deepEqual(saved.getWalletWorkflow(walletPublicKey), { ...workflow, state: 'active' }); assert.equal(saved.getActiveOperation(walletPublicKey), null); }
    finally { saved.close(); }
    await runtime.request('/api/runtime/stop', { method: 'POST' });
    await waitFor(() => !fs.existsSync(path.join(profile, 'runtime.json')));
  });
}
