import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = (name) => fs.readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const guards = read('public/v2/features/shell/action-guards.js');
const events = read('public/v2/features/shell/events.js');

function button(action, { disabled = false, wallet = '' } = {}) {
  const attrs = new Map();
  return { dataset: { action, ...(wallet ? { wallet } : {}) }, disabled, title: '',
    setAttribute: (name, value) => attrs.set(name, value), removeAttribute: (name) => attrs.delete(name), attrs };
}

function page(overrides = {}) {
  const state = { apiStatus: 'connected', fullRunRunning: false, realExecutionRunning: false, demoActive: false, secretPin: { locked: false, configured: true, damaged: false },
    quoteAcquire: { running: false, job: null }, updateCheck: { checking: false }, rpcSaved: ['a', 'b'], vanityCandidates: [], selectedVanityPublicKey: '', customPools: [], ...overrides.state };
  const elements = overrides.elements || [];
  const context = vm.createContext({
    state, requestAnimationFrame: (run) => { run(); return 1; },
    document: { querySelectorAll: () => elements, body: {} }, MutationObserver: class { observe() {} },
    selectedLaunchWalletPublicKey: () => overrides.wallet ?? 'wallet-a', walletIsUnlocked: () => overrides.unlocked ?? true,
    classicFundingEstimateStatus: () => overrides.estimate || { matchesConfig: true }, currentLaunchConfig: () => ({ poolTopology: { sweepDestination: overrides.destination ?? 'return-wallet' } }),
    quoteAcquireRoutes: () => overrides.routes || ['route'], quoteAcquireManualCount: () => 0,
    currentAirdropPlan: () => overrides.airdrop || { enabled: true, requiredSupplyPercent: 5 },
    currentLaunchProof: () => overrides.proof || null, proofConfigForFingerprint: () => ({ poolTopology: {} }), proofCanCreateLocalDossier: () => true,
    airdropCompletionIssue: () => null, airdropCompletionStatus: () => ({}),
    pendingRecoveryWallet: (address) => (overrides.pending || {})[address] || null, isProbablySolanaAddress: (value) => /wallet/.test(value),
    VANITY_VISIBLE_CANDIDATE_LIMIT: 3, heldShareLocked: () => Boolean(overrides.heldLocked),
    quoteAcquireBlockedPools: () => overrides.blocked || [], customQuoteInfoRecord: (pool) => (overrides.records || {})[pool.id] || null,
  });
  vm.runInContext(guards, context);
  return { context, state, elements };
}

test('an action that cannot run is greyed out with its reason, and comes back when it can', () => {
  const sweep = button('run-full-launch'), arm = button('review-and-arm-run'), fit = button('fit-airdrop-budget');
  const p = page({ elements: [sweep, arm, fit], unlocked: false, airdrop: { enabled: false }, state: { fullRunRunning: true } });
  p.context.applyActionGuards();
  assert.equal(sweep.dataset.blockedReason, 'A launch step is running'); assert.equal(sweep.disabled, true); assert.equal(sweep.title, 'A launch step is running');
  assert.equal(arm.dataset.blockedReason, 'Launch wallet is locked');
  assert.equal(fit.dataset.blockedReason, 'No airdrop recipients');
  assert.equal(sweep.attrs.get('aria-disabled'), 'true');
  p.state.fullRunRunning = false;
  p.context.applyActionGuards();
  assert.equal(sweep.dataset.blockedReason, undefined); assert.equal(sweep.disabled, false); assert.equal(sweep.attrs.has('aria-disabled'), false);
});

test('a button a renderer disabled for its own reason stays disabled', () => {
  const pin = button('setup-secret-pin', { disabled: true });
  const p = page({ elements: [pin], state: { secretPin: { configured: true, locked: false, damaged: false } } });
  p.context.applyActionGuards();
  assert.equal(pin.dataset.blockedReason, 'Already set');
  p.state.secretPin.configured = false;
  p.context.applyActionGuards();
  assert.equal(pin.dataset.blockedReason, undefined);
  assert.equal(pin.disabled, true, 'not re-enabled: the guard did not disable it');
});

test('guards read the element they are on and the state they mirror', () => {
  const locked = button('sweep-recovery-wallet', { wallet: 'wallet-locked' }), open = button('sweep-recovery-wallet', { wallet: 'wallet-open' });
  const refund = button('cancel-refund-launch'), estimate = button('start-quote-acquire'), rpc = button('remove-rpc'), mode = button('run-demo-launch');
  const p = page({ elements: [locked, open, refund, estimate, rpc, mode], destination: '', estimate: { matchesConfig: false, stale: true },
    pending: { 'wallet-locked': { secretPinLocked: true }, 'wallet-open': {} }, state: { rpcSaved: ['only'] } });
  p.context.applyActionGuards();
  assert.equal(locked.dataset.blockedReason, 'Recovery PIN is locked');
  assert.equal(open.dataset.blockedReason, undefined);
  assert.equal(refund.dataset.blockedReason, 'No return wallet set');
  assert.equal(estimate.dataset.blockedReason, 'Funding estimate is out of date');
  assert.equal(rpc.dataset.blockedReason, 'The only saved RPC');
  assert.equal(mode.dataset.blockedReason, 'Test mode is off');
  const offline = page({ elements: [button('add-rpc')], state: { apiStatus: 'offline' } });
  offline.context.applyActionGuards();
  assert.equal(offline.elements[0].dataset.blockedReason, 'Needs the desktop app');
});

test('reasons state a fact, never an instruction', () => {
  for (const reason of guards.matchAll(/'([A-Z][^']{3,})'/g)) {
    assert.doesNotMatch(reason[1], /\b(first|retry|rerun|click|before|try again|please)\b/i, reason[1]);
  }
});

test('clicking a blocked action does nothing', () => {
  assert.match(events, /const actionTarget = event\.target\.closest\('\[data-action\]'\);\n  if \(!actionTarget\) return;\n  \/\/ [^\n]*\n  if \(actionTarget\.dataset\.blockedReason\) return;/);
});

test('buying pair tokens says why it can\'t run: a failed or running token check comes first', () => {
  const button1 = button('start-quote-acquire');
  const failed = page({ elements: [button1], blocked: [{ pool: { quoteSymbol: 'RUG' }, badge: { label: 'Check failed' } }] });
  failed.context.applyActionGuards();
  assert.equal(button1.dataset.blockedReason, '$RUG: Check failed');
  const button2 = button('start-quote-acquire');
  const checking = page({ elements: [button2], records: { p1: { loading: true } }, state: { customPools: [{ id: 'p1' }] } });
  checking.context.applyActionGuards();
  assert.equal(button2.dataset.blockedReason, 'Checking the pair tokens');
  const button3 = button('start-quote-acquire');
  const ready = page({ elements: [button3] });
  ready.context.applyActionGuards();
  assert.equal(button3.dataset.blockedReason, undefined);
});
