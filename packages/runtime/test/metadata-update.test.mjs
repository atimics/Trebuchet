import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SystemProgram, Keypair } from '@solana/web3.js';
import { acquireProfileOwner } from '../src/owner.js';
import { openRuntimeStore, RecoveryStorageError } from '../src/store.js';
import { createSolanaSigner, SOLANA_GENESIS_HASHES } from '../src/solana.js';
import { createMetadataUpdateService } from '../src/metadata-update.js';
import { metadataChain, sweepWallet, sweepDestination } from './fixtures/metadata-chain.mjs';

function fixture(t, config = {}, reveal = false) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'trebuchet-metadata-'));
  const owner = acquireProfileOwner(profile), store = openRuntimeStore(profile);
  t.after(() => { store.close(); owner.release(); fs.rmSync(profile, { recursive: true, force: true }); });
  const ledger = metadataChain(config), walletPublicKey = sweepWallet.publicKey.toBase58();
  const intent = { mint: ledger.mint.toBase58(), newAuthority: reveal ? SystemProgram.programId.toBase58() : sweepDestination,
    fields: reveal ? { name: 'Final Token', symbol: 'FINAL', uri: 'https://example.invalid/' + 'm'.repeat(120), ...(config.inline ? { 'trebuchet:sha256': 'b'.repeat(64) } : {}) } : {}, makeImmutable: reveal };
  const approval = { id: 'metadata-request', walletPublicKey, network: 'devnet', genesisHash: SOLANA_GENESIS_HASHES.devnet, metadata: intent,
    maxSpendLamports: ledger.state.balance, expiresAtMs: Date.now() + 60_000 };
  const input = { ...intent, scopeId: 'journal-a', walletPublicKey, approval };
  const options = { owner, store, connection: ledger.connection, network: 'devnet', expectedGenesisHash: SOLANA_GENESIS_HASHES.devnet,
    signer: createSolanaSigner({ getSigners: async () => [sweepWallet] }), authorize: async () => true,
    feePolicy: async () => ({ computeUnitLimit: 300000, microLamports: 50000, feeCeilingLamports: 30000 }), timeoutMs: 0 };
  return { ...ledger, profile, owner, store, options, input, service: () => createMetadataUpdateService(options), active: () => store.getActiveOperation(walletPublicKey),
    recover: () => createMetadataUpdateService(options).recover({ ...input, destinationWallet: intent.newAuthority }) };
}

for (const inline of [false, true]) for (const reveal of [false, true]) {
  test(`${inline ? 'inline' : 'Metaplex'} ${reveal ? 'reveal' : 'authority handoff'} saves its signed intent and verifies metadata`, async (t) => {
    const f = fixture(t, { inline }, reveal);
    f.state.beforeSend = (tx) => {
      const operation = f.active();
      assert.equal(f.store.getTransactions(operation.id)[0].wire, tx.wire);
      assert.deepEqual(f.store.getOperationApprovals(operation.id)[0].metadata, f.input.approval.metadata);
    };
    const result = await f.service().update(f.input);
    assert.equal(f.state.sends.length, 1);
    assert.equal(result.txId, f.state.sends[0].signature);
    assert.equal(result.adopted, false);
    assert.equal(f.state.authority, f.input.newAuthority);
    assert.equal(result.immutable, reveal);
    assert.equal(result.feeLamports, 20000);
    if (inline && reveal) assert.ok(result.rentLamports > 0);
    else assert.equal(result.rentLamports, 0);
    if (reveal) {
      assert.equal(f.state.name, 'Final Token');
      assert.equal(f.state.uri, f.input.fields.uri);
    } else assert.equal(f.state.name, 'Sealed token');
    assert.equal(f.store.getOperation(result.operationId).state, 'confirmed');
    assert.deepEqual(await f.service().update(f.input), result);
    assert.equal(f.state.sends.length, 1);
  });
}

test('metadata recovery verifies an accepted transaction after a lost response', async (t) => {
  for (const inline of [false, true]) {
    const f = fixture(t, { inline }, true);
    f.state.afterSend = () => { throw new Error('Response lost'); };
    await assert.rejects(f.service().update(f.input), /Response lost/);
    const id = f.active().id;
    f.state.afterSend = null;
    f.input.approval.expiresAtMs = 1;
    const result = await f.recover();
    assert.equal(result.operationId, id);
    assert.equal(f.state.sends.length, 1);
  }
});

test('existing authority handoffs become durable observations with zero spending', async (t) => {
  const f = fixture(t);
  f.state.authority = sweepDestination;
  f.state.balance = 0;
  f.input.approval.maxSpendLamports = 0;
  const result = await f.service().update(f.input);
  assert.equal(result.adopted, true);
  assert.equal(result.txId, null);
  assert.equal(result.feeLamports, 0);
  assert.equal(f.state.sends.length, 0);
  assert.equal(f.store.getOperation(result.operationId).state, 'confirmed');
});

test('approval binds the metadata intent, signer, network, fee, and rent ceiling', async (t) => {
  for (const patch of [{ metadata: { fields: {} } }, { metadata: { newAuthority: sweepDestination } }, { metadata: { mint: sweepDestination } }, { metadata: { makeImmutable: false } },
    { maxSpendLamports: 1 }, { walletPublicKey: sweepDestination }, { network: 'mainnet' }, { expiresAtMs: 1 }]) {
    const f = fixture(t, { inline: true }, true);
    const approval = { ...f.input.approval, ...patch, metadata: { ...f.input.approval.metadata, ...patch.metadata } };
    await assert.rejects(f.service().update({ ...f.input, approval }), { code: 'EXECUTION_APPROVAL_REQUIRED' });
    assert.equal(f.state.sends.length, 0);
    assert.equal(f.active(), null);
  }
});

test('missing metadata, wrong authority, owner, mint, or partial RPC data stops preparation', async (t) => {
  for (const change of ['authority', 'owner', 'mint', 'partial']) {
    const f = fixture(t);
    if (change === 'authority') f.state.authority = Keypair.generate().publicKey.toBase58();
    if (change === 'owner') f.state.accountOwner = SystemProgram.programId;
    if (change === 'mint') f.state.metadataMint = Keypair.generate().publicKey;
    if (change === 'partial') f.connection.getMultipleAccountsInfoAndContext = async () => ({ context: { slot: 200 }, value: [null] });
    await assert.rejects(f.service().update(f.input), { code: 'CHAIN_STATE_UNAVAILABLE' });
    assert.equal(f.active(), null);
    assert.equal(f.state.sends.length, 0);
  }
});

test('failed metadata approval, signed bytes, and receipt commits preserve recovery', async (t) => {
  for (const method of ['recordOperationApproval', 'recordSignedTransaction', 'recordReceipt']) {
    const f = fixture(t, { inline: true }, true);
    const original = f.store[method];
    f.store[method] = () => { throw new RecoveryStorageError('Interrupted commit'); };
    await assert.rejects(f.service().update(f.input), { code: 'RECOVERY_STORAGE_UNAVAILABLE' });
    assert.equal(f.state.sends.length, method === 'recordReceipt' ? 1 : 0);
    f.store[method] = original;
    await (f.active() ? f.recover() : f.service().update(f.input));
    assert.equal(f.state.sends.length, 1);
  }
});

test('metadata fees and account state must match the saved result before completion', async (t) => {
  for (const change of ['fee', 'state', 'slot']) {
    const f = fixture(t, { inline: true }, true);
    f.state.afterSend = () => {
      if (change === 'state') f.state.name = 'Unexpected';
      if (change === 'slot') f.state.accountSlot = 199;
    };
    if (change === 'fee') f.state.receiptTransform = (receipt) => ({ ...receipt, meta: { ...receipt.meta, fee: 20001 } });
    await assert.rejects(f.service().update(f.input), { code: 'CHAIN_STATE_UNAVAILABLE' });
    const id = f.active().id;
    f.state.afterSend = null; f.state.name = f.input.fields.name; f.state.accountSlot = 200; f.state.receiptTransform = (receipt) => receipt;
    assert.equal((await f.recover()).operationId, id);
    assert.equal(f.state.sends.length, 1);
  }
});


test('metadata rebroadcast uses its saved bytes and a renewed exact approval', async (t) => {
  const f = fixture(t, { inline: true }, true);
  f.state.beforeSend = () => { throw new Error('Transport closed before acceptance'); };
  await assert.rejects(f.service().update(f.input), /Transport closed/);
  const saved = f.store.getTransactions(f.active().id)[0];
  f.state.beforeSend = null;
  f.input.approval = { ...f.input.approval, id: 'expired', expiresAtMs: 1 };
  await assert.rejects(f.recover(), { code: 'EXECUTION_APPROVAL_REQUIRED' });
  f.input.approval = { ...f.input.approval, id: 'renewed', expiresAtMs: Date.now() + 60_000 };
  f.options.signer = { signTransaction: () => { assert.fail('Use the saved signed bytes'); } };
  assert.equal((await f.recover()).txId, saved.signature);
  assert.equal(f.state.sends[0].wire, saved.wire);
});

test('metadata approval expiry and owner release at the last RPC check stop sending', async (t) => {
  for (const change of ['approval', 'owner']) {
    const f = fixture(t);
    f.connection.getGenesisHash = async () => {
      if (f.active()?.state === 'submitted') {
        if (change === 'approval') f.input.approval.expiresAtMs = 1;
        else f.owner.release();
      }
      return SOLANA_GENESIS_HASHES.devnet;
    };
    await assert.rejects(f.service().update(f.input), { code: change === 'approval' ? 'EXECUTION_APPROVAL_REQUIRED' : 'RUNTIME_OWNER_RELEASED' });
    assert.equal(f.state.sends.length, 0);
  }
});

test('a signer that changes the metadata instruction stops before storage or broadcast', async (t) => {
  const f = fixture(t, { inline: true });
  const signer = f.options.signer;
  f.options.signer = { signTransaction: (context) => {
    context.transaction.instructions.at(-1).data.fill(0, 8);
    return signer.signTransaction(context);
  } };
  await assert.rejects(f.service().update(f.input), { code: 'TRANSACTION_INVALID' });
  assert.equal(f.state.sends.length, 0);
  assert.deepEqual(f.store.getTransactions(f.active().id), []);
});

test('competing metadata clients preserve the active operation and its intent', async (t) => {
  const f = fixture(t);
  let arrived, release;
  const started = new Promise((resolve) => { arrived = resolve; });
  const waiting = new Promise((resolve) => { release = resolve; });
  f.state.beforeSend = async () => { arrived(); await waiting; };
  const first = f.service().update(f.input);
  await started;
  try {
    await assert.rejects(f.recover(), { code: 'OPERATION_IN_FLIGHT' });
    await assert.rejects(f.service().update({ ...f.input, fields: { name: 'Changed' } }), { code: 'OPERATION_IN_FLIGHT' });
  } finally { release(); }
  await first;
  assert.equal(f.state.sends.length, 1);
});
