import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const support = fs.readFileSync(new URL('../public/v2/features/launch/support.js', import.meta.url), 'utf8');
const funding = fs.readFileSync(new URL('../public/v2/features/launch/funding-view.js', import.meta.url), 'utf8');
const events = fs.readFileSync(new URL('../public/v2/features/shell/events.js', import.meta.url), 'utf8');
const amounts = funding.slice(funding.indexOf('function parseRawTokenAmount'), funding.indexOf('function manualPrefundBalanceSnapshotStatus'));
const draft = { jobId: 'support-one', walletPublicKey: 'saved-wallet', nftMint: 'position-nft', poolId: 'pool-address', network: 'localnet',
  planDigest: 'saved-digest', status: 'review_required', depositLamports: '10000000', maxSpendLamports: 165000000,
  feeCeilingLamports: 100000, rentCeilingLamports: 154900000, tokenMint: 'token-mint', plan: {
    poolId: 'pool-address', token: { mint: 'token-mint', symbol: 'FIX' }, currentPriceSol: 1, topPriceSol: 0.99, bottomPriceSol: 0.5,
    depositLamports: '10000000', newArrayRentLamports: '145000000', positionRentLamports: '7000000', otherRentLamports: '2900000',
    feeBufferLamports: '100000', totalLamports: '165000000', walletLamports: null, warnings: [], depthPct: 50, tickLower: 100, tickUpper: 1000,
  } };
function harness({ confirm = true, saved = false, changeDuringReview = false, changeDuringSend = false, failSend = false, demo = false } = {}) {
  const calls = [], dialogs = [], notices = [], refreshes = [], target = { innerHTML: '' };
  let wallet = draft.walletPublicKey, job = structuredClone(draft);
  if (saved) job.status = 'paused';
  const state = { demoActive: demo, poolSupport: { status: 'ready', plan: job.plan, inputs: { target: job.tokenMint, solAmount: 0.01, depthPct: 50 } },
    supportJobs: { walletPublicKey: wallet, jobs: saved ? [job] : [] }, apiClient: {
      prepareSolSupport: async (input) => { calls.push({ action: 'prepare', input }); return { job }; },
      getSupportJob: async () => ({ job }), getSupportJobs: async () => ({ jobs: [job] }),
      openSolSupport: async (input) => {
        calls.push({ action: 'execute', input });
        if (changeDuringSend) { wallet = 'other-wallet'; state.poolSupport = { status: 'idle', plan: null, marker: 'other wallet' }; }
        if (failSend) { job = { ...job, status: 'paused' }; throw new Error('Resume the saved receipt'); }
        const result = { status: 'confirmed', nftMint: job.nftMint, depositedRaw: '10000000', feeLamports: 80000, txId: 'tx-one' };
        job = { ...job, status: 'confirmed', result }; return { result };
      },
    } };
  const context = vm.createContext({ state, Promise, BigInt, Number, window: { crypto: { randomUUID: () => 'request-one' } },
    $: (selector) => selector === '#poolSupportResult' ? target : null,
    selectedLaunchWalletPublicKey: () => wallet, walletIsUnlocked: () => true,
    confirmOperatorAction: async (input) => { calls.push({ action: 'review' }); dialogs.push(input); if (changeDuringReview) wallet = 'other-wallet'; return confirm; },
    fullAddress: (s) => s, shortAddress: (s) => s, escapeHtml: (s) => String(s), solscanTxUrl: (s) => `https://example.invalid/${s}`,
    notify: (s) => notices.push(s), loadCoinDetail: async (mint) => { refreshes.push({ action: 'detail', mint }); },
    loadCoinPositions: async (mint) => { refreshes.push({ action: 'positions', mint }); }, refreshManualPrefundBalance: async () => {},
  });
  vm.runInContext(amounts + support.slice(0, support.indexOf('function renderReturnWalletCard')), context);
  return { context, state, calls, dialogs, notices, refreshes, target, job };
}

test('support review saves first and approves the exact wallet, position, range and costs', async () => {
  const h = harness(); await h.context.openPoolSupport();
  assert.deepEqual(h.calls.map((row) => row.action), ['prepare', 'review', 'execute']);
  for (const value of ['saved-wallet', 'localnet', 'pool-address', 'position-nft', '0.01 SOL', '0.0001 SOL', '0.1549 SOL', '0.165 SOL']) assert.ok(h.dialogs[0].detail.includes(value), value);
  assert.equal(h.dialogs[0].confirmationText, 'ADD SUPPORT');
  const input = h.calls[2].input;
  assert.equal(input.jobId, draft.jobId); assert.equal(input.planDigest, draft.planDigest); assert.equal(input.maxSpendLamports, draft.maxSpendLamports);
  assert.equal(h.state.poolSupport.status, 'done'); assert.match(h.target.innerHTML, /position-nft/);
});

test('cancelled support stays in saved history for later review', async () => {
  const h = harness({ confirm: false }); await h.context.openPoolSupport();
  assert.deepEqual(h.calls.map((row) => row.action), ['prepare', 'review']);
  h.state.poolSupport = { status: 'idle', plan: null }; h.context.renderPoolSupport();
  assert.match(h.target.innerHTML, /Saved support/); assert.match(h.target.innerHTML, /Review support/);
});

test('support recovery uses its original saved job without a fresh plan', async () => {
  const h = harness({ saved: true }); await h.context.resumeSupportPositionJob(draft.jobId);
  assert.deepEqual(h.calls.map((row) => row.action), ['review', 'execute']); assert.equal(h.dialogs[0].title, 'Resume buy support');
  assert.equal(h.calls[1].input.jobId, draft.jobId);
});

test('changing wallet during support review requires another review', async () => {
  const h = harness({ changeDuringReview: true }); await h.context.openPoolSupport();
  assert.deepEqual(h.calls.map((row) => row.action), ['prepare', 'review']); assert.match(h.notices.at(-1), /saved support wallet/);
});

for (const failSend of [false, true]) test(`a late ${failSend ? 'failed' : 'confirmed'} support response preserves the newly selected wallet view`, async () => {
  const h = harness({ changeDuringSend: true, failSend }); await h.context.openPoolSupport();
  assert.equal(h.state.poolSupport.marker, 'other wallet'); assert.equal(h.state.poolSupport.status, 'idle'); assert.equal(h.state.poolSupport.plan, null);
});

test('support polling preserves an open confirmation and accepts one approval', async () => {
  const h = harness(); let release, entered;
  const gate = new Promise((resolve) => { release = resolve; }), reviewing = new Promise((resolve) => { entered = resolve; });
  h.context.confirmOperatorAction = async () => { entered(); await gate; return true; };
  const pending = h.context.openPoolSupport(); await reviewing;
  h.context.applySavedSupportJobs(draft.walletPublicKey, [h.job]);
  await h.context.openPoolSupport(); await h.context.resumeSupportPositionJob(draft.jobId);
  assert.equal(h.calls.filter((row) => row.action === 'prepare').length, 1);
  release(); await pending; assert.equal(h.calls.filter((row) => row.action === 'execute').length, 1);
});

test('the support recovery click reads the job ID from the clicked button', async () => {
  const h = harness({ saved: true }); const seen = [];
  h.context.resumeSupportPositionJob = (id) => seen.push(id);
  vm.runInContext(events.slice(events.indexOf('function handleClick')), h.context);
  h.context.handleClick({ target: { closest: (selector) => selector === '[data-action]' ? { dataset: { action: 'resume-support-job', jobId: draft.jobId } } : null } });
  assert.deepEqual(seen, [draft.jobId]);
});

test('practice support retains its preview confirmation flow', async () => {
  const h = harness({ demo: true }); h.state.poolSupport.inputs.target = 'practice-created-mint'; await h.context.openPoolSupport();
  assert.deepEqual(h.calls.map((row) => row.action), ['review', 'execute']);
  assert.equal(h.calls[1].input.expected.tickLower, draft.plan.tickLower); assert.equal(h.calls[1].input.expected.totalLamports, draft.plan.totalLamports);
  assert.match(h.notices.at(-1), /Practice support added/);
  assert.equal(h.calls[1].input.tokenMint, 'practice-created-mint');
  assert.deepEqual(h.refreshes, [{ action: 'detail', mint: 'practice-created-mint' }, { action: 'positions', mint: 'practice-created-mint' }]);
});
