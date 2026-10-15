import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decideCrank,
  maxDriftPct,
  normalizeFlywheelSchedule,
  verifyFlywheelSchedule,
} from '../src/flywheel-schedule.js';

const rotating = {
  mode: 'rotating',
  targets: [
    { poolId: 'sol-main', weightPct: 70 },
    { poolId: 'meme-flywheel', weightPct: 30 },
  ],
  minIntervalSec: 900,
  driftThresholdPct: 3,
  maxSpendSolPerCrank: 0.05,
  maxSpendSolPerDay: 0.5,
  maxCranksPerDay: 12,
  slippageBps: 100,
  cooldownAfterFailureSec: 1800,
};

const onTarget = [
  { poolId: 'sol-main', currentWeightPct: 70 },
  { poolId: 'meme-flywheel', currentWeightPct: 30 },
];

test('a missing schedule is static, which is the safe default', () => {
  const schedule = normalizeFlywheelSchedule(null);
  assert.equal(schedule.mode, 'static');
  const decision = decideCrank({ schedule, state: { pools: [] } });
  assert.equal(decision.action, 'pause');
  assert.match(decision.reason, /static/i);
});

test('schedule validation rejects bad modes, weights and duplicates', () => {
  assert.throws(() => normalizeFlywheelSchedule({ mode: 'turbo' }), /mode must be one of/);
  assert.throws(() => normalizeFlywheelSchedule({ mode: 'rotating', targets: [] }), /at least one target/);
  assert.throws(
    () => normalizeFlywheelSchedule({ mode: 'rotating', targets: [{ poolId: 'a', weightPct: 60 }] }),
    /must sum to 100/,
  );
  assert.throws(
    () => normalizeFlywheelSchedule({ mode: 'rotating', targets: [{ poolId: 'a', weightPct: 50 }, { poolId: 'a', weightPct: 50 }] }),
    /duplicated/,
  );
  assert.equal(verifyFlywheelSchedule(rotating).valid, true);
  assert.equal(verifyFlywheelSchedule({ mode: 'nope' }).valid, false);
});

test('out-of-range knobs clamp instead of exploding', () => {
  const schedule = normalizeFlywheelSchedule({ ...rotating, minIntervalSec: 1, slippageBps: 99999, maxCranksPerDay: 10000 });
  assert.ok(schedule.minIntervalSec >= 60);
  assert.ok(schedule.slippageBps <= 2000);
  assert.ok(schedule.maxCranksPerDay <= 288);
});

test('drift is measured against the targets', () => {
  assert.equal(maxDriftPct(rotating.targets, onTarget), 0);
  assert.equal(maxDriftPct(rotating.targets, [
    { poolId: 'sol-main', currentWeightPct: 60 },
    { poolId: 'meme-flywheel', currentWeightPct: 40 },
  ]), 10);
});

test('a rotating schedule cranks when drift exceeds the threshold', () => {
  const decision = decideCrank({
    schedule: rotating,
    state: {
      pools: [
        { poolId: 'sol-main', currentWeightPct: 80 },
        { poolId: 'meme-flywheel', currentWeightPct: 20 },
      ],
      cranksToday: 1,
      spendTodaySol: 0.01,
    },
    now: new Date('2026-01-01T12:00:00Z'),
  });
  assert.equal(decision.action, 'crank');
  assert.deepEqual(decision.targets.map((t) => t.weightPct), [70, 30]);
  assert.equal(decision.spendCeilingSol, 0.05);
  assert.equal(decision.slippageBps, 100);
});

test('the keeper waits rather than acting when it should not', () => {
  const drifted = [
    { poolId: 'sol-main', currentWeightPct: 80 },
    { poolId: 'meme-flywheel', currentWeightPct: 20 },
  ];
  const now = new Date('2026-01-01T12:00:00Z');

  // Interval not yet elapsed.
  assert.equal(decideCrank({
    schedule: rotating,
    state: { pools: drifted, lastCrankAt: new Date(now.getTime() - 60_000).toISOString() },
    now,
  }).action, 'wait');

  // Drift below the threshold.
  assert.equal(decideCrank({ schedule: rotating, state: { pools: onTarget }, now }).action, 'wait');

  // Cooling down after a failure.
  assert.equal(decideCrank({
    schedule: rotating,
    state: { pools: drifted, lastCrankStatus: 'failed', failedAt: new Date(now.getTime() - 60_000).toISOString() },
    now,
  }).action, 'wait');
});

test('hard limits pause and need an operator', () => {
  const drifted = [
    { poolId: 'sol-main', currentWeightPct: 80 },
    { poolId: 'meme-flywheel', currentWeightPct: 20 },
  ];
  const now = new Date('2026-01-01T12:00:00Z');
  const base = { pools: drifted };

  assert.equal(decideCrank({ schedule: { ...rotating, killSwitch: true }, state: base, now }).action, 'pause');
  assert.equal(decideCrank({ schedule: rotating, state: { ...base, cranksToday: 12 }, now }).action, 'pause');
  assert.equal(decideCrank({ schedule: rotating, state: { ...base, spendTodaySol: 0.5 }, now }).action, 'pause');
});

test('the per-crank ceiling never exceeds what is left for the day', () => {
  const decision = decideCrank({
    schedule: rotating,
    state: {
      pools: [
        { poolId: 'sol-main', currentWeightPct: 80 },
        { poolId: 'meme-flywheel', currentWeightPct: 20 },
      ],
      spendTodaySol: 0.48,
    },
    now: new Date('2026-01-01T12:00:00Z'),
  });
  assert.equal(decision.action, 'crank');
  assert.ok(decision.spendCeilingSol <= 0.02, `ceiling shrinks to the daily remainder (${decision.spendCeilingSol})`);
});

// ---------------------------------------------------------------------------
// Fee routing (flywheel milestone 1b): claim -> route, never add.
// ---------------------------------------------------------------------------

const feeRouting = {
  mode: 'fee-routing',
  outputs: [
    { type: 'buyback-burn', pct: 60 },
    { type: 'transfer', pct: 40, wallet: 'AtPVyHp52LqHy1rnMu5fUx9eWpDMrr2DnC3C3mdFc54j' },
  ],
  claimThresholdSol: 0.02,
  minIntervalSec: 900,
  maxSpendSolPerCrank: 0.05,
  maxSpendSolPerDay: 0.5,
  maxCranksPerDay: 12,
  slippageBps: 100,
  cooldownAfterFailureSec: 1800,
};

test('fee-routing needs outputs that sum to 100 and allows no add', () => {
  assert.equal(normalizeFlywheelSchedule(feeRouting).mode, 'fee-routing');
  assert.throws(() => normalizeFlywheelSchedule({ ...feeRouting, outputs: [] }), /at least one output/);
  assert.throws(() => normalizeFlywheelSchedule({ ...feeRouting, outputs: [{ type: 'buyback-burn', pct: 60 }, { type: 'buyback-burn', pct: 60 }] }), /sum to 100/);
  assert.throws(() => normalizeFlywheelSchedule({ ...feeRouting, outputs: [{ type: 'add', pct: 100 }] }), /no add/);
  assert.throws(() => normalizeFlywheelSchedule({ ...feeRouting, outputs: [{ type: 'transfer', pct: 100 }] }), /needs a Solana wallet/);
});

test('furthest fee-routing defaults are explicit', () => {
  const plan = normalizeFlywheelSchedule({ mode: 'fee-routing', outputs: [{ type: 'buyback-burn', pct: 100 }] });
  assert.equal(plan.claimThresholdSol, 0.02);
  assert.deepEqual(plan.outputs, [{ type: 'buyback-burn', pct: 100, wallet: null }]);
});

test('a fee-routing crank fires on claimable fees above the threshold', () => {
  const decision = decideCrank({
    schedule: feeRouting,
    state: { claimableSol: 0.1, lastCrankAt: null },
    now: new Date('2026-01-01T12:00:00Z'),
  });
  assert.equal(decision.action, 'crank');
  assert.deepEqual(decision.outputs.map((output) => output.type), ['buyback-burn', 'transfer']);
  assert.equal(decision.spendCeilingSol, 0.05);
  assert.equal(decision.slippageBps, 100);
});

test('a fee-routing keeper waits below the threshold instead of acting', () => {
  const decision = decideCrank({
    schedule: feeRouting,
    state: { claimableSol: 0.001 },
    now: new Date('2026-01-01T12:00:00Z'),
  });
  assert.equal(decision.action, 'wait');
  assert.match(decision.reason, /below the 0.02 SOL threshold/);
});

test('fee-routing honours the kill switch and daily ceilings like rotation', () => {
  assert.equal(decideCrank({ schedule: { ...feeRouting, killSwitch: true }, state: { claimableSol: 1 }, now: new Date('2026-01-01T12:00:00Z') }).action, 'pause');
  assert.equal(decideCrank({ schedule: feeRouting, state: { claimableSol: 1, cranksToday: 12 }, now: new Date('2026-01-01T12:00:00Z') }).action, 'pause');
  assert.equal(decideCrank({ schedule: feeRouting, state: { claimableSol: 1, spendTodaySol: 0.5 }, now: new Date('2026-01-01T12:00:00Z') }).action, 'pause');
});

test('a missing schedule still normalises to static, the safe default', () => {
  assert.equal(decideCrank({ state: { claimableSol: 99 } }).action, 'pause');
  assert.equal(verifyFlywheelSchedule({}).valid, true);
});
