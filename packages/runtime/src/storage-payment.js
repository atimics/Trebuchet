import { createHash } from 'node:crypto';
import bs58 from 'bs58';
import { ComputeBudgetProgram, PublicKey, SystemProgram, Transaction, VersionedTransaction } from '@solana/web3.js';
import { createPreparedTransactionService } from './prepared-transaction.js';
import { publicJson } from './store.js';

export const STORAGE_PAYMENT_KIND = 'storage-payment';
const failure = (code, message) => Object.assign(new Error(message), { code });
const paused = (message) => failure('CHAIN_STATE_UNAVAILABLE', message);
const whole = (value) => Number.isSafeInteger(value) && value >= 0;
const hash = (value) => createHash('sha256').update(publicJson(value)).digest('hex');

export function uploadIdCandidates(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{32,44}$/.test(value)) throw new TypeError('Use the saved signed upload identity');
  const candidates = [], urlBytes = Buffer.from(value, 'base64url');
  if (urlBytes.length === 32 && urlBytes.toString('base64url') === value) candidates.push(urlBytes);
  try {
    const bytes = Buffer.from(bs58.decode(value));
    if (bytes.length === 32 && bs58.encode(bytes) === value && !candidates.some((entry) => entry.equals(bytes))) candidates.push(bytes);
  } catch { /* Check both public encodings used by storage nodes. */ }
  if (!candidates.length) throw new TypeError('Use a canonical 32-byte upload identity');
  return candidates;
}

export function normalizeStoragePaymentPlan(input) {
  uploadIdCandidates(input.uploadId);
  const destinationWallet = new PublicKey(input.destinationWallet).toBase58();
  const node = new URL(input.nodeUrl);
  if (node.protocol !== 'https:' || node.username || node.password || node.search || node.hash || node.pathname !== '/') throw new TypeError('Use the saved HTTPS storage node origin');
  if (!whole(input.amountLamports) || !input.amountLamports
      || !/^[a-f0-9]{64}$/.test(input.contentDigest) || typeof input.nodeReceiptKey !== 'string' || !/^[A-Za-z0-9_-]{256,1024}$/.test(input.nodeReceiptKey)) {
    throw new TypeError('Save the complete upload identity, receipt key, and exact storage payment');
  }
  return { destinationWallet, nodeUrl: node.origin, amountLamports: input.amountLamports, uploadId: input.uploadId,
    contentDigest: input.contentDigest, nodeReceiptKey: input.nodeReceiptKey };
}

export function createStoragePaymentService({ owner, store, connection, signer, network, expectedGenesisHash, authorize, feePolicy,
  now = Date.now, timeoutMs = 60000, pollIntervalMs = 500 }) {
  if (typeof feePolicy !== 'function') throw new TypeError('Supply a storage payment fee policy');
  const service = createPreparedTransactionService({ owner, store, connection, signer, kind: STORAGE_PAYMENT_KIND,
    network, expectedGenesisHash, authorize, now, timeoutMs, pollIntervalMs,
    checkResult: async ({ operation, launch, minContextSlot, receipt }) => {
      const plan = launch.config.plan;
      if (receipt) {
        const keys = receipt.transaction.message.staticAccountKeys.map((key) => key.toBase58());
        const index = keys.indexOf(plan.destinationWallet), meta = receipt.meta;
        if (index < 1 || meta.postBalances[index] - meta.preBalances[index] !== plan.amountLamports
            || meta.preBalances[0] - meta.postBalances[0] !== plan.amountLamports + meta.fee
            || keys.some((_, i) => i !== 0 && i !== index && meta.preBalances[i] !== meta.postBalances[i])) throw paused('Verify the exact storage deposit and payer fee');
        return { state: 'present', slot: receipt.slot, evidence: { depositedLamports: plan.amountLamports } };
      }
      const accounts = await connection.getMultipleAccountsInfoAndContext([new PublicKey(launch.walletPublicKey), new PublicKey(plan.destinationWallet)], { commitment: 'finalized', minContextSlot });
      if (!whole(accounts?.context?.slot) || accounts.context.slot < minContextSlot || !Array.isArray(accounts.value) || accounts.value.length !== 2) throw paused('Read complete finalized storage payment accounts');
      const [payer, recipient] = accounts.value;
      if (!payer || !payer.owner.equals(SystemProgram.programId) || payer.executable || payer.data.length || !whole(payer.lamports)
          || recipient && (!recipient.owner.equals(SystemProgram.programId) || recipient.executable || recipient.data.length || !whole(recipient.lamports))) throw paused('Verify the storage payment system accounts');
      if (payer.lamports < operation.payload.maxSpendLamports) throw failure('INSUFFICIENT_FUNDS', 'Fund the saved storage payment and fee before sending');
      return { state: 'absent', slot: accounts.context.slot };
    } });
  return {
    async execute({ scopeId, walletPublicKey, plan: input, approval, workflowId }) {
      const plan = normalizeStoragePaymentPlan(input);
      if (workflowId) {
        const workflow = store.getWalletWorkflow(walletPublicKey), saved = workflow?.context;
        if (workflow?.id !== workflowId || workflow.kind !== 'storage-upload' || saved.scopeId !== scopeId || saved.network !== network
            || saved.genesisHash !== expectedGenesisHash || saved.itemId !== plan.uploadId || saved.contentDigest !== plan.contentDigest
            || saved.fundingLamports !== plan.amountLamports || saved.node.nodeUrl !== plan.nodeUrl
            || saved.node.paymentAddress !== plan.destinationWallet || saved.node.receiptKey !== plan.nodeReceiptKey) {
          throw failure('OPERATION_CONFLICT', 'Use the payment bound to the saved upload workflow');
        }
      }
      if (plan.destinationWallet === walletPublicKey) throw new TypeError('Use the storage node payment address');
      return service.execute({ scopeId, walletPublicKey, key: plan.uploadId, plan, approval, workflowId, build: async () => {
        const policy = await feePolicy({ connection, walletPublicKey });
        if (![policy.computeUnitLimit, policy.microLamports, policy.feeCeilingLamports].every(whole) || !policy.computeUnitLimit || policy.computeUnitLimit > 1400000) throw paused('Use bounded storage payment fees');
        const maxSpendLamports = plan.amountLamports + policy.feeCeilingLamports;
        if (!whole(maxSpendLamports)) throw paused('Use an exact storage payment ceiling');
        const wallet = new PublicKey(walletPublicKey);
        const tx = new Transaction({ feePayer: wallet, recentBlockhash: PublicKey.default.toBase58() }).add(
          ComputeBudgetProgram.setComputeUnitLimit({ units: policy.computeUnitLimit }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: policy.microLamports }),
          SystemProgram.transfer({ fromPubkey: wallet, toPubkey: new PublicKey(plan.destinationWallet), lamports: plan.amountLamports }));
        return { transaction: VersionedTransaction.deserialize(tx.serialize({ requireAllSignatures: false, verifySignatures: false })), result: plan,
          allowExisting: false, feeCeilingLamports: policy.feeCeilingLamports, maxSpendLamports };
      } });
    },
    recover: (input) => service.recover(input),
    planDigest: (input) => hash(normalizeStoragePaymentPlan(input)),
  };
}
