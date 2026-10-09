import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const prepare = fs.readFileSync(new URL('../public/v2/features/launch/prepare.js', import.meta.url), 'utf8');
function harness() {
  let now = 100000, estimates = 0, reads = 0, scans = 0;
  const state = { apiStatus: 'connected', launchChecks: { active: true }, quoteAcquire: {} };
  const h = { state, Date: { now: () => now }, document: { hidden: false },
    autoVerifyQuoteTokens: async () => { scans++; },
    classicFundingEstimateStatus: () => ({ matchesConfig: Boolean(state.estimated) }),
    estimateClassicFunding: async () => { estimates++; state.estimated = true; return true; },
    selectedLaunchWalletPublicKey: () => 'wallet', launchTokenExists: () => false,
    checkExecutionReadiness: async () => { reads++; return true; }, renderClassicBridge: () => {} };
  vm.runInNewContext(prepare.slice(prepare.indexOf('let launchChecksInFlight')), h);
  return { h, counts: () => ({ estimates, reads, scans }), advance: (ms) => { now += ms; } };
}

test('automatic recovery estimates once and rechecks deposits on the next interval', async () => {
  const { h, counts, advance } = harness();
  await h.refreshLaunchChecks(); await h.refreshLaunchChecks();
  assert.deepEqual(counts(), { estimates: 1, reads: 1, scans: 1 });
  advance(15000); await h.refreshLaunchChecks();
  assert.deepEqual(counts(), { estimates: 1, reads: 2, scans: 2 });
});

test('a failed check backs off, then recovers without a click', async () => {
  const { h, advance } = harness();
  h.checkExecutionReadiness = async () => { throw new Error('RPC busy'); };
  await h.refreshLaunchChecks(); assert.equal(h.state.launchChecks.nextAt, 130000);
  assert.equal(h.state.launchChecks.error, 'RPC busy');
  advance(30000); h.checkExecutionReadiness = async () => true;
  await h.refreshLaunchChecks(); assert.equal(h.state.launchChecks.failures, 0);
});

test('background checks share one request and pause during signing or hidden views', async () => {
  const { h, counts, advance } = harness(); let release;
  h.autoVerifyQuoteTokens = () => new Promise((resolve) => { release = resolve; });
  const first = h.refreshLaunchChecks(); await h.refreshLaunchChecks();
  release(); await first; assert.equal(counts().reads, 1);
  advance(60000); h.state.fullRunRunning = true; await h.refreshLaunchChecks();
  h.state.fullRunRunning = false; h.document.hidden = true; await h.refreshLaunchChecks();
  assert.equal(counts().reads, 1);
});
