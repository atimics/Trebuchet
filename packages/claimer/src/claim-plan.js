// Claim plan: the review boundary for one fee claim. Pure validation with
// explicit spending bounds, mirroring the other runtime plans (support,
// withdrawal, transfers). Execution is chain-side and injected.

import { BASE58_ADDRESS, CLAIM_VENUES } from './inventory.js';

export const CLAIM_PLAN_SCHEMA = 'trebuchet-claim-plan/v1';

function address(name, value, required = true) {
  const v = String(value || '').trim();
  if (required && !BASE58_ADDRESS.test(v)) throw new Error(`${name} is not a Solana address`);
  if (!required && v && !BASE58_ADDRESS.test(v)) throw new Error(`${name} is not a Solana address`);
  return v || null;
}

function wholeOrNull(value, name) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${name} must be a whole non-negative number`);
  return n;
}

/**
 * Validate and normalize a claim request into a bound claim plan.
 *
 * input: {
 *   venue, positionId, feeKeyMint?, owner, receiver?,
 *   network (mainnet|devnet|localnet), expectedGenesisHash,
 *   minContextSlot, maxSpendLamports (worst-case fee ceiling),
 *   scopeId?           // launch scope; keeps claims tied to their launch
 *   solUsd?            // value context for the review
 * }
 *
 * Throws with a read-able message. No chain is touched.
 */
export function buildClaimPlan(input = {}) {
  if (input == null || typeof input !== 'object') throw new Error('Claim request must be an object');
  const venue = String(input.venue || '').trim();
  if (!CLAIM_VENUES.includes(venue)) throw new Error(`Claim venue must be one of: ${CLAIM_VENUES.join(', ')}`);
  const network = String(input.network || 'mainnet').trim();
  if (!['mainnet', 'devnet', 'localnet'].includes(network)) throw new Error('Claim network must be mainnet, devnet or localnet');
  if (!/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(String(input.expectedGenesisHash || ''))) {
    throw new Error('Claim expectedGenesisHash is required (a 32-byte base58 hash)');
  }
  const minContextSlot = wholeOrNull(input.minContextSlot, 'minContextSlot');
  const maxSpendLamports = wholeOrNull(input.maxSpendLamports, 'maxSpendLamports');
  if (maxSpendLamports == null) throw new Error('Claim maxSpendLamports is required so the signer can enforce a spending bound');

  return {
    schema: CLAIM_PLAN_SCHEMA,
    venue,
    network,
    expectedGenesisHash: String(input.expectedGenesisHash),
    positionId: address('positionId', input.positionId),
    feeKeyMint: address('feeKeyMint', input.feeKeyMint, false),
    owner: address('owner', input.owner),
    receiver: address('receiver', input.receiver, false),
    scopeId: input.scopeId ? String(input.scopeId).slice(0, 220) : null,
    minContextSlot,
    maxSpendLamports,
    solUsd: Number(input.solUsd) > 0 ? Number(input.solUsd) : null,
  };
}

/**
 * Pure check: would a claim that netted `receivedLamports` stay inside the
 * plan's ceiling when the claim transaction itself costs up to
 * `feeCeilingLamports`? The signer enforces this before sending.
 */
export function claimStaysInCeiling(plan, { receivedLamports = 0, feeCeilingLamports = 0 } = {}) {
  const received = Number(receivedLamports) || 0;
  const fee = Number(feeCeilingLamports) || 0;
  return plan.maxSpendLamports >= fee && received >= 0;
}