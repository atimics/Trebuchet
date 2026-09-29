import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SystemProgram, PublicKey } from '@solana/web3.js';
import { AccountLayout } from '@solana/spl-token';
import { PoolInfoLayout, SqrtPriceMath } from '@raydium-io/raydium-sdk-v2';
import { acquireProfileOwner } from '../src/owner.js';
import { openRuntimeStore, RecoveryStorageError } from '../src/store.js';
import { createSolanaSigner } from '../src/solana.js';
import { createSupportPositionService } from '../src/support-position.js';
import { supportChain, supportWallet, supportNft } from './fixtures/support-position-chain.mjs';
import { info } from './fixtures/position-withdrawal-chain.mjs';

async function fixture(t, variant = {}) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'trebuchet-support-'));
  let owner = acquireProfileOwner(profile), store = openRuntimeStore(profile), clock = 1000;
  t.after(() => { store.close(); owner.release(); fs.rmSync(profile, { recursive: true, force: true }); });
  const f = supportChain(variant), options = { owner, store, connection: f.connection,
    signer: createSolanaSigner({ getSigners: async () => [supportWallet, supportNft] }), network: 'mainnet', expectedGenesisHash: f.state.genesisHash,
    authorize: async () => true, now: () => clock, timeoutMs: 0 };
  const service = () => createSupportPositionService(options), job = await service().prepare(f.input);
  const approval = { id: 'approved-support', scopeId: f.input.scopeId, key: f.input.key, walletPublicKey: f.input.walletPublicKey,
    network: options.network, genesisHash: options.expectedGenesisHash, planDigest: job.digest, maxSpendLamports: job.plan.maxSpendLamports, expiresAtMs: 2000 };
  return { ...f, options, profile, service, job, approval, execute: () => service().execute({ id: job.id, approval }), get store() { return store; },
    setNow(value) { clock = value; }, reopen() { store.close(); owner.release(); owner = acquireProfileOwner(profile); store = openRuntimeStore(profile); Object.assign(options, { owner, store }); } };
}

for (const variant of [{}, { mintSeed: 58 }, { mintSeed: 58, nft2022: false, token2022: true }, { nft2022: false }, { token2022: true }, { existing: true }, { nft2022: false, token2022: true }]) {
  test(`support saves approval and signed bytes before its exact atomic deposit: ${JSON.stringify(variant)}`, async (t) => {
    const f = await fixture(t, variant), before = f.state.accounts.get(f.input.walletPublicKey).lamports;
    assert.equal(f.job.state, 'prepared'); assert.equal(f.store.getWalletWorkflow(f.input.walletPublicKey), null); assert.equal(f.state.sends.length, 0);
    f.state.beforeSend = (tx) => {
      const operation = f.store.getActiveOperation(f.input.walletPublicKey);
      assert.equal(f.store.getWalletWorkflow(f.input.walletPublicKey).id, f.job.id);
      assert.equal(f.store.getTransactions(operation.id)[0].signature, tx.signature); assert.ok(f.store.getOperationApprovals(operation.id).length);
    };
    const result = await f.execute();
    assert.equal(result.status, 'confirmed'); assert.equal(result.depositedRaw, f.job.plan.depositedRaw); assert.equal(result.liquidity, f.job.plan.liquidity);
    assert.equal(result.feeLamports, 80000); assert.equal(before - f.state.accounts.get(f.input.walletPublicKey).lamports, result.spentLamports);
    assert.equal(result.grossDebitLamports - result.returnedLamports, result.spentLamports); assert.equal(f.state.accounts.has(f.job.plan.temporaryAccount), false);
    assert.equal(f.store.getWalletWorkflow(f.input.walletPublicKey), null); assert.equal(f.state.sends.length, 1);
    if (variant.existing) assert.equal(AccountLayout.decode(f.state.accounts.get(f.job.plan.tokenAccount).data).amount, 1234n);
    f.reopen(); f.connection.getGenesisHash = () => { throw new Error('offline'); };
    assert.deepEqual(await f.service().execute({ id: f.job.id }), result);
  });
}

test('support restart recovers the original signature after a lost reply with expired approval', async (t) => {
  const f = await fixture(t); f.state.afterSend = () => { throw new Error('lost response'); };
  await assert.rejects(f.execute(), /lost response/); f.reopen(); f.state.afterSend = null; f.setNow(3000);
  const result = await f.service().execute({ id: f.job.id }); assert.equal(result.status, 'confirmed'); assert.equal(f.state.sends.length, 1);
});

for (const field of ['scopeId', 'key', 'walletPublicKey', 'network', 'genesisHash', 'planDigest', 'maxSpendLamports', 'expiresAtMs']) {
  test(`support approval binds ${field} before wallet reservation`, async (t) => {
    const f = await fixture(t); f.approval[field] = ['maxSpendLamports', 'expiresAtMs'].includes(field) ? 0 : 'changed';
    await assert.rejects(f.execute(), { code: 'EXECUTION_APPROVAL_REQUIRED' }); assert.equal(f.state.sends.length, 0); assert.equal(f.store.getWalletWorkflow(f.input.walletPublicKey), null);
  });
}

test('support funding includes the deposit and every rent and fee ceiling', async (t) => {
  const f = await fixture(t); f.state.accounts.get(f.input.walletPublicKey).lamports = f.job.plan.maxSpendLamports - 1;
  await assert.rejects(f.execute(), { code: 'INSUFFICIENT_FUNDS' }); assert.equal(f.state.sends.length, 0); assert.equal(f.store.getWalletWorkflow(f.input.walletPublicKey), null);
});

test('a reviewed range entering the price requires a fresh support review', async (t) => {
  const f = await fixture(t), account = f.state.accounts.get(f.poolId.toBase58()), pool = PoolInfoLayout.decode(account.data);
  pool.sqrtPriceX64 = SqrtPriceMath.getSqrtPriceX64FromTick(200); PoolInfoLayout.encode(pool, account.data);
  await assert.rejects(f.execute(), { code: 'SUPPORT_PLAN_CHANGED' }); assert.equal(f.state.sends.length, 0); assert.equal(f.store.getWalletWorkflow(f.input.walletPublicKey), null);
});

test('an existing position identity holds support until its original receipt is found', async (t) => {
  const f = await fixture(t); f.set(f.position, info(SystemProgram.programId, Buffer.alloc(0), 1000000));
  await assert.rejects(f.execute(), { code: 'SUPPORT_POSITION_EXISTS' }); assert.equal(f.state.sends.length, 0); assert.equal(f.store.getWalletWorkflow(f.input.walletPublicKey), null);
});

test('support clients share the profile owner guard', async (t) => {
  const f = await fixture(t); let enter, release;
  const entered = new Promise((r) => { enter = r; }), gate = new Promise((r) => { release = r; });
  f.state.beforeSend = async () => { enter(); await gate; }; const running = f.execute(); await entered;
  try { await assert.rejects(f.execute(), { code: 'OPERATION_IN_FLIGHT' }); } finally { release(); }
  assert.equal((await running).status, 'confirmed'); assert.equal(f.state.sends.length, 1);
});

test('a failed atomic support transaction retains its fee before wallet release', async (t) => {
  const f = await fixture(t); f.state.fail = true; await assert.rejects(f.execute(), { code: 'TRANSACTION_FAILED' });
  const job = f.service().get(f.job.id); assert.equal(job.state, 'failed'); assert.equal(job.result.feeLamports, 80000);
  assert.equal(job.result.returnedLamports, 0); assert.equal(f.state.accounts.has(f.position.toBase58()), false); assert.equal(f.store.getWalletWorkflow(f.input.walletPublicKey), null);
  f.reopen(); f.connection.getGenesisHash = () => { throw new Error('offline'); }; assert.equal((await f.service().execute({ id: f.job.id })).status, 'failed');
});

for (const boundary of ['approval', 'signed transaction', 'final receipt']) {
  test(`support preserves recovery after failed ${boundary} storage`, async (t) => {
    const f = await fixture(t), method = boundary === 'approval' ? 'recordOperationApproval' : boundary === 'signed transaction' ? 'recordSignedTransaction' : 'finishWalletWorkflow';
    const original = f.store[method]; f.store[method] = () => { throw new RecoveryStorageError('failed commit'); };
    await assert.rejects(f.execute(), { code: 'RECOVERY_STORAGE_UNAVAILABLE' }); assert.ok(f.store.getWalletWorkflow(f.input.walletPublicKey));
    assert.equal(f.state.sends.length, boundary === 'final receipt' ? 1 : 0); f.store[method] = original;
    assert.equal((await f.execute()).status, 'confirmed'); assert.equal(f.state.sends.length, 1);
  });
}

for (const changed of ['deposit', 'native lamports', 'other token', 'nft mint', 'position rent', 'extra account', 'wallet', 'token rows', 'fee', 'signature', 'message', 'slot']) {
  test(`changed support receipt holds recovery: ${changed}`, async (t) => {
    const f = await fixture(t), plan = f.job.plan, index = (address) => plan.accountKeys.indexOf(address);
    f.state.receiptTransform = (receipt) => {
      const r = { ...receipt, transaction: { ...receipt.transaction }, meta: { ...receipt.meta, preBalances: receipt.meta.preBalances.slice(), postBalances: receipt.meta.postBalances.slice(),
        preTokenBalances: structuredClone(receipt.meta.preTokenBalances), postTokenBalances: structuredClone(receipt.meta.postTokenBalances) } };
      const token = (address) => r.meta.postTokenBalances.find((row) => row.accountIndex === index(address));
      if (changed === 'deposit') token(plan.nativeVault).uiTokenAmount.amount = r.meta.preTokenBalances.find((row) => row.accountIndex === index(plan.nativeVault)).uiTokenAmount.amount;
      if (changed === 'native lamports') r.meta.postBalances[index(plan.nativeVault)]++;
      if (changed === 'other token') token(plan.tokenAccount).uiTokenAmount.amount = '1';
      if (changed === 'nft mint') token(plan.nftAccount).uiTokenAmount.amount = '0';
      if (changed === 'position rent') r.meta.postBalances[index(plan.positionAddress)] = 0;
      if (changed === 'extra account') r.meta.postBalances[index(plan.poolId)]++;
      if (changed === 'wallet') r.meta.postBalances[0]++;
      if (changed === 'token rows') r.meta.postTokenBalances.push(token(plan.nftAccount));
      if (changed === 'fee') r.meta.fee++;
      if (changed === 'signature') r.transaction.signatures = [];
      if (changed === 'message') r.transaction.message = { serialize: () => new Uint8Array([0]) };
      if (changed === 'slot') r.slot = 0;
      return r;
    };
    await assert.rejects(f.execute(), { code: 'CHAIN_STATE_UNAVAILABLE' }); assert.ok(f.store.getWalletWorkflow(f.input.walletPublicKey));
    f.state.receiptTransform = (r) => r; assert.equal((await f.service().execute({ id: f.job.id })).status, 'confirmed'); assert.equal(f.state.sends.length, 1);
  });
}

test('later position closure and wallet transfers preserve the original support receipt', async (t) => {
  const f = await fixture(t); f.state.afterSend = () => { throw new Error('lost response'); }; await assert.rejects(f.execute(), /lost response/); f.state.afterSend = null;
  for (const address of [f.nft, f.nftAccount, f.position]) f.state.accounts.delete(address.toBase58());
  f.state.accounts.get(f.input.walletPublicKey).lamports += 300000000;
  assert.equal((await f.execute()).status, 'confirmed'); assert.equal(f.state.sends.length, 1);
});

test('a changed saved support witness pauses offline replay', async (t) => {
  const f = await fixture(t); await f.execute(); const records = f.store.collection('runtime-support-positions/v1'), jobs = records.load();
  jobs[0].witness.postBalances[0]++; records.save(jobs);
  assert.throws(() => f.service().get(f.job.id), { code: 'RECOVERY_STORAGE_UNAVAILABLE' });
});

test('output and tick-array prefunding reduce the actual support rent', async (t) => {
  const f = await fixture(t); f.set(new PublicKey(f.job.plan.tokenAccount), info(SystemProgram.programId, Buffer.alloc(0), 1000000));
  const tick = f.job.plan.rents.find((row) => row.type === 'tick-array'); f.set(new PublicKey(tick.address), info(SystemProgram.programId, Buffer.alloc(0), 500000));
  const result = await f.execute(), expected = f.job.plan.rentCeilingLamports - f.job.plan.rents.find((row) => row.type === 'protocol-position').rentCeilingLamports - 1500000;
  assert.equal(result.rentLamports, expected);
});

test('support requires renewed approval for an identical rebroadcast', async (t) => {
  const f = await fixture(t); f.state.drop = true; await assert.rejects(f.execute(), { code: 'CHAIN_STATE_UNAVAILABLE' }); const wire = f.state.sends[0].wire;
  f.setNow(3000); f.state.drop = false; await assert.rejects(f.execute(), { code: 'EXECUTION_APPROVAL_REQUIRED' }); assert.equal(f.state.sends.length, 1);
  assert.equal((await f.service().execute({ id: f.job.id, approval: { ...f.approval, id: 'renewed', expiresAtMs: 4000 } })).status, 'confirmed'); assert.equal(f.state.sends[1].wire, wire);
});

test('support replacement after expiry preserves its NFT, liquidity, and deposit', async (t) => {
  const f = await fixture(t); f.state.drop = true; await assert.rejects(f.execute(), { code: 'CHAIN_STATE_UNAVAILABLE' });
  f.state.drop = false; f.state.height = 501; f.state.valid = false; f.state.blockhash = f.mint.toBase58();
  assert.equal((await f.execute()).status, 'confirmed'); assert.equal(f.state.sends.length, 2); assert.notEqual(f.state.sends[0].signature, f.state.sends[1].signature);
  assert.deepEqual(f.service().get(f.job.id).plan, f.job.plan);
});

test('a saved support identity keeps its original request', async (t) => {
  const f = await fixture(t); assert.deepEqual(await f.service().prepare(f.input), f.job);
  await assert.rejects(f.service().prepare({ ...f.input, depositLamports: '20000000' }), { code: 'OPERATION_CONFLICT' });
  assert.equal(f.state.sends.length, 0);
});

test('support requires its recoverable NFT signer before submission', async (t) => {
  const f = await fixture(t), signer = f.options.signer;
  f.options.signer = createSolanaSigner({ getSigners: async () => [supportWallet] });
  await assert.rejects(f.execute()); assert.equal(f.state.sends.length, 0); assert.ok(f.store.getWalletWorkflow(f.input.walletPublicKey));
  f.options.signer = signer; assert.equal((await f.execute()).status, 'confirmed'); assert.equal(f.state.sends.length, 1);
});

test('failed support review storage leaves the wallet available', async (t) => {
  const f = await fixture(t), collection = f.store.collection;
  f.store.collection = (name) => { const records = collection(name); return name === 'runtime-support-positions/v1'
    ? { ...records, save() { throw new RecoveryStorageError('failed review commit'); } } : records; };
  await assert.rejects(f.service().prepare({ ...f.input, key: 'second', requestId: 'second' }), { code: 'RECOVERY_STORAGE_UNAVAILABLE' });
  assert.equal(f.state.sends.length, 0); assert.equal(f.store.getWalletWorkflow(f.input.walletPublicKey), null);
});

test('an uncertain failed support fee retains wallet admission', async (t) => {
  const f = await fixture(t); f.state.fail = true; f.state.receiptTransform = (r) => ({ ...r, meta: { ...r.meta, fee: r.meta.fee + 1 } });
  await assert.rejects(f.execute(), { code: 'CHAIN_STATE_UNAVAILABLE' }); assert.ok(f.store.getWalletWorkflow(f.input.walletPublicKey));
  f.state.receiptTransform = (r) => r; await assert.rejects(f.execute(), { code: 'TRANSACTION_FAILED' });
  assert.equal(f.service().get(f.job.id).result.feeLamports, 80000); assert.equal(f.store.getWalletWorkflow(f.input.walletPublicKey), null); assert.equal(f.state.sends.length, 1);
});
