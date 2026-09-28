import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import { tokenTransferChain } from '../packages/runtime/test/fixtures/token-transfer-chain.mjs';
import * as walletHelpers from '../walletHelpers.js';
import { metadataChain, metadataMint, metadataRevealFields } from '../packages/runtime/test/fixtures/metadata-chain.mjs';
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

for (const mode of ['SOL', 'token', 'nft', 'metadata-handoff', 'metadata-reveal']) {
test(`the production ${mode} adapter recovers after its process dies between chain acceptance and receipt storage`, { timeout: 20_000 }, async (t) => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'trebuchet-wallet-crash-'));
  const ledger = mode === 'SOL' ? solSweepChain() : mode.startsWith('metadata-') ? metadataChain({ inline: mode === 'metadata-reveal' }) : tokenTransferChain(mode === 'nft' ? { token2022: true, decimals: 0, sourceAmount: 1n } : {});
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
        case 'getMinimumBalanceForRentExemption': result = await ledger.connection.getMinimumBalanceForRentExemption(...body.params); break;
        case 'getMultipleAccounts': {
          result = await ledger.connection.getMultipleAccountsInfoAndContext(body.params[0].map((key) => new PublicKey(key)), body.params[1]);
          result.value = result.value.map((account) => account && ({ ...account, owner: account.owner.toBase58(), data: [account.data.toString('base64'), 'base64'] }));
          break;
        }
        case 'getTokenAccountsByOwner': {
          result = await ledger.connection.getParsedTokenAccountsByOwner(new PublicKey(body.params[0]), { programId: new PublicKey(body.params[1].programId) });
          result = { context: { slot: ledger.state.slot }, value: result.value.map((entry) => ({ pubkey: entry.pubkey.toBase58(), account: {
            ...entry.account, owner: body.params[1].programId, lamports: ledger.state.sourceLamports, rentEpoch: 0, executable: false,
          } })) };
          break;
        }
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
    const child = spawn(process.execPath, [new URL('./fixtures/wallet-execution-worker.mjs', import.meta.url).pathname, profile, `http://127.0.0.1:${server.address().port}`, mode], {
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
  if (mode === 'SOL') assert.equal(ledger.state.balance, 900880);
  else if (mode.startsWith('metadata-')) assert.equal(ledger.state.authority, mode === 'metadata-reveal' ? SystemProgram.programId.toBase58() : sweepDestination);
  else assert.equal(ledger.state.sourceAmount, 0n);
  const second = run();
  const [secondExit] = await once(second.child, 'close');
  assert.equal(secondExit, 0, second.output().err);
  assert.deepEqual(rpcErrors, []);
  const recovered = JSON.parse(second.output().out.split('RESULT:')[1]);
  assert.equal(recovered.txId, ledger.state.sends[0].signature);
  if (mode === 'SOL') assert.equal(recovered.solTransferred, 0.00909312);
  else {
    if (mode.startsWith('metadata-')) assert.equal(recovered.newAuthority, ledger.state.authority);
    else assert.equal(recovered.amountRaw, mode === 'nft' ? '1' : '5000000');
    const third = run();
    assert.equal((await once(third.child, 'close'))[0], 0, third.output().err);
    assert.deepEqual(JSON.parse(third.output().out.split('RESULT:')[1]), recovered);
  }
  assert.equal(ledger.state.sends.length, 1);
  const store = openRuntimeStore(profile);
  try {
    assert.equal(store.getOperation(recovered.operationId).state, 'confirmed');
    assert.equal(store.getTransactions(recovered.operationId).length, 1);
  } finally { store.close(); }
});


}

for (const [label, config, helper] of [
  ['classic token', {}, 'sweepAllTokensToDestination'],
  ['Token-2022 fee token', { token2022: true, transferFee: true }, 'sweepAllTokensToDestination'],
  ['Fee Key NFT', { token2022: true, decimals: 0, sourceAmount: 1n }, 'sweepNftsToDestination'],
]) {
  test(`the production ${label} sweep uses the engine and retains receipts after completion`, async (t) => {
    const ledger = tokenTransferChain(config);
    let scope = 'journal-a', network = 'devnet';
    const f = fixture(t, { getScopeId: () => scope, networkForRequest: () => network, createConnection: () => ledger.connection });
    walletHelpers.setConnectionFactoryForTests(() => ledger.connection);
    t.after(() => walletHelpers.resetConnectionFactoryForTests());
    const result = await walletHelpers[helper]({ ...input, transferToken: f.runtime.transferTokenWithProgram });
    assert.equal(result.transferred.length, 1);
    assert.deepEqual(result.errors, []);
    assert.equal(ledger.state.sends.length, 1);
    assert.equal(await f.runtime.recover(input), null);
    const receipts = f.runtime.getTransferReceipts(walletPublicKey);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].txId, result.transferred[0].txId);
    assert.equal(receipts[0].decimals, config.decimals ?? 6);
    assert.equal(receipts[0].sourceTokenAccount, ledger.source.toBase58());
    assert.equal(receipts[0].receivedRaw, config.transferFee ? '4995000' : config.sourceAmount?.toString() || '5000000');
    const second = await walletHelpers[helper]({ ...input, transferToken: f.runtime.transferTokenWithProgram });
    assert.deepEqual(second.transferred, []);
    assert.deepEqual(f.runtime.getTransferReceipts(walletPublicKey), receipts);
    scope = 'journal-b';
    assert.deepEqual(f.runtime.getTransferReceipts(walletPublicKey), []);
    scope = 'journal-a'; network = 'mainnet';
    assert.deepEqual(f.runtime.getTransferReceipts(walletPublicKey), []);
    network = 'devnet';
    assert.deepEqual(f.runtime.getTransferReceipts(sweepDestination), []);
    assert.deepEqual(f.runtime.getTransferReceipts(walletPublicKey), receipts);
  });
}


test('metadata recovery accepts the saved reveal before other liquidity work', async (t) => {
  const ledger = metadataChain({ inline: true });
  const f = fixture(t, { createConnection: () => ledger.connection });
  const update = { tempWalletSecretKey: input.tempWalletSecretKey, tokenMint: metadataMint.toBase58(), newAuthority: SystemProgram.programId.toBase58(), fields: metadataRevealFields, makeImmutable: true };
  ledger.state.afterSend = () => { throw new Error('Response lost'); };
  await assert.rejects(f.runtime.updateMetadata(update), { code: 'EXECUTION_RECOVERY_REQUIRED' });
  assert.throws(() => f.runtime.recoverMetadataReveal({ ...update, name: 'Changed' }), { code: 'EXECUTION_RECOVERY_REQUIRED' });
  assert.throws(() => f.runtime.recoverMetadataReveal({ ...update, tokenMint: sweepDestination }), { code: 'EXECUTION_RECOVERY_REQUIRED' });
  ledger.state.afterSend = null;
  const result = await f.runtime.recoverMetadataReveal({ ...update, name: metadataRevealFields.name, symbol: metadataRevealFields.symbol, metadataUri: metadataRevealFields.uri });
  assert.equal(result.txId, ledger.state.sends[0].signature);
  assert.equal(f.runtime.active(walletPublicKey), null);
  assert.equal(ledger.state.sends.length, 1);
});
