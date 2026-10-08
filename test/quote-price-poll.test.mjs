import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const prepare = fs.readFileSync(new URL('../public/v2/features/launch/prepare.js', import.meta.url), 'utf8');
function priceHarness() {
  let interval; let calls = 0; let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const info = { symbol: 'SI', priceUsd: '1', compatible: true, freezeAuthorityBlock: false, swapRoute: 'jupiter' };
  const state = { apiStatus: 'connected', activeView: 'launch', demoActive: false,
    customPools: [{ id: 'pair', quoteMint: 'MintA' }, { id: 'same', quoteMint: 'MintA' }],
    quoteTokenInfo: { pair: { query: 'MintA', info }, same: { query: 'MintA', info: { ...info } } },
    classicFundingEstimate: { totalSol: 3 }, lastRunEnvelope: { id: 'armed' }, launchProof: { mint: 'created' },
    apiClient: { getQuoteTokenPrices: async (mints, options) => { calls++; assert.deepEqual(Array.from(mints), ['MintA']); return pending; } } };
  const context = vm.createContext({ state, console, Date,
    window: { setInterval: (fn, delay) => { interval = fn; assert.equal(delay, 30_000); return 1; } }, document: { hidden: false },
    customQuoteInfoRecord: (pool) => state.quoteTokenInfo[pool.id], renderPoolEditorPanel: () => {}, renderClassicBridge: () => {} });
  vm.runInContext(prepare.slice(prepare.indexOf('const QUOTE_PRICE_POLL_MS'), prepare.indexOf('// Return wallet.')), context);
  return { context, state, release, calls: () => calls, tick: () => interval() };
}

test('30-second price polling shares a request and preserves the approved budget and proof', async () => {
  const app = priceHarness(); app.context.startQuotePricePolling();
  const estimate = app.state.classicFundingEstimate; const envelope = app.state.lastRunEnvelope; const proof = app.state.launchProof;
  app.tick(); const pending = app.context.refreshQuotePrices(); app.tick();
  assert.equal(app.calls(), 1);
  app.release([{ mint: 'MintA', priceUsd: '0.2', priceSource: 'geckoterminal', priceCheckedAt: '2026-10-08T12:00:00Z' }]);
  await pending;
  assert.equal(app.state.quoteTokenInfo.pair.info.priceUsd, '0.2');
  assert.equal(app.state.quoteTokenInfo.same.info.priceUsd, '0.2');
  assert.equal(app.state.quoteTokenInfo.pair.info.swapRoute, 'jupiter');
  assert.equal(app.state.classicFundingEstimate, estimate); assert.equal(app.state.lastRunEnvelope, envelope); assert.equal(app.state.launchProof, proof);
});

test('hidden pages and other views pause the price poll', () => {
  const app = priceHarness(); app.context.startQuotePricePolling();
  app.context.document.hidden = true; app.tick(); assert.equal(app.calls(), 0);
  app.context.document.hidden = false; app.state.activeView = 'coins'; app.tick(); assert.equal(app.calls(), 0);
});

test('a failed refresh keeps the last checked price and shows its error', async () => {
  const app = priceHarness(); const pending = app.context.refreshQuotePrices();
  app.release([{ mint: 'MintA', error: 'Market API is busy' }]); await pending;
  assert.equal(app.state.quoteTokenInfo.pair.info.priceUsd, '1');
  assert.equal(app.state.quoteTokenInfo.pair.info.priceError, 'Market API is busy');
});

test('a late price response applies only to the mint still selected', async () => {
  const app = priceHarness(); const pending = app.context.refreshQuotePrices();
  app.state.customPools.forEach((pool) => { pool.quoteMint = 'MintB'; });
  app.release([{ mint: 'MintA', priceUsd: '9', priceSource: 'geckoterminal' }]); await pending;
  assert.equal(app.state.quoteTokenInfo.pair.info.priceUsd, '1');
});

test('Check again retries a partial result and recent failure while automatic checks keep their cooldown', () => {
  const now = Date.now(); const records = {
    partial: { info: { symbol: 'SI' }, checkedAt: new Date(now - 5000).toISOString() },
    failed: { error: '429', checkedAt: new Date(now - 5000).toISOString() },
    complete: { info: { compatible: true, freezeAuthorityBlock: false, swapRoute: 'jupiter' } }, checking: { loading: true },
  };
  const context = vm.createContext({ Date, state: { customPools: Object.keys(records).map((id) => ({ id, quoteMint: id })) },
    customQuoteLookupValue: (pool) => pool.quoteMint, customQuoteInfoRecord: (pool) => records[pool.id] });
  vm.runInContext(prepare.slice(prepare.indexOf('// A pair token is checked automatically once'), prepare.indexOf('function autoVerifyQuoteTokens')), context);
  assert.deepEqual(Array.from(context.pairTokensNeedingCheck(now), (pool) => pool.id), []);
  assert.deepEqual(Array.from(context.pairTokensNeedingCheck(now, true), (pool) => pool.id), ['partial', 'failed', 'complete']);
  assert.deepEqual(Array.from(context.pairTokensNeedingCheck(now + 61_000), (pool) => pool.id), ['partial', 'failed']);
});
