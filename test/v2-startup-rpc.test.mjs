import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = (name) => fs.readFileSync(new URL(`../public/v2/features/${name}`, import.meta.url), 'utf8');

test('opening V2 saves pair-token scans for the funding check', async () => {
  let scans = 0;
  const state = {};
  const context = vm.createContext({
    state,
    window: { TrebuchetV2Api: { createV2ApiClient: () => ({ bootstrap: async () => ({ api: { available: true } }) }) } },
    applyBootState: () => { state.discovery = {}; },
    routeStartupRecoveryFirst: () => null,
    renderAll: () => {}, refreshCoins: async () => {}, refreshDestinations: () => {},
    autoVerifyQuoteTokens: () => { scans += 1; },
    $: () => null,
  });
  const source = read('shell/connection.js');
  vm.runInContext(source.slice(source.indexOf('async function bootLocalApi()'), source.indexOf('async function refreshLocalApiState()')), context);
  await context.bootLocalApi();
  assert.equal(scans, 0);
  assert.match(read('launch/prepare.js'), /await autoVerifyQuoteTokens\(\)/);
  assert.match(read('launch/execute.js'), /await autoVerifyQuoteTokens\(\)/);
});

function destinationsContext() {
  let calls = 0;
  let release;
  let selected = 'wallet-a';
  const pending = new Promise((resolve) => { release = resolve; });
  const state = { apiStatus: 'connected', destinations: { launchWallet: '', checkedAt: 0 },
    apiClient: { listDestinations: async () => { calls += 1; return pending; } } };
  const context = vm.createContext({ state, Date,
    selectedLaunchWalletPublicKey: () => selected,
    renderAll: () => {}, renderReturnWalletCard: () => {}, renderReportPanel: () => {} });
  const source = read('wallet/destinations.js');
  vm.runInContext(source.slice(source.indexOf('async function refreshDestinations'), source.indexOf('function setReturnWallet')), context);
  return { context, state, release, calls: () => calls, select: (wallet) => { selected = wallet; } };
}

test('startup and repeated polls share a pending funding-history read', async () => {
  const h = destinationsContext();
  const requests = Array.from({ length: 12 }, (_, index) => h.context.refreshDestinations({ force: index === 0 }));
  h.release({ funders: [], signed: [] });
  await Promise.all(requests);
  assert.equal(h.calls(), 1);
  await h.context.refreshDestinations();
  assert.equal(h.calls(), 1, 'the completed read stays fresh');
  await h.context.refreshDestinations({ force: true });
  assert.equal(h.calls(), 2, 'a manual refresh starts a fresh read');
});

test('a pending funding-history read keeps the current wallet selected', async () => {
  const h = destinationsContext();
  const request = h.context.refreshDestinations();
  h.select('wallet-b');
  h.release({ funder: 'sender-a', funders: [{ address: 'sender-a', sol: 1 }], signed: [] });
  await request;
  assert.equal(h.state.destinations.funder, undefined);
  assert.equal(h.state.destinations.launchWallet, '');
});
