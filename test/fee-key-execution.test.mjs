import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Keypair } from '@solana/web3.js';
import { acquireProfileOwner } from '../packages/runtime/src/owner.js';
import { openRuntimeStore } from '../packages/runtime/src/store.js';
import { sweepWallet, sweepDestination } from '../packages/runtime/test/fixtures/token-transfer-chain.mjs';
import { feeKeyContext, feeKeyRequest, feeKeyPosition, feeKeyPlan, feeKeyChain } from './fixtures/fee-key-context.mjs';
import { __testHooks as phases } from '../lpService.js';

const walletPublicKey = sweepWallet.publicKey.toBase58();
function fixture(t, options = {}) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'trebuchet-fee-key-')), owner = acquireProfileOwner(profile);
  const ledger = feeKeyChain();
  const host = feeKeyContext({ owner, connection: ledger.connection, ...options });
  t.after(() => { owner.release(); fs.rmSync(profile, { recursive: true, force: true }); });
  return { profile, owner, ...ledger, ...host, transfer: () => host.feeKeyExecution.forLaunch(host.input)(feeKeyRequest) };
}

test('the direct Fee Key phase uses the engine and restores its exact receipt on retry', async (t) => {
  const f = fixture(t), raydium = { connection: f.connection };
  phases.bindLiquidityExecutor(raydium, { transferFeeKey: f.feeKeyExecution.forLaunch(f.input) });
  const run = async () => {
    const results = [{ allocationIndex: 0, poolId: feeKeyRequest.poolId, quoteSymbol: 'SOL', mainPositions: [structuredClone(feeKeyPosition)] }];
    const outcome = await phases.transferFeeKeys({ raydium, ownerKeypair: sweepWallet, results });
    assert.deepEqual(outcome.transferFailures, []);
    return results[0].mainPositions[0];
  };
  const first = await run();
  assert.equal(first.transferredTo, sweepDestination); assert.equal(first.txIds.transfer, f.state.sends[0].signature);
  f.connection.getMultipleAccountsInfoAndContext = async () => { throw new Error('source account closed'); };
  assert.deepEqual(await run(), first);
  assert.equal(f.state.sends.length, 1); assert.equal(f.events.length, 1);
  const receipt = f.walletExecution.getTransferReceipts(walletPublicKey)[0];
  assert.equal(receipt.action.context.positionNftMint, feeKeyRequest.positionNftMint);
  assert.equal(receipt.destinationWallet, sweepDestination); assert.equal(receipt.amountRaw, '1');
});

test('a lost direct Fee Key response recovers before other liquidity work', async (t) => {
  const f = fixture(t);
  f.state.afterSend = () => { throw new Error('response lost'); };
  await assert.rejects(f.transfer(), { code: 'EXECUTION_RECOVERY_REQUIRED' });
  assert.equal(f.feeKeyExecution.canRecover(walletPublicKey), true);
  f.state.afterSend = null;
  const recovered = await f.feeKeyExecution.recover(f.input);
  assert.equal(recovered.txId, f.state.sends[0].signature);
  assert.equal(await f.transfer(), recovered.txId);
  assert.equal(f.state.sends.length, 1);
  assert.equal(f.journal.activeForWallet(walletPublicKey).lp.partialResults[0].mainPositions[0].transferredTo, sweepDestination);
});

for (const [label, change] of Object.entries({ recipient: { recipient: Keypair.generate().publicKey.toBase58() }, position: { positionNftMint: Keypair.generate().publicKey.toBase58() }, mint: { nftMint: Keypair.generate().publicKey.toBase58() }, allocation: { allocationIndex: 1 }, slice: { sliceIndex: 1 } })) {
  test(`direct Fee Key execution checks the saved ${label} before spending`, async (t) => {
    const f = fixture(t);
    await assert.rejects(f.feeKeyExecution.forLaunch(f.input)({ ...feeKeyRequest, ...change }), { code: 'EXECUTION_RECOVERY_REQUIRED' });
    assert.equal(f.state.sends.length, 0);
  });
}

test('an ordinary asset sweep retains its separate recovery path', async (t) => {
  const f = fixture(t); f.state.status = 'confirmed';
  await assert.rejects(f.walletExecution.transferToken({ tempWalletSecretKey: f.input.tempWalletSecretKey, destinationWallet: sweepDestination,
    mint: f.mint.toBase58(), programId: f.program.toBase58(), sourceTokenAccount: f.source.toBase58(), amountRaw: '1', decimals: 0 }), { code: 'EXECUTION_RECOVERY_REQUIRED' });
  assert.equal(f.feeKeyExecution.canRecover(walletPublicKey), false);
  assert.equal(await f.feeKeyExecution.recover(f.input), null);
  assert.equal(f.state.sends.length, 1);
});

test('a confirmed Fee Key receipt survives a failed journal checkpoint', async (t) => {
  let failed = true;
  const f = fixture(t, { recordProgress: () => { if (failed) throw Object.assign(new Error('journal write failed'), { code: 'RECOVERY_STORAGE_UNAVAILABLE' }); } });
  await assert.rejects(f.transfer(), { code: 'RECOVERY_STORAGE_UNAVAILABLE' });
  const db = openRuntimeStore(f.profile);
  try { assert.equal(db.listWalletOperations(walletPublicKey)[0].state, 'confirmed'); } finally { db.close(); }
  failed = false;
  await f.feeKeyExecution.recover(f.input);
  assert.equal(await f.transfer(), f.state.sends[0].signature);
  assert.equal(f.state.sends.length, 1);
});

test('changed launch plans and pending token identities hold Fee Key recovery', async (t) => {
  const f = fixture(t); f.state.status = 'confirmed';
  await assert.rejects(f.transfer(), { code: 'EXECUTION_RECOVERY_REQUIRED' });
  await assert.rejects(f.feeKeyExecution.recover({ ...f.input, tokenMint: Keypair.generate().publicKey.toBase58() }), { code: 'EXECUTION_RECOVERY_REQUIRED' });
  f.journal.upsertForWallet(walletPublicKey, { poolPlan: { ...feeKeyPlan, targetMarketCapUsd: 20000 } });
  assert.throws(() => f.feeKeyExecution.canRecover(walletPublicKey), { code: 'EXECUTION_RECOVERY_REQUIRED' });
  assert.equal(f.state.sends.length, 1);
});


test('saved-journal HTTP recovery restores a direct Fee Key and holds competing requests', { timeout: 30_000 }, async (t) => {
  const { default: http } = await import('node:http');
  const { once } = await import('node:events');
  const { PublicKey } = await import('@solana/web3.js');
  const { ensureRuntime } = await import('../packages/runtime/src/client.js');
  const f = fixture(t); f.state.status = 'confirmed';
  await assert.rejects(f.transfer(), { code: 'EXECUTION_RECOVERY_REQUIRED' });
  const operation = f.walletExecution.active(walletPublicKey), journalId = f.journal.activeForWallet(walletPublicKey).id;
  f.state.status = 'finalized'; f.owner.release();
  let arrived, release, runtime, launchTokenReads = 0;
  const entered = new Promise((resolve) => { arrived = resolve; }), gate = new Promise((resolve) => { release = resolve; });
  const errors = [];
  const account = (value) => value && ({ ...value, owner: value.owner.toBase58(), data: [value.data.toString('base64'), 'base64'] });
  const rpc = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks));
      let result;
      switch (body.method) {
        case 'getGenesisHash': result = await f.connection.getGenesisHash(); break;
        case 'getBalance': result = await f.connection.getBalanceAndContext(); break;
        case 'getSignatureStatuses': arrived(); await gate; result = await f.connection.getSignatureStatuses(...body.params); break;
        case 'getTransaction': result = f.rpcReceipt(body.params[0]); break;
        case 'getAccountInfo': {
          if (body.params[0] === f.input.tokenMint) launchTokenReads++;
          result = { context: { slot: f.state.slot }, value: account(await f.connection.getAccountInfo(new PublicKey(body.params[0]))) }; break;
        }
        default: throw new Error(`Unexpected Fee Key recovery RPC method ${body.method}`);
      }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
    } catch (error) { errors.push(error); res.writeHead(500); res.end(error.message); }
  });
  rpc.listen(0, '127.0.0.1'); await once(rpc, 'listening');
  const url = `http://127.0.0.1:${rpc.address().port}`;
  fs.writeFileSync(path.join(f.profile, 'rpcConfig.json'), JSON.stringify({ active: url, activeNetwork: 'devnet', saved: [{ name: 'Local fixture', url, network: 'devnet' }] }));
  fs.writeFileSync(path.join(f.profile, 'userPrefs.json'), JSON.stringify({ demoMode: false }));
  fs.writeFileSync(path.join(f.profile, 'pendingWallets.json'), JSON.stringify([{ publicKey: walletPublicKey, secretKeyEnc: 'plain:' + JSON.stringify(f.input.tempWalletSecretKey), createdAt: new Date().toISOString() }]));
  t.after(async () => {
    release();
    if (runtime) { try { process.kill(runtime.identity.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    rpc.closeAllConnections(); await new Promise((resolve) => rpc.close(resolve));
  });
  runtime = await ensureRuntime(f.profile, { args: [new URL('../server.js', import.meta.url).pathname] });
  const resumed = runtime.request('/api/launch-journals/resume', { method: 'POST', body: { id: journalId } }).catch((error) => error);
  await Promise.race([entered, resumed.then((result) => { throw new Error(`Recovery stopped before checking the saved signature: ${result.message}`); })]);
  for (const [endpoint, body] of [
    ['/api/launch-journals/resume', { id: journalId }],
    ['/api/create-token', { tempWalletSecretKey: f.input.tempWalletSecretKey, name: 'Pending Test', symbol: 'PEND', description: 'Recovery test', totalSupply: '1000' }],
  ]) await assert.rejects(runtime.request(endpoint, { method: 'POST', body }), (error) => {
    assert.equal(error.statusCode, 409);
    assert.equal(error.code, endpoint.includes('journals') ? 'OP_IN_FLIGHT' : 'EXECUTION_RECOVERY_REQUIRED');
    return true;
  });
  release();
  const ended = await resumed;
  assert.ok(ended.statusCode >= 400, 'The isolated fixture ends at the next token check');
  assert.ok(launchTokenReads > 0, 'The saved Fee Key completes before the next token check');
  const db = openRuntimeStore(f.profile);
  try {
    assert.equal(db.getOperation(operation.id).state, 'confirmed');
    const saved = db.collection('journals').load().find((journal) => journal.id === journalId);
    const position = saved.lp.partialResults[0].mainPositions[0];
    assert.equal(position.transferredTo, sweepDestination);
    assert.equal(position.txIds.transfer, f.state.sends[0].signature);
    assert.ok(saved.lp.operationIds.includes(operation.id));
  } finally { db.close(); }
  assert.deepEqual(errors, []); assert.equal(f.state.sends.length, 1);
  await runtime.request('/api/runtime/stop', { method: 'POST' });
});


test('an altered first Fee Key request preserves the saved plan for a valid retry', async (t) => {
  const f = fixture(t);
  await assert.rejects(f.feeKeyExecution.forLaunch({ ...f.input, targetMarketCapUsd: 20000 })(feeKeyRequest), { code: 'EXECUTION_RECOVERY_REQUIRED' });
  assert.equal(f.state.sends.length, 0);
  assert.equal(await f.transfer(), f.state.sends[0].signature);
});


for (const field of ['positionId', 'poolId', 'lockNftMint', 'lockOwner']) {
  test(`Fee Key preparation verifies the finalized lock ${field}`, async (t) => {
    const f = fixture(t); f.lockFields[field] = Keypair.generate().publicKey;
    await assert.rejects(f.transfer(), { code: 'EXECUTION_RECOVERY_REQUIRED' });
    assert.equal(f.state.sends.length, 0);
  });
}
