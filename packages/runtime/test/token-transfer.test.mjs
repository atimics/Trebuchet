import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ExtensionType, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { Keypair } from '@solana/web3.js';
import { acquireProfileOwner } from '../src/owner.js';
import { openRuntimeStore, RecoveryStorageError } from '../src/store.js';
import { createSolanaSigner, SOLANA_GENESIS_HASHES } from '../src/solana.js';
import { createTokenTransferService } from '../src/token-transfer.js';
import { tokenTransferChain, sweepWallet, sweepDestination } from './fixtures/token-transfer-chain.mjs';

function fixture(t, chainOptions = {}) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'trebuchet-token-transfer-'));
  const owner = acquireProfileOwner(profile), store = openRuntimeStore(profile);
  t.after(() => { store.close(); owner.release(); fs.rmSync(profile, { recursive: true, force: true }); });
  const ledger = tokenTransferChain(chainOptions);
  const walletPublicKey = sweepWallet.publicKey.toBase58();
  const token = { mint: ledger.mint.toBase58(), programId: ledger.program.toBase58(), sourceTokenAccount: ledger.source.toBase58(), amountRaw: ledger.state.sourceAmount.toString(), decimals: ledger.state.decimals };
  const approval = { id: 'token-request', walletPublicKey, destinationWallet: sweepDestination, network: 'devnet', genesisHash: SOLANA_GENESIS_HASHES.devnet,
    maxSpendLamports: ledger.state.balance, expiresAtMs: Date.now() + 60_000, token: { ...token } };
  const input = { ...token, scopeId: 'journal-a', walletPublicKey, destinationWallet: sweepDestination, approval };
  const options = { owner, store, connection: ledger.connection, network: 'devnet', expectedGenesisHash: SOLANA_GENESIS_HASHES.devnet,
    signer: createSolanaSigner({ getSigners: async () => [sweepWallet] }), authorize: async () => true,
    feePolicy: async () => ({ computeUnitLimit: 120000, microLamports: 50000, feeCeilingLamports: 21000 }), timeoutMs: 0 };
  return { ...ledger, owner, store, profile, options, input, service: () => createTokenTransferService(options), active: () => store.getActiveOperation(walletPublicKey) };
}

for (const [name, config, expectedSize] of [
  ['classic token', {}, 165], ['Token-2022 NFT', { token2022: true, decimals: 0, sourceAmount: 1n }, 170],
  ['Token-2022 transfer fee', { token2022: true, transferFee: true }, 182], ['wrapped SOL', { native: true, decimals: 9 }, 165],
  ['large exact token amount', { sourceAmount: 18446744073709551615n }, 165],
]) {
  test(`${name} uses durable signed bytes and exact finalized transfer evidence`, async (t) => {
    const f = fixture(t, config);
    f.state.beforeSend = (tx) => {
      const op = f.active();
      assert.equal(f.store.getTransactions(op.id)[0].wire, tx.wire);
      assert.deepEqual(f.store.getOperationApprovals(op.id)[0].token, f.input.approval.token);
    };
    const result = await f.service().transfer(f.input);
    assert.equal(f.state.sends.length, 1);
    assert.equal(result.txId, f.state.sends[0].signature);
    assert.equal(result.amountRaw, f.input.amountRaw);
    assert.equal(result.transferFeeRaw, config.transferFee ? '5000' : '0');
    assert.equal(result.receivedRaw, (BigInt(f.input.amountRaw) - BigInt(result.transferFeeRaw)).toString());
    assert.equal(f.state.sourceAmount, 0n);
    assert.equal(f.state.destinationAmount.toString(), result.receivedRaw);
    assert.deepEqual(f.state.rentSizes, [expectedSize]);
    assert.equal(f.store.getOperation(result.operationId).state, 'confirmed');
  });
}

test('a transfer that names the wrong token program is refused before anything is saved', async (t) => {
  const f = fixture(t, { token2022: true, associatedSource: true });
  const programId = TOKEN_PROGRAM_ID.toBase58(), sourceTokenAccount = getAssociatedTokenAddressSync(f.mint, sweepWallet.publicKey, false, TOKEN_PROGRAM_ID).toBase58();
  const input = { ...f.input, programId, sourceTokenAccount, approval: { ...f.input.approval, token: { ...f.input.approval.token, programId, sourceTokenAccount } } };
  await assert.rejects(f.service().transfer(input), { code: 'TOKEN_PROGRAM_MISMATCH' });
  assert.equal(f.active(), null); assert.equal(f.state.sends.length, 0);
  assert.equal((await f.service().transfer(f.input)).amountRaw, f.input.amountRaw);
});

test('an existing destination account needs only its transfer fee budget', async (t) => {
  const f = fixture(t, { destinationExists: true });
  f.state.balance = 21000;
  f.input.approval.maxSpendLamports = 21000;
  const result = await f.service().transfer(f.input);
  assert.equal(result.rentLamports, 0);
  assert.equal(f.state.balance, 10000);
  assert.deepEqual(f.state.rentSizes, []);
});

test('a lost send response recovers token and NFT receipts after their source balance reaches zero', async (t) => {
  for (const config of [{}, { token2022: true, decimals: 0, sourceAmount: 1n }]) {
    const f = fixture(t, config);
    f.state.afterSend = () => { throw new Error('Response lost'); };
    await assert.rejects(f.service().transfer(f.input), /Response lost/);
    const id = f.active().id;
    f.state.afterSend = null;
    f.input.approval.expiresAtMs = 1;
    const result = await f.service().recover(f.input);
    assert.equal(result.operationId, id);
    assert.equal(f.state.sends.length, 1);
    assert.equal(f.state.sourceAmount, 0n);
  }
});

test('approval binds exact token identity, amount, source, destination, network, and SOL ceiling', async (t) => {
  for (const change of [{ token: { mint: sweepDestination } }, { token: { amountRaw: '1' } }, { token: { sourceTokenAccount: sweepDestination } }, { token: { programId: sweepDestination } }, { token: { decimals: 0 } }, { destinationWallet: sweepWallet.publicKey.toBase58() }, { network: 'mainnet' }, { genesisHash: 'other' }, { maxSpendLamports: 1 }, { expiresAtMs: 1 }]) {
    const f = fixture(t);
    const approval = { ...f.input.approval, ...change, token: { ...f.input.approval.token, ...change.token } };
    await assert.rejects(f.service().transfer({ ...f.input, approval }), { code: 'EXECUTION_APPROVAL_REQUIRED' });
    assert.equal(f.state.sends.length, 0);
    assert.equal(f.active(), null);
  }
});

test('changed source ownership and incomplete account reads stop preparation', async (t) => {
  const ownerChanged = fixture(t);
  ownerChanged.state.sourceOwner = Keypair.generate().publicKey;
  await assert.rejects(ownerChanged.service().transfer(ownerChanged.input), { code: 'CHAIN_STATE_UNAVAILABLE' });
  assert.equal(ownerChanged.active(), null);
  const partial = fixture(t);
  partial.connection.getMultipleAccountsInfoAndContext = async () => ({ context: { slot: 200 }, value: [null] });
  await assert.rejects(partial.service().transfer(partial.input), { code: 'CHAIN_STATE_UNAVAILABLE' });
  assert.equal(partial.active(), null);
});

test('failed writes before send and after acceptance preserve a recoverable token operation', async (t) => {
  for (const method of ['recordOperationApproval', 'recordSignedTransaction', 'recordReceipt']) {
    const f = fixture(t);
    const saved = f.store[method];
    f.store[method] = () => { throw new RecoveryStorageError('Interrupted commit'); };
    await assert.rejects(f.service().transfer(f.input), { code: 'RECOVERY_STORAGE_UNAVAILABLE' });
    assert.equal(f.state.sends.length, method === 'recordReceipt' ? 1 : 0);
    f.store[method] = saved;
    const result = await (f.active() ? f.service().recover(f.input) : f.service().transfer(f.input));
    assert.equal(f.store.getOperation(result.operationId).state, 'confirmed');
    assert.equal(f.state.sends.length, 1);
  }
});

test('a changed signed amount stops before the transfer is saved or sent', async (t) => {
  const f = fixture(t);
  const signer = f.options.signer;
  f.options.signer = { async signTransaction(context) {
    context.transaction.instructions.at(-1).data.writeBigUInt64LE(1n, 1);
    return signer.signTransaction(context);
  } };
  await assert.rejects(f.service().transfer(f.input), { code: 'TRANSACTION_INVALID' });
  assert.equal(f.state.sends.length, 0);
  assert.deepEqual(f.store.getTransactions(f.active().id), []);
});

test('final receipt checks preserve the operation when amount, rent, owner, or token identity disagrees', async (t) => {
  const changes = [
    (r) => ({ ...r, meta: { ...r.meta, postTokenBalances: r.meta.postTokenBalances.map((b, i) => i === 1 ? { ...b, uiTokenAmount: { ...b.uiTokenAmount, amount: '1' } } : b) } }),
    (r) => ({ ...r, meta: { ...r.meta, fee: r.meta.fee + 1 } }),
    (r) => ({ ...r, meta: { ...r.meta, postTokenBalances: r.meta.postTokenBalances.map((b) => ({ ...b, owner: 'other' })) } }),
    (r) => ({ ...r, meta: { ...r.meta, postTokenBalances: r.meta.postTokenBalances.map((b) => ({ ...b, mint: 'other' })) } }),
    (r) => ({ ...r, meta: { ...r.meta, preTokenBalances: null } }),
  ];
  for (const transform of changes) {
    const f = fixture(t);
    f.state.receiptTransform = transform;
    await assert.rejects(f.service().transfer(f.input), { code: 'CHAIN_STATE_UNAVAILABLE' });
    const id = f.active().id;
    f.state.receiptTransform = (r) => r;
    assert.equal((await f.service().recover(f.input)).operationId, id);
    assert.equal(f.state.sends.length, 1);
  }
});


test('competing token clients share wallet admission and preserve the saved intent', async (t) => {
  const f = fixture(t);
  let arrived, release;
  const started = new Promise((resolve) => { arrived = resolve; });
  const waiting = new Promise((resolve) => { release = resolve; });
  f.state.beforeSend = async () => { arrived(); await waiting; };
  const first = f.service().transfer(f.input);
  await started;
  try {
    await assert.rejects(f.service().recover(f.input), { code: 'OPERATION_IN_FLIGHT' });
    await assert.rejects(f.service().transfer({ ...f.input, amountRaw: '1' }), { code: 'OPERATION_IN_FLIGHT' });
  } finally { release(); }
  await first;
  assert.equal(f.state.sends.length, 1);
});

test('token recovery renews approval and broadcasts the same saved signature', async (t) => {
  const f = fixture(t);
  f.state.beforeSend = () => { throw new Error('Transport closed before acceptance'); };
  await assert.rejects(f.service().transfer(f.input), /Transport closed/);
  const op = f.active(), saved = f.store.getTransactions(op.id)[0];
  f.state.beforeSend = null;
  f.input.approval = { ...f.input.approval, id: 'expired-request', expiresAtMs: 1 };
  await assert.rejects(f.service().recover(f.input), { code: 'EXECUTION_APPROVAL_REQUIRED' });
  assert.equal(f.state.sends.length, 0);
  f.input.approval = { ...f.input.approval, id: 'renewed-request', expiresAtMs: Date.now() + 60_000 };
  f.options.signer = { signTransaction: async () => { assert.fail('Recovery uses its saved signed bytes'); } };
  assert.equal((await f.service().recover(f.input)).txId, saved.signature);
  assert.equal(f.state.sends[0].wire, saved.wire);
  assert.equal(f.store.getOperationApprovals(op.id).length, 2);
});

test('token approval expiry and owner release at the final RPC check stop broadcast', async (t) => {
  for (const change of ['approval', 'owner']) {
    const f = fixture(t);
    f.connection.getGenesisHash = async () => {
      if (f.active()?.state === 'submitted') {
        if (change === 'approval') f.input.approval.expiresAtMs = 1;
        else f.owner.release();
      }
      return SOLANA_GENESIS_HASHES.devnet;
    };
    await assert.rejects(f.service().transfer(f.input), { code: change === 'approval' ? 'EXECUTION_APPROVAL_REQUIRED' : 'RUNTIME_OWNER_RELEASED' });
    assert.equal(f.state.sends.length, 0);
  }
});


test('tokens with transfer hooks or private transfer extensions pause before preparation', async (t) => {
  for (const extension of [ExtensionType.TransferHook, ExtensionType.NonTransferable, ExtensionType.ConfidentialTransferMint]) {
    const f = fixture(t, { token2022: true });
    const read = f.connection.getMultipleAccountsInfoAndContext;
    f.connection.getMultipleAccountsInfoAndContext = async (...args) => {
      const response = await read(...args);
      const header = Buffer.alloc(4); header.writeUInt16LE(extension);
      response.value[1].data = Buffer.concat([response.value[1].data, Buffer.alloc(165 - 82), Buffer.from([1]), header]);
      return response;
    };
    await assert.rejects(f.service().transfer(f.input), { code: 'TOKEN_EXTENSION_REQUIRES_REVIEW' });
    assert.equal(f.active(), null);
    assert.equal(f.state.sends.length, 0);
  }
});

test('a fee increase before signing preserves the transfer for recovery', async (t) => {
  const f = fixture(t);
  f.connection.getFeeForMessage = async () => ({ context: { slot: 200 }, value: 21001 });
  await assert.rejects(f.service().transfer(f.input), { code: 'SPEND_LIMIT_EXCEEDED' });
  assert.equal(f.state.sends.length, 0);
  assert.deepEqual(f.store.getTransactions(f.active().id), []);
  f.connection.getFeeForMessage = async () => ({ context: { slot: 200 }, value: 11000 });
  await f.service().recover(f.input);
  assert.equal(f.state.sends.length, 1);
});

test('receipt token balances support RPCs that omit optional owner and program fields', async (t) => {
  const f = fixture(t);
  f.state.receiptTransform = (receipt) => ({ ...receipt, meta: { ...receipt.meta,
    preTokenBalances: receipt.meta.preTokenBalances.map(({ owner, programId, ...entry }) => entry),
    postTokenBalances: receipt.meta.postTokenBalances.map(({ owner, programId, ...entry }) => entry),
  } });
  assert.equal((await f.service().transfer(f.input)).receivedRaw, '5000000');
  assert.equal(f.state.sends.length, 1);
});


const savedAction = { key: 'fee-key/position-a', context: { purpose: 'liquidity-fee-key', recipient: sweepDestination } };
function keyedInput(f, action = savedAction) {
  return { ...f.input, action, approval: { ...f.input.approval, action, scopeId: f.input.scopeId } };
}

test('a stable transfer action returns its saved receipt after source accounts become unavailable', async (t) => {
  const f = fixture(t, { token2022: true, decimals: 0, sourceAmount: 1n });
  const input = keyedInput(f), result = await f.service().transfer(input);
  f.connection.getMultipleAccountsInfoAndContext = async () => { throw new Error('source was closed'); };
  assert.deepEqual(await f.service().transfer(input), result);
  assert.equal(f.state.sends.length, 1);
  assert.equal(f.store.listWalletOperations(input.walletPublicKey).length, 1);
});

for (const [label, change] of Object.entries({ recipient: { destinationWallet: Keypair.generate().publicKey.toBase58() }, amount: { amountRaw: '2' },
  context: { action: { ...savedAction, context: { purpose: 'another-purpose' } } }, source: { sourceTokenAccount: Keypair.generate().publicKey.toBase58() } })) {
  test(`a completed action preserves its original ${label}`, async (t) => {
    const f = fixture(t); const input = keyedInput(f);
    await f.service().transfer(input);
    await assert.rejects(f.service().transfer({ ...input, ...change }), { code: 'OPERATION_CONFLICT' });
    assert.equal(f.state.sends.length, 1);
  });
}

test('a stable transfer approval binds its scope and action context before spending', async (t) => {
  for (const change of [{ action: null }, { scopeId: 'another-launch' }, { action: { ...savedAction, context: {} } }]) {
    const f = fixture(t); const input = keyedInput(f);
    await assert.rejects(f.service().transfer({ ...input, approval: { ...input.approval, ...change } }), { code: 'EXECUTION_APPROVAL_REQUIRED' });
    assert.equal(f.state.sends.length, 0);
  }
});

test('a pending token transfer keeps its original launch scope and action', async (t) => {
  const f = fixture(t); const input = keyedInput(f); f.state.status = 'confirmed';
  await assert.rejects(f.service().transfer(input), { code: 'CHAIN_STATE_UNAVAILABLE' });
  for (const changed of [{ scopeId: 'another-launch' }, { action: { ...savedAction, key: 'fee-key/position-b' } }, { action: undefined }]) {
    await assert.rejects(f.service().transfer({ ...input, ...changed }), { code: 'OPERATION_IN_FLIGHT' });
  }
  await assert.rejects(f.service().recover({ ...input, scopeId: 'another-launch' }), { code: 'OPERATION_IN_FLIGHT' });
  f.state.status = 'finalized';
  assert.equal((await f.service().transfer(input)).txId, f.state.sends[0].signature);
  assert.equal(f.state.sends.length, 1);
});
