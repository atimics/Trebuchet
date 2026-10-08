import test from 'node:test';
import assert from 'node:assert/strict';
import { computeSupportLayerTicks, computeSupportTicks } from '../lpMath.js';
import { supportLayersProblem } from '../packages/core/src/lp-constants.js';
import { buildV2LaunchPlan, buildV2ExecutionReadiness } from '../v2LaunchPlan.js';

const token = { name: 'New Token', symbol: 'NEW', supply: '1000000000' };
const solPool = (support) => ({
  quoteToken: 'SOL', quoteSymbol: 'SOL', supplyPercent: 100, ammConfigIndex: 1,
  distribution: [{ sharePercent: 100 }], support,
});
const planWith = (support) => buildV2LaunchPlan({ token, poolTopology: { targetMarketCapUsd: 25000, pools: [solPool(support)] } }, { demoMode: true });

test('a support layer holds quote below the launch price, snapped to the tick spacing', () => {
  const currentTick = 5000;
  const spacing = 60;
  const top = computeSupportLayerTicks({ currentTick, tickSpacing: spacing, launchedIsMintA: true, lowerMultiplier: 0.7, upperMultiplier: 1 });
  const low = computeSupportLayerTicks({ currentTick, tickSpacing: spacing, launchedIsMintA: true, lowerMultiplier: 0.25, upperMultiplier: 0.7 });
  [top, low].forEach((layer) => {
    assert.ok(layer.tickLower % spacing === 0 || Object.is(layer.tickLower % spacing, -0));
    assert.ok(layer.tickUpper % spacing === 0 || Object.is(layer.tickUpper % spacing, -0));
    assert.ok(layer.tickLower < layer.tickUpper);
    assert.ok(layer.tickUpper <= currentTick, 'single-sided in quote: never above the pool tick');
  });
  // 0.7x of the price is about ln(0.7)/ln(1.0001) = -3566 ticks.
  assert.ok(Math.abs(top.tickLower - (currentTick - 3566)) <= spacing);
  // The lower layer sits under the upper one, meeting it at 0.7x.
  assert.ok(low.tickUpper <= top.tickLower + spacing);
  assert.ok(low.tickLower < top.tickLower);
});

test('the one-layer 1x range is the same as the single support range', () => {
  const single = computeSupportTicks({ currentTick: 5000, tickSpacing: 60, launchedIsMintA: true, depthPct: 60 });
  const layer = computeSupportLayerTicks({ currentTick: 5000, tickSpacing: 60, launchedIsMintA: true, lowerMultiplier: 0.4, upperMultiplier: 1 });
  assert.equal(layer.tickUpper, single.tickUpper);
  assert.ok(Math.abs(layer.tickLower - single.tickLower) <= 60);
});

test('support layers mirror above the pool tick when the launched token is mint B', () => {
  const layer = computeSupportLayerTicks({ currentTick: 5000, tickSpacing: 60, launchedIsMintA: false, lowerMultiplier: 0.5, upperMultiplier: 0.8 });
  assert.ok(layer.tickLower > 5000 && layer.tickUpper > layer.tickLower);
  assert.equal(layer.tickLower % 60, 0);
});

test('a layer range must sit at or below the launch price', () => {
  assert.throws(() => computeSupportLayerTicks({ currentTick: 0, tickSpacing: 60, launchedIsMintA: true, lowerMultiplier: 0.5, upperMultiplier: 1.2 }), /0 < lower < upper <= 1/);
  assert.throws(() => computeSupportLayerTicks({ currentTick: 0, tickSpacing: 60, launchedIsMintA: true, lowerMultiplier: 0.8, upperMultiplier: 0.5 }), /0 < lower < upper <= 1/);
});

test('supportLayersProblem names what is wrong, and accepts the preset recipes', () => {
  assert.equal(supportLayersProblem([{ sharePercent: 70, lowerMultiplier: 0.7, upperMultiplier: 1 }, { sharePercent: 30, lowerMultiplier: 0.25, upperMultiplier: 0.7 }]), null);
  assert.equal(supportLayersProblem([
    { sharePercent: 50, lowerMultiplier: 0.8, upperMultiplier: 1 },
    { sharePercent: 30, lowerMultiplier: 0.5, upperMultiplier: 0.8 },
    { sharePercent: 20, lowerMultiplier: 0.2, upperMultiplier: 0.5 },
  ]), null);
  assert.match(supportLayersProblem([]), /non-empty/);
  assert.match(supportLayersProblem([{ sharePercent: 60, lowerMultiplier: 0.5, upperMultiplier: 1 }]), /add up to 60%/);
  assert.match(supportLayersProblem([{ sharePercent: 100, lowerMultiplier: 0.5, upperMultiplier: 1.5 }]), /at most 1/);
  assert.match(supportLayersProblem([{ sharePercent: 100, lowerMultiplier: 1, upperMultiplier: 1 }]), /below 1/);
  assert.match(supportLayersProblem(Array.from({ length: 7 }, () => ({ sharePercent: 100 / 7, lowerMultiplier: 0.5, upperMultiplier: 0.9 }))), /at most 6/);
});

test('the plan keeps layers, orders them from the start price down and scales shares to 100%', () => {
  const plan = planWith({
    mode: 'custom', solValue: 8, depthPct: 12,
    layers: [
      { sharePercent: 3, lowerMultiplier: 0.25, upperMultiplier: 0.7 },
      { sharePercent: 7, lowerMultiplier: 0.7, upperMultiplier: 1 },
    ],
  });
  const support = plan.poolTopology.pools[0].support;
  assert.deepEqual(support.layers, [
    { sharePercent: 70, lowerMultiplier: 0.7, upperMultiplier: 1 },
    { sharePercent: 30, lowerMultiplier: 0.25, upperMultiplier: 0.7 },
  ]);
  assert.equal(support.depthPct, 75);
  assert.equal(support.solValue, 8);
});

test('without layers the plan is unchanged', () => {
  const support = planWith({ mode: 'custom', solValue: 0.35, depthPct: 12 }).poolTopology.pools[0].support;
  assert.deepEqual(support, { mode: 'custom', solValue: 0.35, depthPct: 12 });
});

test('bad layers block the plan instead of being repaired', () => {
  const readiness = buildV2ExecutionReadiness({
    token: { name: 'MoonKit', symbol: 'MKT', supply: '1000' },
    poolTopology: { pools: [solPool({ mode: 'custom', solValue: 1, layers: [{ sharePercent: 100, lowerMultiplier: 0.5, upperMultiplier: 1.4 }] })] },
    funding: { estimate: { totalSol: 2.4 } },
  }, { demoMode: true, walletPublicKey: '11111111111111111111111111111111', now: '2026-06-20T12:00:00.000Z' });
  assert.equal(readiness.status, 'blocked');
  const blocker = readiness.blockers.find((item) => /invalid-ladder/.test(item.id));
  assert.ok(blocker);
  assert.match(blocker.detail, /support layer 1/);
});

test('each layer counts as a position in the plan summary', () => {
  const layered = planWith({
    mode: 'custom', solValue: 8,
    layers: [{ sharePercent: 70, lowerMultiplier: 0.7, upperMultiplier: 1 }, { sharePercent: 30, lowerMultiplier: 0.25, upperMultiplier: 0.7 }],
  });
  const single = planWith({ mode: 'custom', solValue: 8, depthPct: 12 });
  const text = (plan) => JSON.stringify(plan);
  assert.match(text(layered), /2 support positions/);
  assert.match(text(single), /1 support position/);
});

// The funding estimate counts each layer as a position (rent and lock) and the same total quote.
import Decimal from 'decimal.js';
import * as lpEstimate from '../lpService.js';
import { WSOL_MINT } from '../lpConstants.js';

test('the funding estimate charges for every support layer but sizes the same quote', async () => {
  const estimate = async (support) => {
    lpEstimate.setPriceOracleForTests(async (mint) => (mint === WSOL_MINT ? new Decimal(150) : null));
    lpEstimate.setRouteDiscoveryForTests(async () => null);
    try {
      return await lpEstimate.estimateRequiredFunding({
        allocations: [{ quoteToken: 'SOL', distribution: [{ sharePercent: 100 }], bootstrap: { mode: 'minimal' }, ladder: { mode: 'off' }, support }],
      });
    } finally { lpEstimate.resetTestFactories(); }
  };
  const single = await estimate({ mode: 'custom', solValue: 8, depthPct: 60 });
  const layered = await estimate({
    mode: 'custom', solValue: 8, depthPct: 75,
    layers: [{ sharePercent: 70, lowerMultiplier: 0.7, upperMultiplier: 1 }, { sharePercent: 30, lowerMultiplier: 0.25, upperMultiplier: 0.7 }],
  });
  assert.ok(layered.totalSol > single.totalSol, `layered ${layered.totalSol} should cost more than single ${single.totalSol}`);
  const supportSol = (result) => result.solBreakdown.filter((line) => /support/i.test(line.label)).reduce((sum, line) => sum + Number(line.sol || 0), 0);
  assert.ok(Math.abs(supportSol(layered) - supportSol(single)) < 1e-6, 'the quote deposited is the same');
});

import BN from 'bn.js';

test('the executor splits the quote deposit across layers exactly, each with its own range', () => {
  const total = new BN('8000000001'); // an odd amount, so the shares cannot divide evenly
  const layers = lpEstimate.buildSupportLayerPlan({
    currentTick: 5000, tickSpacing: 60, launchedIsMintA: true, depthPct: 75, quoteRaw: total,
    layers: [{ sharePercent: 70, lowerMultiplier: 0.7, upperMultiplier: 1 }, { sharePercent: 30, lowerMultiplier: 0.25, upperMultiplier: 0.7 }],
  });
  assert.equal(layers.length, 2);
  assert.equal(layers.reduce((sum, layer) => sum.add(layer.quoteRaw), new BN(0)).toString(), total.toString());
  assert.equal(layers[0].quoteRaw.toString(), '5600000000');
  assert.ok(layers[0].tickLower > layers[1].tickLower);
  assert.ok(layers.every((layer) => layer.tickUpper <= 5000));
  // No layers: the single range, all of the quote.
  const single = lpEstimate.buildSupportLayerPlan({ currentTick: 5000, tickSpacing: 60, launchedIsMintA: true, depthPct: 12, quoteRaw: total, layers: null });
  assert.equal(single.length, 1);
  assert.equal(single[0].quoteRaw.toString(), total.toString());
});
