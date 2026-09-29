import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { PublicKey } from '@solana/web3.js';
import { openRuntimeStore } from '../src/store.js';
import { swapChain, wallet } from './fixtures/swap-chain.mjs';

for (const step of [0, 1, 2]) {
  test(`a new process recovers swap step ${step} after acceptance and before receipt storage`, { timeout: 30000 }, async (t) => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'trebuchet-swap-process-')), ledger = swapChain(), errors = [], children = [];
    let running, crash = true, requests = 0;
    const server = http.createServer(async (req, res) => {
      try {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks)); requests++;
        let result;
        switch (body.method) {
          case 'getGenesisHash': result = await ledger.connection.getGenesisHash(); break;
          case 'getFeeForMessage': result = await ledger.connection.getFeeForMessage(); break;
          case 'getLatestBlockhash': result = { context: { slot: ledger.state.slot }, value: await ledger.connection.getLatestBlockhash() }; break;
          case 'getMinimumBalanceForRentExemption': result = await ledger.connection.getMinimumBalanceForRentExemption(...body.params); break;
          case 'getSignatureStatuses': result = await ledger.connection.getSignatureStatuses(...body.params); break;
          case 'getMultipleAccounts': {
            result = await ledger.connection.getMultipleAccountsInfoAndContext(body.params[0].map((key) => new PublicKey(key)), body.params[1]);
            result.value = result.value.map((info) => info && ({ ...info, owner: info.owner.toBase58(), data: [info.data.toString('base64'), 'base64'] })); break;
          }
          case 'getTransaction': {
            const receipt = await ledger.connection.getTransaction(body.params[0]), message = receipt?.transaction.message;
            result = receipt && { ...receipt, transaction: { ...receipt.transaction, message: {
              header: message.header, accountKeys: message.accountKeys.map((key) => key.toBase58()), recentBlockhash: message.recentBlockhash, instructions: message.instructions,
            } } }; break;
          }
          case 'sendTransaction': {
            result = await ledger.connection.sendRawTransaction(Buffer.from(body.params[0], 'base64'));
            if (crash && ledger.state.sends.length === step + 1) {
              const store = openRuntimeStore(profile);
              try {
                const job = store.collection('runtime-swaps/v1').load()[0], operation = store.getActiveOperation(wallet.toBase58());
                assert.equal(store.getWalletWorkflow(wallet.toBase58()).id, job.id);
                assert.equal(job.receipts.length, step); assert.ok(job.approvals.length);
                assert.equal(store.getTransactions(operation.id)[0].wire, body.params[0]);
                assert.equal(store.getTransactions(operation.id)[0].state, 'signed');
              } finally { store.close(); }
              crash = false; running.kill('SIGKILL');
            }
            break;
          }
          default: throw new Error(`Unexpected fixture method ${body.method}`);
        }
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
      } catch (error) { errors.push(error); res.writeHead(500); res.end(error.message); }
    });
    t.after(async () => {
      for (const child of children) if (child.exitCode === null && child.signalCode === null) { const closed = once(child, 'close'); child.kill('SIGKILL'); await closed; }
      server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); fs.rmSync(profile, { recursive: true, force: true });
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const run = () => {
      const child = spawn(process.execPath, [new URL('./fixtures/swap-worker.mjs', import.meta.url).pathname, profile, `http://127.0.0.1:${server.address().port}`], { stdio: ['ignore', 'pipe', 'pipe'] });
      children.push(child); running = child; let out = '', err = '';
      child.stdout.on('data', (chunk) => { out += chunk; }); child.stderr.on('data', (chunk) => { err += chunk; });
      return { child, output: () => ({ out, err }) };
    };
    const first = run(), [code, signal] = await once(first.child, 'close');
    assert.equal(code, null, first.output().err); assert.equal(signal, 'SIGKILL'); assert.equal(crash, false);
    const second = run(), [recoveredCode] = await once(second.child, 'close');
    assert.equal(recoveredCode, 0, second.output().err); const result = JSON.parse(second.output().out), count = requests;
    assert.equal(result.receivedRaw, '1250'); assert.equal(result.receipts.length, 3); assert.equal(ledger.state.receipts.size, 3);
    const third = run(), [cachedCode] = await once(third.child, 'close');
    assert.equal(cachedCode, 0, third.output().err); assert.deepEqual(JSON.parse(third.output().out), result); assert.equal(requests, count);
    assert.equal(ledger.state.sends.length, 3); assert.equal(ledger.state.source, null); assert.deepEqual(errors, []);
  });
}
