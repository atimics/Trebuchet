import { createHash } from 'node:crypto';
import { PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { createCloseAccountInstruction } from '@solana/spl-token';
import { publicJson } from './store.js';
import { readPreparedFailure, verifyPreparedFailure } from './prepared-failure.js';
import { createPreparedTransactionService } from './prepared-transaction.js';
import { readSwapState, verifySwapEffects } from './swap-state.js';

const hash = (value) => createHash('sha256').update(publicJson(value)).digest('hex');
const equal = (a, b) => publicJson(a) === publicJson(b);
const copy = (value) => JSON.parse(publicJson(value));
const whole = (value) => Number.isSafeInteger(value) && value >= 0;
const fail = (code, message, fields = {}) => Object.assign(new Error(message), { code, ...fields });
export const SWAP_CLEANUP_KIND = 'quote-token-swap-cleanup';
const costs = (job, count = job.cleanupAttempts?.length || 0) => [
  ...job.receipts, ...(job.failure ? [job.failure] : []),
  ...(job.cleanupAttempts || []).slice(0, count).flatMap((attempt) => attempt.receipt ? [attempt.receipt] : attempt.failure ? [attempt.failure] : []),
];
const sum = (receipts, key) => receipts.reduce((total, receipt) => total + receipt[key], 0);
const cleanupPlan = (job, index, before) => ({
  jobId: job.id, index, walletPublicKey: job.walletPublicKey, scopeId: job.plan.scopeId, key: `${job.plan.key}/cleanup/${index}`,
  network: job.plan.network, genesisHash: job.plan.genesisHash, bundleDigest: job.plan.review.digest,
  failedTxId: job.failure.txId, before,
  feeCeilingLamports: before.accounts[job.plan.review.intent.sourceTokenAccount].exists ? job.plan.feeCeilingLamports : 0,
  maxSpendLamports: sum(costs(job, index), 'grossDebitLamports') + (before.accounts[job.plan.review.intent.sourceTokenAccount].exists ? job.plan.feeCeilingLamports : 0),
});
const cleanupStep = (job, digest) => {
  const wallet = new PublicKey(job.walletPublicKey), source = new PublicKey(job.plan.review.intent.sourceTokenAccount);
  const transaction = new VersionedTransaction(new TransactionMessage({ payerKey: wallet, recentBlockhash: PublicKey.default.toBase58(),
    instructions: [createCloseAccountInstruction(source, wallet, wallet), new TransactionInstruction({
      programId: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'), keys: [], data: Buffer.from(`trebuchet-swap-cleanup:${digest}`),
    })] }).compileToLegacyMessage());
  return { transaction, accountKeys: transaction.message.staticAccountKeys.map((key) => key.toBase58()), actions: [{ kind: 'close' }], creates: [], trade: false };
};

export function recoveredSwapResult(job) {
  const tradeIndex = job.plan.review.steps.findIndex((step) => step.trade), trade = job.receipts[tradeIndex], all = costs(job);
  return { status: 'recovered', purchaseStatus: trade ? 'confirmed' : 'failed', txId: trade?.txId || null, receivedRaw: trade?.receivedRaw || '0',
    receipts: job.receipts, failedReceipts: [job.failure, ...(job.cleanupAttempts || []).flatMap((attempt) => attempt.failure ? [attempt.failure] : [])],
    cleanupReceipts: (job.cleanupAttempts || []).flatMap((attempt) => attempt.receipt ? [attempt.receipt] : []),
    feeLamports: sum(all, 'feeLamports'), grossDebitLamports: sum(all, 'grossDebitLamports'), returnedLamports: sum(all, 'returnedLamports') };
}

export function validateSwapRecovery(job, store) {
  const checkFailure = (failure, kind, index, digest) => {
    const { witness, ...saved } = failure, verified = verifyPreparedFailure(store, saved.operationId, witness);
    const operation = store.getOperation(saved.operationId), launch = store.getLaunch(operation.launchId);
    if (!equal(saved, verified) || operation.kind !== kind || operation.payload.result.index !== index || launch.config.workflowId !== job.id
        || kind === SWAP_CLEANUP_KIND && operation.payload.result.cleanupDigest !== digest
        || kind === 'quote-token-swap' && launch.config.plan.bundleDigest !== job.plan.review.digest) throw new Error('Verify the saved swap failure witness');
  };
  if (!job.failure) {
    if (job.state === 'recovery_required' || job.state === 'recovered' || job.cleanupAttempts?.length) throw new Error('Recover the original failed swap receipt');
    return;
  }
  if (!['recovery_required', 'recovered'].includes(job.state) || job.receipts.length >= job.plan.review.steps.length) throw new Error('Verify the failed swap stage');
  checkFailure(job.failure, 'quote-token-swap', job.receipts.length);
  const attempts = job.cleanupAttempts || [];
  if (!Array.isArray(attempts)) throw new Error('Read the saved cleanup attempts');
  for (const [index, attempt] of attempts.entries()) {
    const { plan } = attempt;
    if (!equal(plan, cleanupPlan(job, index, plan.before)) || attempt.digest !== hash(plan) || !whole(plan.maxSpendLamports)
        || !['prepared', 'failed', 'confirmed'].includes(attempt.state) || index < attempts.length - 1 && attempt.state !== 'failed'
        || !Array.isArray(attempt.approvals) || new Set(attempt.approvals.map((approval) => approval.id)).size !== attempt.approvals.length) throw new Error('Verify the saved cleanup plan and order');
    for (const approval of attempt.approvals) if (!approvalMatches(approval, attempt)) throw new Error('Verify the saved cleanup approval');
    if (attempt.failure) checkFailure(attempt.failure, SWAP_CLEANUP_KIND, index, attempt.digest);
    if ((attempt.state === 'failed') !== Boolean(attempt.failure) || attempt.failure && attempt.receipt) throw new Error('Verify the cleanup failure state');
    if (attempt.receipt) {
      const operation = store.getOperation(attempt.receipt.operationId), launch = operation && store.getLaunch(operation.launchId);
      const expected = operation && { ...operation.evidence?.chain, operationId: operation.id, txId: operation.evidence?.chain?.signature };
      if (operation?.state !== 'confirmed' || operation.kind !== SWAP_CLEANUP_KIND || launch.config.workflowId !== job.id
          || operation.payload.result.cleanupDigest !== attempt.digest || !equal(expected, attempt.receipt)) throw new Error('Verify the saved cleanup receipt');
    }
    if (attempt.state === 'confirmed') {
      const source = attempt.completion?.source;
      if (!whole(attempt.completion?.slot) || attempt.completion.slot < Math.max(plan.before.slot, attempt.receipt?.slot || 0)
          || source?.address !== job.plan.review.intent.sourceTokenAccount || source.exists !== false || source.lamports !== 0
          || Boolean(attempt.receipt) !== plan.before.accounts[source.address].exists) throw new Error('Verify the finalized cleanup account');
    }
  }
  if (job.state === 'recovered' && (attempts.at(-1)?.state !== 'confirmed' || !equal(job.result, recoveredSwapResult(job)))) throw new Error('Verify the completed swap recovery');
}

function approvalMatches(approval, attempt) {
  const { plan } = attempt;
  return typeof approval?.id === 'string' && approval.id && approval.scopeId === plan.scopeId && approval.key === plan.key
    && approval.walletPublicKey === plan.walletPublicKey && approval.network === plan.network && approval.genesisHash === plan.genesisHash
    && approval.bundleDigest === plan.bundleDigest && approval.recoveryDigest === attempt.digest && whole(approval.expiresAtMs)
    && whole(approval.maxSpendLamports) && approval.maxSpendLamports >= plan.maxSpendLamports;
}

export function createSwapRecovery({ owner, store, connection, signer, network, expectedGenesisHash, authorize, now, timeoutMs, pollIntervalMs, records, update }) {
  const checkSavedNetwork = (job) => {
    if (job.plan.network !== network || job.plan.genesisHash !== expectedGenesisHash) throw fail('NETWORK_MISMATCH', 'Recover the swap on its saved chain');
  };
  const checkNetwork = async (job) => {
    owner.assertActive(); checkSavedNetwork(job);
    if (await connection.getGenesisHash() !== expectedGenesisHash) throw fail('NETWORK_MISMATCH', 'Recover the swap on its saved chain');
    owner.assertActive();
  };
  const saveAttempt = (job, index, fn) => update(job.id, (saved) => ({ ...saved, cleanupAttempts: saved.cleanupAttempts.map((item, i) => i === index ? fn(item) : item) }));
  const approve = async (job, attempt, approval) => {
    owner.assertActive();
    if (!approvalMatches(approval, attempt) || approval.expiresAtMs <= now() || await authorize({ approval, job, recoveryPlan: attempt.plan }) !== true) {
      throw fail('EXECUTION_APPROVAL_REQUIRED', 'Approve the saved wrapped-SOL cleanup, fee, cumulative spend, and expiry');
    }
    owner.assertActive();
    saveAttempt(job, attempt.plan.index, (saved) => {
      const prior = saved.approvals.find((item) => item.id === approval.id);
      if (prior && !equal(prior, approval)) throw fail('OPERATION_CONFLICT', 'Preserve the original cleanup approval');
      return prior ? saved : { ...saved, approvals: [...saved.approvals, copy(approval)] };
    });
  };
  const failureReceipt = (operationId) => readPreparedFailure({ owner, store, connection, operationId, network, expectedGenesisHash });
  return {
    async recordFailure(job, error) {
      const failure = await failureReceipt(error.operationId);
      return update(job.id, (saved) => ({ ...saved, state: 'recovery_required', failure, cleanupAttempts: [] }));
    },
    async prepare(job) {
      checkSavedNetwork(job);
      if (job.state === 'recovered') return job.cleanupAttempts.at(-1);
      if (!job.failure) throw fail('SWAP_FAILURE_REQUIRED', 'Recover the failed purchase receipt before preparing cleanup');
      const prior = job.cleanupAttempts?.at(-1);
      if (prior && prior.state !== 'failed') return prior;
      await checkNetwork(job);
      const before = await readSwapState(connection, job.plan.review, Math.max(...costs(job).map((receipt) => receipt.slot)));
      const source = before.accounts[job.plan.review.intent.sourceTokenAccount];
      if (!source.exists && source.lamports) throw fail('CHAIN_STATE_UNAVAILABLE', 'Recover the funded source account before closing this workflow');
      const plan = cleanupPlan(job, job.cleanupAttempts?.length || 0, before);
      if (!whole(plan.maxSpendLamports)) throw fail('SPEND_LIMIT_EXCEEDED', 'Use an exact cumulative recovery budget');
      const attempt = { plan, digest: hash(plan), state: 'prepared', approvals: [], receipt: null, failure: null };
      return update(job.id, (saved) => ({ ...saved, cleanupAttempts: [...(saved.cleanupAttempts || []), attempt] })).cleanupAttempts.at(-1);
    },
    async execute(job, approval) {
      checkSavedNetwork(job);
      if (job.state === 'recovered') return { jobId: job.id, ...job.result };
      let attempt = job.cleanupAttempts?.at(-1);
      if (!attempt) throw fail('CLEANUP_PLAN_REQUIRED', 'Prepare and review the wrapped-SOL cleanup');
      if (attempt.failure) throw fail('TRANSACTION_FAILED', 'Prepare a new cleanup attempt after its finalized failure', { operationId: attempt.failure.operationId });
      if (store.getWalletWorkflow(job.walletPublicKey)?.id !== job.id) throw fail('OPERATION_CONFLICT', 'Recover the saved swap wallet reservation');
      await checkNetwork(job);
      const { plan } = attempt, sourceAddress = job.plan.review.intent.sourceTokenAccount, before = plan.before;
      if (before.accounts[sourceAddress].exists && !attempt.receipt) {
        const step = cleanupStep(job, attempt.digest), service = createPreparedTransactionService({ owner, store, connection, signer, network, expectedGenesisHash,
          kind: SWAP_CLEANUP_KIND, now, timeoutMs, pollIntervalMs, authorize: async () => { await approve(job, attempt, approval); return true; },
          checkResult: async ({ minContextSlot, receipt }) => {
            if (receipt) return { state: 'present', slot: receipt.slot, evidence: verifySwapEffects({ review: job.plan.review, step, before, receipt, feeCeilingLamports: plan.feeCeilingLamports }) };
            const state = await readSwapState(connection, job.plan.review, Math.max(before.slot, minContextSlot));
            if (!equal(state.accounts, before.accounts) || !equal(state.mints, before.mints)) throw fail('CHAIN_STATE_UNAVAILABLE', 'Review the changed swap accounts before cleanup');
            if (state.walletLamports < plan.feeCeilingLamports) throw fail('INSUFFICIENT_FUNDS', 'Fund the approved cleanup fee');
            return { state: 'absent', slot: state.slot };
          } });
        try {
          const receipt = await service.execute({ scopeId: plan.scopeId, walletPublicKey: job.walletPublicKey, key: plan.key, workflowId: job.id,
            plan: { cleanupDigest: attempt.digest }, approval: { ...approval, planDigest: hash({ cleanupDigest: attempt.digest }) },
            build: async () => ({ transaction: step.transaction, accountKeys: step.accountKeys, result: { index: plan.index, cleanupDigest: attempt.digest, before },
              allowExisting: false, maxSpendLamports: plan.feeCeilingLamports, feeCeilingLamports: plan.feeCeilingLamports, maxCreditLamports: before.accounts[sourceAddress].lamports }) });
          job = saveAttempt(job, plan.index, (saved) => ({ ...saved, receipt })); attempt = job.cleanupAttempts.at(-1);
        } catch (error) {
          if (error.code === 'TRANSACTION_FAILED') {
            const failure = await failureReceipt(error.operationId);
            saveAttempt(job, plan.index, (saved) => ({ ...saved, state: 'failed', failure }));
          }
          throw error;
        }
      } else if (!before.accounts[sourceAddress].exists) await approve(job, attempt, approval);
      const state = await readSwapState(connection, job.plan.review, Math.max(before.slot, attempt.receipt?.slot || 0)), source = state.accounts[sourceAddress];
      if (source.exists || source.lamports) throw fail('CHAIN_STATE_UNAVAILABLE', 'Verify the wrapped-SOL source is closed before releasing the wallet');
      job = records.transaction(() => {
        const saved = saveAttempt(job, plan.index, (value) => ({ ...value, state: 'confirmed', completion: { slot: state.slot, source } }));
        const outcome = recoveredSwapResult(saved);
        const finished = update(saved.id, (value) => ({ ...value, state: 'recovered', result: outcome }));
        store.finishWalletWorkflow(saved.id, outcome); return finished;
      });
      return { jobId: job.id, ...job.result };
    },
  };
}
