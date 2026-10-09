import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { PublicKey } from '@solana/web3.js';
import { buildV2LaunchPlan, launchPlanConfigFingerprint, v2FundingEstimateFingerprint } from '../v2LaunchPlan.js';

const readiness = readFileSync(new URL('../public/v2/features/launch/readiness.js', import.meta.url), 'utf8');
const execution = readFileSync(new URL('../public/v2/features/launch/execute.js', import.meta.url), 'utf8');
const core = readFileSync(new URL('../public/v2/core.js', import.meta.url), 'utf8');

function functionSource(source, name) {
  const match = source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`));
  assert.ok(match, `${name} is available`);
  return match[0];
}

function harness({ sharedCore = true } = {}) {
  const wallet = new PublicKey(new Uint8Array(32).fill(1)).toBase58();
  const pools = Array.from({ length: 7 }, (_, index) => {
    const quoteMint = index === 0 ? 'So11111111111111111111111111111111111111112'
      : new PublicKey(new Uint8Array(32).fill(index + 2)).toBase58();
    return {
      id: `pool-${index}`, quoteToken: index === 0 ? 'SOL' : quoteMint,
      quoteMint, quoteSymbol: index === 0 ? 'SOL' : `PAIR${index}`, quoteDecimals: 9,
      supplyPercent: index === 0 ? 94 : 1, ammConfigIndex: 1,
      distribution: [{ sharePercent: 100 }], bootstrap: { mode: 'minimal' },
      ladder: { mode: 'off' }, support: { mode: 'off' },
      quotePriceUsd: index === 0 ? 150 : index + 1,
      quotePriceSource: 'pool', quotePriceCheckedAt: '2026-10-08T12:00:00.000Z',
    };
  });
  const config = {
    token: { name: 'Review Token', symbol: 'REVIEW', supply: '1000000000', mintFormat: 'token-2022' },
    mode: 'guarded', launchSol: 2.8841,
    poolTopology: { targetMarketCapUsd: 25000, pools, sweepDestination: wallet },
  };
  const plan = buildV2LaunchPlan({ ...config, walletPublicKey: wallet });
  const calls = { arm: [], restage: 0, notices: [] };
  const state = {
    selectedWalletPublicKey: wallet, apiStatus: 'connected',
    launchPlan: plan, transactions: plan.operations, launchStage: 1,
    classicFundingEstimate: { totalSol: 2.8, v2FundingFingerprint: v2FundingEstimateFingerprint(config) },
    executionReadiness: { nextEndpoint: '/api/create-token' },
    apiClient: { armRunEnvelope: async (input) => {
      const canonical = buildV2LaunchPlan({ ...input.config, walletPublicKey: input.walletPublicKey }, { now: input.reviewedPlan.generatedAt });
      assert.equal(input.reviewedPlanDigest, canonical.integrity.digest, 'the real server can verify the reviewed plan');
      calls.arm.push(input);
      return { id: 'test-envelope', status: 'armed' };
    } },
  };
  const sandbox = {
    state, config, calls, console, history: [],
    currentLaunchConfig: () => config,
    selectedLaunchWalletPublicKey: () => state.selectedWalletPublicKey,
    walletIsUnlocked: () => true,
    account: () => ({ publicKey: state.selectedWalletPublicKey, name: 'Test wallet' }),
    recoveryAuthorizationEndpoint: () => null,
    launchTokenExists: () => false,
    currentClassicFundingEstimateForConfig: () => state.classicFundingEstimate,
    currentLaunchProof: () => null,
    proofConfigForFingerprint: (_proof, value) => value,
    currentLocalDossier: () => null,
    notify: (message) => calls.notices.push(message),
    stageTransactions: async () => { calls.restage += 1; },
    renderAll: () => {},
    $: () => ({ value: 'REVIEW' }),
    window: { requestAnimationFrame: () => {} },
    V2_REQUIRED_LAUNCH_PLAN_OPERATION_IDS: [
      'v2-wallet-and-ca', 'v2-funding-check', 'v2-mint-metadata', 'v2-revoke-authorities',
      'v2-create-liquidity-pools', 'v2-lock-liquidity', 'v2-report-sweep',
    ],
  };
  vm.createContext(sandbox);
  if (sharedCore) vm.runInContext(core, sandbox);
  const helpers = ['stableFundingFingerprintValue', 'fundingEstimateTokenSupply', 'launchPlanLogoFingerprint',
    'launchPlanConfigFingerprint', 'launchPlanWalletFingerprint', 'launchPlanOperationSequenceStatus', 'localApiLaunchPlanStatus'];
  vm.runInContext([
    ...helpers.map((name) => functionSource(readiness, name)),
    functionSource(execution, 'runLaunchEnvelope'),
    'globalThis.status = () => localApiLaunchPlanStatus();',
    'globalThis.arm = runLaunchEnvelope;',
  ].join('\n'), sandbox);
  return sandbox;
}

for (const sharedCore of [true, false]) {
  test(`a reviewed seven-pool plan arms with live quote data (${sharedCore ? 'shared core' : 'fallback'})`, async () => {
    const h = harness({ sharedCore });
    assert.equal(h.status().ready, true);
    await h.arm();
    assert.equal(h.calls.arm.length, 1);
    assert.equal(h.calls.restage, 0);
    assert.equal(h.state.lastRunEnvelope.status, 'armed');
  });
}

test('market quote refreshes keep the reviewed intent current', () => {
  const h = harness();
  const fingerprint = h.state.launchPlan.v2LaunchConfigFingerprint;
  const pool = h.config.poolTopology.pools[1];
  pool.quotePriceUsd = 123;
  pool.quotePriceSource = 'new-pool';
  pool.quotePriceCheckedAt = '2026-10-08T12:01:00.000Z';
  assert.equal(h.status().ready, true);
  assert.equal(launchPlanConfigFingerprint(h.config), fingerprint);
});

for (const change of ['supply', 'manual price', 'wallet', 'operation sequence']) {
  test(`changing ${change} requires fresh review`, async () => {
    const h = harness();
    if (change === 'supply') h.config.token.supply = '2000000000';
    if (change === 'manual price') h.config.poolTopology.pools[1].quoteUsdOverride = 123;
    if (change === 'wallet') h.state.selectedWalletPublicKey = new PublicKey(new Uint8Array(32).fill(9)).toBase58();
    if (change === 'operation sequence') h.state.launchPlan.operations = h.state.launchPlan.operations.slice(1);
    assert.equal(h.status().ready, false);
    await h.arm();
    assert.equal(h.calls.arm.length, 0);
    assert.equal(h.calls.restage, 1);
  });
}
