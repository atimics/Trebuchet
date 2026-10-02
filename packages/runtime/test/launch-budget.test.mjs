import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireProfileOwner } from '../src/owner.js';
import { openRuntimeStore, RecoveryStorageError } from '../src/store.js';
import { createLaunchBudgetLedger } from '../src/launch-budget.js';
import { ExecutionEngine } from '../src/engine.js';

const plan = { scopeId: 'launch-one', walletPublicKey: 'wallet-one', network: 'localnet', genesisHash: 'genesis-one', planDigest: 'a'.repeat(64), maxSpendLamports: 1000 };
function fixture(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'trebuchet-launch-budget-'));
  let store = openRuntimeStore(directory), owner = acquireProfileOwner(directory), clock = 1000, costReads = 0;
  const costs = new Map();
  const options = () => ({ owner, store, now: () => clock, authorize: async () => true,
    verifyCost: async ({ operation }) => { costReads++; return costs.get(operation.id); }, ...overrides });
  let ledger = createLaunchBudgetLedger(options());
  t.after(() => { store.close(); owner.release(); fs.rmSync(directory, { recursive: true, force: true }); });
  const prepare = async () => {
    const budget = ledger.prepare(plan);
    const approval = { id: 'approval-one', budgetId: budget.id, budgetDigest: budget.digest, ...plan, expiresAtMs: 2000 };
    await ledger.approve({ id: budget.id, approval }); return { budget, approval };
  };
  const operation = (index = 0, config = {}) => {
    store.saveLaunch({ id: `part-${index}`, walletPublicKey: plan.walletPublicKey, network: plan.network, planDigest: 'b'.repeat(64),
      config: { scopeId: plan.scopeId, genesisHash: plan.genesisHash, ...config } });
    return store.prepareOperation({ launchId: `part-${index}`, kind: 'fixture', payload: { index } });
  };
  const finish = (op, { grossDebitLamports = 300, returnedLamports = 50, feeLamports = 10, status = 'confirmed' } = {}) => {
    const signature = `signature-${op.id}`;
    store.recordSignedTransaction({ operationId: op.id, signature, wire: 'fixture-public-wire', blockhash: 'fixture-blockhash', lastValidBlockHeight: 100 });
    const receipt = { slot: 10, commitment: 'finalized', error: status === 'failed' ? { failed: true } : null };
    store.recordReceipt(signature, status, receipt); store.setOperationState(op.id, status, { signature, receipt });
    costs.set(op.id, { operationId: op.id, signature, status, grossDebitLamports, returnedLamports, feeLamports });
  };
  return { directory, costs, options, prepare, operation, finish, get store() { return store; }, get owner() { return owner; }, get ledger() { return ledger; },
    get costReads() { return costReads; }, set time(value) { clock = value; },
    restart() { store.close(); owner.release(); store = openRuntimeStore(directory); owner = acquireProfileOwner(directory); ledger = createLaunchBudgetLedger(options()); },
  };
}

test('launch reservations and actual costs survive restart with separate gross, returned, net, and fee totals', async (t) => {
  const f = fixture(t), { budget } = await f.prepare(), op = f.operation();
  f.ledger.reserve({ id: budget.id, operationId: op.id, maxSpendLamports: 600 });
  assert.equal(f.ledger.get(budget.id).totals.availableLamports, 400);
  f.finish(op); f.restart();
  assert.equal(f.ledger.get(budget.id).totals.reservedLamports, 600);
  await f.ledger.settle({ id: budget.id, operationId: op.id });
  assert.deepEqual(f.ledger.get(budget.id).totals, { reservedLamports: 0, grossDebitLamports: 300, returnedLamports: 50, feeLamports: 10, netDebitLamports: 250, availableLamports: 700 });
  f.restart(); await f.ledger.settle({ id: budget.id, operationId: op.id }); assert.equal(f.costReads, 1);
});

test('independent clients keep a completed operation reserved until its costs commit', async (t) => {
  const f = fixture(t), { budget } = await f.prepare(), first = f.operation();
  f.ledger.reserve({ id: budget.id, operationId: first.id, maxSpendLamports: 600 }); f.finish(first);
  const second = f.operation(1), otherStore = openRuntimeStore(f.directory); t.after(() => otherStore.close());
  const other = createLaunchBudgetLedger({ ...f.options(), store: otherStore });
  assert.throws(() => other.reserve({ id: budget.id, operationId: second.id, maxSpendLamports: 500 }), /remaining launch budget/);
  await f.ledger.settle({ id: budget.id, operationId: first.id });
  other.reserve({ id: budget.id, operationId: second.id, maxSpendLamports: 500 });
  assert.equal(f.ledger.get(budget.id).totals.availableLamports, 200);
});

test('failed fees consume launch approval before a later operation can reserve the balance', async (t) => {
  const f = fixture(t), { budget } = await f.prepare(), op = f.operation();
  f.ledger.reserve({ id: budget.id, operationId: op.id, maxSpendLamports: 900 });
  f.finish(op, { status: 'failed', grossDebitLamports: 30, returnedLamports: 0, feeLamports: 30 });
  await f.ledger.settle({ id: budget.id, operationId: op.id });
  assert.equal(f.ledger.get(budget.id).totals.availableLamports, 970);
  assert.equal(f.ledger.get(budget.id).totals.feeLamports, 30);
  const next = f.operation(1); assert.throws(() => f.ledger.reserve({ id: budget.id, operationId: next.id, maxSpendLamports: 971 }), /remaining launch budget/);
});

test('returned account rent is reported while original gross costs keep their budget charge', async (t) => {
  const f = fixture(t), { budget } = await f.prepare(), op = f.operation();
  f.ledger.reserve({ id: budget.id, operationId: op.id, maxSpendLamports: 100 });
  f.finish(op, { grossDebitLamports: 10, returnedLamports: 500, feeLamports: 10 });
  await f.ledger.settle({ id: budget.id, operationId: op.id });
  const totals = f.ledger.get(budget.id).totals;
  assert.equal(totals.availableLamports, 990); assert.equal(totals.netDebitLamports, -490); assert.equal(totals.returnedLamports, 500);
});

test('launch and reservation identities stay fixed across retry', async (t) => {
  const f = fixture(t), { budget } = await f.prepare(), op = f.operation();
  assert.throws(() => f.ledger.prepare({ ...plan, maxSpendLamports: 1001 }), /approved launch plan/);
  assert.throws(() => f.ledger.prepare({ ...plan, planDigest: 'c'.repeat(64) }), /approved launch plan/);
  const input = { id: budget.id, operationId: op.id, maxSpendLamports: 600 };
  f.ledger.reserve(input); f.ledger.reserve(input); assert.equal(f.ledger.get(budget.id).entries.length, 1);
  assert.throws(() => f.ledger.reserve({ ...input, maxSpendLamports: 601 }), /original operation spending/);
  f.store.recordSignedTransaction({ operationId: op.id, signature: 'expired', wire: 'expired-wire', blockhash: 'expired-hash', lastValidBlockHeight: 1 });
  f.store.recordReceipt('expired', 'expired', { slot: 5, finalizedBlockHeight: 10, blockhashValid: false });
  f.finish(op); await f.ledger.settle({ id: budget.id, operationId: op.id });
  assert.equal(f.ledger.get(budget.id).totals.grossDebitLamports, 300);
});

test('approval expiry permits receipt settlement and requires renewal for the next reservation', async (t) => {
  const f = fixture(t), { budget, approval } = await f.prepare(), op = f.operation();
  f.ledger.reserve({ id: budget.id, operationId: op.id, maxSpendLamports: 600 }); f.finish(op); f.time = 2000;
  await f.ledger.settle({ id: budget.id, operationId: op.id }); const next = f.operation(1);
  assert.throws(() => f.ledger.reserve({ id: budget.id, operationId: next.id, maxSpendLamports: 100 }), /Approve the launch budget/);
  await f.ledger.approve({ id: budget.id, approval: { ...approval, id: 'renewed', expiresAtMs: 3000 } });
  f.ledger.reserve({ id: budget.id, operationId: next.id, maxSpendLamports: 100 });
  assert.equal(f.ledger.get(budget.id).totals.availableLamports, 600);
});

for (const field of ['budgetId', 'budgetDigest', 'scopeId', 'walletPublicKey', 'network', 'genesisHash', 'planDigest', 'maxSpendLamports']) {
  test(`budget approval binds ${field}`, async (t) => {
    const f = fixture(t), budget = f.ledger.prepare(plan);
    const approval = { id: 'changed', budgetId: budget.id, budgetDigest: budget.digest, ...plan, expiresAtMs: 2000, [field]: field === 'maxSpendLamports' ? 1001 : 'changed' };
    await assert.rejects(f.ledger.approve({ id: budget.id, approval }), /Approve the saved launch budget/);
    assert.equal(f.ledger.get(budget.id).approvals.length, 0);
  });
}

test('approval checks must complete before any reservation', async (t) => {
  const f = fixture(t, { authorize: async () => false }), budget = f.ledger.prepare(plan), op = f.operation();
  await assert.rejects(f.ledger.approve({ id: budget.id, approval: { id: 'denied', budgetId: budget.id, budgetDigest: budget.digest, ...plan, expiresAtMs: 2000 } }));
  assert.throws(() => f.ledger.reserve({ id: budget.id, operationId: op.id, maxSpendLamports: 100 }), /Approve the launch budget/);
});

for (const config of [{ scopeId: 'other-launch' }, { genesisHash: 'other-chain' }]) test(`reservation checks ${Object.keys(config)[0]}`, async (t) => {
  const f = fixture(t), { budget } = await f.prepare(), op = f.operation(0, config);
  assert.throws(() => f.ledger.reserve({ id: budget.id, operationId: op.id, maxSpendLamports: 100 }), /approved launch, wallet, and chain/);
});

test('pending receipts retain their complete reservation', async (t) => {
  const f = fixture(t), { budget } = await f.prepare(), op = f.operation();
  f.ledger.reserve({ id: budget.id, operationId: op.id, maxSpendLamports: 600 });
  await assert.rejects(f.ledger.settle({ id: budget.id, operationId: op.id }), /one final receipt/);
  assert.equal(f.costReads, 0); assert.equal(f.ledger.get(budget.id).totals.reservedLamports, 600);
});

test('reservation precedes signed bytes', async (t) => {
  const f = fixture(t), { budget } = await f.prepare(), op = f.operation();
  f.store.recordSignedTransaction({ operationId: op.id, signature: 'early', wire: 'signed', blockhash: 'hash', lastValidBlockHeight: 10 });
  assert.throws(() => f.ledger.reserve({ id: budget.id, operationId: op.id, maxSpendLamports: 100 }), /before signing/);
});

for (const changed of [{ grossDebitLamports: 601 }, { signature: 'other' }, { status: 'failed' }, { feeLamports: 301 }]) test(`verified cost checks ${Object.keys(changed)[0]}`, async (t) => {
  const f = fixture(t), { budget } = await f.prepare(), op = f.operation();
  f.ledger.reserve({ id: budget.id, operationId: op.id, maxSpendLamports: 600 }); f.finish(op);
  f.costs.set(op.id, { ...f.costs.get(op.id), ...changed });
  await assert.rejects(f.ledger.settle({ id: budget.id, operationId: op.id }), /complete operation cost/);
  assert.equal(f.ledger.get(budget.id).totals.reservedLamports, 600);
});

test('a failed settlement commit preserves its reservation and recovers once', async (t) => {
  const f = fixture(t), { budget } = await f.prepare(), op = f.operation();
  f.ledger.reserve({ id: budget.id, operationId: op.id, maxSpendLamports: 600 }); f.finish(op);
  const original = f.store.collection;
  const damaged = createLaunchBudgetLedger({ ...f.options(), store: { ...f.store, collection(namespace) {
    const rows = original(namespace); return { ...rows, save(records) { rows.save(records); throw new RecoveryStorageError('fixture commit failure'); } };
  } } });
  await assert.rejects(damaged.settle({ id: budget.id, operationId: op.id }), { code: 'RECOVERY_STORAGE_UNAVAILABLE' });
  f.restart(); assert.equal(f.ledger.get(budget.id).totals.reservedLamports, 600);
  await f.ledger.settle({ id: budget.id, operationId: op.id }); assert.equal(f.ledger.get(budget.id).totals.grossDebitLamports, 300);
});

test('damaged cost records stay available and block further reservations', async (t) => {
  const f = fixture(t), { budget } = await f.prepare(), op = f.operation();
  f.ledger.reserve({ id: budget.id, operationId: op.id, maxSpendLamports: 600 }); f.finish(op); await f.ledger.settle({ id: budget.id, operationId: op.id });
  const rows = f.store.collection('runtime-launch-budgets/v1'), damaged = rows.load(); damaged[0].entries[0].cost.grossDebitLamports = 1; rows.save(damaged);
  assert.throws(() => f.ledger.get(budget.id), { code: 'RECOVERY_STORAGE_UNAVAILABLE' }); assert.deepEqual(rows.load(), damaged);
});

test('lost profile ownership stops approval and new spending reservations', async (t) => {
  const f = fixture(t), { budget } = await f.prepare(), op = f.operation(); f.owner.release();
  assert.throws(() => f.ledger.reserve({ id: budget.id, operationId: op.id, maxSpendLamports: 100 }));
});

async function engineFixture(t, settings = {}) {
  const state = { sends: 0, signs: 0, fail: false, interruptCost: false, expireOnSign: false, lostReply: false, ...settings }, accepted = new Set();
  const f = fixture(t, { verifyCost: async ({ operation }) => {
    if (state.interruptCost) throw new RecoveryStorageError('fixture settlement interrupted');
    return f.costs.get(operation.id);
  } });
  const { budget, approval } = await f.prepare();
  const makeEngine = () => new ExecutionEngine({ store: f.store, owner: f.owner, authorize: async () => true,
    budget: { reserve: ({ operation }) => f.ledger.reserve({ id: budget.id, operationId: operation.id, maxSpendLamports: settings.ceiling ?? 600 }),
      settle: ({ operation }) => f.ledger.settle({ id: budget.id, operationId: operation.id }) },
    signer: { signTransaction: async ({ operation }) => { state.signs++; if (state.expireOnSign) f.time = 2000; return `wire-${operation.id}`; } },
    chain: { network: plan.network,
      inspectTransaction: async (wire, { operation }) => ({ wire, walletPublicKey: plan.walletPublicKey, signature: `sig-${operation.id}`, blockhash: 'fixture-hash' }),
      readTransaction: async (transaction) => accepted.has(transaction.signature)
        ? { state: state.fail ? 'failed' : 'confirmed', evidence: { commitment: 'finalized', slot: 10, error: state.fail ? { failed: true } : null } }
        : { state: 'rebroadcast', evidence: { slot: 9 } },
      sendTransaction: async (transaction, { operation }) => {
        state.sends++; accepted.add(transaction.signature);
        f.costs.set(operation.id, { operationId: operation.id, signature: transaction.signature, status: state.fail ? 'failed' : 'confirmed',
          grossDebitLamports: state.fail ? 10 : 300, returnedLamports: state.fail ? 0 : 50, feeLamports: 10 });
        if (state.lostReply) throw new Error('fixture lost send reply'); return transaction.signature;
      },
    }, operations: { fixture: { buildTransaction: async () => ({ transaction: {}, blockhash: 'fixture-hash', lastValidBlockHeight: 100 }),
      checkState: async ({ transactions }) => transactions.some((tx) => tx.state === 'confirmed')
        ? { state: 'complete', evidence: { verified: true, slot: 10 } } : { state: 'ready', evidence: { slot: 1 } },
    } },
  });
  const engine = makeEngine(), operation = engine.prepare({ launch: { id: 'engine-part', walletPublicKey: plan.walletPublicKey, network: plan.network,
    planDigest: 'b'.repeat(64), config: { scopeId: plan.scopeId, genesisHash: plan.genesisHash } }, kind: 'fixture' });
  return { f, budget, approval, engine, operation, state, makeEngine };
}

test('the engine reserves launch approval before signing and settles actual costs before completion', async (t) => {
  const h = await engineFixture(t); await h.engine.executeNext(h.operation.id);
  assert.equal(h.state.sends, 1); assert.equal(h.state.signs, 1);
  assert.equal(h.f.ledger.get(h.budget.id).totals.availableLamports, 700);
  await h.engine.resume(h.operation.id); assert.equal(h.state.sends, 1);
});

test('an over-budget operation reaches zero signing or broadcast calls', async (t) => {
  const h = await engineFixture(t, { ceiling: 1001 });
  await assert.rejects(h.engine.executeNext(h.operation.id), /remaining launch budget/);
  assert.equal(h.state.sends, 0); assert.equal(h.state.signs, 0);
});

test('approval is checked again after signing and before broadcast', async (t) => {
  const h = await engineFixture(t, { expireOnSign: true });
  await assert.rejects(h.engine.executeNext(h.operation.id), /Approve the launch budget/);
  assert.equal(h.state.signs, 1); assert.equal(h.state.sends, 0);
  assert.equal(h.f.ledger.get(h.budget.id).totals.reservedLamports, 600);
  await h.f.ledger.approve({ id: h.budget.id, approval: { ...h.approval, id: 'renewed', expiresAtMs: 3000 } });
  await h.engine.resume(h.operation.id); assert.equal(h.state.signs, 1); assert.equal(h.state.sends, 1);
});

test('a completed transaction retains its reservation through interrupted cost settlement and restart', async (t) => {
  const h = await engineFixture(t, { interruptCost: true });
  await assert.rejects(h.engine.executeNext(h.operation.id), { code: 'RECOVERY_STORAGE_UNAVAILABLE' });
  assert.equal(h.f.store.getOperation(h.operation.id).state, 'confirmed');
  assert.equal(h.f.ledger.get(h.budget.id).totals.reservedLamports, 600);
  h.f.restart(); h.state.interruptCost = false;
  await h.makeEngine().resume(h.operation.id);
  assert.equal(h.f.ledger.get(h.budget.id).totals.availableLamports, 700); assert.equal(h.state.sends, 1);
});

test('the engine records failed transaction fees in the shared launch budget', async (t) => {
  const h = await engineFixture(t, { fail: true }); const result = await h.engine.executeNext(h.operation.id);
  assert.equal(result.operation.state, 'failed'); assert.equal(h.f.ledger.get(h.budget.id).totals.availableLamports, 990);
  assert.equal(h.f.ledger.get(h.budget.id).totals.feeLamports, 10);
});

test('a lost send reply recovers the original receipt and settles its cost once', async (t) => {
  const h = await engineFixture(t, { lostReply: true }); await assert.rejects(h.engine.executeNext(h.operation.id), /lost send reply/);
  h.f.restart(); h.state.lostReply = false; await h.makeEngine().resume(h.operation.id);
  assert.equal(h.state.sends, 1); assert.equal(h.state.signs, 1); assert.equal(h.f.ledger.get(h.budget.id).totals.grossDebitLamports, 300);
});

test('renewed budget approval can resume an operation paused before its first reservation', async (t) => {
  const h = await engineFixture(t); h.f.time = 2000;
  await assert.rejects(h.engine.executeNext(h.operation.id), /Approve the launch budget/);
  assert.equal(h.f.store.getOperation(h.operation.id).state, 'recovery_required'); assert.equal(h.state.signs, 0);
  await h.f.ledger.approve({ id: h.budget.id, approval: { ...h.approval, id: 'renewed-before-sign', expiresAtMs: 3000 } });
  await h.engine.resume(h.operation.id); assert.equal(h.state.signs, 1); assert.equal(h.state.sends, 1);
});
