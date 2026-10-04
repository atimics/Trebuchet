import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SystemInstruction, SystemProgram } from '@solana/web3.js';
import { acquireProfileOwner } from '../src/owner.js';
import { openRuntimeStore, RecoveryStorageError } from '../src/store.js';
import { createSolanaSigner, SOLANA_GENESIS_HASHES } from '../src/solana.js';
import { createSolSweepService } from '../src/sol-sweep.js';
import { solSweepChain, sweepWallet, sweepDestination } from './fixtures/sol-sweep-chain.mjs';

function fixture(t, changes = {}) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'trebuchet-sol-sweep-'));
  const owner = acquireProfileOwner(profile), store = openRuntimeStore(profile);
  t.after(() => { store.close(); owner.release(); fs.rmSync(profile, { recursive: true, force: true }); });
  const { connection, state } = solSweepChain();
  const walletPublicKey = sweepWallet.publicKey.toBase58();
  const approval = { id: 'request-a', walletPublicKey, destinationWallet: sweepDestination, network: 'devnet', genesisHash: SOLANA_GENESIS_HASHES.devnet, expiresAtMs: Date.now() + 60_000, maxSpendLamports: state.balance };
  const options = { owner, store, connection, network: 'devnet', expectedGenesisHash: SOLANA_GENESIS_HASHES.devnet,
    signer: createSolanaSigner({ getSigners: async () => [sweepWallet] }), authorize: async () => true,
    feePolicy: async () => ({ reserveLamports: 890880, feeCeilingLamports: 16000, microLamports: 50000, computeUnitLimit: 20000 }), timeoutMs: 0, ...changes };
  const input = { scopeId: 'journal-a', walletPublicKey, destinationWallet: sweepDestination, approval };
  const service = () => createSolSweepService(options);
  return { profile, owner, store, state, connection, input, options, service, active: () => store.getActiveOperation(walletPublicKey) };
}

test('a live SOL sweep saves approval and signed bytes before send and verifies final balance changes', async (t) => {
  const f = fixture(t);
  f.state.beforeSend = (tx) => {
    const op = f.active();
    assert.equal(f.store.getTransactions(op.id)[0].wire, tx.wire);
    assert.equal(f.store.getTransactions(op.id)[0].state, 'signed');
    const approval = f.store.getOperationApprovals(op.id)[0];
    assert.equal(approval.requestId, 'request-a');
    assert.equal(approval.maxSpendLamports, 10_000_000);
  };
  const result = await f.service().sweep(f.input);
  assert.equal(result.solTransferred, 0.00909312);
  assert.equal(result.txId, f.state.sends[0].signature);
  assert.equal(f.store.getOperation(result.operationId).state, 'confirmed');
  assert.equal(f.store.getOperation(result.operationId).evidence.chain.feeLamports, 6000);
  assert.equal(f.state.balance, 900880);
  assert.equal(f.active(), null);
  assert.deepEqual(await f.service().sweep(f.input), result);
  assert.equal(f.state.sends.length, 1);
});

test('a lost send response recovers the finalized transfer using its saved identity', async (t) => {
  const f = fixture(t);
  f.state.afterSend = () => { throw new Error('Connection closed after acceptance'); };
  await assert.rejects(f.service().sweep(f.input), /Connection closed/);
  const saved = f.active();
  assert.equal(saved.state, 'recovery_required');
  f.state.afterSend = null;
  // The completed on-chain transfer can be adopted after the approval expires.
  f.input.approval.expiresAtMs = 1;
  const result = await f.service().recover(f.input);
  assert.equal(result.operationId, saved.id);
  assert.equal(result.txId, f.state.sends[0].signature);
  assert.equal(f.state.sends.length, 1);
});

test('an uncertain receipt preserves the active operation and original destination', async (t) => {
  const f = fixture(t);
  f.state.status = 'confirmed';
  await assert.rejects(f.service().sweep(f.input), { code: 'CHAIN_STATE_UNAVAILABLE' });
  const op = f.active();
  await assert.rejects(f.service().sweep({ ...f.input, destinationWallet: SystemProgram.programId.toBase58() }), { code: 'INVALID_INPUT' });
  await assert.rejects(f.service().recover({ ...f.input, destinationWallet: sweepWallet.publicKey.toBase58() }), { code: 'OPERATION_IN_FLIGHT' });
  f.state.status = 'finalized';
  const result = await f.service().recover(f.input);
  assert.equal(result.operationId, op.id);
  assert.equal(f.state.sends.length, 1);
});

test('approval bindings and the expected network are checked before preparation', async (t) => {
  for (const change of [{ id: '' }, { walletPublicKey: sweepDestination }, { destinationWallet: sweepWallet.publicKey.toBase58() }, { network: 'mainnet' }, { genesisHash: 'other' }, { expiresAtMs: 1 }, { maxSpendLamports: 1000 }]) {
    const f = fixture(t);
    await assert.rejects(f.service().sweep({ ...f.input, approval: { ...f.input.approval, ...change } }), { code: 'EXECUTION_APPROVAL_REQUIRED' });
    assert.equal(f.active(), null);
    assert.equal(f.state.sends.length, 0);
  }
  const f = fixture(t);
  f.state.genesisHash = SOLANA_GENESIS_HASHES.mainnet;
  await assert.rejects(f.service().sweep(f.input), { code: 'NETWORK_MISMATCH' });
  assert.equal(f.active(), null);
});

test('the fee ceiling and exact signed message constrain the signer', async (t) => {
  const f = fixture(t);
  f.state.fee = 20000;
  await assert.rejects(f.service().sweep(f.input), { code: 'SPEND_LIMIT_EXCEEDED' });
  assert.equal(f.state.sends.length, 0);
  const changed = fixture(t);
  const realSigner = changed.options.signer;
  changed.options.signer = { async signTransaction(context) {
    const instruction = SystemInstruction.decodeTransfer(context.transaction.instructions[2]);
    context.transaction.instructions[2] = SystemProgram.transfer({ ...instruction, lamports: 1 });
    return realSigner.signTransaction(context);
  } };
  await assert.rejects(changed.service().sweep(changed.input), { code: 'TRANSACTION_INVALID' });
  assert.equal(changed.state.sends.length, 0);
  assert.equal(changed.store.getTransactions(changed.active().id).length, 0);
});

test('durable approval and signed-byte failures stop before broadcast', async (t) => {
  for (const method of ['recordOperationApproval', 'recordSignedTransaction']) {
    const f = fixture(t);
    f.store[method] = () => { throw new RecoveryStorageError('Injected storage failure'); };
    await assert.rejects(f.service().sweep(f.input), { code: 'RECOVERY_STORAGE_UNAVAILABLE' });
    assert.equal(f.state.sends.length, 0);
    if (method === 'recordOperationApproval') assert.equal(f.active(), null);
  }
});

test('a receipt write failure recovers the one transfer already accepted by the chain', async (t) => {
  const f = fixture(t);
  const recordReceipt = f.store.recordReceipt;
  f.store.recordReceipt = () => { throw new RecoveryStorageError('Receipt commit interrupted'); };
  await assert.rejects(f.service().sweep(f.input), { code: 'RECOVERY_STORAGE_UNAVAILABLE' });
  const op = f.active();
  assert.equal(f.store.getTransactions(op.id)[0].state, 'signed');
  f.store.recordReceipt = recordReceipt;
  const result = await f.service().recover(f.input);
  assert.equal(result.operationId, op.id);
  assert.equal(f.state.sends.length, 1);
});

test('finalized receipt evidence requires the exact amount, fee, slot, and message', async (t) => {
  const changes = [
    (r) => ({ ...r, slot: r.slot - 1 }),
    (r) => ({ ...r, meta: { ...r.meta, fee: r.meta.fee + 1 } }),
    (r) => ({ ...r, meta: { ...r.meta, postBalances: r.meta.postBalances.map((n, i) => i === 1 ? n + 1 : n) } }),
    (r) => ({ ...r, transaction: { ...r.transaction, signatures: ['other'] } }),
    () => null,
  ];
  for (const transform of changes) {
    const f = fixture(t);
    f.state.receiptTransform = transform;
    await assert.rejects(f.service().sweep(f.input), { code: 'CHAIN_STATE_UNAVAILABLE' });
    const op = f.active();
    assert.equal(op.state, 'recovery_required');
    f.state.receiptTransform = (r) => r;
    assert.equal((await f.service().recover(f.input)).operationId, op.id);
    assert.equal(f.state.sends.length, 1);
  }
});

test('competing clients share wallet admission through the profile owner', async (t) => {
  const f = fixture(t);
  let arrived, release;
  const started = new Promise((resolve) => { arrived = resolve; });
  const waiting = new Promise((resolve) => { release = resolve; });
  f.state.beforeSend = async () => { arrived(); await waiting; };
  const first = f.service().sweep(f.input);
  await started;
  try { await assert.rejects(f.service().recover(f.input), { code: 'OPERATION_IN_FLIGHT' }); }
  finally { release(); }
  await first;
  assert.equal(f.state.sends.length, 1);
});

test('saved bytes need a current approval before rebroadcast and retain their signature', async (t) => {
  const f = fixture(t);
  f.state.beforeSend = () => { throw new Error('Transport closed before acceptance'); };
  await assert.rejects(f.service().sweep(f.input), /Transport closed/);
  const op = f.active(), saved = f.store.getTransactions(op.id)[0];
  f.state.beforeSend = null;
  f.input.approval = { ...f.input.approval, id: 'expired-request', expiresAtMs: 1 };
  await assert.rejects(f.service().recover(f.input), { code: 'EXECUTION_APPROVAL_REQUIRED' });
  assert.equal(f.state.sends.length, 0);
  f.input.approval = { ...f.input.approval, id: 'renewed-request', expiresAtMs: Date.now() + 60_000 };
  f.options.signer = { signTransaction: async () => { assert.fail('Recovery should reuse the saved signed bytes'); } };
  const result = await f.service().recover(f.input);
  assert.equal(result.txId, saved.signature);
  assert.equal(f.state.sends[0].wire, saved.wire);
  assert.equal(f.store.getOperationApprovals(op.id).length, 2);
});

test('approval expiry during the final fee read stops sending the saved transaction', async (t) => {
  let now = 100, reads = 0;
  const f = fixture(t, { now: () => now });
  f.input.approval.expiresAtMs = 200;
  f.connection.getFeeForMessage = async () => {
    if (++reads === 3) now = 200;
    return { context: { slot: 200 }, value: 6000 };
  };
  await assert.rejects(f.service().sweep(f.input), { code: 'EXECUTION_APPROVAL_REQUIRED' });
  assert.equal(f.store.getTransactions(f.active().id).length, 1);
  assert.equal(f.state.sends.length, 0);
});

test('the final RPC network check preserves approval expiry and owner boundaries', async (t) => {
  for (const change of ['approval', 'owner']) {
    const f = fixture(t);
    f.connection.getGenesisHash = async () => {
      if (f.active()?.state === 'submitted') {
        if (change === 'approval') f.input.approval.expiresAtMs = 1;
        else f.owner.release();
      }
      return SOLANA_GENESIS_HASHES.devnet;
    };
    await assert.rejects(f.service().sweep(f.input), { code: change === 'approval' ? 'EXECUTION_APPROVAL_REQUIRED' : 'RUNTIME_OWNER_RELEASED' });
    assert.equal(f.state.sends.length, 0);
  }
});

test('with nothing reserved the sweep sends everything but the exact fee and leaves the wallet at zero', async (t) => {
  const f = fixture(t, { feePolicy: async () => ({ reserveLamports: 0, feeCeilingLamports: 16000, microLamports: 50000, computeUnitLimit: 20000 }) });
  const result = await f.service().sweep(f.input);
  assert.equal(result.solTransferred, (10_000_000 - 6000) / 1e9);
  assert.equal(f.state.balance, 0);
  const operation = f.store.getOperation(result.operationId);
  assert.equal(operation.payload.feeCeilingLamports, 6000, 'the quoted fee is the limit');
  assert.equal(operation.payload.reserveLamports, 0);
  assert.equal(operation.evidence.chain.feeLamports, 6000);
});

test('a quoted fee above the saved limit stops a draining sweep before anything is signed', async (t) => {
  const f = fixture(t, { feePolicy: async () => ({ reserveLamports: 0, feeCeilingLamports: 5000, microLamports: 50000, computeUnitLimit: 20000 }) });
  await assert.rejects(f.service().sweep(f.input), { code: 'SPEND_LIMIT_EXCEEDED' });
  assert.equal(f.state.sends.length, 0); assert.equal(f.active(), null);
});
