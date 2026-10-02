import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { openRuntimeStore } from '../src/store.js';
import { supportChain, supportWallet } from './fixtures/support-position-chain.mjs';

for (const mode of ['classic', 'nft2022', 'native-b', 'failed']) {
  test(`support process recovers a ${mode} receipt after death during submission`, { timeout: 30000 }, async (t) => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'trebuchet-support-process-'));
    const f = supportChain({ nft2022: ['nft2022', 'native-b'].includes(mode), mintSeed: mode === 'native-b' ? 58 : 60 }), children = [], errors = [];
    f.state.fail = mode === 'failed'; let running, killed = false, requests = 0;
    const server = http.createServer(async (req, res) => {
      try {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks)); requests++; let result;
        switch (body.method) {
          case 'getGenesisHash': result = await f.connection.getGenesisHash(); break;
          case 'getFeeForMessage': result = await f.connection.getFeeForMessage(); break;
          case 'getLatestBlockhash': result = { context: { slot: f.state.slot }, value: await f.connection.getLatestBlockhash() }; break;
          case 'getMinimumBalanceForRentExemption': result = await f.connection.getMinimumBalanceForRentExemption(...body.params); break;
          case 'getEpochInfo': result = { epoch: 100, absoluteSlot: f.state.slot, blockHeight: 200, slotIndex: 0, slotsInEpoch: 432000 }; break;
          case 'getSignatureStatuses': result = await f.connection.getSignatureStatuses(...body.params); break;
          case 'getMultipleAccounts': {
            result = await f.connection.getMultipleAccountsInfoAndContext(body.params[0].map((key) => new PublicKey(key)), body.params[1]);
            result.value = result.value.map((info) => info && ({ ...info, owner: info.owner.toBase58(), data: [info.data.toString('base64'), 'base64'] })); break;
          }
          case 'getTransaction': {
            const receipt = await f.connection.getTransaction(body.params[0]), message = receipt?.transaction.message;
            result = receipt && { ...receipt, version: 0, transaction: { ...receipt.transaction, message: {
              header: message.header, accountKeys: message.staticAccountKeys.map((key) => key.toBase58()), recentBlockhash: message.recentBlockhash,
              instructions: message.compiledInstructions.map((ix) => ({ programIdIndex: ix.programIdIndex, accounts: ix.accountKeyIndexes, data: bs58.encode(ix.data) })), addressTableLookups: [],
            } } }; break;
          }
          case 'sendTransaction': {
            result = await f.connection.sendRawTransaction(Buffer.from(body.params[0], 'base64'));
            const store = openRuntimeStore(profile);
            try {
              const wallet = supportWallet.publicKey.toBase58(), job = store.collection('runtime-support-positions/v1').load()[0], operation = store.getActiveOperation(wallet);
              assert.equal(store.getWalletWorkflow(wallet).id, job.id); assert.equal(job.state, 'approved'); assert.equal(job.approvals.length, 1);
              assert.equal(store.getTransactions(operation.id)[0].wire, body.params[0]); assert.equal(store.getTransactions(operation.id)[0].state, 'signed');
            } finally { store.close(); }
            assert.equal(killed, false); killed = true; running.kill('SIGKILL'); break;
          }
          default: throw new Error(`Unexpected fixture method ${body.method}`);
        }
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
      } catch (error) { errors.push(error); res.writeHead(500); res.end(error.message); }
    });
    t.after(async () => {
      for (const child of children) if (child.exitCode === null && child.signalCode === null) { const done = once(child, 'close'); child.kill('SIGKILL'); await done; }
      server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); fs.rmSync(profile, { recursive: true, force: true });
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const run = async () => {
      const child = spawn(process.execPath, [new URL('./fixtures/support-position-worker.mjs', import.meta.url).pathname, profile, `http://127.0.0.1:${server.address().port}`, mode], { stdio: ['ignore', 'pipe', 'pipe'] });
      children.push(child); running = child; let out = '', err = '';
      child.stdout.on('data', (chunk) => { out += chunk; }); child.stderr.on('data', (chunk) => { err += chunk; });
      const [code, signal] = await once(child, 'close'); return { code, signal, out, err };
    };
    const first = await run(); assert.equal(first.signal, 'SIGKILL', first.err); assert.equal(killed, true);
    const recovered = await run(); assert.equal(recovered.code, 0, recovered.err); const result = JSON.parse(recovered.out);
    assert.equal(result.status, mode === 'failed' ? 'failed' : 'confirmed'); assert.equal(result.feeLamports, 80000); assert.equal(f.state.sends.length, 1);
    const count = requests, cached = await run(); assert.equal(cached.code, 0, cached.err); assert.deepEqual(JSON.parse(cached.out), result); assert.equal(requests, count);
    assert.deepEqual(errors, []);
  });
}
