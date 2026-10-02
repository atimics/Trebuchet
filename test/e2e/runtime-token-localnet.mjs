// A private local validator verifies Token-2022 creation and process recovery.
// Run: npm run test:e2e:runtime-token:localnet
// Requires solana-test-validator on PATH. All keys and funds are test fixtures.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Connection, Keypair } from '@solana/web3.js';
import { getMint, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { openRuntimeStore } from '../../packages/runtime/src/store.js';
import { sweepWallet, mintSigner } from '../../packages/runtime/test/fixtures/token-creation-chain.mjs';

const phases = ['mint-create', 'metadata-create', 'supply-finalize'];
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'trebuchet-validator-create-'));
const children = [], rpcErrors = [], accepted = new Map();
let validator, proxy, activeChild, crashPhase, sends = 0;
const logFile = path.join(profile, 'validator.log');
const log = fs.openSync(logFile, 'a', 0o600);
const waitFor = async (check, label, timeout = 60000) => {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch (error) { lastError = error; }
    if (validator?.exitCode !== null && validator?.exitCode !== undefined) throw new Error(`Validator exited while waiting for ${label}`);
    await sleep(300);
  }
  throw new Error(`Timed out waiting for ${label}: ${lastError?.message || 'pending'}`);
};
const rpcPort = async () => {
  for (let attempt = 0; attempt < 10; attempt++) {
    const first = net.createServer(), second = net.createServer();
    try {
      first.listen(0, '127.0.0.1'); await once(first, 'listening');
      const port = first.address().port;
      second.listen(port + 1, '127.0.0.1'); await once(second, 'listening');
      return port;
    } catch { /* Choose another free pair for RPC and its websocket. */ }
    finally { await Promise.all([first, second].map((server) => new Promise((resolve) => server.close(resolve)))); }
  }
  throw new Error('Choose free local validator ports');
};
const stop = async (child) => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, 'close');
  const force = setTimeout(() => child.kill('SIGKILL'), 5000);
  child.kill('SIGTERM');
  try { await closed; } finally { clearTimeout(force); }
};
try {
  const port = await rpcPort(), faucetPort = await rpcPort();
  const url = `http://127.0.0.1:${port}`;
  // A separate fixture key receives genesis funds. The launch wallet receives
  // exactly one local test SOL from this validator's faucet.
  validator = spawn('solana-test-validator', ['--quiet', '--ledger', path.join(profile, 'ledger'), '--bind-address', '127.0.0.1',
    '--rpc-port', String(port), '--faucet-port', String(faucetPort), '--mint', Keypair.fromSeed(new Uint8Array(32).fill(99)).publicKey.toBase58()], { stdio: ['ignore', log, log] });
  await once(validator, 'spawn');
  const connection = new Connection(url, 'finalized');
  await waitFor(() => connection.getVersion(), 'validator startup');
  process.stdout.write('Private local validator is ready.\n');
  const genesisHash = await connection.getGenesisHash();
  const funding = await connection.requestAirdrop(sweepWallet.publicKey, 1000000000);
  await waitFor(async () => {
    const response = await connection.getSignatureStatuses([funding], { searchTransactionHistory: true });
    const status = response.value[0];
    if (status?.err) throw new Error(JSON.stringify(status.err));
    return status?.confirmationStatus === 'finalized';
  }, 'local test funding');
  assert.equal(await connection.getBalance(sweepWallet.publicKey, 'finalized'), 1000000000);
  process.stdout.write('Fixture wallet has one finalized local test SOL.\n');
  proxy = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks));
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
      const reply = await response.json();
      if (body.method === 'sendTransaction' && reply.result) {
        sends++;
        if (accepted.has(reply.result)) assert.equal(accepted.get(reply.result), body.params[0]);
        accepted.set(reply.result, body.params[0]);
        const store = openRuntimeStore(profile);
        try {
          const operation = store.getActiveOperation(sweepWallet.publicKey.toBase58());
          const signed = store.getTransactions(operation.id).at(-1);
          assert.equal(signed.wire, body.params[0]); assert.ok(['signed', 'submitted'].includes(signed.state));
          assert.equal(signed.signature, reply.result); assert.ok(store.getOperationApprovals(operation.id).length);
          if (operation.payload.result.type === crashPhase) {
            assert.equal(signed.state, 'signed');
            crashPhase = null; activeChild.kill('SIGKILL');
          }
        } finally { store.close(); }
      }
      res.writeHead(response.status, { 'content-type': 'application/json' }); res.end(JSON.stringify(reply));
    } catch (error) { rpcErrors.push(error); res.writeHead(500); res.end(error.message); }
  });
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  const run = (phase) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../../packages/runtime/test/fixtures/token-creation-worker.mjs', import.meta.url)),
      profile, `http://127.0.0.1:${proxy.address().port}`, 'inline', phase, 'localnet', genesisHash, '60000'], { stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child); activeChild = child;
    let out = '', err = '';
    child.stdout.on('data', (chunk) => { out += chunk; }); child.stderr.on('data', (chunk) => { err += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 90000);
    child.once('close', () => clearTimeout(timer));
    return { child, output: () => ({ out, err }) };
  };
  for (const [index, phase] of phases.entries()) {
    const sendsBefore = sends;
    crashPhase = phase;
    const first = run(phase), [firstExit, signal] = await once(first.child, 'close');
    assert.equal(firstExit, null, first.output().err); assert.equal(signal, 'SIGKILL'); assert.equal(crashPhase, null);
    const second = run(phase), [secondExit] = await once(second.child, 'close');
    assert.equal(secondExit, 0, second.output().err); const result = JSON.parse(second.output().out);
    const third = run(phase), [thirdExit] = await once(third.child, 'close');
    assert.equal(thirdExit, 0, third.output().err); assert.deepEqual(JSON.parse(third.output().out), result);
    assert.equal(accepted.size, index + 1); assert.deepEqual(rpcErrors, []);
    process.stdout.write(`${phase}: finalized after process death; ${sends - sendsBefore} RPC submissions; one saved signature; receipt replayed\n`);
  }
  const mint = await getMint(connection, mintSigner.publicKey, 'finalized', TOKEN_2022_PROGRAM_ID);
  assert.equal(mint.supply, 1000000000000n); assert.equal(mint.mintAuthority, null); assert.equal(mint.freezeAuthority, null);
  process.stdout.write('Token-2022 validator recovery passed: three distinct finalized transactions, exact supply, and retired mint authority.\n');
} catch (error) {
  process.stderr.write(fs.readFileSync(logFile, 'utf8').slice(-4000) + '\n');
  throw error;
} finally {
  for (const child of children) await stop(child);
  if (proxy) { proxy.closeAllConnections(); await new Promise((resolve) => proxy.close(resolve)); }
  await stop(validator); fs.closeSync(log);
  fs.rmSync(profile, { recursive: true, force: true });
}
