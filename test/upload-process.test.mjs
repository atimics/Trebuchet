import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { PublicKey } from '@solana/web3.js';
import { openRuntimeStore } from '@trebuchet/runtime/store';
import { uploadChain, sweepWallet } from './fixtures/upload-chain.mjs';

for (const stage of ['payment', 'acknowledgement', 'upload']) {
  test(`upload recovery survives process death after ${stage} acceptance`, { timeout: 30000 }, async (t) => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'trebuchet-upload-crash-')), ledger = uploadChain(), children = [], errors = [];
    let running, crash = true, requests = 0;
    const walletPublicKey = sweepWallet.publicKey.toBase58();
    const server = http.createServer(async (req, res) => {
      try {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks)); requests++;
        let result;
        switch (body.method) {
          case 'getGenesisHash': result = await ledger.connection.getGenesisHash(); break;
          case 'getFeeForMessage': result = await ledger.connection.getFeeForMessage(); break;
          case 'getLatestBlockhash': result = { context: { slot: ledger.state.slot }, value: await ledger.connection.getLatestBlockhash() }; break;
          case 'getSignatureStatuses': result = await ledger.connection.getSignatureStatuses(...body.params); break;
          case 'getTransaction': result = ledger.rpcReceipt(body.params[0]); break;
          case 'getMultipleAccounts': {
            result = await ledger.connection.getMultipleAccountsInfoAndContext(body.params[0].map((value) => new PublicKey(value)), body.params[1]);
            result.value = result.value.map((account) => account && ({ ...account, owner: account.owner.toBase58(), data: [account.data.toString('base64'), 'base64'] })); break;
          }
          case 'sendTransaction': result = await ledger.connection.sendRawTransaction(Buffer.from(body.params[0], 'base64')); break;
          case 'storage_identity': result = await ledger.transport.identity(); break;
          case 'storage_quote': result = await ledger.transport.quote(...body.params); break;
          case 'storage_balance': result = await ledger.transport.balance(...body.params); break;
          case 'storage_acknowledge': await ledger.transport.acknowledge(...body.params); result = true; break;
          case 'storage_receipt': result = await ledger.transport.findReceipt(...body.params); break;
          case 'storage_upload': result = await ledger.transport.upload(Buffer.from(body.params[0], 'base64')); break;
          default: throw new Error(`Unexpected local fixture RPC method ${body.method}`);
        }
        const killMethod = { payment: 'sendTransaction', acknowledgement: 'storage_acknowledge', upload: 'storage_upload' }[stage];
        if (crash && body.method === killMethod) {
          const store = openRuntimeStore(profile);
          try {
            const job = store.collection('runtime-uploads/v1').load()[0];
            assert.equal(store.getWalletWorkflow(walletPublicKey).id, job.id); assert.ok(job.approvals.length);
            const signed = fs.readFileSync(path.join(profile, 'upload-data', job.plan.wireDigest));
            assert.equal((await ledger.transport.inspect(signed)).rawId, job.plan.itemDigest);
            if (stage === 'payment') {
              const operation = store.getActiveOperation(walletPublicKey);
              assert.equal(store.getTransactions(operation.id)[0].wire, body.params[0]);
              assert.equal(store.getTransactions(operation.id)[0].state, 'signed');
            } else assert.equal(job.fundingReceipt.txId, ledger.state.sends[0].signature);
            if (stage === 'upload') assert.deepEqual(signed, Buffer.from(body.params[0], 'base64'));
          } finally { store.close(); }
          crash = false; running.kill('SIGKILL');
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
      const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/upload-worker.mjs', import.meta.url)), profile, `http://127.0.0.1:${server.address().port}`], { stdio: ['ignore', 'pipe', 'pipe'] });
      children.push(child); running = child; let out = '', err = '';
      child.stdout.on('data', (chunk) => { out += chunk; }); child.stderr.on('data', (chunk) => { err += chunk; });
      return { child, output: () => ({ out, err }) };
    };
    const first = run(), [firstCode, signal] = await once(first.child, 'close');
    assert.equal(firstCode, null, first.output().err); assert.equal(signal, 'SIGKILL'); assert.equal(crash, false);
    const second = run(), [secondCode] = await once(second.child, 'close');
    assert.equal(secondCode, 0, second.output().err); const result = JSON.parse(second.output().out), priorRequests = requests;
    const third = run(), [thirdCode] = await once(third.child, 'close');
    assert.equal(thirdCode, 0, third.output().err); assert.deepEqual(JSON.parse(third.output().out), result); assert.equal(requests, priorRequests);
    assert.equal(ledger.state.sends.length, 1); assert.equal(ledger.state.uploadAttempts, 1); assert.deepEqual(errors, []);
    const store = openRuntimeStore(profile);
    try { assert.equal(store.getActiveOperation(walletPublicKey), null); assert.equal(store.getWalletWorkflow(walletPublicKey), null); } finally { store.close(); }
  });
}
