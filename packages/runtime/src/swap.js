import { createHash } from 'node:crypto';
import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import { publicJson, RecoveryStorageError } from './store.js';
import { reviewSwapBundle } from './swap-bundle.js';
import { readSwapState, projectSwapStep, verifySwapEffects } from './swap-state.js';
import { createPreparedTransactionService } from './prepared-transaction.js';

const hash = (value) => createHash('sha256').update(publicJson(value)).digest('hex');
const copy = (value) => JSON.parse(publicJson(value));
const whole = (value) => Number.isSafeInteger(value) && value >= 0;
const failure = (code, message, fields = {}) => Object.assign(new Error(message), { code, ...fields });
const busy = new WeakMap();
export const SWAP_OPERATION_KIND = 'quote-token-swap';

export function createSwapService({ owner, store, connection, signer, network, expectedGenesisHash, authorize,
  now = Date.now, timeoutMs = 60000, pollIntervalMs = 500 }) {
  if (store.directory !== owner.profile || !['devnet', 'mainnet', 'localnet'].includes(network) || !expectedGenesisHash || typeof authorize !== 'function') throw new TypeError('Supply the owned swap profile, network, and approval interface');
  const records = store.collection('runtime-swaps/v1');
  const summarize = (job) => {
    const trade = job.receipts[job.plan.review.steps.findIndex((step) => step.trade)];
    return { txId: trade.txId, receivedRaw: trade.receivedRaw, receipts: job.receipts,
      feeLamports: job.receipts.reduce((sum, item) => sum + item.feeLamports, 0), grossDebitLamports: job.receipts.reduce((sum, item) => sum + item.grossDebitLamports, 0),
      returnedLamports: job.receipts.reduce((sum, item) => sum + item.returnedLamports, 0) };
  };

  const loadJobs = () => {
    const jobs = records.load();
    try {
      if (!Array.isArray(jobs) || new Set(jobs.map((job) => job.id)).size !== jobs.length) throw new Error('Read distinct saved swap jobs');
      for (const job of jobs) {
        const { plan } = job, { digest, ...review } = plan.review;
        if (job.id !== hash({ scopeId: plan.scopeId, key: plan.key, walletPublicKey: job.walletPublicKey, network: plan.network })
            || new PublicKey(job.walletPublicKey).toBase58() !== job.walletPublicKey || review.intent.walletPublicKey !== job.walletPublicKey
            || review.intent.network !== plan.network || hash(review) !== digest || !['prepared', 'confirmed'].includes(job.state)
            || !Array.isArray(job.receipts) || !Array.isArray(job.approvals) || !Array.isArray(review.steps) || !review.steps.length || review.steps.length > 8
            || !whole(plan.feeCeilingLamports) || !whole(plan.maxSpendLamports) || plan.maxSpendLamports !== Number(review.intent.inputAmountRaw) + review.intent.rentCeilingLamports + review.steps.length * plan.feeCeilingLamports
            || job.receipts.length > review.steps.length || job.state === 'confirmed' && (job.receipts.length !== review.steps.length || !job.result)) throw new Error('Verify the saved swap identity and plan');
        if (new Set(job.approvals.map((item) => item.id)).size !== job.approvals.length || job.approvals.some((item) => !item.id
            || item.walletPublicKey !== job.walletPublicKey || item.scopeId !== plan.scopeId || item.key !== plan.key || item.network !== plan.network
            || item.genesisHash !== plan.genesisHash || item.bundleDigest !== digest || !whole(item.expiresAtMs)
            || !whole(item.maxSpendLamports) || item.maxSpendLamports < plan.maxSpendLamports)) throw new Error('Verify the saved swap approvals');
        if (job.state === 'confirmed' && publicJson(job.result) !== publicJson(summarize(job))) throw new Error('Verify the completed swap result against its receipts');
        for (const [index, receipt] of job.receipts.entries()) {
          const operation = store.getOperation(receipt.operationId), launch = operation && store.getLaunch(operation.launchId);
          const expected = operation && { ...operation.evidence?.chain, operationId: operation.id, txId: operation.evidence?.chain?.signature };
          if (operation?.state !== 'confirmed' || operation.kind !== SWAP_OPERATION_KIND || operation.payload.result.index !== index
              || launch.config.workflowId !== job.id || publicJson(expected) !== publicJson(receipt)) throw new Error('Verify the original swap operation receipts');
        }
      }
      return jobs;
    } catch (cause) { throw new RecoveryStorageError('Preserve the saved swap jobs and recover their storage before spending.', { cause }); }
  };
  if (!busy.has(owner)) busy.set(owner, new Set());
  const get = (id) => loadJobs().find((job) => job.id === id) || null;
  const active = (walletPublicKey) => loadJobs().find((job) => job.walletPublicKey === walletPublicKey && job.state !== 'confirmed') || null;
  const checkNetwork = async () => {
    owner.assertActive();
    if (await connection.getGenesisHash() !== expectedGenesisHash) throw failure('NETWORK_MISMATCH', 'Use the saved swap network and genesis hash');
    owner.assertActive();
  };
  const owned = async (wallet, fn) => {
    owner.assertActive();
    if (busy.get(owner).has(wallet)) throw failure('OPERATION_IN_FLIGHT', 'Recover the active swap request');
    busy.get(owner).add(wallet);
    try { return await fn(); } finally { busy.get(owner).delete(wallet); }
  };
  const approvalFor = async (approval, job) => {
    owner.assertActive();
    const plan = job.plan;
    if (!approval?.id || approval.scopeId !== plan.scopeId || approval.key !== plan.key || approval.walletPublicKey !== job.walletPublicKey
        || approval.network !== network || approval.genesisHash !== expectedGenesisHash || approval.bundleDigest !== plan.review.digest
        || !whole(approval.expiresAtMs) || approval.expiresAtMs <= now() || !whole(approval.maxSpendLamports) || approval.maxSpendLamports < plan.maxSpendLamports
        || await authorize({ approval, job }) !== true) throw failure('EXECUTION_APPROVAL_REQUIRED', 'Approve the complete saved swap, wallet, network, budget, and expiry');
    owner.assertActive();
  };
  const update = (id, fn) => records.transaction(() => {
    owner.assertActive();
    const all = loadJobs(), index = all.findIndex((job) => job.id === id);
    if (index < 0) throw new Error('Prepare the swap before saving its progress');
    const next = fn(all[index]); all[index] = next; records.save(all); return next;
  });
  const saveApproval = (job, approval) => update(job.id, (saved) => {
    const prior = saved.approvals.find((item) => item.id === approval.id);
    if (prior && publicJson(prior) !== publicJson(approval)) throw failure('OPERATION_CONFLICT', 'Preserve the original swap approval');
    return prior ? saved : { ...saved, approvals: [...saved.approvals, copy(approval)] };
  });
  const result = (job) => ({ jobId: job.id, ...job.result });
  const run = async (initial, approval) => {
    let job = initial;
    if (job.plan.network !== network || job.plan.genesisHash !== expectedGenesisHash) throw failure('NETWORK_MISMATCH', 'Recover the swap on its saved chain');
    if (job.state === 'confirmed') return result(job);
    if (store.getWalletWorkflow(job.walletPublicKey)?.id !== job.id) throw failure('OPERATION_CONFLICT', 'Recover the saved swap wallet reservation');
    const { plan } = job;
    for (let index = job.receipts.length; index < plan.review.steps.length; index++) {
      const step = plan.review.steps[index], stepPlan = { jobId: job.id, bundleDigest: plan.review.digest, index };
      const service = createPreparedTransactionService({ owner, store, connection, signer, kind: SWAP_OPERATION_KIND, network, expectedGenesisHash,
        now, timeoutMs, pollIntervalMs,
        authorize: async () => {
          await approvalFor(approval, job);
          saveApproval(job, approval);
          return true;
        },
        checkResult: async ({ operation, minContextSlot, receipt }) => {
          if (receipt) return { state: 'present', slot: receipt.slot, evidence: verifySwapEffects({ review: plan.review, step,
            before: operation.payload.result.before, receipt, feeCeilingLamports: plan.feeCeilingLamports }) };
          const state = await readSwapState(connection, plan.review, minContextSlot), projection = projectSwapStep(plan.review, step, state);
          if (state.walletLamports < projection.grossDebitLamports + plan.feeCeilingLamports) throw failure('INSUFFICIENT_FUNDS', 'Fund the complete saved swap step and fee');
          const savedBefore = operation.payload.result.before;
          if (publicJson(state.accounts) !== publicJson(savedBefore.accounts) || publicJson(state.mints) !== publicJson(savedBefore.mints)) throw failure('CHAIN_STATE_UNAVAILABLE', 'Recover changed swap account state before a new submission');
          return { state: 'absent', slot: state.slot };
        } });
      const receipt = await service.execute({ scopeId: plan.scopeId, walletPublicKey: job.walletPublicKey, key: `${plan.key}/${index}`, plan: stepPlan,
        workflowId: job.id, approval: { ...approval, planDigest: hash(stepPlan) }, build: async () => {
          await approvalFor(approval, job); job = saveApproval(job, approval);
          const before = await readSwapState(connection, plan.review), projection = projectSwapStep(plan.review, step, before);
          const usedRent = job.receipts.reduce((sum, item) => sum + item.rentLamports, 0);
          if (usedRent + projection.createdRentLamports > plan.review.intent.rentCeilingLamports) throw failure('SPEND_LIMIT_EXCEEDED', 'Keep total swap rent within its approved ceiling');
          const maxSpendLamports = projection.grossDebitLamports + plan.feeCeilingLamports;
          const spent = job.receipts.reduce((sum, item) => sum + item.grossDebitLamports, 0);
          if (!whole(maxSpendLamports) || spent + maxSpendLamports > plan.maxSpendLamports) throw failure('SPEND_LIMIT_EXCEEDED', 'Keep all swap steps within the saved purchase budget');
          return { transaction: VersionedTransaction.deserialize(Buffer.from(step.template, 'base64')), accountKeys: step.accountKeys,
            result: { index, before }, allowExisting: false, feeCeilingLamports: plan.feeCeilingLamports, maxSpendLamports,
            maxCreditLamports: projection.returnedLamports };
        } });
      job = update(job.id, (saved) => {
        if (saved.receipts.length !== index) throw failure('OPERATION_CONFLICT', 'Save each swap receipt once and in order');
        return { ...saved, receipts: [...saved.receipts, receipt] };
      });
    }
    const outcome = summarize(job);
    job = records.transaction(() => {
      const saved = update(job.id, (value) => ({ ...value, state: 'confirmed', result: outcome }));
      store.finishWalletWorkflow(job.id, outcome); return saved;
    });
    return result(job);
  };
  return {
    get, active,
    async prepare({ scopeId, key, transactions, intent, feeCeilingLamports, approval }) {
      if (![scopeId, key].every((value) => typeof value === 'string' && value && value.length <= 256) || intent.network !== network || !whole(feeCeilingLamports)) throw new TypeError('Use a complete saved swap identity and fee ceiling');
      const walletPublicKey = new PublicKey(intent.walletPublicKey).toBase58();
      return owned(walletPublicKey, async () => {
        if (!Array.isArray(transactions) || !transactions.length || transactions.length > 8 || transactions.some((tx) => !(tx instanceof VersionedTransaction) || tx.serialize().length > 1232)) throw new TypeError('Use a bounded swap transaction bundle');
        await checkNetwork();
        const lookups = new Map();
        for (const transaction of transactions) for (const lookup of transaction.message.addressTableLookups || []) {
          if (lookups.has(lookup.accountKey.toBase58())) continue;
          const response = await connection.getAddressLookupTable(lookup.accountKey, { commitment: 'finalized' });
          if (!response?.value || !whole(response.context?.slot)) throw failure('CHAIN_STATE_UNAVAILABLE', 'Read all finalized swap lookup tables');
          lookups.set(lookup.accountKey.toBase58(), response.value);
        }
        const review = await reviewSwapBundle({ transactions, lookupTables: [...lookups.values()], intent });
        const id = hash({ scopeId, key, walletPublicKey, network });
        const maxSpendLamports = Number(review.intent.inputAmountRaw) + review.intent.rentCeilingLamports + review.steps.length * feeCeilingLamports;
        if (!whole(maxSpendLamports)) throw new TypeError('Use an exact total swap spending ceiling');
        const plan = { scopeId, key, network, genesisHash: expectedGenesisHash, review, feeCeilingLamports, maxSpendLamports };
        const prior = get(id);
        if (prior) {
          if (publicJson(prior.plan) !== publicJson(plan)) throw failure('OPERATION_CONFLICT', 'Recover the original swap bundle before requesting another quote');
          return prior;
        }
        const job = { id, walletPublicKey, plan, state: 'prepared', receipts: [], approvals: [], result: null };
        await approvalFor(approval, job);
        let state = await readSwapState(connection, review), gross = 0, rent = 0;
        const expiry = await connection.getLatestBlockhash('finalized');
        for (const step of review.steps) {
          const transaction = VersionedTransaction.deserialize(Buffer.from(step.template, 'base64'));
          transaction.message.recentBlockhash = expiry.blockhash;
          const fee = await connection.getFeeForMessage(transaction.message, 'finalized');
          if (!whole(fee?.context?.slot) || fee.context.slot < state.slot || !whole(fee.value)) throw failure('CHAIN_STATE_UNAVAILABLE', 'Read every swap transaction fee before preparing payment');
          if (fee.value > feeCeilingLamports) throw failure('SPEND_LIMIT_EXCEEDED', 'Keep every swap transaction fee within its approved ceiling');
          const projection = projectSwapStep(review, step, state);
          gross += projection.grossDebitLamports + feeCeilingLamports; rent += projection.createdRentLamports;
          if (state.walletLamports < projection.grossDebitLamports + feeCeilingLamports || gross > maxSpendLamports || rent > intent.rentCeilingLamports) throw failure('SPEND_LIMIT_EXCEEDED', 'Fund the complete swap bundle within the approved budget');
          state = { ...state, accounts: projection.accounts, walletLamports: state.walletLamports - projection.grossDebitLamports - feeCeilingLamports + projection.returnedLamports };
        }
        await approvalFor(approval, job);
        return records.transaction(() => {
          store.reserveWalletWorkflow({ id, walletPublicKey, kind: SWAP_OPERATION_KIND, context: plan });
          const all = loadJobs(); records.save([...all, { ...job, approvals: [copy(approval)] }]); return get(id);
        });
      });
    },
    async execute({ id, approval }) {
      const job = get(id);
      if (!job) throw failure('OPERATION_UNKNOWN', 'Prepare the swap before execution');
      return owned(job.walletPublicKey, () => run(get(id), approval));
    },
    async recover({ walletPublicKey, approval }) {
      return owned(walletPublicKey, () => { const job = active(walletPublicKey); return job ? run(job, approval) : null; });
    },
  };
}
