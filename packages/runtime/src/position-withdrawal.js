import { createHash } from 'node:crypto';
import { PublicKey, SystemProgram, VersionedTransaction } from '@solana/web3.js';
import { publicJson, RecoveryStorageError } from './store.js';
import { buildPositionWithdrawalPlan } from './position-withdrawal-plan.js';
import { createPreparedTransactionService } from './prepared-transaction.js';
import { readPreparedFailure, verifyPreparedFailure } from './prepared-failure.js';
import { withdrawalReceiptWitness, verifyWithdrawalEffects, verifySavedWithdrawal, readWithdrawalPosition } from './position-withdrawal-result.js';

export const POSITION_WITHDRAWAL_KIND = 'position-withdrawal';
const hash = (value) => createHash('sha256').update(publicJson(value)).digest('hex');
const equal = (a, b) => publicJson(a) === publicJson(b);
const copy = (value) => JSON.parse(publicJson(value));
const whole = (value) => Number.isSafeInteger(value) && value >= 0;
const fail = (code, message, fields = {}) => Object.assign(new Error(message), { code, ...fields });
const identity = ({ scopeId, walletPublicKey, network, key }) => hash({ scopeId, walletPublicKey, network, kind: POSITION_WITHDRAWAL_KIND, key });
const busy = new WeakMap();
const approved = (approval, job) => typeof approval?.id === 'string' && approval.id.length > 0 && approval.id.length <= 220
  && approval.scopeId === job.plan.scopeId && approval.key === job.plan.key && approval.walletPublicKey === job.plan.walletPublicKey
  && approval.network === job.plan.network && approval.genesisHash === job.plan.genesisHash && approval.planDigest === job.digest
  && whole(approval.expiresAtMs) && whole(approval.maxSpendLamports) && approval.maxSpendLamports >= job.plan.maxSpendLamports;

// Preparation saves a public review draft. Approval then reserves this wallet
// through finalized success or a complete atomic failure receipt.
export function createPositionWithdrawalService(options) {
  const { owner, store, connection, network, expectedGenesisHash, authorize, now = Date.now } = options;
  if (owner?.profile !== store?.directory || typeof authorize !== 'function') throw new TypeError('Supply the owned withdrawal profile and approval interface');
  const records = store.collection('runtime-position-withdrawals/v1');
  if (!busy.has(owner)) busy.set(owner, new Set());
  const owned = async (wallet, run) => {
    owner.assertActive();
    if (busy.get(owner).has(wallet)) throw fail('OPERATION_IN_FLIGHT', 'Recover the active withdrawal request');
    busy.get(owner).add(wallet);
    try { return await run(); } finally { busy.get(owner).delete(wallet); }
  };
  const load = () => {
    try {
      const jobs = records.load();
      if (!Array.isArray(jobs) || new Set(jobs.map((job) => job.id)).size !== jobs.length) throw new Error('Read distinct withdrawal jobs');
      for (const job of jobs) {
        const { plan } = job;
        if (identity(plan) !== job.id || hash(plan) !== job.digest || !['prepared', 'approved', 'confirmed', 'failed'].includes(job.state)
            || !whole(plan.maxSpendLamports) || !whole(plan.rentCeilingLamports) || !whole(plan.feeCeilingLamports)
            || plan.maxSpendLamports !== plan.feeCeilingLamports + plan.rentCeilingLamports
            || !Array.isArray(job.approvals) || new Set(job.approvals.map((item) => item.id)).size !== job.approvals.length
            || job.approvals.some((item) => !approved(item, job)) || job.state !== 'prepared' && !job.approvals.length
            || !Array.isArray(plan.tokens) || plan.tokens.length < 2 || plan.tokens.length > 5
            || new Set(plan.tokens.map((row) => row.mint)).size !== plan.tokens.length
            || !Array.isArray(plan.accountKeys) || new Set(plan.accountKeys).size !== plan.accountKeys.length
            || plan.accountKeys[0] !== plan.walletPublicKey || plan.network !== plan.request.network) throw new Error('Verify the complete saved withdrawal plan and approvals');
        const transaction = VersionedTransaction.deserialize(Buffer.from(plan.template, 'base64'));
        if (transaction.message.header.numRequiredSignatures !== 1 || transaction.signatures.some((row) => row.some((byte) => byte !== 0))
            || transaction.message.recentBlockhash !== PublicKey.default.toBase58()
            || transaction.message.staticAccountKeys[0]?.toBase58() !== plan.walletPublicKey) throw new Error('Verify the saved unsigned withdrawal template');
        if (job.state === 'confirmed') {
          const result = verifySavedWithdrawal(store, job.result.operationId, plan, job.witness), operation = store.getOperation(result.operationId);
          if (!equal(job.result, { status: 'confirmed', poolId: plan.poolId, nftMint: plan.nftMint, ...result })
              || !equal(operation.evidence.chain.witness, job.witness)) throw new Error('Verify the saved withdrawal completion against its receipt');
        } else if (job.state === 'failed') {
          const result = verifyPreparedFailure(store, job.result.operationId, job.witness), operation = store.getOperation(result.operationId);
          if (operation.kind !== POSITION_WITHDRAWAL_KIND || !equal(store.getLaunch(operation.launchId)?.config?.plan, plan)
              || !equal(job.result, { status: 'failed', poolId: plan.poolId, nftMint: plan.nftMint, ...result })) throw new Error('Verify the saved withdrawal failure against its receipt');
        } else if (job.result !== null || job.witness !== null) throw new Error('Read complete withdrawal state');
      }
      return jobs;
    } catch (cause) { throw new RecoveryStorageError('Preserve the withdrawal records and recover their saved evidence.', { cause }); }
  };
  const get = (id) => load().find((job) => job.id === id) || null;
  const update = (id, change) => records.transaction(() => {
    owner.assertActive(); const all = load(), index = all.findIndex((job) => job.id === id);
    if (index < 0) throw fail('OPERATION_UNKNOWN', 'Prepare the withdrawal before saving its progress');
    all[index] = change(all[index]); records.save(all); return all[index];
  });
  const checkHost = (job) => {
    owner.assertActive();
    if (job.plan.network !== network || job.plan.genesisHash !== expectedGenesisHash) throw fail('NETWORK_MISMATCH', 'Recover the withdrawal on its saved chain');
  };
  const checkApproval = async (job, approval) => {
    checkHost(job);
    if (!approved(approval, job) || approval.expiresAtMs <= now() || await authorize({ approval, job }) !== true) throw fail('EXECUTION_APPROVAL_REQUIRED', 'Approve the saved position, minima, wallet, network, spending ceiling, and expiry');
    owner.assertActive();
  };
  const saveApproval = (job, approval) => update(job.id, (saved) => {
    const prior = saved.approvals.find((item) => item.id === approval.id);
    if (prior && !equal(prior, approval)) throw fail('OPERATION_CONFLICT', 'Preserve the original withdrawal approval');
    return prior ? saved : { ...saved, approvals: [...saved.approvals, copy(approval)] };
  });
  const reservation = (job) => {
    const saved = store.getWalletWorkflow(job.plan.walletPublicKey);
    if (saved?.id !== job.id || saved.kind !== POSITION_WITHDRAWAL_KIND || !equal(saved.context, { plan: job.plan, digest: job.digest })) throw fail('OPERATION_CONFLICT', 'Recover the complete withdrawal wallet reservation');
  };
  const funded = async (job) => {
    if (await connection.getGenesisHash() !== expectedGenesisHash) throw fail('NETWORK_MISMATCH', 'Read the withdrawal balance on its approved chain');
    const result = await connection.getMultipleAccountsInfoAndContext([new PublicKey(job.plan.walletPublicKey)], { commitment: 'finalized', minContextSlot: job.plan.observedSlot });
    const wallet = result?.value?.[0];
    if (!whole(result?.context?.slot) || result.context.slot < job.plan.observedSlot || result.value.length !== 1 || !whole(wallet?.lamports)
        || wallet.executable || !wallet.owner.equals(SystemProgram.programId) || wallet.data.length !== 0) throw fail('CHAIN_STATE_UNAVAILABLE', 'Read the complete finalized withdrawal wallet');
    if (wallet.lamports < job.plan.maxSpendLamports) throw fail('INSUFFICIENT_FUNDS', 'Fund the approved withdrawal fee and account rent before execution');
  };
  const finish = (job, state, result, witness) => records.transaction(() => {
    reservation(job);
    const saved = update(job.id, (value) => ({ ...value, state, result: { status: state, poolId: value.plan.poolId, nftMint: value.plan.nftMint, ...result }, witness }));
    // Read back and validate the saved witness before releasing wallet admission.
    const verified = get(saved.id); store.finishWalletWorkflow(job.id, verified.result); return { jobId: job.id, ...verified.result };
  });
  return {
    get,
    list(walletPublicKey) { return load().filter((job) => job.plan.walletPublicKey === walletPublicKey); },
    async prepare(input) {
      const { scopeId, key, walletPublicKey, poolId, nftMint, expectedLiquidity, requestId, lookupTables = [], slippageBps = 100,
        priorityFeeMicroLamports = 50000, feePadLamports = 5000 } = input;
      if (![scopeId, key].every((value) => typeof value === 'string' && value && value.length <= 220)) throw new TypeError('Use a stable withdrawal scope and key');
      return owned(walletPublicKey, async () => {
        const request = { scopeId, key, walletPublicKey, poolId, nftMint, expectedLiquidity, requestId, lookupTables, slippageBps, priorityFeeMicroLamports, feePadLamports, network };
        const id = identity(request), prior = get(id);
        if (prior) {
          checkHost(prior);
          if (!equal(prior.plan.request, request)) throw fail('OPERATION_CONFLICT', 'Recover the original withdrawal before changing its request');
          return prior;
        }
        const built = await buildPositionWithdrawalPlan({ ...request, connection, expectedGenesisHash });
        const unsigned = new VersionedTransaction(built.transaction.message); unsigned.message.recentBlockhash = PublicKey.default.toBase58();
        const plan = { ...built.plan, scopeId, key, request, template: Buffer.from(unsigned.serialize()).toString('base64') };
        const job = { id, plan, digest: hash(plan), state: 'prepared', approvals: [], result: null, witness: null };
        owner.assertActive(); records.transaction(() => { records.save([...load(), job]); }); return get(id);
      });
    },
    async execute({ id, approval }) {
      const initial = get(id);
      if (!initial) throw fail('OPERATION_UNKNOWN', 'Prepare and review the withdrawal before execution');
      return owned(initial.plan.walletPublicKey, async () => {
        let job = get(id); checkHost(job);
        if (['confirmed', 'failed'].includes(job.state)) return { jobId: id, ...job.result };
        if (job.state === 'prepared') {
          await checkApproval(job, approval); await funded(job);
          await readWithdrawalPosition(connection, job.plan); await checkApproval(job, approval);
          job = records.transaction(() => {
            store.reserveWalletWorkflow({ id, walletPublicKey: job.plan.walletPublicKey, kind: POSITION_WITHDRAWAL_KIND, context: { plan: job.plan, digest: job.digest } });
            saveApproval(job, approval); return update(id, (value) => ({ ...value, state: 'approved' }));
          });
        }
        reservation(job);
        const { plan } = job;
        const service = createPreparedTransactionService({ ...options, kind: POSITION_WITHDRAWAL_KIND, receiptCreditAccounts: plan.refundAccounts,
          authorize: async ({ approval: candidate, launch }) => {
            const saved = get(id); reservation(saved);
            if (!equal(launch.config.plan, saved.plan) || launch.config.workflowId !== id) throw fail('OPERATION_CONFLICT', 'Use the saved withdrawal plan and wallet reservation');
            await checkApproval(saved, candidate); saveApproval(saved, candidate); return true;
          },
          checkResult: async ({ receipt, confirmed, minContextSlot }) => {
            if (!confirmed) return { state: 'absent', slot: await readWithdrawalPosition(connection, plan, { minContextSlot }) };
            const witness = withdrawalReceiptWitness(receipt), effects = verifyWithdrawalEffects(plan, witness);
            const slot = await readWithdrawalPosition(connection, plan, { minContextSlot: Math.max(minContextSlot, receipt.slot), closed: true });
            return { state: 'present', slot, evidence: { ...effects, witness } };
          } });
        try {
          const result = await service.execute({ scopeId: plan.scopeId, key: plan.key, walletPublicKey: plan.walletPublicKey, plan, approval, workflowId: id,
            build: async () => {
              await funded(job);
              return { transaction: VersionedTransaction.deserialize(Buffer.from(plan.template, 'base64')), accountKeys: plan.accountKeys,
                result: { poolId: plan.poolId, nftMint: plan.nftMint }, allowExisting: false,
                feeCeilingLamports: plan.feeCeilingLamports, maxSpendLamports: plan.maxSpendLamports };
            } });
          const verified = verifySavedWithdrawal(store, result.operationId, plan, result.witness);
          return finish(job, 'confirmed', verified, result.witness);
        } catch (error) {
          if (error.code === 'TRANSACTION_FAILED' && error.operationId) {
            const { witness, ...result } = await readPreparedFailure({ owner, store, connection, operationId: error.operationId, network, expectedGenesisHash });
            finish(job, 'failed', result, witness);
          }
          error.jobId = id; throw error;
        }
      });
    },
  };
}
