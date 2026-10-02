import { PublicKey } from '@solana/web3.js';
import { publicJson } from './store.js';
import { createUploadStore, uploadDigest, UPLOAD_BYTE_LIMIT } from './upload-store.js';
import { normalizeStoragePaymentPlan, uploadIdCandidates } from './storage-payment.js';

const busy = new WeakMap();
const hash = (value) => uploadDigest(publicJson(value));
const whole = (value) => Number.isSafeInteger(value) && value >= 0;
const failure = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });
const paused = (message) => failure('EXECUTION_RECOVERY_REQUIRED', message);
const normalizeTags = (tags) => {
  if (!Array.isArray(tags) || tags.length > 16 || tags.some((tag) => typeof tag?.name !== 'string' || typeof tag.value !== 'string'
      || !tag.name || Buffer.byteLength(tag.name) > 128 || Buffer.byteLength(tag.value) > 1024)) throw new TypeError('Use bounded upload tags');
  return tags.map(({ name, value }) => ({ name, value }));
};
const identity = (value) => {
  const result = normalizeStoragePaymentPlan({ destinationWallet: value.paymentAddress, nodeUrl: value.nodeUrl, nodeReceiptKey: value.receiptKey,
    amountLamports: 1, uploadId: 'A'.repeat(43), contentDigest: 'a'.repeat(64) });
  const gateway = new URL(value.gatewayUrl);
  if (gateway.protocol !== 'https:' || gateway.username || gateway.password || gateway.search || gateway.hash || gateway.pathname !== '/') throw new TypeError('Use the saved HTTPS storage gateway origin');
  return { nodeUrl: result.nodeUrl, paymentAddress: result.destinationWallet, receiptKey: result.nodeReceiptKey, gatewayUrl: gateway.origin };
};

// The host supplies the storage protocol and its existing signer. Payments use
// the shared transaction engine; public signed upload bytes commit first.
export function createUploadService({ owner, store, network, expectedGenesisHash, transport, pay, authorize, now = Date.now, uploadStore = createUploadStore({ owner, store }) }) {
  if (!['mainnet', 'devnet', 'localnet'].includes(network) || !expectedGenesisHash || typeof pay !== 'function' || typeof authorize !== 'function') throw new TypeError('Supply the upload network, payment, and approval interfaces');
  if (['identity', 'prepare', 'inspect', 'quote', 'balance', 'acknowledge', 'findReceipt', 'upload', 'verifyReceipt'].some((name) => typeof transport?.[name] !== 'function')) throw new TypeError('Supply the complete upload transport');
  if (!busy.has(owner)) busy.set(owner, new Set());
  const result = (job) => ({ uploadId: job.plan.itemId, uri: `${job.plan.node.gatewayUrl}/${job.receipt.id}`, receipt: job.receipt,
    operationId: job.id, fundingReceipt: job.fundingReceipt });
  const checkSigned = async (plan) => {
    const wire = uploadStore.read(plan.wireDigest), actual = await transport.inspect(wire);
    if (actual.id !== plan.itemId || actual.rawId !== plan.itemDigest || actual.walletPublicKey !== plan.walletPublicKey || actual.contentDigest !== plan.contentDigest
        || actual.byteLength !== plan.byteLength || publicJson(actual.tags) !== publicJson(plan.tags)) throw paused('Verify the saved signed upload bytes and content');
    return wire;
  };
  const approvalFor = async (approval, job) => {
    owner.assertActive();
    const plan = job.plan;
    if (!approval?.id || approval.uploadKey !== plan.key || approval.tagsDigest !== hash(plan.tags) || approval.scopeId !== plan.scopeId || approval.walletPublicKey !== plan.walletPublicKey || approval.network !== network
        || approval.genesisHash !== expectedGenesisHash || approval.contentDigest !== plan.contentDigest || approval.nodeUrl !== plan.node.nodeUrl
        || !whole(approval.expiresAtMs) || approval.expiresAtMs <= now() || !whole(approval.maxUploadLamports) || approval.maxUploadLamports < plan.priceLamports
        || await authorize({ approval, job }) !== true) throw failure('EXECUTION_APPROVAL_REQUIRED', 'Approve the saved upload content, node, wallet, network, price, and expiry');
    owner.assertActive();
  };
  const saveReceipt = async (job, receipt) => {
    const verified = await transport.verifyReceipt(receipt, { id: job.plan.itemId, rawId: job.plan.itemDigest, publicKey: job.plan.node.receiptKey });
    owner.assertActive();
    if (!verified) throw paused('Verify the storage node receipt for the saved upload');
    return uploadStore.update(job.id, { state: 'confirmed', receipt: verified });
  };
  const resume = async (job, approval) => {
    if (job.plan.network !== network || job.plan.genesisHash !== expectedGenesisHash) throw failure('NETWORK_MISMATCH', 'Recover the upload on its saved network');
    if (job.state === 'confirmed') return result(job);
    if (store.getWalletWorkflow(job.walletPublicKey)?.id !== job.id) throw paused('Recover the saved wallet reservation before upload');
    const wire = await checkSigned(job.plan);
    if (publicJson(identity(await transport.identity())) !== publicJson(job.plan.node)) throw paused('Recover using the saved storage node, payment address, and receipt key');
    if (job.state === 'uploading') {
      const receipt = await transport.findReceipt(job.plan.itemId, job.plan.node.receiptKey, job.plan.itemDigest);
      if (receipt) return result(await saveReceipt(job, receipt));
    }
    await approvalFor(approval, job);
    uploadStore.recordApproval(job.id, { ...approval, uploadPlanDigest: hash(job.plan) });
    if (job.plan.fundingLamports && !job.fundingReceipt) {
      const fundingReceipt = await pay({ job, approval, plan: {
        nodeUrl: job.plan.node.nodeUrl, destinationWallet: job.plan.node.paymentAddress, nodeReceiptKey: job.plan.node.receiptKey,
        uploadId: job.plan.itemId, contentDigest: job.plan.contentDigest, amountLamports: job.plan.fundingLamports,
      } });
      if (!fundingReceipt?.txId || fundingReceipt.amountLamports !== job.plan.fundingLamports || fundingReceipt.destinationWallet !== job.plan.node.paymentAddress
          || fundingReceipt.uploadId !== job.plan.itemId || fundingReceipt.contentDigest !== job.plan.contentDigest) throw paused('Verify the saved storage payment receipt');
      job = uploadStore.update(job.id, { state: 'funded', fundingReceipt });
    }
    if (job.plan.fundingLamports && !job.fundingAcknowledged) {
      await transport.acknowledge(job.fundingReceipt.txId);
      job = uploadStore.update(job.id, { fundingAcknowledged: true });
    }
    const price = await transport.quote({ byteLength: wire.length, tags: job.plan.tags });
    const balance = await transport.balance(job.plan.walletPublicKey);
    if (!whole(price) || !whole(balance) || price > job.plan.priceLamports || balance < price) throw paused('Recover the saved storage price and credited payment before upload');
    await approvalFor(approval, job);
    uploadStore.recordApproval(job.id, { ...approval, uploadPlanDigest: hash(job.plan) });
    job = uploadStore.update(job.id, { state: 'uploading' });
    const receipt = await transport.upload(wire);
    return result(await saveReceipt(job, receipt));
  };
  const owned = async (walletPublicKey, run) => {
    owner.assertActive();
    if (busy.get(owner).has(walletPublicKey)) throw failure('OPERATION_IN_FLIGHT', 'The wallet has an active upload request');
    busy.get(owner).add(walletPublicKey);
    try { return await run(); }
    catch (cause) { cause.uploadOperationId = uploadStore.active(walletPublicKey)?.id; throw cause; }
    finally { busy.get(owner).delete(walletPublicKey); }
  };
  return {
    active: uploadStore.active,
    async upload({ scopeId, walletPublicKey, key, bytes, tags: inputTags, approval }) {
      if (!(bytes instanceof Uint8Array) || bytes.length > UPLOAD_BYTE_LIMIT - 4096) throw new TypeError('Use bounded public upload content');
      const wallet = new PublicKey(walletPublicKey).toBase58(), tags = normalizeTags(inputTags), contentDigest = uploadDigest(bytes);
      if (![scopeId, key].every((value) => typeof value === 'string' && value)) throw new TypeError('Use a saved launch and upload action key');
      return owned(wallet, async () => {
        const id = hash({ scopeId, walletPublicKey: wallet, network, key });
        let job = uploadStore.get(id);
        if (job) {
          if (job.plan.contentDigest !== contentDigest || job.plan.byteLength !== bytes.length || publicJson(job.plan.tags) !== publicJson(tags)) throw failure('OPERATION_CONFLICT', 'Use the exact saved upload content and tags');
          return resume(job, approval);
        }
        if (uploadStore.active(wallet) || store.getActiveOperation(wallet)) throw failure('OPERATION_IN_FLIGHT', 'Recover the active wallet operation before preparing an upload');
        const node = identity(await transport.identity()), wire = await transport.prepare(bytes, tags);
        const item = await transport.inspect(wire);
        if (!/^[a-f0-9]{64}$/.test(item.rawId) || !uploadIdCandidates(item.id).some((bytes) => bytes.toString('hex') === item.rawId)) throw paused('Verify the upload identity against its signed bytes');
        if (item.walletPublicKey !== wallet || item.contentDigest !== contentDigest || item.byteLength !== bytes.length || publicJson(item.tags) !== publicJson(tags)) throw paused('Verify the upload signer and exact content');
        const priceLamports = await transport.quote({ byteLength: wire.length, tags }), balance = await transport.balance(wallet);
        if (!whole(priceLamports) || !whole(balance)) throw paused('Read complete storage price and account balance');
        const fundingLamports = Math.max(0, priceLamports - balance);
        const plan = { scopeId, key, walletPublicKey: wallet, network, genesisHash: expectedGenesisHash, node, contentDigest, byteLength: bytes.length,
          tags, itemId: item.id, itemDigest: item.rawId, wireDigest: uploadDigest(wire), priceLamports, fundingLamports };
        await approvalFor(approval, { id, plan });
        uploadStore.put(wire);
        job = uploadStore.prepare({ id, walletPublicKey: wallet, plan });
        return resume(job, approval);
      });
    },
    recover({ walletPublicKey, approval }) {
      return owned(walletPublicKey, async () => {
        const job = uploadStore.active(walletPublicKey);
        return job ? resume(job, approval) : null;
      });
    },
  };
}
