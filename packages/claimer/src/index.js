// @trebuchet/claimer — modular fee claiming and routing core.
//
// One package, two hosts:
//   - Trebuchet desktop: local HTTP routes under /api/v2/claims/* and
//     /api/v2/flywheel/*.
//   - Sealed runner: /v1/cranks* + a crank loop.
//
// Everything here is chain-injected and policy-pure where possible, so the
// same code paths are unit-tested without a validator.

export { CLAIM_VENUES, normalizeInventoryEntry, buildInventoryPlan } from './inventory.js';
export { positionInRange, unclaimedClmmInRange, clmmUnclaimed } from './fee-growth.js';
export { CLAIM_PLAN_SCHEMA, buildClaimPlan, claimStaysInCeiling } from './claim-plan.js';
export { allocateRoute, buybackNotional } from './route-plan.js';
export { openCrankCollections, loadCrankJournal, journalStep, saveSchedule, loadSchedule } from './store.js';