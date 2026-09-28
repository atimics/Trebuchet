import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { PublicKey } from '@solana/web3.js';
import { openRuntimeStore } from '../src/store.js';
import { tokenCreationChain, sweepWallet } from './fixtures/token-creation-chain.mjs';

const phases = ['mint-create', 'metadata-create', 'supply-finalize'];
for (const inline of [false, true]) for (const phase of phases) {
  test(`${inline ? 'inline' : 'classic'} ${phase} survives process death after chain acceptance`, { timeout: 20000 }, async (t) => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'trebuchet-create-crash-'));
    const ledger = tokenCreationChain({ inline }), children = [], errors = [];
    const walletPublicKey = sweepWallet.publicKey.toBase58();
    let running, crash = true, operationId;
    const server = http.createServer(async (req, res) => {
      try {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks));
        let result;
        switch (body.method) {
          case 'getGenesisHash': result = await ledger.connection.getGenesisHash(); break;
          case 'getMinimumBalanceForRentExemption': result = await ledger.connection.getMinimumBalanceForRentExemption(...body.params); break;
          case 'getFeeForMessage': result = await ledger.connection.getFeeForMessage(); break;
          case 'getLatestBlockhash': result = { context: { slot: ledger.state.slot }, value: await ledger.connection.getLatestBlockhash() }; break;
          case 'getSignatureStatuses': result = await ledger.connection.getSignatureStatuses(...body.params); break;
          case 'getTransaction': result = ledger.rpcReceipt(body.params[0]); break;
          case 'getMultipleAccounts': {
            result = await ledger.connection.getMultipleAccountsInfoAndContext(body.params[0].map((value) => new PublicKey(value)), body.params[1]);
            result.value = result.value.map((account) => account && ({ ...account, owner: account.owner.toBase58(), data: [account.data.toString('base64'), 'base64'] }));
            break;
          }
          case 'sendTransaction': {
            const store = openRuntimeStore(profile);
            let operation;
            try {
              operation = store.getActiveOperation(walletPublicKey);
              assert.equal(store.getTransactions(operation.id)[0].wire, body.params[0]);
              assert.equal(store.getTransactions(operation.id)[0].state, 'signed');
              assert.equal(store.getOperationApprovals(operation.id)[0].id.length, 64);
            } finally { store.close(); }
            result = await ledger.connection.sendRawTransaction(Buffer.from(body.params[0], 'base64'));
            if (crash && operation.payload.result.type === phase) {
              operationId = operation.id; crash = false;
              running.kill('SIGKILL');
            }
            break;
          }
          default: throw new Error(`Unexpected fixture RPC method ${body.method}`);
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
      } catch (error) { errors.push(error); res.writeHead(500); res.end(error.message); }
    });
    t.after(async () => {
      for (const child of children) if (child.exitCode === null && child.signalCode === null) {
        const closed = once(child, 'close'); child.kill('SIGKILL'); await closed;
      }
      server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
      fs.rmSync(profile, { recursive: true, force: true });
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const run = () => {
      const worker = fileURLToPath(new URL('./fixtures/token-creation-worker.mjs', import.meta.url));
      const child = spawn(process.execPath, [worker, profile, `http://127.0.0.1:${server.address().port}`, inline ? 'inline' : 'classic', phase], { stdio: ['ignore', 'pipe', 'pipe'] });
      children.push(child); running = child;
      let out = '', err = '';
      child.stdout.on('data', (chunk) => { out += chunk; }); child.stderr.on('data', (chunk) => { err += chunk; });
      return { child, output: () => ({ out, err }) };
    };
    const first = run(), [code, signal] = await once(first.child, 'close');
    assert.equal(code, null, first.output().err); assert.equal(signal, 'SIGKILL');
    const second = run(), [secondCode] = await once(second.child, 'close');
    assert.equal(secondCode, 0, second.output().err);
    const result = JSON.parse(second.output().out);
    assert.equal(result.operationId, operationId); assert.equal(result.txId, ledger.state.sends.at(-1).signature);
    const third = run(), [thirdCode] = await once(third.child, 'close');
    assert.equal(thirdCode, 0, third.output().err); assert.deepEqual(JSON.parse(third.output().out), result);
    assert.equal(ledger.state.sends.length, phases.indexOf(phase) + 1); assert.deepEqual(errors, []);
    if (phase === 'supply-finalize') {
      assert.equal(ledger.state.supply.toString(), ledger.plan.supplyRaw); assert.equal(ledger.state.mintAuthority, null);
    }
  });
}
