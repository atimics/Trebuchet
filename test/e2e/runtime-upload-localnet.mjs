// A private Solana validator and local storage fixture exercise upload recovery.
// Run: npm run test:e2e:runtime-upload:localnet
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
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { openRuntimeStore } from '../../packages/runtime/src/store.js';
import { uploadChain, sweepWallet, sweepDestination } from '../fixtures/upload-chain.mjs';

const phases = ['payment', 'acknowledgement', 'upload'];
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'trebuchet-validator-upload-'));
const children = [], rpcErrors = [], accepted = new Map(), receipts = [];
let validator, proxy, activeChild, crashPhase, ledger, profile, sends = 0, requests = 0;
const logFile = path.join(directory, 'validator.log');
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
  const port = await rpcPort(), faucetPort = await rpcPort(), url = `http://127.0.0.1:${port}`;
  validator = spawn('solana-test-validator', ['--quiet', '--ledger', path.join(directory, 'ledger'), '--bind-address', '127.0.0.1',
    '--rpc-port', String(port), '--faucet-port', String(faucetPort), '--mint', Keypair.fromSeed(new Uint8Array(32).fill(99)).publicKey.toBase58()], { stdio: ['ignore', log, log] });
  await once(validator, 'spawn');
  const connection = new Connection(url, 'finalized');
  await waitFor(() => connection.getVersion(), 'validator startup');
  process.stdout.write('Private local validator is ready.\n');
  const genesisHash = await connection.getGenesisHash(), destination = new PublicKey(sweepDestination);
  const funding = [await connection.requestAirdrop(sweepWallet.publicKey, 1000000000), await connection.requestAirdrop(destination, 1000000)];
  await waitFor(async () => {
    const response = await connection.getSignatureStatuses(funding, { searchTransactionHistory: true });
    return response.value.every((status) => status?.confirmationStatus === 'finalized' && status.err === null);
  }, 'local test funding');
  assert.equal(await connection.getBalance(sweepWallet.publicKey, 'finalized'), 1000000000);
  assert.equal(await connection.getBalance(destination, 'finalized'), 1000000);
  process.stdout.write('Payer and storage recipient have finalized local test funds.\n');
  proxy = http.createServer(async (req, res) => {
    try {
      requests++;
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks));
      let reply, status = 200;
      if (body.method.startsWith('storage_')) {
        let result;
        switch (body.method) {
          case 'storage_identity': result = await ledger.transport.identity(); break;
          case 'storage_quote': result = await ledger.transport.quote(...body.params); break;
          case 'storage_balance': result = await ledger.transport.balance(...body.params); break;
          case 'storage_receipt': result = await ledger.transport.findReceipt(...body.params); break;
          case 'storage_acknowledge': {
            const receipt = await connection.getTransaction(body.params[0], { commitment: 'finalized', maxSupportedTransactionVersion: 0 });
            assert.ok(receipt); assert.equal(receipt.meta.err, null);
            ledger.state.receipts.set(body.params[0], receipt);
            await ledger.transport.acknowledge(...body.params); result = true; break;
          }
          case 'storage_upload': result = await ledger.transport.upload(Buffer.from(body.params[0], 'base64')); break;
          default: throw new Error(`Unexpected local storage request ${body.method}`);
        }
        reply = { jsonrpc: '2.0', id: body.id, result };
      } else {
        const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
        status = response.status; reply = await response.json();
      }
      if (body.method === 'sendTransaction' && reply.result) {
        sends++;
        if (accepted.has(reply.result)) assert.equal(accepted.get(reply.result), body.params[0]);
        accepted.set(reply.result, body.params[0]);
      }
      const killMethod = { payment: 'sendTransaction', acknowledgement: 'storage_acknowledge', upload: 'storage_upload' }[crashPhase];
      if (body.method === killMethod && reply.result) {
        const store = openRuntimeStore(profile);
        try {
          const job = store.collection('runtime-uploads/v1').load()[0];
          assert.equal(store.getWalletWorkflow(sweepWallet.publicKey.toBase58()).id, job.id); assert.ok(job.approvals.length);
          const signed = fs.readFileSync(path.join(profile, 'upload-data', job.plan.wireDigest));
          assert.equal((await ledger.transport.inspect(signed)).rawId, job.plan.itemDigest);
          if (crashPhase === 'payment') {
            const operation = store.getActiveOperation(sweepWallet.publicKey.toBase58()), transaction = store.getTransactions(operation.id).at(-1);
            assert.equal(transaction.wire, body.params[0]); assert.equal(transaction.signature, reply.result); assert.equal(transaction.state, 'signed');
          } else assert.ok(job.fundingReceipt.txId);
          if (crashPhase === 'upload') assert.deepEqual(signed, Buffer.from(body.params[0], 'base64'));
          crashPhase = null; activeChild.kill('SIGKILL');
        } finally { store.close(); }
      }
      res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(reply));
    } catch (error) { rpcErrors.push(error); res.writeHead(500); res.end(error.message); }
  });
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  const run = (phase) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../fixtures/upload-worker.mjs', import.meta.url)),
      profile, `http://127.0.0.1:${proxy.address().port}`, 'localnet', genesisHash, '60000', `validator/${phase}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child); activeChild = child;
    let out = '', err = '';
    child.stdout.on('data', (chunk) => { out += chunk; }); child.stderr.on('data', (chunk) => { err += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 90000);
    child.once('close', () => clearTimeout(timer));
    return { child, output: () => ({ out, err }) };
  };
  for (const [index, phase] of phases.entries()) {
    profile = path.join(directory, phase); ledger = uploadChain();
    const sendsBefore = sends;
    crashPhase = phase;
    const first = run(phase), [firstExit, signal] = await once(first.child, 'close');
    assert.equal(firstExit, null, first.output().err); assert.equal(signal, 'SIGKILL'); assert.equal(crashPhase, null);
    const second = run(phase), [secondExit] = await once(second.child, 'close');
    assert.equal(secondExit, 0, second.output().err); const result = JSON.parse(second.output().out), priorRequests = requests;
    const third = run(phase), [thirdExit] = await once(third.child, 'close');
    assert.equal(thirdExit, 0, third.output().err); assert.deepEqual(JSON.parse(third.output().out), result); assert.equal(requests, priorRequests);
    assert.equal(accepted.size, index + 1); assert.deepEqual(rpcErrors, []); assert.equal(ledger.state.uploadAttempts, 1);
    assert.equal(ledger.state.acknowledged.size, 1); assert.equal(ledger.state.storageBalance, 0);
    const receipt = await connection.getTransaction(result.fundingReceipt.txId, { commitment: 'finalized', maxSupportedTransactionVersion: 0 });
    assert.ok(receipt); assert.equal(receipt.meta.err, null); receipts.push(receipt);
    const store = openRuntimeStore(profile);
    try { assert.equal(store.getActiveOperation(sweepWallet.publicKey.toBase58()), null); assert.equal(store.getWalletWorkflow(sweepWallet.publicKey.toBase58()), null); } finally { store.close(); }
    process.stdout.write(`${phase}: recovered after process death; ${sends - sendsBefore} RPC submissions; one deposit and upload; cached receipt replayed\n`);
  }
  assert.equal(await connection.getBalance(destination, 'finalized'), 1030000);
  assert.equal(await connection.getBalance(sweepWallet.publicKey, 'finalized'), 1000000000 - 30000 - receipts.reduce((sum, receipt) => sum + receipt.meta.fee, 0));
  process.stdout.write('Upload validator recovery passed: three distinct finalized deposits, three verified uploads, and exact wallet balances.\n');
} catch (error) {
  process.stderr.write(fs.readFileSync(logFile, 'utf8').slice(-4000) + '\n');
  throw error;
} finally {
  for (const child of children) await stop(child);
  if (proxy) { proxy.closeAllConnections(); await new Promise((resolve) => proxy.close(resolve)); }
  await stop(validator); fs.closeSync(log);
  fs.rmSync(directory, { recursive: true, force: true });
}
