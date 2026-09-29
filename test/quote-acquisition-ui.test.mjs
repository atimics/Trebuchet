import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const classic = fs.readFileSync(new URL('../public/modules/funding.js', import.meta.url), 'utf8');
const v2 = fs.readFileSync(new URL('../public/v2/features/launch/actions.js', import.meta.url), 'utf8');
const fundingView = fs.readFileSync(new URL('../public/v2/features/launch/funding-view.js', import.meta.url), 'utf8');
const amounts = fundingView.slice(fundingView.indexOf('function parseRawTokenAmount'), fundingView.indexOf('function manualPrefundBalanceSnapshotStatus'));
const draft = { jobId: 'quotes-one', walletPublicKey: 'fixture-wallet', network: 'localnet', status: 'review_required', planDigest: 'approved-digest',
  maxSpendLamports: 10100, inputLamports: 8000, feeCeilingLamports: 100, rentCeilingLamports: 2000, grossDebitLamports: 0,
  rows: [{ state: 'purchase', quoteSymbol: 'TEST', quoteDecimals: 6, minimumOutputRaw: '1250000' }], expiresAtMs: Date.now() + 60000 };

for (const ui of ['classic', 'v2']) {
  const harness = ({ confirm = true, cleanup = false, changedWallet = false } = {}) => {
    const requests = [], dialogs = [], job = { ...draft, ...(cleanup ? { status: 'recovery_required' } : {}) };
    let wallet = job.walletPublicKey;
    const recovery = { ...job, recoveryDigest: 'cleanup-digest', recoveryMaxSpendLamports: 10200, cleanupFeeCeilingLamports: 100 };
    const execute = async (input) => { requests.push(input); return { ...job, status: 'running' }; };
    const review = async (input) => { dialogs.push(input); if (changedWallet) wallet = 'another-wallet'; return confirm; };
    const context = vm.createContext({ console, Number, BigInt, Date, setTimeout,
      tempWallet: { get publicKey() { return wallet; } }, demoModeActive: false, escapeHtml: (s) => String(s), confirmDialog: review,
      fetch: async (url, init) => {
        const body = JSON.parse(init.body); requests.push({ url, ...body });
        return { ok: true, json: async () => url.endsWith('/prepare') ? recovery : { ...job, status: 'running' } };
      }, state: { apiClient: { prepareAcquireQuoteCleanup: async (input) => { requests.push(input); return recovery; }, executeAcquireQuoteTokens: execute } },
      selectedLaunchWalletPublicKey: () => wallet, walletIsUnlocked: () => true, applyQuoteAcquireJob: () => {},
      formatRawTokenAmount: (amount, decimals) => String(Number(amount) / 10 ** decimals), shortAddress: (value) => value,
      confirmOperatorAction: review, startQuoteAcquirePolling: () => {}, renderClassicBridge: () => {},
    });
    const source = ui === 'classic' ? classic.slice(classic.indexOf('let isAcquireFlowRunning = false;'), classic.indexOf("bind('acquireQuoteTokensBtn'"))
      : v2.slice(v2.indexOf('async function reviewQuoteAcquireJob'), v2.indexOf('async function startQuoteAcquire'));
    vm.runInContext(amounts + source, context);
    return { requests, dialogs, job, run: () => context[ui === 'classic' ? 'approveAcquireJob' : 'reviewQuoteAcquireJob'](job) };
  };
  test(`${ui} review shows saved costs and posts their exact approval`, async () => {
    const h = harness(); await h.run(); const text = h.dialogs[0].body || h.dialogs[0].detail;
    for (const value of ['fixture-wallet', 'localnet', '0.000008', '0.0000001', '0.000002', '0.0000101', '1.25 TEST']) assert.ok(text.includes(value), value);
    assert.equal(h.requests.length, 1); assert.equal(h.requests[0].maxSpendLamports, draft.maxSpendLamports);
    assert.equal(h.requests[0].planDigest, draft.planDigest); assert.equal(h.requests[0].walletPublicKey, draft.walletPublicKey);
  });
  test(`${ui} cancelled quote review preserves spending for a later click`, async () => {
    const h = harness({ confirm: false }); await h.run(); assert.equal(h.dialogs.length, 1); assert.equal(h.requests.length, 0);
  });
  test(`${ui} cleanup uses its saved digest and full recovery ceiling`, async () => {
    const h = harness({ cleanup: true }); await h.run(); assert.equal(h.requests.length, 2);
    assert.equal(h.requests[1].recoveryDigest, 'cleanup-digest'); assert.equal(h.requests[1].maxSpendLamports, 10200);
    assert.match(h.dialogs[0].body || h.dialogs[0].detail, /0\.0000001 SOL/);
  });
  test(`${ui} a wallet change during review requires a fresh action`, async () => {
    const h = harness({ changedWallet: true }); await assert.rejects(h.run(), /saved quote wallet/); assert.equal(h.requests.length, 0);
  });
}
