import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fundingTokenCoverage } from '../packages/core/src/funding-balance.js';

const source = readFileSync(new URL('../public/v2/app.js', import.meta.url), 'utf8');

function functionSource(name) {
  let start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  if (source.slice(start - 6, start) === 'async ') start -= 6;
  const end = source.indexOf('\n}', start) + 2;
  assert.ok(end > start, `${name} has a body`);
  return source.slice(start, end);
}

function harness() {
  const pools = [
    { id: 'sol-main', quoteSymbol: 'SOL', supplyPercent: 90 },
    { id: 'usdc', quoteSymbol: 'USDC', quoteMint: 'UsdcMint', supplyPercent: 5 },
    { id: 'usd1', quoteSymbol: 'USD1', quoteMint: 'Usd1Mint', supplyPercent: 5 },
  ];
  const routes = pools.slice(1).map((pool, index) => ({
    allocationIndex: index + 1, quoteMint: pool.quoteMint, quoteSymbol: pool.quoteSymbol,
    minRaw: '100', targetRaw: '200', estSolSpend: 0.034,
  }));
  const calls = { api: 0, execute: 0, unlock: 0, confirm: 0, notices: [] };
  const state = {
    apiStatus: 'connected', demoActive: false, customPools: pools.slice(1),
    classicFundingEstimate: { autoSwapPlan: routes, byQuote: {} },
    quoteAcquire: { running: false, job: null, jobId: null },
    manualPrefund: {},
  };
  const sandbox = {
    console, Intl, Date, state, calls, CLASSIC_QUOTE_VENUES: {},
    TrebuchetCore: { fundingTokenCoverage },
    currentClassicFundingEstimateForConfig: () => state.classicFundingEstimate,
    WALLET_BALANCE_FRESH_MS: 60_000,
    currentLaunchConfig: () => ({ poolTopology: { pools } }),
    currentClassicModel: () => ({ pools }),
    classicFundingEstimateStatus: () => ({ hasEstimate: true, matchesConfig: true, stale: false }),
    quoteAcquireRoutes: () => routes,
    quoteAcquireManualCount: () => 0,
    quoteManualPrefundItems: () => [],
    quoteAcquireProgress: () => ({ total: routes.length, completed: state.quoteAcquire.job?.completed || 0, failed: 0, percent: 0 }),
    quoteAcquireFingerprint: () => 'current',
    selectedLaunchWalletPublicKey: () => 'Wallet111',
    customQuoteInfoBadge: (pool) => pool.blocked
      ? { className: 'danger', label: 'Freeze block', detail: 'Quote token freeze authority can strand launch-wallet balances.' }
      : { className: '', label: 'Verified', detail: 'Verified' },
    shortAddress: (value) => String(value || '').slice(0, 8),
    escapeHtml: (value) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
    formatPercent: (value) => Number(value),
    formatManualPrefundAmount: (value) => String(value),
    formatDate: (value) => String(value),
    notify: (value) => calls.notices.push(value),
    renderFundingWalletHint: () => '',
    renderManualPrefundPanel: () => '',
    walletIsUnlocked: () => true,
    unlockSecretPin: async () => { calls.unlock += 1; return true; },
    refreshManualPrefundBalance: async () => ({ tokens: {} }),
    confirmOperatorAction: async () => { calls.confirm += 1; return true; },
    window: {},
    renderClassicBridge: () => {},
    applyQuoteAcquireJob: (job) => { state.quoteAcquire.job = job; state.quoteAcquire.running = job.status === 'running'; },
    startQuoteAcquirePolling: () => {},
    resetQuoteAcquireState: () => {},
    defaultQuoteAcquireState: () => ({ running: false, job: null, jobId: null }),
    formatRawTokenAmount: String,
  };
  const prepared = { jobId: 'job', status: 'review_required', walletPublicKey: 'Wallet111', maxSpendLamports: 1000, rows: [] };
  state.apiClient = {
    acquireQuoteTokens: async () => { calls.api += 1; return prepared; },
    executeAcquireQuoteTokens: async () => { calls.execute += 1; return { ...prepared, status: 'running' }; },
  };
  const names = [
    'manualPrefundBalanceSnapshotStatus', 'currentFundingTokenCoverage', 'pairTokenFundingDetail', 'quoteAcquireBlockedPools', 'quoteAcquireSafetyCheck', 'quoteAcquireSuccessEvidence',
    'quoteAcquireResultMatchesRoute', 'quoteWalletFundingStatus', 'quoteAcquireStatus', 'quoteAcquireBadge', 'quoteAcquireRouteLabel', 'quoteKey', 'sameQuoteIdentity',
    'findQuoteRouteForPool', 'findManualPrefundForPool', 'quotePoolGuidanceItems',
    'renderQuotePoolGuidance', 'renderQuoteAcquirePanel', 'reviewQuoteAcquireJob', 'startQuoteAcquire',
  ];
  const receiptStart = source.indexOf('const FUNDING_RECEIPT_GROUPS =');
  const receiptEnd = source.indexOf('\nfunction renderFundingWalletHint', receiptStart);
  vm.runInNewContext([
    ...names.map(functionSource), source.slice(receiptStart, receiptEnd),
    ...names.map((name) => `globalThis.${name} = ${name};`),
    'globalThis.renderFundingReceipt = renderFundingReceipt;',
  ].join('\n'), sandbox);
  return sandbox;
}

function fundingCell(markup, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = markup.match(new RegExp(`<small>${escaped}</small><strong>([0-9.]+)</strong>`));
  assert.ok(match, `${label} is shown`);
  return Number(match[1]);
}

test('funding receipt separates the SOL opening deposit, pair buys, setup, and buffer', () => {
  const app = harness();
  const estimate = { totalSol: 4.8706, solBreakdown: [
    { label: 'Pool 1 (SOL): bootstrap quote-side (SOL, dust)', sol: 0.001 },
    { label: 'Pool 2 (RUG): bootstrap quote-side (auto-swap -> ~$2 RUG)', sol: 0.3382 },
    { label: 'Safety buffer (20% on slippage/fee variance)', sol: 0.8118 },
  ] };
  const markup = app.renderFundingReceipt(estimate);
  const cells = ['SOL pool funding', 'Pair-token buys', 'Accounts and fees', 'Buffer'].map((label) => fundingCell(markup, label));
  assert.deepEqual(cells, [0.001, 0.3382, 3.7196, 0.8118]);
  assert.ok(Math.abs(cells.reduce((sum, value) => sum + value, 0) - estimate.totalSol) < 1e-8);
  assert.match(markup, /Set SOL in the pool/);
  assert.doesNotMatch(markup, /No SOL goes into the pool|Into the pool|not returned/);
});

test('direct SOL support stays separate from its position and lock cost', () => {
  const app = harness();
  const markup = app.renderFundingReceipt({ totalSol: 2.627, solBreakdown: [
    { label: 'Pool 1 (SOL): bootstrap support (~$60 as SOL)', sol: 0.5 },
    { label: 'Pool 1 (SOL): support position (~$180 as SOL)', sol: 1.5 },
    { label: 'Pool 1 (SOL): support position (NFT mint + lock)', sol: 0.027 },
    { label: 'Pool 2 (USDC): support position (auto-swap -> ~$30 USDC)', sol: 0.25 },
    { label: 'Safety buffer', sol: 0.35 },
  ] });
  assert.equal(fundingCell(markup, 'SOL pool funding'), 2);
  assert.equal(fundingCell(markup, 'Pair-token buys'), 0.25);
  assert.equal(fundingCell(markup, 'Accounts and fees'), 0.027);
  assert.doesNotMatch(markup, /funding-split-warning/);
});

test('pair-token support purchases retain the direct SOL support prompt', () => {
  const app = harness();
  const markup = app.renderFundingReceipt({ totalSol: 0.8, solBreakdown: [
    { label: 'Pool 2 (USDC): support position (auto-swap -> ~$60 USDC)', sol: 0.5 },
    { label: 'Safety buffer', sol: 0.1 },
  ] });
  assert.equal(fundingCell(markup, 'SOL pool funding'), 0);
  assert.equal(fundingCell(markup, 'Pair-token buys'), 0.5);
  assert.match(markup, /funding-split-warning/);
});

test('a routed frozen quote is shown as blocked in the acquire map', () => {
  const app = harness();
  app.state.customPools[1].blocked = true;
  const rows = app.quotePoolGuidanceItems();
  assert.equal(rows[0].status, 'auto');
  assert.equal(rows[1].status, 'blocked');
  assert.equal(rows[1].badge, 'Freeze block');
  assert.match(rows[1].detail, /freeze authority/);
  const markup = app.renderQuotePoolGuidance();
  assert.match(markup, /1 blocked/);
  assert.doesNotMatch(markup, /2 auto/);
});

test('blocked quotes disable acquisition and prevent a completed job becoming ready', () => {
  const app = harness();
  app.state.customPools[1].blocked = true;
  app.state.quoteAcquire.job = {
    status: 'done', total: 2, completed: 2, v2QuoteAcquireFingerprint: 'current',
    results: [{ success: true, allocationIndex: 1, quoteMint: 'UsdcMint' }, { success: true, allocationIndex: 2, quoteMint: 'Usd1Mint' }],
  };
  assert.equal(app.quoteAcquireStatus().ready, false);
  assert.equal(app.quoteAcquireBadge().className, 'danger');
  const markup = app.renderQuoteAcquirePanel();
  assert.match(markup, /data-action="start-quote-acquire" disabled>Resolve pair block/);
  assert.match(markup, /Resolve USD1 on Token &amp; pools/);
});

test('acquire checks quote blocks before unlock, confirmation, or API calls', async () => {
  const app = harness();
  app.state.customPools[1].blocked = true;
  app.walletIsUnlocked = () => false;
  await app.startQuoteAcquire();
  assert.equal(app.calls.unlock, 0);
  assert.equal(app.calls.confirm, 0);
  assert.equal(app.calls.api, 0);
  assert.equal(app.state.quoteAcquire.running, false);
  assert.match(app.calls.notices[0], /Resolve USD1/);
});

test('acquire checks a new quote block after the spend confirmation, before any spend', async () => {
  const app = harness();
  app.confirmOperatorAction = async () => {
    app.calls.confirm += 1;
    app.state.customPools[1].blocked = true;
    return true;
  };
  await app.startQuoteAcquire();
  assert.equal(app.calls.confirm, 1);
  assert.equal(app.calls.execute, 0);
  assert.equal(app.state.quoteAcquire.running, false);
});

test('verified active pairs remain acquirable and inactive pairs leave no block', () => {
  const app = harness();
  app.state.customPools[1].blocked = true;
  app.state.customPools[1].supplyPercent = 0;
  assert.equal(app.quoteAcquireBlockedPools().length, 0);
  const markup = app.renderQuoteAcquirePanel();
  assert.match(markup, /data-action="start-quote-acquire" >Acquire/);
  assert.equal(app.quoteAcquireBadge().label, 'Ready');
});

function putHeldBalance(app, raw = '100') {
  app.state.manualPrefund = { walletPublicKey: 'Wallet111', lastUpdatedAt: new Date().toISOString(),
    balance: { tokens: { UsdcMint: { amountRaw: raw }, Usd1Mint: { amountRaw: raw } } } };
}

test('a fresh wallet balance funds pair tokens without a purchase receipt', () => {
  const app = harness(); putHeldBalance(app);
  assert.equal(app.quoteAcquireStatus().ready, true);
  assert.equal(app.quoteAcquireStatus().walletFunding.missingRoutes.length, 0);
  assert.match(app.renderQuoteAcquirePanel(), /holds enough pair tokens/);
});

test('a held balance sums pools using the same mint and includes manual deposits', () => {
  const app = harness(); putHeldBalance(app, '150');
  const routes = app.quoteAcquireRoutes(); routes[1].quoteMint = 'UsdcMint';
  assert.equal(app.quoteAcquireStatus().ready, false);
  app.state.manualPrefund.balance.tokens.UsdcMint.amountRaw = '200';
  assert.equal(app.quoteAcquireStatus().ready, true);
  app.state.classicFundingEstimate.byQuote = { UsdcMint: '1' };
  assert.equal(app.quoteAcquireStatus().ready, false);
});

test('a fresh shortage takes priority over an earlier purchase receipt', () => {
  const app = harness(); putHeldBalance(app, '99');
  app.state.quoteAcquire.job = { status: 'done', v2QuoteAcquireFingerprint: 'current', completed: 2,
    results: app.quoteAcquireRoutes().map((route) => ({ success: true, quoteMint: route.quoteMint })) };
  assert.equal(app.quoteAcquireStatus().successEvidence, true);
  assert.equal(app.quoteAcquireStatus().ready, false);
});

test('balances from another wallet or an older check require a fresh check', () => {
  const app = harness(); putHeldBalance(app);
  app.state.manualPrefund.walletPublicKey = 'AnotherWallet';
  assert.equal(app.quoteAcquireStatus().ready, false);
  putHeldBalance(app); app.state.manualPrefund.lastUpdatedAt = new Date(Date.now() - 61_000).toISOString();
  assert.equal(app.quoteAcquireStatus().ready, false);
});


test('custom pair badges show fresh holdings for Jupiter and wallet-funded pairs', () => {
  const info = { compatible: true, freezeAuthorityBlock: false, swapRoute: 'jupiter' };
  const heldMints = new Set();
  const h = { customQuoteLookupValue: () => 'OWL', customQuoteInfoRecord: () => ({ info }),
    customQuoteResolvedInfo: () => info, quoteWalletFundingStatus: () => ({ heldMints }) };
  vm.runInNewContext(functionSource('customQuoteInfoBadge'), h);
  const pool = { quoteMint: 'OWL' };
  assert.equal(h.customQuoteInfoBadge(pool).label, 'Verified');
  info.swapRoute = 'none';
  assert.equal(h.customQuoteInfoBadge(pool).label, 'Use wallet tokens');
  heldMints.add('OWL');
  assert.equal(h.customQuoteInfoBadge(pool).label, 'Held in wallet');
  info.freezeAuthorityBlock = true;
  assert.equal(h.customQuoteInfoBadge(pool).className, 'danger');
});
