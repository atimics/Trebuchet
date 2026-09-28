import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { acquireProfileOwner } from '../packages/runtime/src/owner.js';
import { openRuntimeStore } from '../packages/runtime/src/store.js';
import { createWalletExecutionRuntime } from '../walletExecution.js';
import { SOLANA_GENESIS_HASHES } from '../packages/runtime/src/solana.js';
import { solSweepChain, sweepWallet, sweepDestination } from '../packages/runtime/test/fixtures/sol-sweep-chain.mjs';

const input = { tempWalletSecretKey: Array.from(sweepWallet.secretKey), destinationWallet: sweepDestination };
const walletPublicKey = sweepWallet.publicKey.toBase58();
function fixture(t, options = {}) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'trebuchet-wallet-execution-'));
  const owner = acquireProfileOwner(profile);
  const { connection, state } = solSweepChain();
  const runtime = createWalletExecutionRuntime({ owner, getScopeId: () => 'journal-a', networkForRequest: () => 'devnet', createConnection: () => connection, timeoutMs: 0, ...options });
  t.after(() => { owner.release(); fs.rmSync(profile, { recursive: true, force: true }); });
  return { profile, owner, state, connection, runtime };
}

test('the local wallet host records its request approval and returns the verified sweep receipt', async (t) => {
  const f = fixture(t);
  assert.equal(await f.runtime.recover(input), null);
  const result = await f.runtime.sweepSolToDestination(input);
  assert.equal(result.solTransferred, 0.00909312);
  assert.equal(f.runtime.active(walletPublicKey), null);
  const store = openRuntimeStore(f.profile);
  try {
    const approval = store.getOperationApprovals(result.operationId)[0];
    assert.equal(approval.source, 'local-transfer-request');
    assert.equal(approval.walletPublicKey, walletPublicKey);
    assert.equal(approval.destinationWallet, sweepDestination);
    assert.equal(approval.genesisHash, SOLANA_GENESIS_HASHES.devnet);
    assert.equal(approval.maxSpendLamports, 10_000_000);
    assert.equal(store.getTransactions(result.operationId)[0].signature, result.txId);
  } finally { store.close(); }
});

test('the local host exposes durable recovery details while finalization is pending', async (t) => {
  const f = fixture(t);
  f.state.status = 'confirmed';
  await assert.rejects(f.runtime.sweepSolToDestination(input), (error) => {
    assert.equal(error.code, 'EXECUTION_RECOVERY_REQUIRED');
    assert.equal(error.statusCode, 409);
    assert.equal(error.operationId, f.runtime.active(walletPublicKey).id);
    assert.equal(error.errorDetails.code, 'CHAIN_STATE_UNAVAILABLE');
    return true;
  });
  f.state.status = 'finalized';
  const result = await f.runtime.recover(input);
  assert.equal(result.txId, f.state.sends[0].signature);
  assert.equal(f.state.sends.length, 1);
});

test('local approval requires the saved launch and the same network at send time', async (t) => {
  const missing = fixture(t, { getScopeId: () => null });
  await assert.rejects(missing.runtime.sweepSolToDestination(input), { code: 'EXECUTION_RECOVERY_REQUIRED' });
  assert.equal(missing.state.sends.length, 0);
  let network = 'devnet';
  const changed = fixture(t, { networkForRequest: () => network });
  changed.connection.getFeeForMessage = async () => { network = 'mainnet'; return { context: { slot: 200 }, value: 6000 }; };
  await assert.rejects(changed.runtime.sweepSolToDestination(input), (error) => error.errorDetails.code === 'EXECUTION_APPROVAL_REQUIRED');
  assert.equal(changed.state.sends.length, 0);
});

test('the production SOL adapter recovers after its process dies between chain acceptance and receipt storage', { timeout: 20_000 }, async (t) => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'trebuchet-wallet-crash-'));
  const ledger = solSweepChain();
  const children = [];
  let running;
  const rpcErrors = [];
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks));
      let result;
      switch (body.method) {
        case 'getGenesisHash': result = await ledger.connection.getGenesisHash(); break;
        case 'getBalance': result = await ledger.connection.getBalanceAndContext(); break;
        case 'getMinimumBalanceForRentExemption': result = await ledger.connection.getMinimumBalanceForRentExemption(); break;
        case 'getRecentPrioritizationFees': result = []; break;
        case 'getFeeForMessage': result = await ledger.connection.getFeeForMessage(); break;
        case 'getLatestBlockhash': result = { context: { slot: ledger.state.slot }, value: await ledger.connection.getLatestBlockhash() }; break;
        case 'getSignatureStatuses': result = await ledger.connection.getSignatureStatuses(...body.params); break;
        case 'getTransaction': result = ledger.rpcReceipt(body.params[0]); break;
        case 'sendTransaction': {
          result = await ledger.connection.sendRawTransaction(Buffer.from(body.params[0], 'base64'));
          const store = openRuntimeStore(profile);
          try {
            const op = store.getActiveOperation(walletPublicKey);
            assert.equal(store.getTransactions(op.id)[0].wire, body.params[0]);
            assert.equal(store.getTransactions(op.id)[0].state, 'signed');
            assert.equal(store.getOperationApprovals(op.id)[0].source, 'local-transfer-request');
          } finally { store.close(); }
          running.kill('SIGKILL');
          break;
        }
        default: throw new Error(`Unexpected local RPC method ${body.method}`);
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
    } catch (error) {
      rpcErrors.push(error);
      res.writeHead(500); res.end(error.message);
    }
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
    const child = spawn(process.execPath, [new URL('./fixtures/wallet-execution-worker.mjs', import.meta.url).pathname, profile, `http://127.0.0.1:${server.address().port}`], {
      stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TREBUCHET_CONFIG_DIR: profile },
    });
    running = child; children.push(child);
    let out = '', err = '';
    child.stdout.on('data', (chunk) => { out += chunk; }); child.stderr.on('data', (chunk) => { err += chunk; });
    return { child, output: () => ({ out, err }) };
  };
  const first = run();
  const [firstExit, signal] = await once(first.child, 'close');
  assert.equal(firstExit, null, first.output().err);
  assert.equal(signal, 'SIGKILL');
  assert.equal(ledger.state.sends.length, 1);
  assert.equal(ledger.state.balance, 900880);
  const second = run();
  const [secondExit] = await once(second.child, 'close');
  assert.equal(secondExit, 0, second.output().err);
  assert.deepEqual(rpcErrors, []);
  const recovered = JSON.parse(second.output().out.split('RESULT:')[1]);
  assert.equal(recovered.txId, ledger.state.sends[0].signature);
  assert.equal(recovered.solTransferred, 0.00909312);
  assert.equal(ledger.state.sends.length, 1);
  const store = openRuntimeStore(profile);
  try {
    assert.equal(store.getOperation(recovered.operationId).state, 'confirmed');
    assert.equal(store.getTransactions(recovered.operationId).length, 1);
  } finally { store.close(); }
});
