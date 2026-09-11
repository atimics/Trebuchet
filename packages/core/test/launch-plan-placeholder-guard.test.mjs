import test from 'node:test';
import assert from 'node:assert/strict';
import { buildV2ExecutionReadiness, buildV2LaunchPlan } from '../src/launch-plan.js';

function intent(sweepDestination) {
  return {
    token: { name: 'Guard', symbol: 'GRD', supply: '1000000', description: '' },
    mode: 'guarded',
    launchSol: 1,
    walletPublicKey: '11111111111111111111111111111115',
    poolTopology: {
      targetMarketCapUsd: 250000,
      pools: [{
        quoteSymbol: 'SOL',
        quoteMint: 'So11111111111111111111111111111111111111112',
        supplyPercent: 100,
        distribution: [{ sharePercent: 100 }],
        ladder: { mode: 'off' },
        support: { mode: 'off' },
      }],
      sweepDestination,
    },
  };
}

test('a placeholder sweep destination is a danger guardrail', () => {
  const plan = buildV2LaunchPlan(intent('11111111111111111111111111111116'));
  const issue = (plan.guardrails || []).find((i) => /placeholder address/i.test(i.detail || ''));
  assert.ok(issue, 'placeholder sweep destination must raise a guardrail');
  assert.equal(issue.state, 'danger');
  assert.match(issue.detail, /Fee Key NFTs would be unrecoverable/);
});

test('readiness blocks a placeholder sweep destination for a fresh live run', () => {
  const config = intent('11111111111111111111111111111116');
  const readiness = buildV2ExecutionReadiness(config, {
    demoMode: false,
    walletPublicKey: config.walletPublicKey,
    walletAvailable: true,
    secretAvailable: true,
  });
  const blocker = (readiness.blockers || []).find((b) => /placeholder address/i.test(b.detail || b.message || ''));
  assert.ok(blocker, 'readiness must block a placeholder sweep destination');
});

test('a real sweep destination is not flagged as a placeholder', () => {
  const plan = buildV2LaunchPlan(intent('AtPVyHp52LqHy1rnMu5fUx9eWpDMrr2DnC3C3mdFc54j'));
  const issue = (plan.guardrails || []).find((i) => /placeholder address/i.test(i.detail || ''));
  assert.equal(issue, undefined);
});

test('an empty sweep destination is not flagged as a placeholder', () => {
  const plan = buildV2LaunchPlan(intent(null));
  const issue = (plan.guardrails || []).find((i) => /placeholder address/i.test(i.detail || ''));
  assert.equal(issue, undefined);
});
