import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSavedLaunchConfig } from '../packages/core/src/launch-store.js';
import { buildV2LaunchPlan } from '../packages/core/src/launch-plan.js';

const pools = [{
  quoteSymbol: 'SOL',
  quoteMint: 'So11111111111111111111111111111111111111112',
  supplyPercent: 100,
  distribution: [{ sharePercent: 100 }],
  ladder: { mode: 'off' },
  support: { mode: 'off' },
}];
const address = '8fFf5jzUp1jtAf6bX3zM9nNSb8VJRfZdt6TtrEbUcHET';
const base = { token: { name: 'Trebuchet', symbol: 'TREB', supply: '1000000000', description: 'x' }, poolTopology: { pools } };

test('a saved launch keeps an any-case vanity address valid after a round trip', () => {
  const saved = normalizeSavedLaunchConfig({
    ...base,
    vanity: { suffix: 'trebuchet', caseInsensitive: true, selectedPublicKey: address },
  });
  assert.equal(saved.vanity.caseInsensitive, true);
  // The plan check compares the selected address to the suffix; it must still pass.
  const plan = buildV2LaunchPlan(saved, { demoMode: false });
  assert.equal(plan.vanity.selectedPublicKey, address);
});

test('without the flag the suffix is still compared exactly', () => {
  const saved = normalizeSavedLaunchConfig({ ...base, vanity: { suffix: 'trebuchet', selectedPublicKey: address } });
  assert.equal('caseInsensitive' in saved.vanity, false);
  assert.throws(() => buildV2LaunchPlan(saved, { demoMode: false }), /does not end with trebuchet/);
});

test('a saved launch keeps a requested address length and drops a bad one', () => {
  assert.equal(normalizeSavedLaunchConfig({ ...base, vanity: { suffix: 'x', length: 44 } }).vanity.length, 44);
  assert.equal('length' in normalizeSavedLaunchConfig({ ...base, vanity: { suffix: 'x', length: 7 } }).vanity, false);
});
