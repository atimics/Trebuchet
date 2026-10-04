import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { supportLayersProblem } from '../packages/core/src/lp-constants.js';

const source = readFileSync(new URL('../public/v2/features/launch/presets.js', import.meta.url), 'utf8');
const sandbox = {};
vm.runInNewContext(`${source}\nthis.api = { LAUNCH_PRESETS, launchPresetById, launchPresetPositionCount, launchPresetMarketPlan, launchPresetSummary };`, sandbox);
const api = sandbox.api;

test('the four presets have the budgets and position counts the spec gives', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(api.LAUNCH_PRESETS.map((preset) => [preset.id, preset.budgetSol, api.launchPresetPositionCount(preset)]))), [
    ['spark', 0, 1],
    ['anchor', 1, 4],
    ['constellation', 10, 18],
    ['vortex', 100, 40],
  ]);
});

test('market shares add up to 100%, and the quote deposited adds up to the budget', () => {
  api.LAUNCH_PRESETS.forEach((preset) => {
    assert.equal(preset.markets.reduce((sum, market) => sum + market.share, 0), 100, `${preset.id} shares`);
    assert.equal(preset.markets.reduce((sum, market) => sum + market.quoteSol, 0), preset.budgetSol, `${preset.id} quote`);
  });
  assert.deepEqual(JSON.parse(JSON.stringify(api.launchPresetById('constellation').markets.map((market) => market.share))), [80, 10, 10]);
  assert.deepEqual(JSON.parse(JSON.stringify(api.launchPresetById('vortex').markets.map((market) => market.share))), [80, 5, 5, 5, 5]);
});

test('every layer is accepted by the engine and every band by the plan rules', () => {
  api.LAUNCH_PRESETS.forEach((preset) => preset.markets.forEach((market) => {
    if (market.layers.length) {
      const layers = market.layers.map(([sharePercent, lowerMultiplier, upperMultiplier]) => ({ sharePercent, lowerMultiplier, upperMultiplier }));
      assert.equal(supportLayersProblem(layers), null, `${preset.id} layers`);
    }
    const bandTotal = market.bands.reduce((sum, [share]) => sum + share, 0);
    assert.ok(bandTotal < 100, `${preset.id}: the broad main position keeps a share (${bandTotal}% in bands)`);
    market.bands.forEach(([, low, high]) => assert.ok(low >= 1 && high > low));
    // Layers meet end to end: each one's top is the next one's bottom.
    market.layers.forEach((layer, index) => {
      if (index > 0) assert.equal(layer[2], market.layers[index - 1][1], `${preset.id} layer ${index + 1} meets the one above`);
    });
  }));
});

test('the broad main position is what the bands leave, as the spec says', () => {
  const broad = (id) => 100 - api.launchPresetById(id).markets[0].bands.reduce((sum, [share]) => sum + share, 0);
  assert.equal(broad('anchor'), 40);
  assert.equal(broad('constellation'), 30);
  assert.equal(broad('vortex'), 20);
});

test('market plans scale the shares to the supply the pools may use', () => {
  const plan = api.launchPresetMarketPlan(api.launchPresetById('vortex'), 90);
  assert.deepEqual(JSON.parse(JSON.stringify(plan.map((market) => market.percent))), [72, 4.5, 4.5, 4.5, 4.5]);
  assert.match(plan[0].layersText, /^50, 0\.8, 1\n30, 0\.5, 0\.8\n20, 0\.2, 0\.5$/);
  assert.equal(api.launchPresetSummary(api.launchPresetById('spark')), '1 market · 1 position');
});
