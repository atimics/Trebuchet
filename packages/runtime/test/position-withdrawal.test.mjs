import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SystemProgram } from '@solana/web3.js';
import { AccountLayout } from '@solana/spl-token';
import { PositionInfoLayout } from '@raydium-io/raydium-sdk-v2';
import BN from 'bn.js';
import { acquireProfileOwner } from '../src/owner.js';
import { openRuntimeStore, RecoveryStorageError } from '../src/store.js';
import { createSolanaSigner } from '../src/solana.js';
import { createPositionWithdrawalService } from '../src/position-withdrawal.js';
import { withdrawalChain, enableWithdrawalExecution, withdrawalWallet, info } from './fixtures/position-withdrawal-chain.mjs';

async function fixture(t, variant = {}) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'trebuchet-withdrawal-'));
  let owner = acquireProfileOwner(profile), store = openRuntimeStore(profile), clock = 1000;
  t.after(() => { store.close(); owner.release(); fs.rmSync(profile, { recursive: true, force: true }); });
  const f = enableWithdrawalExecution(withdrawalChain(variant)), { connection, state } = f;
  const options = { owner, store, connection, signer: createSolanaSigner({ getSigners: async () => [withdrawalWallet] }),
    network: f.input.network, expectedGenesisHash: f.input.expectedGenesisHash, authorize: async () => true, now: () => clock, timeoutMs: 0 };
  const service = () => createPositionWithdrawalService(options), input = { ...f.input, scopeId: 'wallet', key: 'withdraw-one' };
  const job = await service().prepare(input);
  const approval = { id: 'reviewed-withdrawal', scopeId: input.scopeId, key: input.key, walletPublicKey: input.walletPublicKey,
    network: options.network, genesisHash: options.expectedGenesisHash, planDigest: job.digest, maxSpendLamports: job.plan.maxSpendLamports, expiresAtMs: 2000 };
  return { ...f, profile, options, service, input, job, approval, execute: () => service().execute({ id: job.id, approval }),
    get store() { return store; }, get owner() { return owner; }, setNow(value) { clock = value; },
    reopen() { store.close(); owner.release(); owner = acquireProfileOwner(profile); store = openRuntimeStore(profile); Object.assign(options, { owner, store }); } };
}

for (const variant of [{}, { existing: true }, { token2022: true }, { nft2022: true }, { frozenNft: true }, { rewards: true }]) {
  test(`withdrawal verifies the original receipt and exact account effects: ${JSON.stringify(variant)}`, async (t) => {
    const f = await fixture(t, variant);
    assert.equal(f.job.state, 'prepared'); assert.equal(f.store.getWalletWorkflow(f.input.walletPublicKey), null); assert.equal(f.state.sends.length, 0);
    f.state.beforeSend = (tx) => {
      const operation = f.store.getActiveOperation(f.input.walletPublicKey);
      assert.equal(f.store.getWalletWorkflow(f.input.walletPublicKey).id, f.job.id);
      assert.equal(f.store.getTransactions(operation.id)[0].signature, tx.signature); assert.ok(f.store.getOperationApprovals(operation.id).length);
    };
    const result = await f.execute();
    assert.equal(result.status, 'confirmed'); assert.equal(result.nativeReceivedLamports, 5100000); assert.equal(result.feeLamports, 75000);
    assert.equal(result.received.length, variant.rewards ? 3 : 2); assert.ok(result.received.every((row) => BigInt(row.receivedRaw) >= BigInt(row.minimumRaw)));
    assert.equal(result.returnedPositionRentLamports, 4500000 + 2039280 + (variant.nft2022 ? 2500000 : 0));
    assert.equal(result.grossDebitLamports - result.returnedLamports, result.spentLamports);
    assert.equal(f.store.getWalletWorkflow(f.input.walletPublicKey), null); assert.equal(f.state.sends.length, 1);
    f.reopen(); f.connection.getGenesisHash = () => { throw new Error('offline'); };
    assert.deepEqual(await f.service().execute({ id: f.job.id }), result);
  });
}

test('restart recovers the accepted signature after its response is lost', async (t) => {
  const f = await fixture(t); f.state.afterSend = () => { throw new Error('lost response'); };
  await assert.rejects(f.execute(), /lost response/); f.reopen(); f.state.afterSend = null; f.setNow(3000);
  const result = await f.service().execute({ id: f.job.id });
  assert.equal(result.status, 'confirmed'); assert.equal(f.state.sends.length, 1);
});

for (const field of ['scopeId', 'key', 'walletPublicKey', 'network', 'genesisHash', 'planDigest', 'maxSpendLamports', 'expiresAtMs']) {
  test(`withdrawal approval binds ${field} before reservation`, async (t) => {
    const f = await fixture(t); f.approval[field] = ['maxSpendLamports', 'expiresAtMs'].includes(field) ? 0 : 'changed';
    await assert.rejects(f.execute(), { code: 'EXECUTION_APPROVAL_REQUIRED' });
    assert.equal(f.store.getWalletWorkflow(f.input.walletPublicKey), null); assert.equal(f.state.sends.length, 0);
  });
}

test('a missing position requires the original receipt', async (t) => {
  const f = await fixture(t); f.state.accounts.delete(f.position.toBase58());
  await assert.rejects(f.execute(), { code: 'CHAIN_STATE_UNAVAILABLE' }); assert.equal(f.state.sends.length, 0);
  assert.equal(f.store.getWalletWorkflow(f.input.walletPublicKey), null);
});

test('fresh funding covers the full fee and rent ceiling', async (t) => {
  const f = await fixture(t); f.state.accounts.get(f.input.walletPublicKey).lamports = f.job.plan.maxSpendLamports - 1;
  await assert.rejects(f.execute(), { code: 'INSUFFICIENT_FUNDS' }); assert.equal(f.store.getWalletWorkflow(f.input.walletPublicKey), null);
  assert.equal(f.state.sends.length, 0);
});

test('competing clients share the withdrawal owner guard', async (t) => {
  const f = await fixture(t); let enter, release;
  const entered = new Promise((r) => { enter = r; }), gate = new Promise((r) => { release = r; });
  f.state.beforeSend = async () => { enter(); await gate; };
  const running = f.execute(); await entered;
  try { await assert.rejects(f.execute(), { code: 'OPERATION_IN_FLIGHT' }); } finally { release(); }
  assert.equal((await running).status, 'confirmed'); assert.equal(f.state.sends.length, 1);
});

test('a failed atomic withdrawal saves its fee before releasing the wallet', async (t) => {
  const f = await fixture(t); f.state.fail = true;
  await assert.rejects(f.execute(), { code: 'TRANSACTION_FAILED' });
  const job = f.service().get(f.job.id); assert.equal(job.state, 'failed'); assert.equal(job.result.feeLamports, 75000);
  assert.equal(job.result.returnedLamports, 0); assert.ok(f.state.accounts.has(f.position.toBase58()));
  assert.equal(f.store.getWalletWorkflow(f.input.walletPublicKey), null);
  f.reopen(); f.connection.getGenesisHash = () => { throw new Error('offline'); };
  assert.equal((await f.service().execute({ id: f.job.id })).status, 'failed'); assert.equal(f.state.sends.length, 1);
});

test('final receipt commit failure preserves wallet admission and recovers without another send', async (t) => {
  const f = await fixture(t), finish = f.store.finishWalletWorkflow;
  f.store.finishWalletWorkflow = () => { throw new RecoveryStorageError('failed final commit'); };
  await assert.rejects(f.execute(), { code: 'RECOVERY_STORAGE_UNAVAILABLE' });
  assert.equal(f.service().get(f.job.id).state, 'approved'); assert.ok(f.store.getWalletWorkflow(f.input.walletPublicKey));
  f.store.finishWalletWorkflow = finish; assert.equal((await f.service().execute({ id: f.job.id })).status, 'confirmed'); assert.equal(f.state.sends.length, 1);
});

for (const changed of ['minimum', 'owner', 'native vault', 'nft burn', 'position close', 'wallet credit', 'token rows', 'fee', 'signature', 'message', 'slot']) {
  test(`a changed receipt pauses withdrawal completion: ${changed}`, async (t) => {
    const f = await fixture(t);
    f.state.receiptTransform = (receipt) => {
      const r = { ...receipt, transaction: { ...receipt.transaction }, meta: { ...receipt.meta,
        preBalances: receipt.meta.preBalances.slice(), postBalances: receipt.meta.postBalances.slice(),
        preTokenBalances: structuredClone(receipt.meta.preTokenBalances), postTokenBalances: structuredClone(receipt.meta.postTokenBalances) } };
      const token = f.job.plan.tokens.find((row) => !row.native), native = f.job.plan.tokens.find((row) => row.native);
      const index = (key) => f.job.plan.accountKeys.indexOf(key), output = r.meta.postTokenBalances.find((row) => row.accountIndex === index(token.destination));
      if (changed === 'minimum') output.uiTokenAmount.amount = '0';
      if (changed === 'owner') output.owner = f.poolId.toBase58();
      if (changed === 'native vault') r.meta.postBalances[index(native.vaults[0])]++;
      if (changed === 'nft burn') r.meta.preTokenBalances.find((row) => row.mint === f.input.nftMint).uiTokenAmount.amount = '0';
      if (changed === 'position close') r.meta.postBalances[index(f.job.plan.positionAddress)] = 1;
      if (changed === 'wallet credit') r.meta.postBalances[0]++;
      if (changed === 'token rows') r.meta.postTokenBalances.push(output);
      if (changed === 'fee') r.meta.fee++;
      if (changed === 'signature') r.transaction.signatures = [];
      if (changed === 'message') r.transaction.message = { serialize: () => new Uint8Array([0]) };
      if (changed === 'slot') r.slot = 0;
      return r;
    };
    await assert.rejects(f.execute(), { code: 'CHAIN_STATE_UNAVAILABLE' }); assert.ok(f.store.getWalletWorkflow(f.input.walletPublicKey));
    f.state.receiptTransform = (r) => r;
    assert.equal((await f.service().execute({ id: f.job.id })).status, 'confirmed'); assert.equal(f.state.sends.length, 1);
  });
}

test('later output transfers preserve the original withdrawal result', async (t) => {
  const f = await fixture(t); f.state.afterSend = () => { throw new Error('lost response'); };
  await assert.rejects(f.execute(), /lost response/); f.state.afterSend = null;
  const account = f.state.accounts.get(f.destination.toBase58()), token = AccountLayout.decode(account.data); token.amount = 0n; AccountLayout.encode(token, account.data);
  f.state.accounts.get(f.input.walletPublicKey).lamports += 300000000;
  assert.equal((await f.execute()).received.find((row) => !row.native).receivedRaw, '5100000'); assert.equal(f.state.sends.length, 1);
});

test('a changed saved witness pauses offline replay', async (t) => {
  const f = await fixture(t); await f.execute();
  const records = f.store.collection('runtime-position-withdrawals/v1'), jobs = records.load(); jobs[0].witness.postBalances[0]++; records.save(jobs);
  assert.throws(() => f.service().get(f.job.id), { code: 'RECOVERY_STORAGE_UNAVAILABLE' });
});

test('pre-funded output rent is counted from the original receipt', async (t) => {
  const f = await fixture(t);
  f.set(f.destination, info(SystemProgram.programId, Buffer.alloc(0), 1000000));
  // Funding after review reduces the actual rent while the reviewed ceiling stays fixed.
  const result = await f.execute(); assert.equal(result.rentLamports, 2 * 2039280 - 1000000);
});

test('pending signatures require renewed approval before identical rebroadcast', async (t) => {
  const f = await fixture(t); f.state.drop = true;
  await assert.rejects(f.execute(), { code: 'CHAIN_STATE_UNAVAILABLE' }); const wire = f.state.sends[0].wire;
  f.setNow(3000); f.state.drop = false;
  await assert.rejects(f.execute(), { code: 'EXECUTION_APPROVAL_REQUIRED' }); assert.equal(f.state.sends.length, 1);
  const result = await f.service().execute({ id: f.job.id, approval: { ...f.approval, id: 'renewed', expiresAtMs: 4000 } });
  assert.equal(result.status, 'confirmed'); assert.equal(f.state.sends[1].wire, wire);
});

for (const boundary of ['approval', 'signed transaction']) {
  test(`failed ${boundary} storage stops withdrawal submission`, async (t) => {
    const f = await fixture(t), method = boundary === 'approval' ? 'recordOperationApproval' : 'recordSignedTransaction', original = f.store[method];
    f.store[method] = () => { throw new RecoveryStorageError('failed durable write'); };
    await assert.rejects(f.execute(), { code: 'RECOVERY_STORAGE_UNAVAILABLE' }); assert.equal(f.state.sends.length, 0);
    assert.ok(f.store.getWalletWorkflow(f.input.walletPublicKey)); f.store[method] = original;
    assert.equal((await f.execute()).status, 'confirmed'); assert.equal(f.state.sends.length, 1);
  });
}

test('failed review storage leaves the original position available', async (t) => {
  const f = await fixture(t), collection = f.store.collection;
  f.store.collection = (name) => {
    const records = collection(name);
    return name === 'runtime-position-withdrawals/v1' ? { ...records, save() { throw new RecoveryStorageError('failed review write'); } } : records;
  };
  await assert.rejects(f.service().prepare({ ...f.input, key: 'second', requestId: 'second' }), { code: 'RECOVERY_STORAGE_UNAVAILABLE' });
  assert.equal(f.state.sends.length, 0); assert.ok(f.state.accounts.has(f.position.toBase58())); assert.equal(f.store.getWalletWorkflow(f.input.walletPublicKey), null);
});

test('a changed failed receipt holds wallet admission until its original fee is verified', async (t) => {
  const f = await fixture(t); f.state.fail = true;
  f.state.receiptTransform = (receipt) => ({ ...receipt, meta: { ...receipt.meta, fee: receipt.meta.fee + 1 } });
  await assert.rejects(f.execute(), { code: 'CHAIN_STATE_UNAVAILABLE' }); assert.ok(f.store.getWalletWorkflow(f.input.walletPublicKey));
  f.state.receiptTransform = (receipt) => receipt;
  await assert.rejects(f.execute(), { code: 'TRANSACTION_FAILED' }); assert.equal(f.store.getWalletWorkflow(f.input.walletPublicKey), null); assert.equal(f.state.sends.length, 1);
});

test('finalized failure permits a separately reviewed withdrawal and retains its paid fee', async (t) => {
  const f = await fixture(t); f.state.fail = true; await assert.rejects(f.execute(), { code: 'TRANSACTION_FAILED' });
  f.state.fail = false;
  const job = await f.service().prepare({ ...f.input, key: 'second', requestId: 'second' });
  const approval = { ...f.approval, id: 'new-position-review', key: job.plan.key, planDigest: job.digest, maxSpendLamports: job.plan.maxSpendLamports };
  assert.equal((await f.service().execute({ id: job.id, approval })).status, 'confirmed');
  assert.equal(f.service().get(f.job.id).result.feeLamports, 75000); assert.equal(f.state.sends.length, 2);
});

test('replacement after expiry keeps the approved minimum and temporary SOL account', async (t) => {
  const f = await fixture(t); f.state.drop = true;
  await assert.rejects(f.execute(), { code: 'CHAIN_STATE_UNAVAILABLE' });
  f.state.drop = false; f.state.height = 501; f.state.valid = false; f.state.blockhash = f.mint.toBase58();
  const result = await f.execute(); assert.equal(result.status, 'confirmed'); assert.equal(f.state.sends.length, 2);
  assert.notEqual(f.state.sends[0].signature, f.state.sends[1].signature);
  assert.deepEqual(f.service().get(f.job.id).plan, f.job.plan);
});


test('a position changed after review requires a fresh plan before wallet reservation', async (t) => {
  const f = await fixture(t), account = f.state.accounts.get(f.position.toBase58());
  const position = PositionInfoLayout.decode(account.data); position.liquidity = new BN(1); PositionInfoLayout.encode(position, account.data);
  await assert.rejects(f.execute(), { code: 'POSITION_CHANGED' }); assert.equal(f.state.sends.length, 0);
  assert.equal(f.store.getWalletWorkflow(f.input.walletPublicKey), null);
  const refreshed = await f.service().prepare({ ...f.input, key: 'changed-position', requestId: 'changed-position', expectedLiquidity: '1' });
  assert.equal(refreshed.plan.liquidity, '1'); assert.equal(refreshed.state, 'prepared');
});
