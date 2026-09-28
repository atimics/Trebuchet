import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Keypair } from '@solana/web3.js';
import { acquireProfileOwner } from '../packages/runtime/src/owner.js';
import { openRuntimeStore } from '../packages/runtime/src/store.js';
import { createProfileJournalStore } from '../packages/runtime/src/profile-stores.js';
import { createLiquidityExecutionRuntime, deriveLiquidityAccount } from '../liquidityExecution.js';
import { liquidityChain, sweepWallet, plan, actionFor, actionKey } from './fixtures/liquidity-chain.mjs';

const walletPublicKey = sweepWallet.publicKey.toBase58();
const input = { ...plan, tempWalletSecretKey: Array.from(sweepWallet.secretKey) };
function fixture(t, mode = 'position', options = {}) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'trebuchet-liquidity-'));
  const owner = acquireProfileOwner(profile), journal = createProfileJournalStore(profile);
  const scope = journal.start({ walletPublicKey });
  const ledger = liquidityChain({ mode });
  const events = [];
  const runtime = createLiquidityExecutionRuntime({ owner, getScopeId: (wallet) => journal.activeForWallet(wallet)?.id,
    recordProgress: (_wallet, event) => { journal.recordEvent(walletPublicKey, event); events.push(event); },
    networkForRequest: () => 'mainnet', createConnection: () => ledger.connection, timeoutMs: 0, ...options });
  t.after(() => { owner.release(); fs.rmSync(profile, { recursive: true, force: true }); });
  const execute = (extra = {}) => runtime.forLaunch(input).execute({ key: actionKey(mode), action: actionFor(mode), build: ledger.build, ...extra });
  return { profile, owner, scope, journal, events, runtime, execute, ...ledger };
}

for (const mode of ['pool', 'position', 'position22', 'lock']) {
  test(`the ${mode} SDK action saves its account identity and finalized receipt`, async (t) => {
    const f = fixture(t, mode);
    f.state.beforeSend = (transaction) => {
      const store = openRuntimeStore(f.profile);
      try {
        const op = store.getActiveOperation(walletPublicKey);
        assert.equal(op.kind, 'liquidity-transaction');
        assert.equal(store.getTransactions(op.id)[0].wire, transaction.wire);
        assert.equal(store.getOperationApprovals(op.id)[0].source, 'local-liquidity-request');
      } finally { store.close(); }
    };
    const result = await f.execute();
    assert.equal(result.value.tx.txId, f.state.sends[0].signature);
    assert.equal(f.events.at(-1).operationId, result.value.saved.operationId);
    assert.equal(f.journal.activeForWallet(walletPublicKey).events.at(-1).operationId, result.value.saved.operationId);
    assert.equal(result.value.saved.spentLamports, 10_010_000);
    if (mode !== 'pool') assert.equal(result.value.saved.nftMint, deriveLiquidityAccount(sweepWallet, f.scope.id, actionKey(mode)).publicKey.toBase58());
    const second = await f.execute({ build: () => { throw new Error('The saved SDK action should be reused'); } });
    assert.deepEqual(second.value.saved, result.value.saved);
    assert.equal(f.state.sends.length, 1);
    assert.equal(f.state.builds, 1);
  });
}

test('a lost SDK reply recovers the exact position receipt and journal event', async (t) => {
  const f = fixture(t);
  f.state.afterSend = () => { throw new Error('response lost'); };
  await assert.rejects(f.execute(), { code: 'EXECUTION_RECOVERY_REQUIRED' });
  f.state.afterSend = null;
  const result = await f.runtime.recover(input);
  assert.equal(result.txId, f.state.sends[0].signature);
  assert.equal(f.events.at(-1).nftMint, result.nftMint);
  assert.equal(f.state.sends.length, 1);
  assert.equal(f.state.builds, 1);
});

test('an expired SDK transaction keeps its prepared message and NFT mint', async (t) => {
  const f = fixture(t);
  f.state.drop = true;
  await assert.rejects(f.execute(), { code: 'EXECUTION_RECOVERY_REQUIRED' });
  f.state.drop = false; f.state.height = 401; f.state.valid = false;
  f.state.blockhash = Keypair.fromSeed(new Uint8Array(32).fill(90)).publicKey.toBase58();
  const result = await f.runtime.recover(input);
  assert.equal(f.state.sends.length, 2);
  assert.notEqual(f.state.sends[0].signature, f.state.sends[1].signature);
  assert.equal(result.nftMint, deriveLiquidityAccount(sweepWallet, f.scope.id, actionKey('position')).publicKey.toBase58());
  assert.equal(f.state.builds, 1);
});

test('a changed launch plan preserves the saved action and its receipt', async (t) => {
  const f = fixture(t); await f.execute();
  await assert.rejects(f.runtime.forLaunch({ ...input, targetMarketCapUsd: 2000 }).execute({ key: actionKey('position'), action: actionFor('position'), build: f.build }), { code: 'EXECUTION_RECOVERY_REQUIRED' });
  assert.equal(f.state.sends.length, 1);
});

test('an uncertain finalized result holds later wallet actions', async (t) => {
  const f = fixture(t);
  f.state.accountSlot = 199;
  await assert.rejects(f.execute(), { code: 'EXECUTION_RECOVERY_REQUIRED' });
  const store = openRuntimeStore(f.profile);
  try { assert.equal(store.getActiveOperation(walletPublicKey).state, 'recovery_required'); } finally { store.close(); }
  assert.equal(f.events.length, 0);
  f.state.accountSlot = 200;
  await f.runtime.recover(input);
  assert.equal(f.state.sends.length, 1);
});

for (const mode of ['pool', 'position', 'position22', 'lock']) {
  test(`the ${mode} host recovers after process death between chain acceptance and receipt storage`, { timeout: 20_000 }, async (t) => {
    const { default: http } = await import('node:http');
    const { once } = await import('node:events');
    const { spawn } = await import('node:child_process');
    const { PublicKey } = await import('@solana/web3.js');
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'trebuchet-liquidity-crash-'));
    const ledger = liquidityChain({ mode }), children = [], errors = [];
    let running, killed = false;
    const account = (value) => value && ({ ...value, owner: value.owner.toBase58(), data: [value.data.toString('base64'), 'base64'] });
    const server = http.createServer(async (req, res) => {
      try {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks));
        let result;
        switch (body.method) {
          case 'getGenesisHash': result = await ledger.connection.getGenesisHash(); break;
          case 'getBalance': result = await ledger.connection.getBalanceAndContext(); break;
          case 'getLatestBlockhash': result = { context: { slot: ledger.state.slot }, value: await ledger.connection.getLatestBlockhash() }; break;
          case 'getFeeForMessage': result = await ledger.connection.getFeeForMessage(); break;
          case 'getAccountInfo': result = { context: { slot: ledger.state.slot }, value: account(await ledger.connection.getAccountInfo(new PublicKey(body.params[0]))) }; break;
          case 'getMultipleAccounts': result = await ledger.connection.getMultipleAccountsInfoAndContext(body.params[0].map((key) => new PublicKey(key))); result.value = result.value.map(account); break;
          case 'getSignatureStatuses': result = await ledger.connection.getSignatureStatuses(...body.params); break;
          case 'getTransaction': result = ledger.rpcReceipt(body.params[0]); break;
          case 'sendTransaction': {
            result = await ledger.connection.sendRawTransaction(Buffer.from(body.params[0], 'base64'));
            const db = openRuntimeStore(profile);
            try {
              const op = db.getActiveOperation(walletPublicKey);
              assert.equal(db.getTransactions(op.id)[0].wire, body.params[0]);
              assert.equal(db.getOperationApprovals(op.id)[0].source, 'local-liquidity-request');
            } finally { db.close(); }
            assert.equal(killed, false); killed = true; running.kill('SIGKILL');
            break;
          }
          default: throw new Error(`Unexpected fixture RPC method: ${body.method}`);
        }
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
      } catch (error) { errors.push(error); res.writeHead(500); res.end(error.message); }
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(async () => {
      for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
      fs.rmSync(profile, { recursive: true, force: true });
    });
    const run = async () => {
      const child = spawn(process.execPath, [new URL('./fixtures/liquidity-execution-worker.mjs', import.meta.url).pathname, profile, `http://127.0.0.1:${server.address().port}`, mode], { stdio: ['ignore', 'pipe', 'pipe'] });
      children.push(child); running = child;
      let out = '', err = ''; child.stdout.on('data', (chunk) => { out += chunk; }); child.stderr.on('data', (chunk) => { err += chunk; });
      const [code, signal] = await once(child, 'close'); return { code, signal, out, err };
    };
    const first = await run(); assert.equal(first.signal, 'SIGKILL', first.err);
    const second = await run(); assert.equal(second.code, 0, second.err);
    const result = JSON.parse(second.out.split('RESULT:')[1]);
    assert.equal(result.txId, ledger.state.sends[0].signature);
    const third = await run(); assert.equal(third.code, 0, third.err);
    assert.deepEqual(JSON.parse(third.out.split('RESULT:')[1]), result);
    assert.deepEqual(errors, []); assert.equal(ledger.state.sends.length, 1);
    const journal = createProfileJournalStore(profile).activeForWallet(walletPublicKey);
    assert.ok(journal.events.some((event) => event.operationId === result.operationId && event.txId === result.txId));
  });
}

test('all launch liquidity phases use durable SDK submission and stable action keys', { timeout: 15_000 }, async (t) => {
  const { __testHooks: phases } = await import('../lpService.js');
  const { buildLiquiditySdk, poolInfo, poolTokens, poolId } = await import('./fixtures/liquidity-chain.mjs');
  const { PositionInfoLayout, CLMM_PROGRAM_ID } = await import('@raydium-io/raydium-sdk-v2');
  const { default: BN } = await import('bn.js');
  const { default: Decimal } = await import('decimal.js');
  const f = fixture(t, 'pool');
  f.connection.getBalance = async () => f.state.balance;
  f.connection.getParsedTokenAccountsByOwner = async () => ({ value: [] });
  const raydium = { connection: f.connection, account: { fetchWalletTokenAccounts: async () => ({ tokenAccounts: [] }) }, clmm: {
    createPool: () => buildLiquiditySdk('pool', f.connection),
    openPositionFromBase: (args) => buildLiquiditySdk('position', f.connection, { getEphemeralSigners: args.getEphemeralSigners }, args),
    lockPosition: (args) => buildLiquiditySdk('lock', f.connection, { getEphemeralSigners: args.getEphemeralSigners }, args),
    getPoolInfoFromRpc: async () => ({ poolInfo, poolKeys: {} }),
    getRpcClmmPoolInfo: async () => ({ tickCurrent: 0, sqrtPriceX64: new BN(2).pow(new BN(64)) }),
    getOwnerPositionInfo: async () => [...f.state.accounts.values()].filter((entry) => entry.owner.equals(CLMM_PROGRAM_ID) && entry.data.length === PositionInfoLayout.span).map((entry) => PositionInfoLayout.decode(entry.data)),
  } };
  phases.bindLiquidityExecutor(raydium, f.runtime.forLaunch(input));
  const result = await phases.createSinglePool({ raydium, allocationIndex: 0, ownerKeypair: sweepWallet,
    ammConfig: poolInfo.config, launchedToken: poolTokens[0], quoteToken: { ...poolTokens[1], symbol: 'QUOTE' }, initialPrice: new Decimal(1),
    wideBaseRaw: new BN(10_000_000), bootstrapBaseRaw: new BN(1000), bootstrapMode: 'minimal',
    distribution: [{ sharePercent: 50 }, { sharePercent: 50 }], ladderMode: 'manual',
    ladderBands: [{ baseRaw: new BN(1_000_000), lowerMultiplier: 2, upperMultiplier: 3 }],
    supportEnabled: true, supportQuoteRaw: new BN(1000), supportDepthPct: 10,
  });
  result.allocationIndex = 0;
  result.bootstrap = await phases.openBootstrapPosition({ raydium, allocationIndex: 0, ctx: result._bootstrapContext,
    priorNftMints: [...result.mainPositions, ...result.ladderPositions, ...result.supportPositions].map((position) => position.nftMint) });
  const locked = await phases.lockAllPositions({ raydium, results: [result] });
  assert.deepEqual(locked.lockFailures, []);
  assert.equal(result.poolId, poolId);
  assert.equal(result.mainPositions.length, 2); assert.equal(result.ladderPositions.length, 1); assert.equal(result.supportPositions.length, 1);
  const positions = [...result.mainPositions, ...result.ladderPositions, ...result.supportPositions, result.bootstrap];
  assert.ok(positions.every((position) => position.locked && position.feeKeyNftMint && position.txIds.open && position.txIds.lock));
  assert.equal(f.state.sends.length, 11);
  const db = openRuntimeStore(f.profile);
  try {
    const operations = db.listWalletOperations(walletPublicKey);
    assert.equal(operations.length, 11); assert.ok(operations.every((op) => op.state === 'confirmed'));
    assert.equal(new Set(operations.map((op) => op.payload.key)).size, 11);
  } finally { db.close(); }
});

test('a completed liquidity receipt survives a failed final journal checkpoint', async (t) => {
  let failed = true;
  const f = fixture(t, 'position', { recordProgress: () => {
    if (failed) throw Object.assign(new Error('fixture journal commit failed'), { code: 'RECOVERY_STORAGE_UNAVAILABLE' });
  } });
  await assert.rejects(f.execute(), { code: 'RECOVERY_STORAGE_UNAVAILABLE' });
  const db = openRuntimeStore(f.profile);
  try { assert.equal(db.listWalletOperations(walletPublicKey)[0].state, 'confirmed'); } finally { db.close(); }
  failed = false;
  await f.runtime.recover(input);
  const repeated = await f.execute({ build: () => { throw new Error('Use the confirmed SDK action'); } });
  assert.equal(repeated.value.tx.txId, f.state.sends[0].signature);
  assert.equal(f.state.sends.length, 1);
});
