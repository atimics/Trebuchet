import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireProfileOwner } from '@trebuchet/runtime/owner';
import { openRuntimeStore, RecoveryStorageError, publicJson } from '@trebuchet/runtime/store';
import { createSolanaSigner, SOLANA_GENESIS_HASHES } from '@trebuchet/runtime/solana';
import { createStoragePaymentService } from '@trebuchet/runtime/storage-payment';
import { createUploadService } from '@trebuchet/runtime/upload';
import { createUploadStore, uploadDigest } from '@trebuchet/runtime/upload-store';
import { uploadChain, sweepWallet, uploadNodeUrl } from './fixtures/upload-chain.mjs';

function fixture(t) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'trebuchet-upload-')), owner = acquireProfileOwner(profile), store = openRuntimeStore(profile);
  t.after(() => { store.close(); owner.release(); fs.rmSync(profile, { recursive: true, force: true }); });
  const ledger = uploadChain(), walletPublicKey = sweepWallet.publicKey.toBase58(), uploadStore = createUploadStore({ owner, store });
  const payment = createStoragePaymentService({ owner, store, connection: ledger.connection, network: 'devnet', expectedGenesisHash: SOLANA_GENESIS_HASHES.devnet,
    signer: createSolanaSigner({ getSigners: async () => [sweepWallet] }), authorize: async () => true, timeoutMs: 0,
    feePolicy: async () => ({ computeUnitLimit: 1000, microLamports: 1000, feeCeilingLamports: 10000 }) });
  const bytes = Buffer.from('{"name":"Durable Token"}');
  const approval = { id: 'upload-approval', scopeId: 'journal-a', walletPublicKey, network: 'devnet', genesisHash: SOLANA_GENESIS_HASHES.devnet,
    uploadKey: 'sealed/metadata', tagsDigest: uploadDigest(publicJson([{ name: 'Content-Type', value: 'application/json' }])), contentDigest: uploadDigest(bytes), nodeUrl: uploadNodeUrl, expiresAtMs: Date.now() + 60000, maxUploadLamports: 100000 };
  const options = { owner, store, uploadStore, network: 'devnet', expectedGenesisHash: SOLANA_GENESIS_HASHES.devnet, transport: ledger.transport, authorize: async () => true,
    pay: async ({ job, plan }) => payment.execute({ scopeId: job.plan.scopeId, walletPublicKey, plan, workflowId: job.id, approval: {
      ...approval, id: 'payment-approval', planDigest: payment.planDigest(plan), maxSpendLamports: 100000,
    } }) };
  const input = { scopeId: 'journal-a', walletPublicKey, key: 'sealed/metadata', bytes, tags: [{ name: 'Content-Type', value: 'application/json' }], approval };
  const service = createUploadService(options);
  return { ...ledger, profile, owner, store, uploadStore, payment, input, options, service, run: () => service.upload(input) };
}

test('a signed upload and approval commit before funding and upload, with a verified node receipt', async (t) => {
  const f = fixture(t);
  f.state.beforeSend = () => {
    const job = f.uploadStore.active(f.input.walletPublicKey);
    assert.ok(job.approvals.length); assert.ok(f.uploadStore.read(job.plan.wireDigest).length);
    const operation = f.store.getActiveOperation(f.input.walletPublicKey);
    assert.equal(f.store.getTransactions(operation.id).length, 1);
  };
  f.state.beforeUpload = (item) => {
    const job = f.uploadStore.active(f.input.walletPublicKey);
    assert.equal(job.state, 'uploading'); assert.equal(job.plan.itemId, item.id); assert.equal(job.fundingReceipt.txId, f.state.sends[0].signature);
    assert.equal(job.fundingAcknowledged, true); assert.ok(job.approvals.length);
  };
  const result = await f.run();
  assert.equal(result.receipt.id, result.uploadId); assert.equal(f.state.sends.length, 1); assert.equal(f.state.uploadAttempts, 1);
  f.irys.api.get = async () => { throw new Error('offline'); };
  assert.deepEqual(await f.run(), result); assert.equal(f.state.uploadAttempts, 1);
});

for (const stage of ['payment', 'acknowledgement', 'upload']) {
  test(`a lost ${stage} reply resumes the same payment and signed upload`, async (t) => {
    const f = fixture(t);
    const fail = () => { throw new Error('fixture lost reply'); };
    if (stage === 'payment') f.state.afterSend = fail;
    if (stage === 'acknowledgement') f.state.afterAcknowledge = fail;
    if (stage === 'upload') f.state.afterUpload = fail;
    await assert.rejects(f.run(), /fixture lost reply/);
    const job = f.uploadStore.active(f.input.walletPublicKey), wire = f.uploadStore.read(job.plan.wireDigest);
    f.state.afterSend = null; f.state.afterAcknowledge = null; f.state.afterUpload = null;
    const fresh = createUploadService(f.options);
    const result = await fresh.recover(f.input);
    assert.equal(result.uploadId, job.plan.itemId); assert.equal(f.state.sends.length, 1); assert.equal(f.state.uploadAttempts, 1);
    assert.deepEqual(f.state.uploadWires[0], wire); assert.equal(f.uploadStore.active(f.input.walletPublicKey), null);
  });
}

for (const method of ['put', 'prepare', 'recordApproval']) {
  test(`a failed ${method} upload commit stops spending`, async (t) => {
    const f = fixture(t), original = f.uploadStore[method];
    f.uploadStore[method] = () => { throw new RecoveryStorageError('fixture failed commit'); };
    await assert.rejects(f.run(), { code: 'RECOVERY_STORAGE_UNAVAILABLE' });
    assert.equal(f.state.sends.length, 0); assert.equal(f.state.uploadAttempts, 0);
    f.uploadStore[method] = original; await f.run();
    assert.equal(f.state.sends.length, 1); assert.equal(f.state.uploadAttempts, 1);
  });
}

test('a failed final upload receipt commit recovers its original remote receipt', async (t) => {
  const f = fixture(t), update = f.uploadStore.update;
  f.uploadStore.update = (id, patch) => { if (patch.state === 'confirmed') throw new RecoveryStorageError('fixture final commit'); return update(id, patch); };
  await assert.rejects(f.run(), { code: 'RECOVERY_STORAGE_UNAVAILABLE' });
  f.uploadStore.update = update;
  await f.service.recover(f.input); assert.equal(f.state.sends.length, 1); assert.equal(f.state.uploadAttempts, 1);
});

test('corrupt signed upload bytes are preserved and stop recovery before payment', async (t) => {
  const f = fixture(t); f.state.beforeSend = () => { throw new Error('fixture offline'); };
  await assert.rejects(f.run(), /fixture offline/);
  const job = f.uploadStore.active(f.input.walletPublicKey), file = path.join(f.profile, 'upload-data', job.plan.wireDigest);
  const damaged = Buffer.from('damaged upload'); fs.writeFileSync(file, damaged);
  f.state.beforeSend = null;
  await assert.rejects(f.service.recover(f.input), { code: 'RECOVERY_STORAGE_UNAVAILABLE' });
  assert.deepEqual(fs.readFileSync(file), damaged); assert.equal(f.state.sends.length, 0);
});

for (const change of ['content', 'tags', 'receipt-key', 'receipt-signature', 'receipt-id', 'lookup', 'price']) {
  test(`a changed ${change} pauses the saved upload`, async (t) => {
    const f = fixture(t); f.state.beforeUpload = () => { throw new Error('fixture interrupted upload'); };
    await assert.rejects(f.run(), /fixture interrupted upload/); f.state.beforeUpload = null;
    let run = () => f.service.recover(f.input);
    if (change === 'content') run = () => f.service.upload({ ...f.input, bytes: Buffer.from('changed') });
    if (change === 'tags') run = () => f.service.upload({ ...f.input, tags: [] });
    if (change === 'receipt-key') f.state.receiptKey = 'c'.repeat(342);
    if (change === 'receipt-signature') f.state.uploadReceiptTransform = (receipt) => ({ ...receipt, signature: 'a'.repeat(receipt.signature.length) });
    if (change === 'receipt-id') f.state.uploadReceiptTransform = (receipt) => ({ ...receipt, id: 'a'.repeat(43) });
    if (change === 'lookup') f.state.lookupTransform = () => ({ status: 200, data: { errors: [{ message: 'unavailable' }] } });
    if (change === 'price') f.state.storagePrice++;
    await assert.rejects(run());
    assert.ok(f.uploadStore.active(f.input.walletPublicKey)); assert.equal(f.state.sends.length, 1);
    if (!change.startsWith('receipt-') || change === 'receipt-key') assert.equal(f.state.uploadAttempts, 0);
  });
}

test('existing storage credit pays for a verified upload with zero chain payments', async (t) => {
  const f = fixture(t); f.state.storageBalance = f.state.storagePrice;
  const result = await f.run();
  assert.equal(result.fundingReceipt, null); assert.equal(f.state.sends.length, 0); assert.equal(f.state.uploadAttempts, 1);
});

test('an expired approval can recover a verified receipt and holds a pending upload', async (t) => {
  const f = fixture(t); f.state.afterUpload = () => { throw new Error('reply lost'); };
  await assert.rejects(f.run(), /reply lost/); f.state.afterUpload = null;
  const input = { ...f.input, approval: { ...f.input.approval, id: 'expired', expiresAtMs: 0 } };
  f.state.hideReceipts = true;
  await assert.rejects(f.service.recover(input), { code: 'EXECUTION_APPROVAL_REQUIRED' });
  f.state.hideReceipts = false;
  await f.service.recover(input); assert.equal(f.state.uploadAttempts, 1);
});

test('a base64url node receipt recovers the exact data item named by its base58 SDK ID', async (t) => {
  const f = fixture(t); f.state.receiptEncoding = 'base64url';
  f.state.afterUpload = () => { throw new Error('reply lost'); };
  await assert.rejects(f.run(), /reply lost/); f.state.afterUpload = null;
  const job = f.uploadStore.active(f.input.walletPublicKey);
  const result = await f.service.recover(f.input);
  assert.equal(Buffer.from(result.receipt.id, 'base64url').toString('hex'), job.plan.itemDigest);
  assert.equal(result.uri, `https://gateway.example.invalid/${result.receipt.id}`);
  assert.equal(f.state.sends.length, 1); assert.equal(f.state.uploadAttempts, 1);
});

for (const field of ['scopeId', 'walletPublicKey', 'network', 'genesisHash', 'contentDigest', 'nodeUrl', 'uploadKey', 'tagsDigest', 'expiresAtMs', 'maxUploadLamports']) {
  test(`upload approval binds ${field} before payment`, async (t) => {
    const f = fixture(t); f.input.approval[field] = ['expiresAtMs', 'maxUploadLamports'].includes(field) ? 0 : 'changed';
    await assert.rejects(f.run(), { code: 'EXECUTION_APPROVAL_REQUIRED' });
    assert.equal(f.state.sends.length, 0); assert.equal(f.state.uploadAttempts, 0);
    assert.equal(f.uploadStore.active(f.input.walletPublicKey), null); assert.equal(f.store.getWalletWorkflow(f.input.walletPublicKey), null);
  });
}

test('a pending upload reserves its wallet across store reopen and releases it with the receipt', async (t) => {
  const f = fixture(t); f.state.beforeUpload = () => { throw new Error('fixture paused'); };
  await assert.rejects(f.run(), /fixture paused/); f.state.beforeUpload = null;
  const other = openRuntimeStore(f.profile);
  try {
    const job = f.uploadStore.active(f.input.walletPublicKey);
    assert.equal(other.getWalletWorkflow(f.input.walletPublicKey).id, job.id);
    other.saveLaunch({ id: 'competing', walletPublicKey: f.input.walletPublicKey, network: 'devnet', planDigest: 'a'.repeat(64), config: {} });
    assert.throws(() => other.prepareOperation({ launchId: 'competing', kind: 'fixture' }), { code: 'OPERATION_IN_FLIGHT' });
    await f.service.recover(f.input);
    assert.equal(other.getWalletWorkflow(f.input.walletPublicKey), null);
    assert.ok(other.prepareOperation({ launchId: 'competing', kind: 'fixture' }).id);
  } finally { other.close(); }
});

test('an active chain operation stops upload reservation before spending', async (t) => {
  const f = fixture(t);
  const prepare = f.transport.prepare;
  f.transport.prepare = async (...args) => {
    const wire = await prepare(...args);
    f.store.saveLaunch({ id: 'competing', walletPublicKey: f.input.walletPublicKey, network: 'devnet', planDigest: 'a'.repeat(64), config: {} });
    f.store.prepareOperation({ launchId: 'competing', kind: 'fixture' });
    return wire;
  };
  await assert.rejects(f.run(), { code: 'OPERATION_IN_FLIGHT' });
  assert.equal(f.state.sends.length, 0); assert.equal(f.store.getWalletWorkflow(f.input.walletPublicKey), null);
  assert.equal(f.uploadStore.active(f.input.walletPublicKey), null);
});

test('a failed wallet reservation release preserves the pending upload and its receipt recovery', async (t) => {
  const f = fixture(t), finish = f.store.finishWalletWorkflow;
  f.store.finishWalletWorkflow = () => { throw new RecoveryStorageError('fixture workflow commit'); };
  await assert.rejects(f.run(), { code: 'RECOVERY_STORAGE_UNAVAILABLE' });
  assert.equal(f.uploadStore.active(f.input.walletPublicKey).state, 'uploading');
  assert.ok(f.store.getWalletWorkflow(f.input.walletPublicKey));
  f.store.finishWalletWorkflow = finish;
  await f.service.recover(f.input); assert.equal(f.state.sends.length, 1); assert.equal(f.state.uploadAttempts, 1);
});

test('competing upload clients preserve one signed asset and payment', async (t) => {
  const f = fixture(t); let arrived, release;
  const started = new Promise((resolve) => { arrived = resolve; }), gate = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  f.state.beforeUpload = async () => { arrived(); await gate; };
  const first = f.run(); await started;
  await assert.rejects(createUploadService(f.options).upload(f.input), { code: 'OPERATION_IN_FLIGHT' });
  release(); await first; assert.equal(f.state.sends.length, 1); assert.equal(f.state.uploadAttempts, 1);
});

test('a pending signed upload keeps its node deposit after a delayed remote receipt', async (t) => {
  const f = fixture(t); f.state.afterUpload = () => { throw new Error('reply lost'); };
  await assert.rejects(f.run(), /reply lost/); f.state.afterUpload = null; f.state.hideReceipts = true;
  await assert.rejects(f.service.recover(f.input), { code: 'EXECUTION_RECOVERY_REQUIRED' });
  assert.equal(f.state.sends.length, 1); assert.equal(f.state.uploadAttempts, 1);
  f.state.hideReceipts = false; await f.service.recover(f.input);
  assert.equal(f.state.sends.length, 1); assert.equal(f.state.uploadAttempts, 1);
});

test('a dangling upload-file link is preserved during recovery', async (t) => {
  const f = fixture(t), bytes = Buffer.from('test bytes'), digest = uploadDigest(bytes);
  const directory = path.join(f.profile, 'upload-data'); fs.mkdirSync(directory, { mode: 0o700 });
  const target = path.join(directory, digest); fs.symlinkSync(path.join(f.profile, 'missing'), target);
  assert.throws(() => f.uploadStore.put(bytes), { code: 'RECOVERY_STORAGE_UNAVAILABLE' });
  assert.equal(fs.lstatSync(target).isSymbolicLink(), true);
});

for (const change of ['expiry', 'authorization', 'ownership']) {
  test(`upload waits after ${change} changes during the final price read`, async (t) => {
    const f = fixture(t), quote = f.transport.quote; let reads = 0, allowed = true;
    f.options.authorize = async () => allowed;
    const service = createUploadService(f.options);
    f.transport.quote = async (...args) => {
      const price = await quote(...args);
      if (++reads === 2) {
        if (change === 'expiry') f.input.approval.expiresAtMs = 0;
        if (change === 'authorization') allowed = false;
        if (change === 'ownership') f.owner.release();
      }
      return price;
    };
    await assert.rejects(service.upload(f.input), { code: change === 'ownership' ? 'RUNTIME_OWNER_RELEASED' : 'EXECUTION_APPROVAL_REQUIRED' });
    assert.equal(f.state.sends.length, 1); assert.equal(f.state.uploadAttempts, 0);
    assert.equal(f.uploadStore.active(f.input.walletPublicKey).state, 'funded');
    assert.ok(f.store.getWalletWorkflow(f.input.walletPublicKey));
  });
}

test('upload approval renewal preserves the original approval and funding receipt', async (t) => {
  const f = fixture(t); f.state.beforeUpload = () => { throw new Error('fixture paused upload'); };
  await assert.rejects(f.run(), /fixture paused upload/); f.state.beforeUpload = null;
  const job = f.uploadStore.active(f.input.walletPublicKey), original = job.approvals[0];
  const approval = { ...f.input.approval, expiresAtMs: f.input.approval.expiresAtMs + 60000 };
  await assert.rejects(f.service.recover({ ...f.input, approval }), { code: 'OPERATION_CONFLICT' });
  const result = await f.service.recover({ ...f.input, approval: { ...approval, id: 'renewed-upload-approval' } });
  const saved = f.uploadStore.get(job.id);
  assert.deepEqual(saved.approvals[0], original); assert.equal(saved.approvals.length, 2);
  assert.equal(saved.approvals[1].uploadPlanDigest, original.uploadPlanDigest);
  assert.equal(result.fundingReceipt.txId, job.fundingReceipt.txId);
  assert.equal(f.state.sends.length, 1); assert.equal(f.state.uploadAttempts, 1);
});

for (const change of ['missing-response', 'duplicate-receipt', 'unrelated-receipt']) {
  test(`receipt lookup preserves the saved upload after ${change}`, async (t) => {
    const f = fixture(t); f.state.afterUpload = () => { throw new Error('reply lost'); };
    await assert.rejects(f.run(), /reply lost/); f.state.afterUpload = null;
    const transform = f.state.lookupTransform;
    f.state.lookupTransform = (response) => {
      if (change === 'missing-response') return { status: 200, data: {} };
      const edges = response.data.data.transactions.edges;
      if (change === 'duplicate-receipt') edges.push(edges[0]);
      if (change === 'unrelated-receipt') edges[0].node.id = 'A'.repeat(43);
      return response;
    };
    await assert.rejects(f.service.recover(f.input));
    assert.ok(f.uploadStore.active(f.input.walletPublicKey));
    assert.equal(f.state.sends.length, 1); assert.equal(f.state.uploadAttempts, 1);
    f.state.lookupTransform = transform;
    await f.service.recover(f.input); assert.equal(f.state.uploadAttempts, 1);
  });
}
