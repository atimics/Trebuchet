import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Keypair } from '@solana/web3.js';
import { inspectSolanaTransaction } from '../src/solana.js';
import { openRuntimeStore } from '../src/store.js';

const worker = new URL('./fixtures/engine-worker.mjs', import.meta.url);

test('a killed engine recovers a real signed transaction from a local RPC receipt', { timeout: 20_000 }, async (t) => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'trebuchet-engine-crash-'));
  const children = [];
  let receipt = null, sends = 0, running;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    let result;
    if (body.method === 'getGenesisHash') result = 'fixture-genesis';
    else if (body.method === 'getLatestBlockhash') result = { context: { slot: 40 }, value: { blockhash: Keypair.fromSeed(new Uint8Array(32).fill(9)).publicKey.toBase58(), lastValidBlockHeight: 100 } };
    else if (body.method === 'getBalance') result = { context: { slot: 50 }, value: receipt ? 3 : 0 };
    else if (body.method === 'getSignatureStatuses') {
      assert.equal(body.params[1].searchTransactionHistory, true);
      result = { context: { slot: 50 }, value: [receipt ? { slot: 42, confirmations: null, err: null, confirmationStatus: 'finalized' } : null] };
    } else if (body.method === 'sendTransaction') {
      sends++;
      receipt = inspectSolanaTransaction(body.params[0]);
      // The RPC accepted the signed bytes. Kill the caller before returning
      // the signature, which leaves its durable transaction in signed state.
      const saved = openRuntimeStore(profile);
      try {
        const op = saved.listOperations('crash-launch')[0];
        assert.equal(saved.getTransactions(op.id)[0].wire, receipt.wire);
        assert.equal(saved.getTransactions(op.id)[0].state, 'signed');
      } finally { saved.close(); }
      running.kill('SIGKILL');
      result = receipt.signature;
    } else throw new Error(`Unexpected RPC method ${body.method}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
  });
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(profile, { recursive: true, force: true });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const run = () => {
    const child = spawn(process.execPath, [worker.pathname, profile, `http://127.0.0.1:${server.address().port}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child); running = child;
    let out = '', err = '';
    child.stdout.on('data', (chunk) => { out += chunk; }); child.stderr.on('data', (chunk) => { err += chunk; });
    return { child, output: () => ({ out, err }) };
  };
  const first = run();
  const [exit, signal] = await once(first.child, 'close');
  assert.equal(exit, null, first.output().err);
  assert.equal(signal, 'SIGKILL');
  const second = run();
  const [secondExit] = await once(second.child, 'close');
  assert.equal(secondExit, 0, second.output().err);
  const recovered = JSON.parse(second.output().out);
  assert.equal(recovered.operation.state, 'confirmed');
  assert.equal(recovered.transactions[0].signature, receipt.signature);
  assert.equal(sends, 1);
});
