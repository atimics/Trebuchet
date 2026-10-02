import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Keypair, SystemProgram, Transaction } from '@solana/web3.js';
import { ExecutionEngine } from '../src/engine.js';
import { createSolanaSigner, inspectSolanaTransaction } from '../src/solana.js';
import { openRuntimeStore, RecoveryStorageError } from '../src/store.js';
import { acquireProfileOwner } from '../src/owner.js';

const wallet = Keypair.fromSeed(new Uint8Array(32).fill(7));
const recipient = Keypair.fromSeed(new Uint8Array(32).fill(8)).publicKey;
function fixture(t) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'trebuchet-engine-'));
  const state = { builds: 0, signs: 0, sends: [], complete: false, status: 'confirmed', approved: true };
  const launch = { id: 'launch', walletPublicKey: wallet.publicKey.toBase58(), network: 'localnet', planDigest: 'a'.repeat(64), config: { recipient: recipient.toBase58() } };
  let owner, store, engine;
  const backend = createSolanaSigner({ getSigners: async () => { state.signs++; return [wallet]; } });
  const operations = { 'liquidity-position': {
    checkState: async ({ minContextSlot }) => ({ state: state.complete ? 'complete' : 'ready', evidence: { pool: 'pool-a', position: recipient.toBase58(), slot: Math.max(minContextSlot, 50) } }),
    buildTransaction: async () => {
      const blockhash = Keypair.fromSeed(new Uint8Array(32).fill(++state.builds)).publicKey.toBase58();
      return { blockhash, lastValidBlockHeight: 100, transaction: new Transaction({ feePayer: wallet.publicKey, recentBlockhash: blockhash }).add(SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: recipient, lamports: 3 })) };
    },
  } };
  const chain = {
    network: 'localnet', inspectTransaction: inspectSolanaTransaction,
    readTransaction: async () => {
      if (state.readError) throw state.readError;
      return { state: state.status, evidence: { slot: 50, commitment: 'finalized' } };
    },
    sendTransaction: async (tx) => {
      assert.equal(store.getTransactions(tx.operationId).find((entry) => entry.signature === tx.signature).wire, tx.wire);
      assert.equal(store.getOperation(tx.operationId).state, 'submitted');
      state.sends.push(tx.wire);
      if (state.status === 'confirmed') state.complete = true;
      if (state.sendError) throw state.sendError;
      return tx.signature;
    },
  };
  const open = () => {
    owner = acquireProfileOwner(profile);
    store = openRuntimeStore(profile);
    engine = new ExecutionEngine({ owner, store, signer: backend, chain, operations, authorize: async () => state.approved });
    return engine;
  };
  open();
  t.after(() => { owner.release(); store.close(); fs.rmSync(profile, { recursive: true, force: true }); });
  const operation = engine.prepare({ launch, kind: 'liquidity-position', payload: { recipient: recipient.toBase58(), amountLamports: '3' } });
  return {
    state, operation, launch, chain, operations,
    get engine() { return engine; }, get store() { return store; }, get owner() { return owner; },
    restart() { owner.release(); store.close(); return open(); },
  };
}

test('engine saves signed bytes before sending and retains an immutable completed operation', async (t) => {
  const f = fixture(t);
  const status = await f.engine.executeNext(f.operation.id);
  assert.equal(status.operation.state, 'confirmed');
  assert.equal(status.transactions[0].state, 'confirmed');
  assert.equal(Object.hasOwn(status.transactions[0], 'wire'), false);
  assert.equal(f.state.sends.length, 1);
  await f.restart().resume(f.operation.id);
  assert.equal(f.state.sends.length, 1);
  assert.equal(f.state.builds, 1);
  assert.throws(() => f.engine.prepare({ launch: f.launch, kind: 'liquidity-position', payload: { amountLamports: '9' } }), { code: 'OPERATION_CONFLICT' });
});

test('restart adopts a landed position after submission throws before a receipt', async (t) => {
  const f = fixture(t);
  f.state.sendError = new Error('Connection closed after broadcast');
  await assert.rejects(f.engine.executeNext(f.operation.id), /after broadcast/);
  assert.equal(f.store.getTransactions(f.operation.id)[0].state, 'signed');
  assert.equal(f.store.getOperation(f.operation.id).state, 'recovery_required');
  f.state.sendError = null;
  const status = await f.restart().resume(f.operation.id);
  assert.equal(status.operation.state, 'confirmed');
  assert.equal(f.state.sends.length, 1);
  assert.equal(f.state.signs, 1);
});

test('uncertain chain state retains wallet ownership across a restart', async (t) => {
  const f = fixture(t);
  f.state.status = 'pending';
  await f.engine.executeNext(f.operation.id);
  f.state.readError = new Error('RPC is unavailable');
  await assert.rejects(f.restart().resume(f.operation.id), /RPC is unavailable/);
  assert.throws(() => f.engine.prepare({ launch: f.launch, kind: 'liquidity-position', index: 1 }), { code: 'OPERATION_IN_FLIGHT' });
  assert.equal(f.state.sends.length, 1);
  assert.equal(f.state.builds, 1);
});

test('recovery rechecks approval and resends the exact saved bytes', async (t) => {
  const f = fixture(t);
  f.state.status = 'rebroadcast';
  await f.engine.executeNext(f.operation.id);
  f.state.approved = false;
  await assert.rejects(f.restart().resume(f.operation.id), { code: 'EXECUTION_APPROVAL_REQUIRED' });
  assert.equal(f.state.sends.length, 1);
  f.state.approved = true;
  await f.engine.resume(f.operation.id);
  assert.equal(f.state.sends.length, 2);
  assert.equal(f.state.sends[0], f.state.sends[1]);
  assert.equal(f.state.builds, 1);
  assert.equal(f.state.signs, 1);
});

test('replacement signing follows proven expiry and a fresh operation state check', async (t) => {
  const f = fixture(t);
  f.state.status = 'pending';
  await f.engine.executeNext(f.operation.id);
  const read = f.chain.readTransaction;
  f.chain.readTransaction = async (...args) => {
    if (f.state.builds === 1) return { state: 'expired', evidence: { slot: 100, finalizedBlockHeight: 101, blockhashValid: false } };
    return read(...args);
  };
  f.state.status = 'confirmed';
  const status = await f.restart().resume(f.operation.id);
  assert.equal(status.operation.state, 'confirmed');
  assert.deepEqual(status.transactions.map((tx) => tx.state), ['expired', 'confirmed']);
  assert.equal(f.state.builds, 2);
  assert.notEqual(f.state.sends[0], f.state.sends[1]);
});

test('a finalized chain failure stays terminal across retries', async (t) => {
  const f = fixture(t);
  f.state.status = 'failed';
  assert.equal((await f.engine.executeNext(f.operation.id)).operation.state, 'failed');
  assert.equal((await f.restart().resume(f.operation.id)).operation.state, 'failed');
  assert.equal(f.state.sends.length, 1);
});

test('a confirmed transaction waits for its chain result before freeing the wallet', async (t) => {
  const f = fixture(t);
  f.operations['liquidity-position'].checkState = async () => ({ state: 'ready', evidence: { slot: 50 } });
  assert.equal((await f.engine.executeNext(f.operation.id)).operation.state, 'recovery_required');
  await f.restart().resume(f.operation.id);
  assert.equal(f.state.sends.length, 1);
  assert.equal(f.state.builds, 1);
});

test('failed signed-byte storage stops before broadcast', async (t) => {
  const f = fixture(t);
  f.store.recordSignedTransaction = () => { throw new RecoveryStorageError('Disk write failed'); };
  await assert.rejects(f.engine.executeNext(f.operation.id), { code: 'RECOVERY_STORAGE_UNAVAILABLE' });
  assert.equal(f.state.sends.length, 0);
  assert.equal(f.store.getTransactions(f.operation.id).length, 0);
});

test('failed receipt storage recovers the signed transaction after restart', async (t) => {
  const f = fixture(t);
  f.store.recordReceipt = () => { throw new RecoveryStorageError('Disk write failed'); };
  await assert.rejects(f.engine.executeNext(f.operation.id), { code: 'RECOVERY_STORAGE_UNAVAILABLE' });
  assert.equal(f.state.sends.length, 1);
  assert.equal(f.store.getTransactions(f.operation.id)[0].state, 'signed');
  assert.equal((await f.restart().resume(f.operation.id)).operation.state, 'confirmed');
  assert.equal(f.state.sends.length, 1);
});

test('a second engine sharing the owner waits for the wallet request', async (t) => {
  const f = fixture(t);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  f.operations['liquidity-position'].checkState = async () => { await gate; return { state: 'complete', evidence: { slot: 1 } }; };
  const first = f.engine.executeNext(f.operation.id);
  const second = new ExecutionEngine({ store: f.store, owner: f.owner, signer: f.engine.signer, chain: f.chain, operations: f.operations, authorize: async () => true });
  await assert.rejects(second.executeNext(f.operation.id), { code: 'OPERATION_IN_FLIGHT' });
  release();
  await first;
  assert.equal(f.state.sends.length, 0);
});

test('owner release while a signer is busy pauses the operation', async (t) => {
  const f = fixture(t);
  const sign = f.engine.signer.signTransaction;
  f.engine.signer.signTransaction = async (context) => { const signed = await sign(context); f.owner.release(); return signed; };
  await assert.rejects(f.engine.executeNext(f.operation.id), { code: 'RUNTIME_OWNER_RELEASED' });
  assert.equal(f.state.sends.length, 0);
});

test('transaction storage requires resolution of prior signed bytes', async (t) => {
  const f = fixture(t);
  f.state.status = 'pending';
  await f.engine.executeNext(f.operation.id);
  const stored = f.store.getTransactions(f.operation.id)[0];
  assert.throws(() => f.store.recordSignedTransaction({ ...stored, signature: 'replacement' }), { code: 'OPERATION_IN_FLIGHT' });
});
