import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import bs58 from 'bs58';
import { ComputeBudgetProgram, SendTransactionError, PublicKey, SystemProgram, Transaction, VersionedTransaction, AddressLookupTableAccount, TransactionMessage } from '@solana/web3.js';
import { acquireProfileOwner } from '../src/owner.js';
import { openRuntimeStore, publicJson, RecoveryStorageError } from '../src/store.js';
import { createSolanaSigner, SOLANA_GENESIS_HASHES } from '../src/solana.js';
import { createPreparedTransactionService } from '../src/prepared-transaction.js';
import { solSweepChain, sweepWallet, sweepDestination } from './fixtures/sol-sweep-chain.mjs';

function fixture(t, options = {}) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'trebuchet-prepared-'));
  const owner = acquireProfileOwner(profile), store = openRuntimeStore(profile), ledger = solSweepChain();
  t.after(() => { store.close(); owner.release(); fs.rmSync(profile, { recursive: true, force: true }); });
  let builds = 0, now = 1000;
  const plan = { action: 'fixture-transfer' };
  const approval = { id: 'approval-1', walletPublicKey: sweepWallet.publicKey.toBase58(), network: 'devnet', genesisHash: SOLANA_GENESIS_HASHES.devnet,
    scopeId: 'journal-a', planDigest: createHash('sha256').update(publicJson(plan)).digest('hex'), expiresAtMs: 2000, maxSpendLamports: 20000 };
  const signer = createSolanaSigner({ getSigners: async () => [sweepWallet] });
  const service = createPreparedTransactionService({ owner, store, ...ledger, signer, kind: 'fixture-transfer', network: 'devnet', expectedGenesisHash: SOLANA_GENESIS_HASHES.devnet,
    now: () => now, timeoutMs: 0, authorize: async () => true,
    checkResult: async () => ({ state: ledger.state.balance < 10_000_000 ? 'present' : 'absent', slot: ledger.state.slot }), ...options });
  const build = async () => {
    builds++;
    const transaction = new Transaction({ feePayer: sweepWallet.publicKey, recentBlockhash: (await ledger.connection.getLatestBlockhash()).blockhash }).add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
      SystemProgram.transfer({ fromPubkey: sweepWallet.publicKey, toPubkey: new PublicKey(sweepDestination), lamports: 1000 }),
    );
    return { transaction: VersionedTransaction.deserialize(transaction.serialize({ requireAllSignatures: false, verifySignatures: false })), result: { destination: sweepDestination }, feeCeilingLamports: 10000, maxSpendLamports: 20000 };
  };
  const input = { scopeId: 'journal-a', key: 'transfer/0', walletPublicKey: approval.walletPublicKey, plan, approval, build };
  return { owner, store, ...ledger, signer, service, input, approval, build, builds: () => builds, setNow: (value) => { now = value; } };
}

for (const field of ['walletPublicKey', 'network', 'genesisHash', 'scopeId', 'planDigest', 'expiresAtMs', 'maxSpendLamports']) {
  test(`prepared SDK approval binds ${field}`, async (t) => {
    const f = fixture(t); f.approval[field] = field === 'expiresAtMs' || field === 'maxSpendLamports' ? 0 : 'changed';
    await assert.rejects(f.service.execute(f.input), { code: 'EXECUTION_APPROVAL_REQUIRED' });
    assert.equal(f.state.sends.length, 0); assert.equal(f.store.getActiveOperation(f.approval.walletPublicKey), null);
  });
}

for (const method of ['recordOperationApproval', 'recordSignedTransaction']) {
  test(`a failed ${method} commit stops SDK submission`, async (t) => {
    const f = fixture(t); f.store[method] = () => { throw new RecoveryStorageError('fixture disk failure'); };
    await assert.rejects(f.service.execute(f.input), { code: 'RECOVERY_STORAGE_UNAVAILABLE' });
    assert.equal(f.state.sends.length, 0);
  });
}

test('a signer that changes prepared instruction bytes is rejected before send', async (t) => {
  let f;
  f = fixture(t, { signer: { signTransaction: async (context) => {
    const tx = context.transaction;
    // Change the transfer amount while preserving a valid wallet signature.
    const changed = bs58.decode(tx.message.instructions[2].data); changed[4] ^= 1;
    tx.message.instructions[2].data = bs58.encode(changed);
    return f.signer.signTransaction({ ...context, transaction: tx });
  } } });
  await assert.rejects(f.service.execute(f.input), { code: 'TRANSACTION_INVALID' });
  assert.equal(f.state.sends.length, 0);
});

for (const change of ['fee', 'payer', 'signature', 'message', 'slot']) {
  test(`a changed finalized ${change} leaves the prepared action in recovery`, async (t) => {
    const f = fixture(t);
    f.state.receiptTransform = (receipt) => {
      if (change === 'fee') return { ...receipt, meta: { ...receipt.meta, fee: 10001 } };
      if (change === 'payer') return { ...receipt, meta: { ...receipt.meta, postBalances: receipt.meta.postBalances.map((n, i) => i === 0 ? n - 50000 : n) } };
      if (change === 'signature') return { ...receipt, transaction: { ...receipt.transaction, signatures: ['changed'] } };
      if (change === 'message') return { ...receipt, transaction: { ...receipt.transaction, message: { serialize: () => Buffer.from('changed') } } };
      return { ...receipt, slot: 199 };
    };
    await assert.rejects(f.service.execute(f.input), { code: 'CHAIN_STATE_UNAVAILABLE' });
    assert.equal(f.store.getActiveOperation(f.input.walletPublicKey).state, 'recovery_required');
    assert.equal(f.state.sends.length, 1);
    f.state.receiptTransform = (receipt) => receipt;
    const recovered = await f.service.recover(f.input);
    assert.equal(recovered.txId, f.state.sends[0].signature); assert.equal(f.state.sends.length, 1);
  });
}

test('a fresh approval permits identical saved bytes to be rebroadcast', async (t) => {
  const f = fixture(t); f.state.status = null;
  await assert.rejects(f.service.execute(f.input), { code: 'CHAIN_STATE_UNAVAILABLE' });
  f.setNow(2000);
  await assert.rejects(f.service.recover(f.input), { code: 'EXECUTION_APPROVAL_REQUIRED' });
  assert.equal(f.state.sends.length, 1);
  f.approval.id = 'renewed'; f.approval.expiresAtMs = 3000;
  f.state.afterSend = () => { f.state.status = 'finalized'; };
  const result = await f.service.recover(f.input);
  assert.equal(result.txId, f.state.sends[0].signature);
  assert.equal(f.state.sends.length, 2); assert.equal(f.state.sends[0].wire, f.state.sends[1].wire); assert.equal(f.builds(), 1);
});

test('a changed lookup table stops the saved SDK message before signing', async (t) => {
  const f = fixture(t); let lookups = 0;
  const table = new AddressLookupTableAccount({ key: new PublicKey(new Uint8Array(32).fill(8)), state: { deactivationSlot: BigInt('18446744073709551615'), lastExtendedSlot: 1, lastExtendedSlotStartIndex: 0, addresses: [new PublicKey(sweepDestination)] } });
  f.connection.getAddressLookupTable = async () => {
    if (++lookups > 1) table.state.addresses = [SystemProgram.programId];
    return { context: { slot: 200 }, value: table };
  };
  f.input.build = async () => {
    const prepared = await f.build();
    const transaction = Transaction.from(prepared.transaction.serialize());
    return { ...prepared, transaction: new VersionedTransaction(new TransactionMessage({ payerKey: sweepWallet.publicKey,
      recentBlockhash: transaction.recentBlockhash, instructions: transaction.instructions }).compileToV0Message([table])) };
  };
  await assert.rejects(f.service.execute(f.input), { code: 'CHAIN_STATE_UNAVAILABLE' });
  assert.equal(f.state.sends.length, 0);
});

test('competing SDK actions retain one wallet operation', async (t) => {
  const f = fixture(t); let release, arrived;
  const gate = new Promise((resolve) => { release = resolve; }), started = new Promise((resolve) => { arrived = resolve; });
  f.state.beforeSend = async () => { arrived(); await gate; };
  const first = f.service.execute(f.input); await started;
  await assert.rejects(f.service.execute(f.input), { code: 'OPERATION_IN_FLIGHT' });
  await assert.rejects(f.service.execute({ ...f.input, key: 'transfer/1' }), { code: 'OPERATION_IN_FLIGHT' });
  release(); await first; assert.equal(f.state.sends.length, 1);
});

for (const reason of ['expiry', 'owner']) {
  test(`SDK submission rechecks ${reason} after its final network read`, async (t) => {
    const f = fixture(t);
    f.connection.getGenesisHash = async () => {
      const op = f.store.getActiveOperation(f.input.walletPublicKey);
      if (op && f.store.getTransactions(op.id).length) {
        if (reason === 'expiry') f.setNow(2000); else f.owner.release();
      }
      return SOLANA_GENESIS_HASHES.devnet;
    };
    await assert.rejects(f.service.execute(f.input));
    assert.equal(f.state.sends.length, 0);
    const op = f.store.getActiveOperation(f.input.walletPublicKey);
    assert.equal(f.store.getTransactions(op.id).length, 1);
  });
}

test('a failed receipt commit retains signed SDK bytes for recovery', async (t) => {
  const f = fixture(t), record = f.store.recordReceipt;
  f.store.recordReceipt = () => { throw new RecoveryStorageError('fixture receipt commit failed'); };
  await assert.rejects(f.service.execute(f.input), { code: 'RECOVERY_STORAGE_UNAVAILABLE' });
  assert.equal(f.state.sends.length, 1);
  f.store.recordReceipt = record;
  assert.equal((await f.service.recover(f.input)).txId, f.state.sends[0].signature);
  assert.equal(f.state.sends.length, 1);
});

test('a reviewed account list must match the resolved prepared message before commit', async (t) => {
  const f = fixture(t), original = f.input.build;
  f.input.build = async () => ({ ...await original(), accountKeys: [sweepWallet.publicKey.toBase58(), 'changed'] });
  await assert.rejects(f.service.execute(f.input), { code: 'CHAIN_STATE_UNAVAILABLE' });
  assert.equal(f.state.sends.length, 0); assert.equal(f.store.getActiveOperation(f.input.walletPublicKey), null);
});

for (const refund of ['payer', 'program', 'missing']) {
  test(`the receipt credit account requires a distinct writable account before spending: ${refund}`, async (t) => {
    const account = refund === 'payer' ? sweepWallet.publicKey.toBase58() : refund === 'program' ? SystemProgram.programId.toBase58() : PublicKey.default.toBase58().replace(/1$/, '2');
    const f = fixture(t, { receiptCreditAccount: account });
    await assert.rejects(f.service.execute(f.input), { code: 'CHAIN_STATE_UNAVAILABLE' });
    assert.equal(f.state.sends.length, 0); assert.equal(f.store.getActiveOperation(f.input.walletPublicKey), null);
  });
}

test('saved refund account policy stays fixed across recovery hosts', async (t) => {
  const f = fixture(t, { receiptCreditAccount: sweepDestination });
  const receipt = await f.service.execute(f.input);
  assert.equal(f.store.getOperation(receipt.operationId).payload.receiptCreditAccount, sweepDestination);
  const changed = createPreparedTransactionService({ owner: f.owner, store: f.store, connection: f.connection, signer: f.signer,
    kind: 'fixture-transfer', network: 'devnet', expectedGenesisHash: SOLANA_GENESIS_HASHES.devnet, authorize: async () => true,
    checkResult: async () => { throw new Error('use saved policy'); } });
  f.connection.getGenesisHash = () => { throw new Error('offline'); };
  await assert.rejects(changed.execute(f.input), { code: 'OPERATION_CONFLICT' });
  assert.equal(f.state.sends.length, 1);
});


test('prepared recovery waits through a duplicate preflight reply and verifies the original receipt', async (t) => {
  const f = fixture(t); f.state.status = null;
  f.state.afterSend = () => { throw new Error('lost accepted reply'); };
  await assert.rejects(f.service.execute(f.input), /lost accepted reply/);
  const original = f.state.sends[0], operation = f.store.getActiveOperation(f.input.walletPublicKey);
  f.connection.sendRawTransaction = async (bytes) => {
    assert.equal(Buffer.from(bytes).toString('base64'), original.wire);
    throw new SendTransactionError({ action: 'simulate', signature: '', transactionMessage: 'Transaction simulation failed: This transaction has already been processed', logs: [] });
  };
  await assert.rejects(f.service.recover(f.input), { code: 'CHAIN_STATE_UNAVAILABLE' });
  assert.equal(f.store.getOperation(operation.id).state, 'recovery_required');
  assert.equal(f.store.getTransactions(operation.id).length, 1); assert.equal(f.builds(), 1);
  f.state.status = 'finalized';
  const result = await f.service.recover(f.input);
  assert.equal(result.txId, original.signature); assert.equal(f.state.balance, 9993000); assert.equal(f.state.receipts.size, 1);
  assert.equal(f.store.getOperation(operation.id).state, 'confirmed'); assert.equal(f.builds(), 1);
});


for (const accounts of [[sweepDestination, sweepDestination], [sweepDestination, 1], 'source', Array(65).fill(sweepDestination)]) {
  test(`refund policies require distinct bounded account names: ${JSON.stringify(accounts).slice(0, 70)}`, (t) => {
    assert.throws(() => fixture(t, { receiptCreditAccounts: accounts }), TypeError);
  });
}

test('an explicit empty refund policy remains fixed after completion', async (t) => {
  const f = fixture(t), result = await f.service.execute(f.input);
  assert.deepEqual(f.store.getOperation(result.operationId).payload.receiptCreditAccounts, []);
  const changed = createPreparedTransactionService({ owner: f.owner, store: f.store, connection: f.connection, signer: f.signer,
    kind: 'fixture-transfer', network: 'devnet', expectedGenesisHash: SOLANA_GENESIS_HASHES.devnet, authorize: async () => true,
    receiptCreditAccount: sweepDestination, checkResult: async () => { throw new Error('preserve saved policy'); } });
  f.connection.getGenesisHash = () => { throw new Error('offline'); };
  await assert.rejects(changed.execute(f.input), { code: 'OPERATION_CONFLICT' });
});

test('several refund accounts retain their complete policy and receipt bound', async (t) => {
  const extra = new PublicKey(new Uint8Array(32).fill(71)), accounts = [sweepDestination, extra.toBase58()];
  const f = fixture(t, { receiptCreditAccounts: accounts }), build = f.input.build;
  f.input.build = async () => {
    const prepared = await build(), transaction = Transaction.from(prepared.transaction.serialize());
    transaction.add(SystemProgram.transfer({ fromPubkey: sweepWallet.publicKey, toPubkey: extra, lamports: 0 }));
    return { ...prepared, transaction: VersionedTransaction.deserialize(transaction.serialize({ requireAllSignatures: false, verifySignatures: false })) };
  };
  f.state.receiptTransform = (receipt) => ({ ...receipt, meta: { ...receipt.meta, postBalances: receipt.meta.postBalances.map((n, i) => i === 0 ? n + 5000 : n) } });
  await assert.rejects(f.service.execute(f.input), { code: 'CHAIN_STATE_UNAVAILABLE' });
  const operation = f.store.getActiveOperation(f.input.walletPublicKey);
  assert.deepEqual(operation.payload.receiptCreditAccounts, [...accounts].sort());
  f.state.receiptTransform = (receipt) => receipt;
  const result = await f.service.recover(f.input); assert.equal(result.txId, f.state.sends[0].signature);
  const changed = createPreparedTransactionService({ owner: f.owner, store: f.store, connection: f.connection, signer: f.signer,
    kind: 'fixture-transfer', network: 'devnet', expectedGenesisHash: SOLANA_GENESIS_HASHES.devnet, authorize: async () => true,
    receiptCreditAccount: sweepDestination, checkResult: async () => { throw new Error('preserve the complete policy'); } });
  f.connection.getGenesisHash = () => { throw new Error('offline'); };
  await assert.rejects(changed.execute(f.input), { code: 'OPERATION_CONFLICT' }); assert.equal(f.state.sends.length, 1);
});

test('an empty fee quote from a lagging node is asked again, and stays a refusal only if it never fills', async (t) => {
  const f = fixture(t, { feeQuoteDelayMs: 0 });
  const real = f.connection.getFeeForMessage.bind(f.connection);
  let quotes = 0;
  f.connection.getFeeForMessage = async (...args) => (++quotes <= 2 ? { context: { slot: f.state.slot }, value: null } : real(...args));
  f.state.afterSend = () => { f.state.status = 'finalized'; };
  const result = await f.service.execute(f.input);
  assert.ok(result.txId);
  assert.ok(quotes >= 3);

  const g = fixture(t, { feeQuoteDelayMs: 0, feeQuoteAttempts: 3 });
  let empty = 0;
  g.connection.getFeeForMessage = async () => { empty++; return { context: { slot: g.state.slot }, value: null }; };
  await assert.rejects(g.service.execute(g.input), { code: 'CHAIN_STATE_UNAVAILABLE' });
  assert.equal(empty, 3);
  assert.equal(g.state.sends.length, 0);
});
