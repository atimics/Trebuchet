import test from 'node:test';
import assert from 'node:assert/strict';

import { buildClaimPlan, claimStaysInCeiling, CLAIM_PLAN_SCHEMA } from '../src/claim-plan.js';

const GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const GOOD = {
  venue: 'meteora-damm-v2',
  positionId: '8aJx2HQYQZPzVK8nCq7vJ9TXpYf4YK2VhEWhsQ8fXKsT',
  owner: 'AtPVyHp52LqHy1rnMu5fUx9eWpDMrr2DnC3C3mdFc54j',
  receiver: 'AtPVyHp52LqHy1rnMu5fUx9eWpDMrr2DnC3C3mdFc54j',
  network: 'mainnet',
  expectedGenesisHash: GENESIS,
  maxSpendLamports: 50000,
  scopeId: 'scope-1',
};

test('buildClaimPlan validates and normalizes a claim request', () => {
  const plan = buildClaimPlan(GOOD);
  assert.equal(plan.schema, CLAIM_PLAN_SCHEMA);
  assert.equal(plan.venue, 'meteora-damm-v2');
  assert.equal(plan.network, 'mainnet');
  assert.equal(plan.maxSpendLamports, 50000);
});

test('buildClaimPlan rejects bad venue, network, hash, and addresses', () => {
  assert.throws(() => buildClaimPlan({ ...GOOD, venue: 'raydium-amm' }), /venue must be one of/);
  assert.throws(() => buildClaimPlan({ ...GOOD, network: 'mars' }), /network must be/);
  assert.throws(() => buildClaimPlan({ ...GOOD, expectedGenesisHash: 'short' }), /expectedGenesisHash is required/);
  assert.throws(() => buildClaimPlan({ ...GOOD, positionId: 'not-an-address' }), /positionId is not a Solana address/);
  assert.throws(() => buildClaimPlan({ ...GOOD, maxSpendLamports: undefined }), /maxSpendLamports is required/);
  assert.throws(() => buildClaimPlan({ ...GOOD, maxSpendLamports: -5 }), /whole non-negative/);
});

test('claimStaysInCeiling: the signer enforces the bound', () => {
  const plan = buildClaimPlan(GOOD);
  assert.equal(claimStaysInCeiling(plan, { feeCeilingLamports: 40000 }), true);
  assert.equal(claimStaysInCeiling(plan, { feeCeilingLamports: 60000 }), false, 'fees exceed the bound');
});