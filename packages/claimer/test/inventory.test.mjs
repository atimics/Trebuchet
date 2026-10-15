import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeInventoryEntry, buildInventoryPlan } from '../src/inventory.js';

const good = {
  venue: 'meteora-damm-v2',
  poolId: '6BmRFxG4aWT7VsDU6AdDnRNBryN1qVB9RvEJFL3bkZqT',
  positionId: '8aJx2HQYQZPzVK8nCq7vJ9TXpYf4YK2VhEWhsQ8fXKsT',
  positionNftMint: 'B8Jx2HQYQZPzVK8nCq7vJ9TXpYf4YK2VhEWhsQ8fXKsT',
  feeKeyMint: 'B8Jx2HQYQZPzVK8nCq7vJ9TXpYf4YK2VhEWhsQ8fXKsT',
  owner: 'AtPVyHp52LqHy1rnMu5fUx9eWpDMrr2DnC3C3mdFc54j',
  locked: true,
};

test('normalizeInventoryEntry accepts a valid entry', () => {
  assert.deepEqual(normalizeInventoryEntry(good), { ...good });
});

test('normalizeInventoryEntry rejects bad venues and addresses', () => {
  assert.throws(() => normalizeInventoryEntry({ ...good, venue: 'uniswap' }), /venue must be one of/);
  assert.throws(() => normalizeInventoryEntry({ ...good, poolId: 'nope' }), /poolId is not a Solana address/);
  assert.throws(() => normalizeInventoryEntry({ ...good, positionId: 'nope' }), /positionId is not a Solana address/);
});

test('buildInventoryPlan dedupes by venue+position, ranks by unclaimedUsd, and caps', () => {
  const raw = [
    { ...good, unclaimedUsd: 1 },
    { ...good, unclaimedUsd: 9 },                      // duplicate position, ignored
    { ...good, positionId: '8aJx2HQYQZPzVK8nCq7vJ9TXpYf4YK2VhEWhsQ8fXKsU', unclaimedUsd: 12 },
    { venue: 'raydium-clmm', poolId: good.poolId, positionId: '7aJx2HQYQZPzVK8nCq7vJ9TXpYf4YK2VhEWhsQ8fXKsT', feeKeyMint: good.positionNftMint, owner: good.owner, locked: true, unclaimedUsd: 5 },
  ];
  const plan = buildInventoryPlan(raw, { cap: 2 });
  assert.equal(plan.count, 2);
  assert.equal(plan.rows[0].unclaimedUsd, 12, 'highest first');
  assert.equal(plan.rows[1].unclaimedUsd, 5);
  assert.equal(plan.totalUnclaimedUsd, 17);
});

test('buildInventoryPlan handles empty input', () => {
  const plan = buildInventoryPlan(null);
  assert.equal(plan.count, 0);
  assert.equal(plan.totalUnclaimedUsd, 0);
});