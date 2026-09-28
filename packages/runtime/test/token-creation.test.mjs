import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Keypair, VersionedTransaction } from '@solana/web3.js';
import { acquireProfileOwner } from '../src/owner.js';
import { openRuntimeStore, RecoveryStorageError } from '../src/store.js';
import { createSolanaSigner, SOLANA_GENESIS_HASHES } from '../src/solana.js';
import { createTokenCreationService } from '../src/token-creation.js';
import { tokenCreationChain, sweepWallet, mintSigner } from './fixtures/token-creation-chain.mjs';

function fixture(t, inline = false) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'trebuchet-token-create-')), owner = acquireProfileOwner(profile), store = openRuntimeStore(profile);
  const chain = tokenCreationChain({ inline });
  t.after(() => { store.close(); owner.release(); fs.rmSync(profile, { recursive: true, force: true }); });
  const walletPublicKey = sweepWallet.publicKey.toBase58();
  const options = { owner, store, connection: chain.connection, network: 'devnet', expectedGenesisHash: SOLANA_GENESIS_HASHES.devnet,
    signer: createSolanaSigner({ getSigners: async ({ operation }) => operation.payload.result.type === 'mint-create' ? [sweepWallet, mintSigner] : [sweepWallet] }),
    authorize: async () => true, feePolicy: async () => ({ computeUnitLimit: 500000, microLamports: 10000, feeCeilingLamports: 50000 }), timeoutMs: 0 };
  const service = createTokenCreationService(options);
  const approval = { id: 'creation-approval', scopeId: 'journal-a', walletPublicKey, network: options.network, genesisHash: options.expectedGenesisHash,
    planDigest: service.planDigest(chain.plan), expiresAtMs: Date.now() + 60000, maxSpendLamports: 100000000 };
  const input = { scopeId: 'journal-a', walletPublicKey, plan: chain.plan, approval };
  return { ...chain, owner, store, options, service, input, active: () => store.getActiveOperation(walletPublicKey), execute: (type) => service.execute({ ...input, type }) };
}

for (const inline of [false, true]) {
  test(`${inline ? 'Token-2022' : 'classic'} creation records signed messages and fixes supply atomically`, async (t) => {
    const f = fixture(t, inline);
    f.state.beforeSend = (tx) => {
      const op = f.active();
      assert.equal(f.store.getTransactions(op.id)[0].wire, tx.wire);
      assert.equal(f.store.getOperationApprovals(op.id)[0].planDigest, f.input.approval.planDigest);
    };
    const results = [];
    for (const type of ['mint-create', 'metadata-create', 'supply-finalize']) results.push(await f.execute(type));
    assert.equal(f.state.sends.length, 3); assert.equal(f.state.supply, 1000000000000n); assert.equal(f.state.holdingAmount, f.state.supply);
    assert.equal(f.state.mintAuthority, null); assert.equal(f.state.freezeAuthority, null);
    assert.equal(f.state.metadata.uri, f.plan.metadata.uri);
    if (inline) assert.equal(f.state.metadata.hash, f.plan.metadata.hash);
    for (const [i, type] of ['mint-create', 'metadata-create', 'supply-finalize'].entries()) assert.deepEqual(await f.execute(type), results[i]);
    assert.equal(f.state.sends.length, 3);
  });
  for (const type of ['mint-create', 'metadata-create', 'supply-finalize']) {
    test(`${inline ? 'inline' : 'classic'} ${type} recovers a lost reply with one send`, async (t) => {
      const f = fixture(t, inline);
      if (type !== 'mint-create') await f.execute('mint-create');
      if (type === 'supply-finalize') await f.execute('metadata-create');
      const prior = f.state.sends.length;
      f.state.afterSend = () => { throw new Error('reply lost'); };
      await assert.rejects(f.execute(type), /reply lost/);
      const operationId = f.active().id;
      f.state.afterSend = null;
      const fresh = createTokenCreationService(f.options);
      const result = await fresh.recover(f.input);
      assert.equal(result.operationId, operationId); assert.equal(f.state.sends.length, prior + 1); assert.equal(f.active(), null);
    });
  }
}

for (const method of ['recordOperationApproval', 'recordSignedTransaction', 'recordReceipt']) {
  test(`token creation preserves recovery when ${method} fails`, async (t) => {
    const f = fixture(t); const original = f.store[method];
    f.store[method] = () => { throw new RecoveryStorageError('fixture disk failure'); };
    await assert.rejects(f.execute('mint-create'), { code: 'RECOVERY_STORAGE_UNAVAILABLE' });
    assert.equal(f.state.sends.length, method === 'recordReceipt' ? 1 : 0);
    f.store[method] = original;
    await (f.active() ? f.service.recover(f.input) : f.execute('mint-create'));
    assert.equal(f.state.sends.length, 1);
  });
}

test('creation recovery verifies its saved network before reading a receipt', async (t) => {
  const f = fixture(t); f.state.afterSend = () => { throw new Error('reply lost'); };
  await assert.rejects(f.execute('mint-create'), /reply lost/);
  f.state.afterSend = null; f.state.genesisHash = SOLANA_GENESIS_HASHES.mainnet;
  let reads = 0; f.connection.getTransaction = async () => { reads++; throw new Error('wrong network receipt'); };
  const other = createTokenCreationService({ ...f.options, network: 'mainnet', expectedGenesisHash: SOLANA_GENESIS_HASHES.mainnet });
  await assert.rejects(other.recover({ ...f.input, approval: { ...f.input.approval, network: 'mainnet', genesisHash: SOLANA_GENESIS_HASHES.mainnet } }), { code: 'NETWORK_MISMATCH' });
  assert.equal(reads, 0); assert.equal(f.state.sends.length, 1);
});

for (const change of ['supply', 'authority', 'metadata', 'credit', 'rent', 'stale']) {
  test(`a changed ${change} keeps token creation in recovery`, async (t) => {
    const f = fixture(t, true); await f.execute('mint-create');
    const type = change === 'metadata' ? 'metadata-create' : 'supply-finalize';
    if (type === 'supply-finalize') await f.execute('metadata-create');
    f.state.afterSend = () => {
      if (change === 'supply') f.state.supply++;
      if (change === 'authority') f.state.mintAuthority = Keypair.generate().publicKey;
      if (change === 'metadata') f.state.metadata.uri = 'https://example.invalid/changed.json';
      if (change === 'stale') f.state.accountSlot = 1;
    };
    f.state.receiptTransform = (receipt) => {
      if (change === 'credit') return { ...receipt, meta: { ...receipt.meta, postTokenBalances: receipt.meta.postTokenBalances.map((row) => ({ ...row, uiTokenAmount: { ...row.uiTokenAmount, amount: '1' } })) } };
      if (change === 'rent') return { ...receipt, meta: { ...receipt.meta, postBalances: receipt.meta.postBalances.map((value, i) => i === 0 ? value - 1 : value) } };
      return receipt;
    };
    await assert.rejects(f.execute(type), { code: 'CHAIN_STATE_UNAVAILABLE' });
    assert.ok(f.active());
  });
}

test('an existing exact supply retires authority without issuing more tokens', async (t) => {
  const f = fixture(t); await f.execute('mint-create'); await f.execute('metadata-create');
  f.state.supply = BigInt(f.plan.supplyRaw); f.state.holdingExists = true; f.state.holdingAmount = f.state.supply; f.state.holdingLamports = f.rent(165);
  const result = await f.execute('supply-finalize');
  assert.equal(result.issuedRaw, '0'); assert.equal(f.state.supply, BigInt(f.plan.supplyRaw)); assert.equal(f.state.mintAuthority, null);
});

test('a partial existing supply pauses before any supply transaction', async (t) => {
  const f = fixture(t); await f.execute('mint-create'); f.state.supply = 1n;
  await assert.rejects(f.execute('supply-finalize'), { code: 'CHAIN_STATE_UNAVAILABLE' });
  assert.equal(f.state.sends.length, 1);
});

for (const change of ['supplyRaw', 'mint', 'metadata']) {
  test(`later creation phases require the saved ${change}`, async (t) => {
    const f = fixture(t); await f.execute('mint-create');
    const plan = structuredClone(f.plan);
    if (change === 'supplyRaw') plan.supplyRaw = '7';
    if (change === 'mint') plan.mint = Keypair.generate().publicKey.toBase58();
    if (change === 'metadata') plan.metadata.uri = 'https://example.invalid/other.json';
    const approval = { ...f.input.approval, planDigest: f.service.planDigest(plan) };
    await assert.rejects(f.service.execute({ ...f.input, plan, approval, type: 'metadata-create' }), { code: 'OPERATION_CONFLICT' });
    assert.equal(f.state.sends.length, 1);
  });
}

for (const inline of [false, true]) {
  test(`${inline ? 'inline' : 'classic'} mint receipt requires its exact saved rent`, async (t) => {
    const f = fixture(t, inline);
    f.state.receiptTransform = (receipt) => {
      const index = receipt.transaction.message.staticAccountKeys.findIndex((key) => key.equals(f.mint));
      // Preserve the total payer debit and a plausible ceiling while changing
      // the reported rent by one lamport.
      return { ...receipt, meta: { ...receipt.meta, postBalances: receipt.meta.postBalances.map((value, i) => i === index ? value - 1 : i === 0 ? value + 1 : value) } };
    };
    await assert.rejects(f.execute('mint-create'), { code: 'CHAIN_STATE_UNAVAILABLE' });
    assert.ok(f.active()); assert.equal(f.state.sends.length, 1);
    f.state.receiptTransform = (receipt) => receipt;
    await f.service.recover(f.input); assert.equal(f.state.sends.length, 1);
  });
}

test('an underfunded creation pauses before signing and resumes with its saved plan', async (t) => {
  const f = fixture(t); f.state.balance = 1;
  await assert.rejects(f.execute('mint-create'), { code: 'INSUFFICIENT_FUNDS' });
  assert.equal(f.store.getTransactions(f.active().id).length, 0); assert.equal(f.state.sends.length, 0);
  f.state.balance = 100000000;
  await f.service.recover(f.input); assert.equal(f.state.sends.length, 1);
});

test('competing creation phases retain one saved wallet action', async (t) => {
  const f = fixture(t); let release, reached;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { reached = resolve; });
  t.after(() => release());
  f.state.beforeSend = async () => { reached(); await gate; };
  const first = f.execute('mint-create'); await started;
  await assert.rejects(f.execute('metadata-create'), { code: 'OPERATION_IN_FLIGHT' });
  await assert.rejects(f.execute('mint-create'), { code: 'OPERATION_IN_FLIGHT' });
  release(); await first; assert.equal(f.state.sends.length, 1);
});

test('recovery binds the saved genesis hash when the network label stays the same', async (t) => {
  const f = fixture(t); f.state.afterSend = () => { throw new Error('reply lost'); };
  await assert.rejects(f.execute('mint-create'), /reply lost/);
  f.state.afterSend = null; f.state.genesisHash = SOLANA_GENESIS_HASHES.mainnet;
  let reads = 0;
  const read = f.connection.getTransaction;
  f.connection.getTransaction = async (...args) => { reads++; return read(...args); };
  const other = createTokenCreationService({ ...f.options, expectedGenesisHash: SOLANA_GENESIS_HASHES.mainnet });
  await assert.rejects(other.recover({ ...f.input, approval: { ...f.input.approval, genesisHash: SOLANA_GENESIS_HASHES.mainnet } }), { code: 'NETWORK_MISMATCH' });
  assert.equal(reads, 0); assert.equal(f.state.sends.length, 1);
});

test('recovery checks the RPC network again after transaction finality was saved', async (t) => {
  const f = fixture(t);
  f.state.receiptTransform = () => null;
  await assert.rejects(f.execute('mint-create'), { code: 'CHAIN_STATE_UNAVAILABLE' });
  assert.equal(f.store.getTransactions(f.active().id)[0].state, 'confirmed');
  let reads = 0;
  const read = f.connection.getTransaction;
  f.state.receiptTransform = (receipt) => receipt;
  f.state.genesisHash = SOLANA_GENESIS_HASHES.mainnet;
  f.connection.getTransaction = async (...args) => { reads++; return read(...args); };
  await assert.rejects(f.service.recover(f.input), { code: 'NETWORK_MISMATCH' });
  assert.equal(reads, 0); assert.equal(f.state.sends.length, 1);
});

for (const inline of [false, true]) for (const phase of ['mint-create', 'metadata-create', 'supply-finalize']) {
  test(`${inline ? 'inline' : 'classic'} ${phase} replaces expired bytes with the same saved accounts and instructions`, async (t) => {
    const f = fixture(t, inline);
    if (phase !== 'mint-create') await f.execute('mint-create');
    if (phase === 'supply-finalize') await f.execute('metadata-create');
    const prior = f.state.sends.length;
    f.state.beforeSend = () => { throw new Error('fixture offline'); };
    await assert.rejects(f.execute(phase), /fixture offline/);
    const operationId = f.active().id;
    const original = f.store.getTransactions(operationId)[0];
    f.state.beforeSend = null; f.state.slot = 500; f.state.accountSlot = 500;
    f.connection.isBlockhashValid = async () => ({ context: { slot: 500 }, value: false });
    f.connection.getLatestBlockhash = async () => ({ blockhash: Keypair.fromSeed(new Uint8Array(32).fill(78)).publicKey.toBase58(), lastValidBlockHeight: 800 });
    const result = await f.service.recover(f.input);
    const records = f.store.getTransactions(operationId);
    assert.deepEqual(records.map((record) => record.state), ['expired', 'confirmed']);
    assert.equal(result.operationId, operationId); assert.equal(f.state.sends.length, prior + 1);
    const saved = VersionedTransaction.deserialize(Buffer.from(original.wire, 'base64'));
    const replacement = VersionedTransaction.deserialize(Buffer.from(records[1].wire, 'base64'));
    assert.notEqual(replacement.message.recentBlockhash, saved.message.recentBlockhash);
    replacement.message.recentBlockhash = saved.message.recentBlockhash;
    assert.deepEqual(replacement.message.serialize(), saved.message.serialize());
  });
}

test('a supply receipt must match saved balances as well as the issued difference', async (t) => {
  const f = fixture(t); await f.execute('mint-create'); await f.execute('metadata-create');
  f.state.holdingExists = true; f.state.holdingLamports = f.rent(165);
  const shift = (rows) => rows.map((row) => ({ ...row, uiTokenAmount: { ...row.uiTokenAmount, amount: (BigInt(row.uiTokenAmount.amount) + 1n).toString() } }));
  f.state.receiptTransform = (receipt) => ({ ...receipt, meta: { ...receipt.meta, preTokenBalances: shift(receipt.meta.preTokenBalances), postTokenBalances: shift(receipt.meta.postTokenBalances) } });
  await assert.rejects(f.execute('supply-finalize'), { code: 'CHAIN_STATE_UNAVAILABLE' });
  f.state.receiptTransform = (receipt) => receipt;
  await f.service.recover(f.input); assert.equal(f.state.sends.length, 3);
});

test('the mint receipt includes the original mint signer signature', async (t) => {
  const f = fixture(t);
  f.state.receiptTransform = (receipt) => ({ ...receipt, transaction: { ...receipt.transaction, signatures: [receipt.transaction.signatures[0]] } });
  await assert.rejects(f.execute('mint-create'), { code: 'CHAIN_STATE_UNAVAILABLE' });
  f.state.receiptTransform = (receipt) => receipt;
  await f.service.recover(f.input); assert.equal(f.state.sends.length, 1);
});

test('missing mint signing material preserves the operation for the supplied signer', async (t) => {
  const f = fixture(t);
  const service = createTokenCreationService({ ...f.options, signer: createSolanaSigner({ getSigners: async () => [sweepWallet] }) });
  await assert.rejects(service.execute({ ...f.input, type: 'mint-create' }), { code: 'TRANSACTION_INVALID' });
  assert.equal(f.state.sends.length, 0); assert.equal(f.store.getTransactions(f.active().id).length, 0);
  await f.service.recover(f.input); assert.equal(f.state.sends.length, 1);
});

test('completed creation receipts remain available while the RPC is offline', async (t) => {
  const f = fixture(t), saved = [];
  const phases = ['mint-create', 'metadata-create', 'supply-finalize'];
  for (const type of phases) saved.push(await f.execute(type));
  f.connection.getGenesisHash = async () => { throw new Error('fixture offline'); };
  for (const [index, type] of phases.entries()) assert.deepEqual(await f.execute(type), saved[index]);
  assert.equal(f.state.sends.length, 3);
});
