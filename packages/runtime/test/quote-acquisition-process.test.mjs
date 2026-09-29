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
import { wallet } from './fixtures/swap-chain.mjs';
import { quoteAcquisitionChain } from './fixtures/quote-acquisition-chain.mjs';

for (const config of [{ step: 1 }, { step: 2 }, { step: 3, split: true }, { step: 3, split: true, failed: true }]) {
  test(`acquisition process recovery after submission ${config.step}, split ${!!config.split}, failed ${!!config.failed}`, { timeout: 30000 }, async (t) => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'trebuchet-acquisition-process-'));
    const chain = quoteAcquisitionChain({ combined: !config.split }), errors = [], children = [];
    if (config.failed) chain.ledgers[0].state.failAt = 1;
    let running, crash = true, requests = 0;
    const sends = () => chain.ledgers.reduce((count, ledger) => count + ledger.state.sends.length, 0);
    const server = http.createServer(async (req, res) => {
      try {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks)); requests++; let result;
        switch (body.method) {
          case 'getGenesisHash': result = await chain.connection.getGenesisHash(); break;
          case 'getFeeForMessage': result = await chain.connection.getFeeForMessage(); break;
          case 'getLatestBlockhash': result = { context: { slot: chain.slot() }, value: await chain.connection.getLatestBlockhash() }; break;
          case 'getMinimumBalanceForRentExemption': result = await chain.connection.getMinimumBalanceForRentExemption(...body.params); break;
          case 'getSignatureStatuses': result = await chain.connection.getSignatureStatuses(...body.params); break;
          case 'getMultipleAccounts': {
            result = await chain.connection.getMultipleAccountsInfoAndContext(body.params[0].map((key) => new PublicKey(key)), body.params[1]);
            result.value = result.value.map((info) => info && ({ ...info, owner: info.owner.toBase58(), data: [info.data.toString('base64'), 'base64'] })); break;
          }
          case 'getTransaction': {
            const receipt = await chain.connection.getTransaction(body.params[0]), message = receipt?.transaction.message;
            result = receipt && { ...receipt, transaction: { ...receipt.transaction, message: {
              header: message.header, accountKeys: message.accountKeys.map((key) => key.toBase58()), recentBlockhash: message.recentBlockhash, instructions: message.instructions,
            } } }; break;
          }
          case 'sendTransaction': {
            result = await chain.connection.sendRawTransaction(Buffer.from(body.params[0], 'base64'));
            if (crash && sends() === config.step) {
              const store = openRuntimeStore(profile);
              try {
                const job = store.collection('runtime-quote-acquisitions/v1').load()[0], operation = store.getActiveOperation(wallet.toBase58());
                assert.equal(store.getWalletWorkflow(wallet.toBase58()).id, job.id);
                assert.equal(job.plan.purchases.length, 2); assert.ok(job.approvals.length);
                assert.equal(store.getLaunch(operation.launchId).config.workflowId, job.id);
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
      const child = spawn(process.execPath, [new URL('./fixtures/quote-acquisition-worker.mjs', import.meta.url).pathname, profile,
        `http://127.0.0.1:${server.address().port}`, String(!!config.split)], { stdio: ['ignore', 'pipe', 'pipe'] });
      children.push(child); running = child; let out = '', err = '';
      child.stdout.on('data', (chunk) => { out += chunk; }); child.stderr.on('data', (chunk) => { err += chunk; });
      return { child, output: () => ({ out, err }) };
    };
    const first = run(), [code, signal] = await once(first.child, 'close');
    assert.equal(code, null, first.output().err); assert.equal(signal, 'SIGKILL'); assert.equal(crash, false);
    const second = run(), [recoveredCode] = await once(second.child, 'close');
    assert.equal(recoveredCode, 0, second.output().err); const result = JSON.parse(second.output().out), count = requests;
    assert.equal(result.status, config.failed ? 'recovered' : 'confirmed');
    assert.equal(sends(), config.failed ? 3 : config.split ? 6 : 2);
    assert.equal(result.feeLamports, sends() * 5000);
    if (config.failed) {
      assert.equal(result.purchases[0].result.purchaseStatus, 'failed'); assert.equal(result.purchases[1].state, 'pending');
    } else assert.ok(result.purchases.every((purchase) => purchase.result.receivedRaw === '1250'));
    const third = run(), [cachedCode] = await once(third.child, 'close');
    assert.equal(cachedCode, 0, third.output().err); assert.deepEqual(JSON.parse(third.output().out), result); assert.equal(requests, count);
    assert.deepEqual(errors, []);
  });
}
