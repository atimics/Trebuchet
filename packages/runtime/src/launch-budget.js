import { createHash } from 'node:crypto';
import { publicJson, RecoveryStorageError } from './store.js';

const hash = (value) => createHash('sha256').update(publicJson(value)).digest('hex');
const copy = (value) => JSON.parse(publicJson(value));
const same = (a, b) => publicJson(a) === publicJson(b);
const whole = (value) => Number.isSafeInteger(value) && value >= 0;
const text = (value) => typeof value === 'string' && value.length > 0 && value.length <= 220;
const digest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fail = (message, code = 'OPERATION_CONFLICT') => Object.assign(new Error(message), { code });
const identity = ({ scopeId, walletPublicKey, network, genesisHash }) => hash({ scopeId, walletPublicKey, network, genesisHash });
const total = (values) => {
  const value = values.reduce((sum, item) => sum + BigInt(item), 0n);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw fail('Keep launch budget totals within exact integer limits');
  return Number(value);
};
const validPlan = (plan) => plan?.version === 1 && plan.returnPolicy === 'report-only'
  && [plan.scopeId, plan.walletPublicKey, plan.genesisHash].every(text) && ['mainnet', 'devnet', 'localnet', 'demo'].includes(plan.network)
  && digest(plan.planDigest) && whole(plan.maxSpendLamports);
const validApproval = (approval, budget) => text(approval?.id) && approval.budgetId === budget.id && approval.budgetDigest === budget.digest
  && approval.scopeId === budget.plan.scopeId && approval.walletPublicKey === budget.plan.walletPublicKey
  && approval.network === budget.plan.network && approval.genesisHash === budget.plan.genesisHash && approval.planDigest === budget.plan.planDigest
  && approval.maxSpendLamports === budget.plan.maxSpendLamports && whole(approval.expiresAtMs);

// Each reservation covers one atomic operation, including every replacement
// of its expired signed transaction. Verified returns are reported separately;
// gross spending consumes approval and returns retain that original charge.
export function createLaunchBudgetLedger({ owner, store, authorize, verifyCost, now = Date.now }) {
  if (owner?.profile !== store?.directory || typeof owner?.assertActive !== 'function'
      || typeof authorize !== 'function' || typeof verifyCost !== 'function') throw new TypeError('Supply the budget owner, store, approval check, and verified cost reader');
  const records = store.collection('runtime-launch-budgets/v1');
  const context = (budget, operationId) => {
    const operation = store.getOperation(operationId), launch = operation && store.getLaunch(operation.launchId);
    if (!operation || launch?.walletPublicKey !== budget.plan.walletPublicKey || launch.network !== budget.plan.network
        || launch.config.scopeId !== budget.plan.scopeId || launch.config.genesisHash !== budget.plan.genesisHash) {
      throw fail('Reserve the operation within its approved launch, wallet, and chain');
    }
    return { operation, launch, transactions: store.getTransactions(operationId) };
  };
  const proof = (value) => hash({ operation: value.operation, launch: value.launch, transactions: value.transactions });
  const summary = (budget) => {
    const settled = budget.entries.filter((entry) => entry.state === 'settled');
    const reservedLamports = total(budget.entries.filter((entry) => entry.state === 'reserved').map((entry) => entry.maxSpendLamports));
    const grossDebitLamports = total(settled.map((entry) => entry.cost.grossDebitLamports));
    const returnedLamports = total(settled.map((entry) => entry.cost.returnedLamports));
    const feeLamports = total(settled.map((entry) => entry.cost.feeLamports));
    const used = total([reservedLamports, grossDebitLamports]);
    if (used > budget.plan.maxSpendLamports) throw fail('Recover the launch spending ledger within its approved ceiling');
    return { reservedLamports, grossDebitLamports, returnedLamports, feeLamports, netDebitLamports: grossDebitLamports - returnedLamports,
      availableLamports: budget.plan.maxSpendLamports - used };
  };
  const terminalContext = (budget, operationId) => {
    const value = context(budget, operationId), { operation, transactions } = value;
    const final = transactions.filter((tx) => ['confirmed', 'failed'].includes(tx.state));
    if (!['confirmed', 'failed'].includes(operation.state) || final.length !== 1 || transactions.some((tx) => !['confirmed', 'failed', 'expired'].includes(tx.state))
        || final[0].state !== operation.state || final[0].receipt?.commitment !== 'finalized'
        || !whole(final[0].receipt.slot) || final[0].state === 'confirmed' && final[0].receipt.error !== null
        || final[0].state === 'failed' && final[0].receipt.error == null) throw fail('Verify one final receipt and every earlier transaction before settling the budget');
    return { value, final: final[0] };
  };
  const validCost = (cost, entry, terminal) => cost && cost.operationId === entry.operationId && cost.signature === terminal.signature
    && cost.status === terminal.state && [cost.grossDebitLamports, cost.returnedLamports, cost.feeLamports].every(whole)
    && cost.grossDebitLamports >= cost.feeLamports && cost.grossDebitLamports <= entry.maxSpendLamports
    && (cost.status !== 'failed' || cost.grossDebitLamports === cost.feeLamports && cost.returnedLamports === 0);
  const load = () => {
    owner.assertActive();
    try {
      const budgets = records.load();
      if (new Set(budgets.map((budget) => budget.id)).size !== budgets.length) throw fail('Read distinct launch budgets');
      for (const budget of budgets) {
        if (!validPlan(budget.plan) || identity(budget.plan) !== budget.id || hash(budget.plan) !== budget.digest
            || !Array.isArray(budget.approvals) || new Set(budget.approvals.map((approval) => approval.id)).size !== budget.approvals.length
            || budget.approvals.some((approval) => !validApproval(approval, budget)) || !Array.isArray(budget.entries)
            || new Set(budget.entries.map((entry) => entry.operationId)).size !== budget.entries.length) throw fail('Verify the saved launch budget and approvals');
        for (const entry of budget.entries) {
          const value = context(budget, entry.operationId);
          if (!budget.approvals.some((approval) => approval.id === entry.approvalId) || !whole(entry.maxSpendLamports)
              || entry.intentDigest !== value.operation.intentDigest || entry.launchDigest !== value.launch.planDigest
              || !['reserved', 'settled'].includes(entry.state)) throw fail('Verify the complete operation reservation');
          if (entry.state === 'settled') {
            const terminal = terminalContext(budget, entry.operationId);
            if (!validCost(entry.cost, entry, terminal.final) || entry.proofDigest !== proof(terminal.value)
                || entry.costDigest !== hash({ cost: entry.cost, proofDigest: entry.proofDigest })) throw fail('Recover the original verified launch cost');
          } else if (entry.cost !== null || entry.costDigest !== null || entry.proofDigest !== null) throw fail('Keep pending costs reserved until verification');
        }
        summary(budget);
      }
      return budgets;
    } catch (error) {
      if (error instanceof RecoveryStorageError) throw error;
      throw new RecoveryStorageError('Launch spending records need recovery before the next operation.', { cause: error });
    }
  };
  const get = (id) => load().find((budget) => budget.id === id) || null;
  const update = (id, mutate) => records.transaction(() => {
    const budgets = load(), index = budgets.findIndex((budget) => budget.id === id);
    if (index < 0) throw fail('Prepare the launch budget before execution');
    budgets[index] = mutate(budgets[index]); summary(budgets[index]); records.save(budgets); return get(id);
  });
  return {
    get(id) { const budget = get(id); return budget ? { ...budget, totals: summary(budget) } : null; },
    prepare(input) {
      owner.assertActive();
      const plan = { version: 1, returnPolicy: 'report-only', ...copy(input) };
      if (!validPlan(plan)) throw new TypeError('Use a complete launch identity and exact spending ceiling');
      return records.transaction(() => {
        const id = identity(plan), budgets = load(), prior = budgets.find((budget) => budget.id === id);
        if (prior) { if (!same(prior.plan, plan)) throw fail('Preserve the approved launch plan and spending ceiling'); return prior; }
        const budget = { id, plan, digest: hash(plan), approvals: [], entries: [] }; records.save([...budgets, budget]); return get(id);
      });
    },
    async approve({ id, approval }) {
      const budget = get(id), candidate = copy(approval);
      if (!budget || !validApproval(candidate, budget) || candidate.expiresAtMs <= now()
          || await authorize({ budget: copy(budget), approval: copy(candidate) }) !== true) throw fail('Approve the saved launch budget and exact spending ceiling');
      owner.assertActive();
      if (candidate.expiresAtMs <= now()) throw fail('Renew the launch budget approval before spending');
      return update(id, (current) => {
        const prior = current.approvals.find((item) => item.id === candidate.id);
        if (prior && !same(prior, candidate)) throw fail('Preserve the original launch budget approval');
        return prior ? current : { ...current, approvals: [...current.approvals, candidate] };
      });
    },
    reserve({ id, operationId, maxSpendLamports }) {
      if (!whole(maxSpendLamports)) throw new TypeError('Reserve an exact operation spending ceiling');
      return update(id, (budget) => {
        const value = context(budget, operationId), prior = budget.entries.find((entry) => entry.operationId === operationId);
        const approval = budget.approvals.findLast((item) => item.expiresAtMs > now());
        if (!approval) throw fail('Approve the launch budget before reserving funds');
        if (prior) {
          if (prior.state !== 'reserved' || prior.maxSpendLamports !== maxSpendLamports) throw fail('Preserve the original operation spending reservation');
          return budget;
        }
        if (!['prepared', 'recovery_required'].includes(value.operation.state) || value.transactions.length) throw fail('Reserve launch funds before signing the operation');
        if (maxSpendLamports > summary(budget).availableLamports) throw fail('The operation exceeds the remaining launch budget');
        return { ...budget, entries: [...budget.entries, { operationId, intentDigest: value.operation.intentDigest, launchDigest: value.launch.planDigest,
          approvalId: approval.id, maxSpendLamports, state: 'reserved', cost: null, costDigest: null, proofDigest: null }] };
      });
    },
    async settle({ id, operationId }) {
      const budget = get(id), entry = budget?.entries.find((item) => item.operationId === operationId);
      if (!entry) throw fail('Recover the original operation budget reservation');
      if (entry.state === 'settled') return budget;
      const terminal = terminalContext(budget, operationId), proofDigest = proof(terminal.value);
      const cost = copy(await verifyCost({ budget: copy(budget), ...copy(terminal.value) }));
      owner.assertActive();
      if (!validCost(cost, entry, terminal.final)) throw fail('Verify the complete operation cost within its reservation');
      return update(id, (current) => {
        const fresh = terminalContext(current, operationId);
        if (proof(fresh.value) !== proofDigest) throw fail('Recover the original operation receipt before settling its cost');
        const index = current.entries.findIndex((item) => item.operationId === operationId), prior = current.entries[index];
        if (prior.state === 'settled') {
          if (!same(prior.cost, cost)) throw fail('Preserve the original verified operation cost');
          return current;
        }
        const entries = current.entries.slice();
        entries[index] = { ...prior, state: 'settled', cost, proofDigest, costDigest: hash({ cost, proofDigest }) };
        return { ...current, entries };
      });
    },
  };
}
