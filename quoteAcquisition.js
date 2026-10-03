import { createHash, randomUUID } from 'node:crypto';
import { Connection, VersionedTransaction } from '@solana/web3.js';
import { openRuntimeStore, publicJson, RecoveryStorageError } from '@trebuchet/runtime/store';
import { createQuoteAcquisitionService } from '@trebuchet/runtime/quote-acquisition';
import { createQuotePlanBuilder, normalizeQuoteRequest } from '@trebuchet/runtime/quote-plan';
import { createSolanaSigner, SOLANA_GENESIS_HASHES } from '@trebuchet/runtime/solana';
import { getNetwork, getRpcUrl } from './rpcConfig.js';

const hash = (value) => createHash('sha256').update(publicJson(value)).digest('hex');
const copy = (value) => JSON.parse(publicJson(value));
const fail = (code, message, statusCode = 409) => Object.assign(new Error(message), { code, statusCode });
const namespace = 'local-quote-drafts/v1';
const whole = (value) => Number.isSafeInteger(value) && value >= 0;
const runningByOwner = new WeakMap();

export function createQuoteAcquisitionRuntime({ owner, getScopeId, ensureScopeId = getScopeId, createConnection = () => new Connection(getRpcUrl(), 'finalized'),
  networkForRequest = getNetwork, genesisForNetwork = (network) => SOLANA_GENESIS_HASHES[network], createPlanner = createQuotePlanBuilder, now = Date.now, timeoutMs = 60000 }) {
  if (!owner || typeof getScopeId !== 'function') throw new TypeError('Supply the profile owner and launch journal');
  if (!runningByOwner.has(owner)) runningByOwner.set(owner, { running: new Map(), planning: new Set() });
  const { running, planning } = runningByOwner.get(owner);
  const withStore = (fn) => { owner.assertActive(); const store = openRuntimeStore(owner.profile); try { return fn(store); } finally { store.close(); } };
  const drafts = (store) => {
    try {
      const all = store.collection(namespace).load();
      for (const draft of all) {
        if (draft.id !== draft.preview.id || draft.walletPublicKey !== draft.preview.plan.walletPublicKey
            || draft.scopeId !== draft.preview.plan.scopeId || draft.network !== draft.preview.plan.network || draft.genesisHash !== draft.preview.plan.genesisHash
            || hash(draft.preview.plan) !== draft.preview.digest || draft.requestDigest !== draft.preview.plan.context.requestDigest
            || !Array.isArray(draft.preview.plan.context.rows) || !whole(draft.createdAtMs) || !whole(draft.expiresAtMs)) throw new Error('Verify the complete saved quote draft');
      }
      return all;
    } catch (cause) { throw new RecoveryStorageError('Preserve the saved quote drafts and recover their plan.', { cause }); }
  };
  const load = (store, id) => drafts(store).find((item) => item.id === id) || null;
  const save = (store, draft) => store.transaction(() => {
    owner.assertActive(); const all = drafts(store), index = all.findIndex((item) => item.id === draft.id);
    if (index < 0) all.push(draft); else all[index] = draft;
    store.collection(namespace).save(all); return draft;
  });
  const service = (store, draft, { connection = createConnection(), signer, authorize = async () => false } = {}) => createQuoteAcquisitionService({ owner, store, connection,
    network: draft.network, expectedGenesisHash: draft.genesisHash, signer, authorize, now, timeoutMs });
  const view = (store, draft) => {
    const job = service(store, draft).get(draft.id), busy = running.get(draft.walletPublicKey)?.id === draft.id;
    const status = job?.state === 'confirmed' || job?.state === 'recovered' ? 'done' : busy ? 'running'
      : job?.state === 'recovery_required' ? 'recovery_required' : job ? 'paused' : 'review_required';
    const results = [], pendingMints = [], inProgressMints = [];
    for (const row of draft.preview.plan.context.rows) {
      const purchase = job?.progress.purchases.find((item) => item.outputMint === row.quoteMint), result = purchase?.result;
      if (row.state === 'held') results.push({ ...row, allocationIndex: row.allocationIndices[0], success: true, txId: null, swappedRaw: '0', finalBalanceRaw: row.alreadyHadRaw });
      else if (result) {
        const child = draft.preview.plan.purchases.find((item) => item.id === purchase.jobId), index = child.plan.review.steps.findIndex((step) => step.trade), trade = result.receipts[index];
        const before = trade?.receiptBefore.accounts[child.plan.review.intent.destinationTokenAccount]?.amountRaw || row.alreadyHadRaw;
        results.push({ ...row, allocationIndex: row.allocationIndices[0], success: purchase.state === 'confirmed' || result.purchaseStatus === 'confirmed', txId: result.txId,
          swappedRaw: result.receivedRaw, alreadyHadRaw: before, finalBalanceRaw: (BigInt(before) + BigInt(result.receivedRaw)).toString(),
          ...(result.purchaseStatus === 'failed' ? { error: 'Purchase failed; cleanup is verified. Review a new quote to continue.' } : {}) });
      } else {
        pendingMints.push(row.quoteMint);
        if (purchase?.state && purchase.state !== 'pending') inProgressMints.push(row.quoteMint);
      }
    }
    const recovery = job?.recoveryPlans.at(-1), plan = draft.preview.plan;
    const cleanup = recovery ? store.collection('runtime-swaps/v1').load().find((child) => child.id === recovery.childId)?.cleanupAttempts?.at(-1)?.plan : null;
    return { jobId: draft.id, walletPublicKey: draft.walletPublicKey, network: draft.network, planDigest: draft.preview.digest,
      status, total: plan.context.rows.length, completed: results.length, results, pendingMints, inProgressMints,
      rows: plan.context.rows, maxSpendLamports: plan.maxSpendLamports,
      inputLamports: plan.purchases.reduce((total, item) => total + Number(item.plan.review.intent.inputAmountRaw), 0),
      feeCeilingLamports: plan.purchases.reduce((total, item) => total + item.plan.review.steps.length * item.plan.feeCeilingLamports, 0),
      rentCeilingLamports: plan.purchases.reduce((total, item) => total + item.plan.review.intent.rentCeilingLamports, 0),
      feeLamports: job?.progress.feeLamports || 0, grossDebitLamports: job?.progress.grossDebitLamports || 0, returnedLamports: job?.progress.returnedLamports || 0,
      expiresAtMs: draft.expiresAtMs, archived: draft.archived === true, error: draft.lastError?.message || null, errorCode: draft.lastError?.code || null,
      ...(recovery ? { recoveryDigest: recovery.digest, recoveryMaxSpendLamports: Math.max(plan.maxSpendLamports, recovery.maxSpendLamports), cleanupFeeCeilingLamports: cleanup?.feeCeilingLamports || 0 } : {}) };
  };
  const get = (id) => withStore((store) => { const draft = load(store, id); return draft ? view(store, draft) : null; });
  const active = (wallet) => withStore((store) => {
    const reservation = store.getWalletWorkflow(wallet);
    if (!reservation || reservation.kind !== 'quote-token-acquisition') return null;
    const draft = load(store, reservation.id);
    if (!draft) throw new RecoveryStorageError('Recover the acquisition draft for the reserved wallet.');
    return view(store, draft);
  });
  const requestFor = (draft) => ({ scopeId: draft.scopeId, key: draft.preview.plan.key, walletPublicKey: draft.walletPublicKey, context: draft.preview.plan.context,
    purchases: draft.preview.plan.purchases.map(({ plan }) => ({ intent: plan.review.intent, feeCeilingLamports: plan.feeCeilingLamports,
      transactions: plan.review.steps.map((step) => VersionedTransaction.deserialize(Buffer.from(step.template, 'base64'))) })) });
  const checkHost = (draft) => {
    owner.assertActive();
    if (networkForRequest() !== draft.network || genesisForNetwork(draft.network) !== draft.genesisHash) throw fail('NETWORK_MISMATCH', 'Select the saved quote network before continuing');
    if (getScopeId(draft.walletPublicKey) !== draft.scopeId) throw fail('OPERATION_CONFLICT', 'Recover quotes through their original launch journal');
  };
  const start = async (input, cleanup = false) => {
    owner.assertActive();
    const { id, ownerKeypair } = input, walletPublicKey = ownerKeypair.publicKey.toBase58();
    if (running.has(walletPublicKey) || planning.has(walletPublicKey)) throw fail('OPERATION_IN_FLIGHT', 'Wait for the current quote request');
    const store = openRuntimeStore(owner.profile); let handedOff = false;
    planning.add(walletPublicKey);
    try {
      let draft = load(store, id);
      if (!draft || draft.walletPublicKey !== walletPublicKey) throw fail('OPERATION_UNKNOWN', 'Use the saved quote job and its wallet', 404);
      checkHost(draft);
      const saved = service(store, draft).get(id), recovery = cleanup ? saved?.recoveryPlans.at(-1) : undefined;
      const limit = cleanup ? Math.max(draft.preview.plan.maxSpendLamports, recovery?.maxSpendLamports || 0) : draft.preview.plan.maxSpendLamports;
      if (input.planDigest !== draft.preview.digest || input.maxSpendLamports !== limit || cleanup && (!recovery || input.recoveryDigest !== recovery.digest)) {
        throw fail('EXECUTION_APPROVAL_REQUIRED', 'Confirm the saved quote plan and exact spending ceiling');
      }
      if (!saved && (draft.archived || now() >= draft.expiresAtMs)) throw fail('QUOTE_EXPIRED', 'Refresh the quote before approving this purchase');
      const approval = { id: randomUUID(), scopeId: draft.scopeId, key: draft.preview.plan.key, walletPublicKey, network: draft.network, genesisHash: draft.genesisHash,
        planDigest: draft.preview.digest, maxSpendLamports: limit, expiresAtMs: now() + 10 * 60000, ...(cleanup ? { recoveryDigest: recovery.digest } : {}) };
      const execution = service(store, draft, { signer: createSolanaSigner({ getSigners: async ({ launch }) => {
        checkHost(draft); if (launch.walletPublicKey !== walletPublicKey) throw fail('SIGNER_MISMATCH', 'Sign the saved quote wallet'); return [ownerKeypair];
      } }), authorize: async ({ approval: candidate }) => { checkHost(draft); return publicJson(candidate) === publicJson(approval); } });
      if (!saved) await execution.prepare({ ...requestFor(draft), approval });
      draft = save(store, { ...draft, lastError: null });
      running.set(walletPublicKey, { id });
      let job;
      try { job = view(store, draft); } catch (error) { running.delete(walletPublicKey); throw error; }
      const completion = Promise.resolve().then(async () => {
        try { return cleanup ? await execution.cleanup({ id, approval }) : await execution.execute({ id, approval }); }
        catch (error) {
          save(store, { ...load(store, id), lastError: { code: error.code || 'EXECUTION_INTERRUPTED', message: String(error.message).slice(0, 2000) } });
          throw error;
        } finally { running.delete(walletPublicKey); store.close(); }
      });
      completion.catch(() => {});
      handedOff = true;
      return { job, completion };
    } finally { planning.delete(walletPublicKey); if (!handedOff) store.close(); }
  };
  return {
    get, active,
    async prepare({ walletPublicKey, autoSwapPlan, requestId = randomUUID() }) {
      if (running.has(walletPublicKey) || planning.has(walletPublicKey)) throw fail('OPERATION_IN_FLIGHT', 'Wait for the current quote request');
      const existing = active(walletPublicKey); if (existing) return existing;
      if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(requestId)) throw new TypeError('Use a stable quote request identity');
      // Quotes belong to the wallet's launch record. A saved wallet with no open record (made on
      // the Wallet page, or reused after a finished launch) gets one here: the route has already
      // checked the app holds this wallet's key.
      const scopeId = ensureScopeId(walletPublicKey), network = networkForRequest(), genesisHash = genesisForNetwork(network);
      if (!scopeId) throw fail('EXECUTION_RECOVERY_REQUIRED', 'Choose a launch wallet this app holds the key for before buying pair tokens');
      if (!genesisHash) throw fail('EXECUTION_RECOVERY_REQUIRED', `Pair tokens can't be bought on the ${network} network. Switch to mainnet or devnet in Settings.`);
      const normalized = normalizeQuoteRequest(autoSwapPlan), requestDigest = hash(normalized);
      const store = openRuntimeStore(owner.profile); planning.add(walletPublicKey);
      try {
        const prior = drafts(store).find((draft) => draft.scopeId === scopeId && draft.walletPublicKey === walletPublicKey && draft.network === network && draft.requestId === requestId);
        if (prior) {
          if (prior.requestDigest !== requestDigest) throw fail('OPERATION_CONFLICT', 'Use the original quote request or choose a new request identity');
          return view(store, prior);
        }
        const connection = createConnection(), built = await createPlanner({ connection, network, expectedGenesisHash: genesisHash }).build({ walletPublicKey, autoSwapPlan });
        const runtime = createQuoteAcquisitionService({ owner, store, connection, network, expectedGenesisHash: genesisHash, authorize: async () => false, now, timeoutMs });
        const preview = await runtime.preview({ scopeId, key: `quotes/${requestId}`, walletPublicKey, purchases: built.purchases, context: { requestDigest, rows: built.rows } });
        const draft = { id: preview.id, walletPublicKey, scopeId, network, genesisHash, requestDigest, requestId, preview: copy(preview),
          createdAtMs: now(), expiresAtMs: now() + 10 * 60000, lastError: null, archived: false };
        checkHost(draft); save(store, draft); return view(store, draft);
      } finally { planning.delete(walletPublicKey); store.close(); }
    },
    start,
    startCleanup: (input) => start(input, true),
    async prepareCleanup(id) {
      owner.assertActive();
      const store = openRuntimeStore(owner.profile);
      try {
        const draft = load(store, id); if (!draft) throw fail('OPERATION_UNKNOWN', 'Recover the saved quote job', 404);
        checkHost(draft); await service(store, draft).prepareCleanup({ id }); return view(store, draft);
      } finally { store.close(); }
    },
    archive(id) {
      return withStore((store) => {
        const draft = load(store, id); if (!draft) return { deleted: false };
        if (running.has(draft.walletPublicKey) || planning.has(draft.walletPublicKey)) throw fail('OPERATION_IN_FLIGHT', 'Wait for the current quote request');
        const job = view(store, draft);
        if (!['done', 'review_required'].includes(job.status)) throw fail('EXECUTION_RECOVERY_REQUIRED', 'Recover the saved quote purchase before clearing its view');
        save(store, { ...draft, archived: true }); return { deleted: true };
      });
    },
  };
}
