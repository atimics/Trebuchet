import { createHash } from 'node:crypto';
import { PublicKey, SystemProgram, VersionedTransaction } from '@solana/web3.js';
import { publicJson, RecoveryStorageError } from './store.js';
import { createSwapService } from './swap.js';
import { ACQUISITION_KIND } from './swap-workflow.js';

const hash = (value) => createHash('sha256').update(publicJson(value)).digest('hex');
const equal = (a, b) => publicJson(a) === publicJson(b);
const copy = (value) => JSON.parse(publicJson(value));
const whole = (value) => Number.isSafeInteger(value) && value >= 0;
const fail = (code, message) => Object.assign(new Error(message), { code });
const busy = new WeakMap();
const identity = ({ scopeId, key, walletPublicKey, network }) => hash({ scopeId, key, walletPublicKey, network, kind: ACQUISITION_KIND });
const sum = (items, field) => items.reduce((total, item) => total + item[field], 0);
const costs = (child) => [...(child?.receipts || []), ...(child?.failure ? [child.failure] : []),
  ...(child?.cleanupAttempts || []).flatMap((attempt) => attempt.receipt ? [attempt.receipt] : attempt.failure ? [attempt.failure] : [])];
const approvalMatches = (approval, job, recoveryPlan) => Boolean(typeof approval?.id === 'string' && approval.id
  && approval.scopeId === job.plan.scopeId && approval.key === job.plan.key && approval.walletPublicKey === job.plan.walletPublicKey
  && approval.network === job.plan.network && approval.genesisHash === job.plan.genesisHash && approval.planDigest === job.digest
  && approval.recoveryDigest === recoveryPlan?.digest && whole(approval.expiresAtMs) && whole(approval.maxSpendLamports)
  && approval.maxSpendLamports >= Math.max(job.plan.maxSpendLamports, recoveryPlan?.maxSpendLamports || 0));

// A single durable owner spans the approved purchases. Child swaps keep their
// own transaction receipts while the parent retains the wallet between them.
export function createQuoteAcquisitionService(options) {
  const { owner, store, connection, network, expectedGenesisHash, authorize, now = Date.now } = options;
  if (typeof authorize !== 'function') throw new TypeError('Supply the acquisition approval check');
  const records = store.collection('runtime-quote-acquisitions/v1');
  if (!busy.has(owner)) busy.set(owner, new Set());
  const owned = async (wallet, run) => {
    owner.assertActive();
    if (busy.get(owner).has(wallet)) throw fail('OPERATION_IN_FLIGHT', 'Recover the active acquisition request');
    busy.get(owner).add(wallet);
    try { return await run(); } finally { busy.get(owner).delete(wallet); }
  };
  const read = (id) => {
    try {
      const jobs = records.load();
      if (!Array.isArray(jobs) || new Set(jobs.map((job) => job.id)).size !== jobs.length) throw new Error('Read distinct acquisition jobs');
      for (const job of jobs) {
        const { plan } = job, purchases = plan.purchases;
        if (identity(plan) !== job.id || hash(plan) !== job.digest || new PublicKey(plan.walletPublicKey).toBase58() !== plan.walletPublicKey
            || !Array.isArray(purchases) || !purchases.length || purchases.length > 16 || new Set(purchases.map((item) => item.id)).size !== purchases.length
            || new Set(purchases.map((item) => item.plan.review.intent.outputMint)).size !== purchases.length
            || !whole(plan.maxSpendLamports) || plan.maxSpendLamports !== sum(purchases.map((item) => item.plan), 'maxSpendLamports')
            || !['prepared', 'confirmed', 'recovery_required', 'recovered'].includes(job.state) || !Array.isArray(job.approvals)
            || new Set(job.approvals.map((item) => item.id)).size !== job.approvals.length) throw new Error('Verify the saved acquisition plan');
        for (const [index, child] of purchases.entries()) {
          const childPlan = child.plan, intent = childPlan.review.intent, { digest, ...review } = childPlan.review;
          if (child.id !== hash({ scopeId: childPlan.scopeId, key: childPlan.key, walletPublicKey: plan.walletPublicKey, network: plan.network })
              || childPlan.workflowId !== job.id || childPlan.scopeId !== plan.scopeId || childPlan.key !== `${plan.key}/${index}`
              || childPlan.network !== plan.network || childPlan.genesisHash !== plan.genesisHash || intent.walletPublicKey !== plan.walletPublicKey
              || intent.network !== plan.network || hash(review) !== digest || !whole(childPlan.feeCeilingLamports)
              || !whole(childPlan.maxSpendLamports) || childPlan.maxSpendLamports !== Number(intent.inputAmountRaw) + intent.rentCeilingLamports + review.steps.length * childPlan.feeCeilingLamports) {
            throw new Error('Verify every saved acquisition purchase');
          }
        }
        for (const approval of job.approvals) {
          const recovery = approval.recoveryDigest ? job.recoveryPlans?.find((item) => item.digest === approval.recoveryDigest) : undefined;
          if (approval.recoveryDigest && !recovery || !approvalMatches(approval, job, recovery)) throw new Error('Verify the saved acquisition approval');
        }
        for (const recovery of job.recoveryPlans || []) {
          const { digest, ...plan } = recovery;
          if (digest !== hash(plan) || plan.jobId !== job.id || plan.planDigest !== job.digest || !whole(plan.maxSpendLamports)) throw new Error('Verify the saved acquisition recovery plan');
        }
      }
      return jobs.find((job) => job.id === id) || null;
    } catch (cause) { throw new RecoveryStorageError('Preserve the acquisition records and recover their saved plan.', { cause }); }
  };
  const update = (id, change) => records.transaction(() => {
    owner.assertActive(); const saved = read(id);
    if (!saved) throw fail('OPERATION_UNKNOWN', 'Prepare the acquisition before saving progress');
    const next = change(saved); records.save(records.load().map((job) => job.id === id ? next : job)); return next;
  });
  const checkHost = (job) => {
    owner.assertActive();
    if (job.plan.network !== network || job.plan.genesisHash !== expectedGenesisHash) throw fail('NETWORK_MISMATCH', 'Recover the acquisition on its saved chain');
  };
  const assertReservation = (job) => {
    const reservation = store.getWalletWorkflow(job.plan.walletPublicKey);
    if (reservation?.id !== job.id || reservation.kind !== ACQUISITION_KIND || !equal(reservation.context, { plan: job.plan, digest: job.digest })) {
      throw fail('OPERATION_CONFLICT', 'Recover the complete acquisition wallet reservation');
    }
  };
  const approve = async (job, approval, recoveryPlan) => {
    checkHost(job);
    if (!approvalMatches(approval, job, recoveryPlan) || approval.expiresAtMs <= now() || await authorize({ approval, job, recoveryPlan }) !== true) {
      throw fail('EXECUTION_APPROVAL_REQUIRED', 'Approve the complete acquisition plan, wallet, network, budget, and expiry');
    }
    owner.assertActive();
  };
  const saveApproval = (job, approval) => update(job.id, (saved) => {
    const prior = saved.approvals.find((item) => item.id === approval.id);
    if (prior && !equal(prior, approval)) throw fail('OPERATION_CONFLICT', 'Preserve the original acquisition approval');
    return prior ? saved : { ...saved, approvals: [...saved.approvals, copy(approval)] };
  });
  const plainSwaps = createSwapService({ ...options, authorize: async () => false });
  const children = (job) => job.plan.purchases.map((item) => {
    const saved = plainSwaps.get(item.id);
    if (saved && !equal(saved.plan, item.plan)) throw new RecoveryStorageError('Recover the original child purchase plan.');
    return saved;
  });
  const outcome = (job) => {
    const saved = children(job), receipts = saved.flatMap(costs);
    return { status: job.state, purchases: saved.map((child, index) => ({ jobId: job.plan.purchases[index].id,
      outputMint: job.plan.purchases[index].plan.review.intent.outputMint, state: child?.state || 'pending', result: child?.result || null })),
      feeLamports: sum(receipts, 'feeLamports'), grossDebitLamports: sum(receipts, 'grossDebitLamports'), returnedLamports: sum(receipts, 'returnedLamports') };
  };
  const get = (id) => {
    const job = read(id); if (!job) return null;
    const result = outcome(job);
    if (['confirmed', 'recovered'].includes(job.state)) {
      const states = result.purchases.map((item) => item.state), failed = states.indexOf('recovered');
      if (!equal(job.result, result) || job.state === 'confirmed' && states.some((state) => state !== 'confirmed')
          || job.state === 'recovered' && (failed < 0 || states.slice(0, failed).some((state) => state !== 'confirmed') || states.slice(failed + 1).some((state) => state !== 'pending'))) {
        throw new RecoveryStorageError('Verify acquisition completion against every saved purchase.');
      }
    }
    return { ...job, progress: result };
  };
  const requestFor = (child) => ({ scopeId: child.plan.scopeId, key: child.plan.key, workflowId: child.plan.workflowId,
    transactions: child.plan.review.steps.map((step) => VersionedTransaction.deserialize(Buffer.from(step.template, 'base64'))),
    intent: child.plan.review.intent, feeCeilingLamports: child.plan.feeCeilingLamports });
  const approvalForChild = (approval, child, cleanup) => !approval ? undefined : ({ id: hash({ request: approval.id, child: child.id, ...(cleanup ? { recovery: cleanup.digest } : {}) }),
    scopeId: child.plan.scopeId, key: cleanup?.plan.key || child.plan.key, workflowId: child.plan.workflowId, walletPublicKey: child.plan.review.intent.walletPublicKey,
    network: child.plan.network, genesisHash: child.plan.genesisHash, bundleDigest: child.plan.review.digest,
    expiresAtMs: approval.expiresAtMs, maxSpendLamports: cleanup?.plan.maxSpendLamports ?? child.plan.maxSpendLamports,
    ...(cleanup ? { recoveryDigest: cleanup.digest } : {}) });
  const serviceFor = (job, child, approval, recoveryPlan, cleanup) => createSwapService({ ...options, authorize: async ({ approval: candidate }) => {
    const current = read(job.id); assertReservation(current);
    if (!equal(candidate, approvalForChild(approval, child, cleanup))) return false;
    await approve(current, approval, recoveryPlan);
    const spentElsewhere = children(current).filter((item) => item?.id !== child.id).flatMap(costs);
    if (sum(spentElsewhere, 'grossDebitLamports') + (cleanup?.plan.maxSpendLamports ?? child.plan.maxSpendLamports) > approval.maxSpendLamports) {
      throw fail('SPEND_LIMIT_EXCEEDED', 'Keep purchases and recovery fees within the acquisition budget');
    }
    saveApproval(current, approval); return true;
  } });
  const finish = (job, state) => records.transaction(() => {
    assertReservation(job);
    const result = outcome({ ...job, state });
    const saved = update(job.id, (value) => ({ ...value, state, result }));
    store.finishWalletWorkflow(job.id, result); return { jobId: saved.id, ...get(saved.id).result };
  });
  const preview = async ({ scopeId, key, walletPublicKey, purchases }) => {
    if (![scopeId, key].every((value) => typeof value === 'string' && value && value.length <= 220) || !Array.isArray(purchases) || !purchases.length || purchases.length > 16) {
      throw new TypeError('Use a stable acquisition identity and up to 16 purchases');
    }
    walletPublicKey = new PublicKey(walletPublicKey).toBase58();
    const id = identity({ scopeId, key, walletPublicKey, network }), reviewed = [];
    for (const [index, purchase] of purchases.entries()) {
      if (purchase.intent.walletPublicKey !== walletPublicKey) throw new TypeError('Use the same approved wallet for every purchase');
      const child = await plainSwaps.preview({ ...purchase, scopeId, key: `${key}/${index}`, workflowId: id });
      reviewed.push({ id: child.id, plan: child.plan });
    }
    if (new Set(reviewed.map((item) => item.plan.review.intent.outputMint)).size !== reviewed.length) throw new TypeError('Combine each quote mint into one approved purchase');
    const maxSpendLamports = sum(reviewed.map((item) => item.plan), 'maxSpendLamports');
    if (!whole(maxSpendLamports)) throw new TypeError('Use an exact acquisition spending ceiling');
    const plan = { scopeId, key, walletPublicKey, network, genesisHash: expectedGenesisHash, purchases: reviewed, maxSpendLamports };
    return { id, plan, digest: hash(plan), state: 'prepared', approvals: [], recoveryPlans: [], result: null };
  };
  return {
    get,
    active(walletPublicKey) { const job = records.load().find((item) => item.plan.walletPublicKey === walletPublicKey && !['confirmed', 'recovered'].includes(item.state)); return job ? get(job.id) : null; },
    async preview(input) { return owned(input.walletPublicKey, () => preview(input)); },
    async prepare(input) {
      return owned(input.walletPublicKey, async () => {
        const job = await preview(input), prior = get(job.id);
        if (prior) {
          if (!equal(prior.plan, job.plan)) throw fail('OPERATION_CONFLICT', 'Recover the original acquisition before changing its purchases');
          return prior;
        }
        await approve(job, input.approval);
        const balances = await connection.getMultipleAccountsInfoAndContext([new PublicKey(job.plan.walletPublicKey)], { commitment: 'finalized' });
        const wallet = balances?.value?.[0];
        if (!whole(balances?.context?.slot) || balances.value.length !== 1 || !whole(wallet?.lamports) || wallet.executable
            || wallet.owner?.toBase58() !== SystemProgram.programId.toBase58()) throw fail('CHAIN_STATE_UNAVAILABLE', 'Read the complete acquisition wallet balance');
        if (wallet.lamports < job.plan.maxSpendLamports) throw fail('INSUFFICIENT_FUNDS', 'Fund the complete acquisition budget before the first purchase');
        await approve(job, input.approval);
        return records.transaction(() => {
          store.reserveWalletWorkflow({ id: job.id, walletPublicKey: job.plan.walletPublicKey, kind: ACQUISITION_KIND, context: { plan: job.plan, digest: job.digest } });
          records.save([...records.load(), { ...job, approvals: [copy(input.approval)] }]); return get(job.id);
        });
      });
    },
    async execute({ id, approval }) {
      const initial = get(id);
      if (!initial) throw fail('OPERATION_UNKNOWN', 'Prepare the acquisition before execution');
      return owned(initial.plan.walletPublicKey, async () => {
        let job = read(id); checkHost(job);
        if (['confirmed', 'recovered'].includes(job.state)) return { jobId: id, ...get(id).result };
        assertReservation(job);
        if (job.state === 'recovery_required') throw fail('TRANSACTION_FAILED', 'Review the failed purchase and its acquisition cleanup');
        for (const child of job.plan.purchases) {
          const service = serviceFor(job, child, approval), childApproval = approvalForChild(approval, child);
          try {
            if (!service.get(child.id)) await service.prepare({ ...requestFor(child), approval: childApproval });
            await service.execute({ id: child.id, approval: childApproval });
          } catch (error) {
            if (service.get(child.id)?.failure) update(id, (value) => ({ ...value, state: 'recovery_required' }));
            error.jobId = id; throw error;
          }
        }
        job = read(id); return finish(job, 'confirmed');
      });
    },
    async prepareCleanup({ id }) {
      const job = get(id); if (!job) throw fail('OPERATION_UNKNOWN', 'Recover the saved acquisition');
      return owned(job.plan.walletPublicKey, async () => {
        checkHost(job);
        if (job.state === 'recovered') return job.recoveryPlans.at(-1);
        assertReservation(job);
        const failed = children(job).find((item) => item?.failure);
        if (!failed) throw fail('SWAP_FAILURE_REQUIRED', 'Recover the failed purchase receipt before preparing cleanup');
        const cleanup = await plainSwaps.prepareCleanup({ id: failed.id });
        const plan = { jobId: id, planDigest: job.digest, childId: failed.id, childRecoveryDigest: cleanup.digest,
          maxSpendLamports: sum(children(job).filter((item) => item?.id !== failed.id).flatMap(costs), 'grossDebitLamports') + cleanup.plan.maxSpendLamports };
        const recovery = { ...plan, digest: hash(plan) };
        return update(id, (value) => ({ ...value, state: 'recovery_required',
          recoveryPlans: value.recoveryPlans.some((item) => item.digest === recovery.digest) ? value.recoveryPlans : [...value.recoveryPlans, recovery] })).recoveryPlans.at(-1);
      });
    },
    async cleanup({ id, approval }) {
      const job = get(id); if (!job) throw fail('OPERATION_UNKNOWN', 'Recover the saved acquisition');
      return owned(job.plan.walletPublicKey, async () => {
        checkHost(job);
        if (job.state === 'recovered') return { jobId: id, ...job.result };
        assertReservation(job);
        const recovery = job.recoveryPlans.at(-1);
        if (!recovery) throw fail('CLEANUP_PLAN_REQUIRED', 'Prepare and approve acquisition cleanup');
        const child = job.plan.purchases.find((item) => item.id === recovery.childId);
        const cleanup = plainSwaps.get(child.id)?.cleanupAttempts?.at(-1);
        if (cleanup?.digest !== recovery.childRecoveryDigest) throw fail('OPERATION_CONFLICT', 'Recover the saved acquisition cleanup plan');
        const service = serviceFor(job, child, approval, recovery, cleanup);
        await service.cleanup({ id: child.id, approval: approvalForChild(approval, child, cleanup) });
        return finish(read(id), 'recovered');
      });
    },
  };
}
