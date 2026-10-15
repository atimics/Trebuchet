// Flywheel rotation schedule contract for Trebuchet Core.
//
// A rotating flywheel means the quote allocation does not stay where the
// launch put it: fees are claimed, swapped into the paired memecoin, and the
// pools are re-weighted toward a target. That is a *running* process, so it
// needs a contract that says when it may act and how much it may spend.
//
// This module is that contract, and it is intentionally pure: it takes the
// schedule, the observed state, and a clock, and returns a decision. Both
// execution paths implement the same decision —
//
//   Path A (keeper): a sealed runner calls decideCrank(), then executes
//     claim -> swap -> add liquidity with spend caps and a journal.
//   Path B (program): an on-chain crank instruction enforces the same rules,
//     so no keeper key is trusted.
//
// Nothing here signs, spends, or touches a chain. It is the policy half of
// the flywheel, testable without a validator.

export const FLYWHEEL_SCHEDULE_SCHEMA = 'trebuchet-flywheel-schedule/v1';
export const FLYWHEEL_MODES = new Set(['static', 'rotating', 'fee-routing']);

// Fee-routing outputs: what a crank does with the claimed fees. There is
// deliberately NO `add` output — adding liquidity is rotation, which is a
// different promise and out of scope until the rotational-vs-locked
// milestone. `holders` distributes pro-rata from a snapshot; `transfer`
// sends to one wallet; `buyback-burn` swaps into the launched token and
// burns it.
export const FEE_ROUTING_OUTPUTS = new Set(['buyback-burn', 'transfer', 'holders']);
export const DEFAULT_FEE_ROUTING_OUTPUT = Object.freeze({ type: 'transfer', pct: 100, wallet: null });
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;

const LIMITS = Object.freeze({
  minIntervalSec: [60, 7 * 24 * 3600],
  driftThresholdPct: [0.5, 50],
  maxSpendSolPerCrank: [0, 10],
  maxSpendSolPerDay: [0, 100],
  slippageBps: [10, 2000],
  cooldownAfterFailureSec: [60, 7 * 24 * 3600],
  maxCranksPerDay: [1, 288],
  claimThresholdSol: [0, 100],
});

function numeric(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bounded(value, [min, max], fallback) {
  const parsed = numeric(value, fallback);
  return Math.min(max, Math.max(min, parsed));
}

function parseTime(value) {
  const ms = Date.parse(String(value || ''));
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Validate and normalise a rotation schedule. Throws with a clear message so
 * an operator learns what is wrong instead of getting a silent default.
 *
 * `static` is the default and the safe state: an explicit mode is required to
 * let anything move.
 */
export function normalizeFlywheelSchedule(input = {}) {
  if (input == null) {
    return { schema: FLYWHEEL_SCHEDULE_SCHEMA, mode: 'static' };
  }
  if (typeof input !== 'object') {
    throw new Error('Flywheel schedule must be an object');
  }
  const mode = String(input.mode || 'static').trim().toLowerCase();
  if (!FLYWHEEL_MODES.has(mode)) {
    throw new Error(`Flywheel mode must be one of: ${[...FLYWHEEL_MODES].join(', ')}`);
  }

  const targets = Array.isArray(input.targets) ? input.targets : [];
  const seen = new Set();
  const normalizedTargets = targets.map((target, index) => {
    if (!target || typeof target !== 'object') {
      throw new Error(`Flywheel target ${index + 1} must be an object`);
    }
    const poolId = String(target.poolId || '').trim();
    if (!poolId) throw new Error(`Flywheel target ${index + 1} is missing poolId`);
    if (seen.has(poolId)) throw new Error(`Flywheel target ${poolId} is duplicated`);
    seen.add(poolId);
    const weightPct = numeric(target.weightPct, NaN);
    if (!Number.isFinite(weightPct) || weightPct < 0 || weightPct > 100) {
      throw new Error(`Flywheel target ${poolId} needs a weight between 0 and 100`);
    }
    return { poolId, weightPct: Math.round(weightPct * 10) / 10 };
  });

  if (mode === 'rotating') {
    if (!normalizedTargets.length) {
      throw new Error('A rotating flywheel needs at least one target');
    }
    const total = normalizedTargets.reduce((sum, target) => sum + target.weightPct, 0);
    if (Math.abs(total - 100) > 0.1) {
      throw new Error(`Flywheel target weights must sum to 100 (got ${total})`);
    }
  }

  // Fee-routing outputs: every recognized type except `add`, pct sum 100,
  // and a transfer carries a wallet. `holders` rows are taken at crank time
  // so no snapshot is validated here.
  let outputs = [];
  if (mode === 'fee-routing') {
    const rows = Array.isArray(input.outputs) ? input.outputs : [];
    if (!rows.length) {
      throw new Error('A fee-routing flywheel needs at least one output');
    }
    outputs = rows.map((output, index) => {
      if (!output || typeof output !== 'object') {
        throw new Error(`Fee-routing output ${index + 1} must be an object`);
      }
      const type = String(output.type || '').trim();
      if (!FEE_ROUTING_OUTPUTS.has(type)) {
        throw new Error(`Fee-routing output ${index + 1} must be one of: ${[...FEE_ROUTING_OUTPUTS].join(', ')} (no add: adding liquidity is rotation)`);
      }
      const pct = numeric(output.pct, NaN);
      if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
        throw new Error(`Fee-routing output ${index + 1} needs a percent between 0 and 100`);
      }
      const wallet = output.wallet ? String(output.wallet).trim() : null;
      if (type === 'transfer' && (!wallet || !BASE58_ADDRESS.test(wallet))) {
        throw new Error(`Fee-routing output ${index + 1} (transfer) needs a Solana wallet address`);
      }
      return { type, pct: Math.round(pct * 10) / 10, wallet };
    });
    const total = outputs.reduce((sum, output) => sum + output.pct, 0);
    if (Math.abs(total - 100) > 0.1) {
      throw new Error(`Fee-routing output percentages must sum to 100 (got ${total})`);
    }
    if (new Set(outputs.map((output) => `${output.type}:${output.wallet || ''}`)).size !== outputs.length) {
      throw new Error('Fee-routing outputs must be distinct');
    }
  }

  return {
    schema: FLYWHEEL_SCHEDULE_SCHEMA,
    mode,
    targets: normalizedTargets,
    outputs,
    claimThresholdSol: bounded(input.claimThresholdSol, LIMITS.claimThresholdSol, 0.02),
    minIntervalSec: bounded(input.minIntervalSec, LIMITS.minIntervalSec, 900),
    driftThresholdPct: bounded(input.driftThresholdPct, LIMITS.driftThresholdPct, 3),
    maxSpendSolPerCrank: bounded(input.maxSpendSolPerCrank, LIMITS.maxSpendSolPerCrank, 0.05),
    maxSpendSolPerDay: bounded(input.maxSpendSolPerDay, LIMITS.maxSpendSolPerDay, 0.5),
    slippageBps: Math.round(bounded(input.slippageBps, LIMITS.slippageBps, 100)),
    cooldownAfterFailureSec: bounded(input.cooldownAfterFailureSec, LIMITS.cooldownAfterFailureSec, 1800),
    maxCranksPerDay: Math.round(bounded(input.maxCranksPerDay, LIMITS.maxCranksPerDay, 12)),
    killSwitch: input.killSwitch === true,
    createdAt: typeof input.createdAt === 'string' ? input.createdAt : null,
  };
}

export function verifyFlywheelSchedule(schedule) {
  const errors = [];
  try {
    normalizeFlywheelSchedule(schedule);
  } catch (error) {
    errors.push({ code: 'INVALID_SCHEDULE', message: error.message });
  }
  return { valid: errors.length === 0, errors };
}

/** Largest drift between the observed weights and the targets, in points. */
export function maxDriftPct(targets = [], pools = []) {
  const byId = new Map(pools.map((pool) => [String(pool.poolId), numeric(pool.currentWeightPct, 0)]));
  let worst = 0;
  for (const target of targets) {
    const current = byId.has(target.poolId) ? byId.get(target.poolId) : 0;
    worst = Math.max(worst, Math.abs(current - target.weightPct));
  }
  return Math.round(worst * 100) / 100;
}

/**
 * Decide whether the flywheel may act.
 *
 * `state` is what the keeper (or the program) observed:
 *   { lastCrankAt, lastCrankStatus, failedAt, cranksToday, spendTodaySol,
 *     pools: [{ poolId, currentWeightPct }] }
 *
 * Returns { action: 'crank' | 'wait' | 'pause', reason, targets?, spendCeilingSol? }.
 * `pause` means an operator must intervene; `wait` means trying again later is
 * expected to succeed.
 */
export function decideCrank({ schedule, state = {}, now = new Date() } = {}) {
  const normalized = normalizeFlywheelSchedule(schedule);
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
  if (Number.isNaN(nowMs)) {
    return { action: 'pause', reason: 'Invalid clock' };
  }

  if (normalized.mode === 'static') {
    return { action: 'pause', reason: 'Schedule is static; nothing is allowed to move' };
  }
  if (normalized.killSwitch) {
    return { action: 'pause', reason: 'Kill switch is engaged' };
  }

  const cranksToday = Math.max(0, Math.floor(numeric(state.cranksToday, 0)));
  if (cranksToday >= normalized.maxCranksPerDay) {
    return { action: 'pause', reason: `Daily crank budget reached (${normalized.maxCranksPerDay})` };
  }
  const spendTodaySol = Math.max(0, numeric(state.spendTodaySol, 0));
  const dayRemaining = Math.max(0, normalized.maxSpendSolPerDay - spendTodaySol);
  if (dayRemaining <= 0) {
    return { action: 'pause', reason: 'Daily spend ceiling reached' };
  }

  const lastCrankMs = parseTime(state.lastCrankAt);
  if (lastCrankMs != null && nowMs - lastCrankMs < normalized.minIntervalSec * 1000) {
    const waitSec = Math.ceil((normalized.minIntervalSec * 1000 - (nowMs - lastCrankMs)) / 1000);
    return { action: 'wait', reason: `Minimum interval not elapsed (${waitSec}s left)` };
  }

  if (String(state.lastCrankStatus || '').toLowerCase() === 'failed') {
    const failedMs = parseTime(state.failedAt);
    if (failedMs != null && nowMs - failedMs < normalized.cooldownAfterFailureSec * 1000) {
      const waitSec = Math.ceil((normalized.cooldownAfterFailureSec * 1000 - (nowMs - failedMs)) / 1000);
      return { action: 'wait', reason: `Cooling down after a failed crank (${waitSec}s left)` };
    }
  }

  const ceiling = {
    slippageBps: normalized.slippageBps,
    spendCeilingSol: Math.round(Math.min(normalized.maxSpendSolPerCrank, dayRemaining) * 1e6) / 1e6,
  };

  // Fee routing: the trigger is claimable fees, not pool-weight drift. The
  // keeper claims whatever is above the threshold and routes it per outputs;
  // it never adds liquidity and never touches the locked positions.
  if (normalized.mode === 'fee-routing') {
    const claimableSol = Math.max(0, numeric(state.claimableSol, 0));
    if (claimableSol < normalized.claimThresholdSol) {
      return {
        action: 'wait',
        reason: `Claimable fees ${claimableSol} SOL are below the ${normalized.claimThresholdSol} SOL threshold`,
      };
    }
    return {
      action: 'crank',
      reason: `Claimable fees ${claimableSol} SOL are above the ${normalized.claimThresholdSol} SOL threshold`,
      outputs: normalized.outputs.map((output) => ({ ...output })),
      ...ceiling,
    };
  }

  const drift = maxDriftPct(normalized.targets, state.pools || []);
  if (drift < normalized.driftThresholdPct) {
    return { action: 'wait', reason: `Drift ${drift}% is below the ${normalized.driftThresholdPct}% threshold` };
  }

  return {
    action: 'crank',
    reason: `Drift ${drift}% exceeds the ${normalized.driftThresholdPct}% threshold`,
    targets: normalized.targets.map((target) => ({ ...target })),
    ...ceiling,
  };
}
