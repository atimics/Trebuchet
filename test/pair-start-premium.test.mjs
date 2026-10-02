import test from 'node:test';
import assert from 'node:assert/strict';
import Decimal from 'decimal.js';
import { allocationStartPrice } from '../lpService.js';
import { buildV2LaunchPlan } from '../packages/core/src/launch-plan.js';

test('pair pools open above the target by their start premium', () => {
  const launchedUsd = new Decimal(250000).div(1e9); // $0.00025
  const quoteUsd = new Decimal('0.000883');
  const flat = allocationStartPrice(launchedUsd, quoteUsd, {});
  assert.equal(flat.toString(), launchedUsd.div(quoteUsd).toString());
  const raised = allocationStartPrice(launchedUsd, quoteUsd, { startPricePremiumPct: 25 });
  assert.equal(raised.div(flat).toFixed(6), '1.250000');
  // The pair token can now fall 20% before the new token is cheaper there.
  assert.equal(new Decimal(1).sub(new Decimal(1).div(1.25)).toFixed(2), '0.20');
  assert.throws(() => allocationStartPrice(launchedUsd, quoteUsd, { startPricePremiumPct: 501 }), /at most 500/);
});

test('the plan carries the premium only when it is set', () => {
  const config = (pairExtra = {}) => ({
    token: { name: 'Test', symbol: 'TST', supply: '1000000000', decimals: 9 },
    poolTopology: {
      targetMarketCapUsd: 250000,
      pools: [
        { id: 'sol-main', quoteToken: 'SOL', quoteSymbol: 'SOL', supplyPercent: 90, ammConfigIndex: 3 },
        { id: 'pair', quoteToken: 'Mint111', quoteMint: 'Mint111', quoteSymbol: 'PAIR', supplyPercent: 10, ammConfigIndex: 3, ...pairExtra },
      ],
    },
  });
  const legacy = buildV2LaunchPlan(config(), { demoMode: true });
  const legacyPair = legacy.poolTopology.pools.find((pool) => pool.id === 'pair');
  assert.equal('startPricePremiumPct' in legacyPair, false, 'older plans must keep their fingerprints');
  const current = buildV2LaunchPlan(config({ startPricePremiumPct: 25 }), { demoMode: true });
  assert.equal(current.poolTopology.pools.find((pool) => pool.id === 'pair').startPricePremiumPct, 25);
});
