import test from 'node:test';
import assert from 'node:assert/strict';

import { allocateRoute, buybackNotional } from '../src/route-plan.js';

test('allocateRoute splits proceeds by output percentage', () => {
  const result = allocateRoute({
    proceedsLamports: 10_000_000, // 0.01 SOL
    outputs: [
      { type: 'buyback-burn', pct: 60 },
      { type: 'transfer', pct: 40, wallet: 'AtPVyHp52LqHy1rnMu5fUx9eWpDMrr2DnC3C3mdFc54j' },
    ],
    spendCeilingLamports: 20_000_000,
  });
  assert.equal(result.routedLamports, 10_000_000);
  assert.deepEqual(result.rows.map((row) => row.type), ['buyback-burn', 'transfer']);
  assert.equal(result.rows[0].lamports, 6_000_000);
  assert.equal(result.rows[1].lamports, 4_000_000);
  assert.equal(result.retainedLamports, 0);
});

test('allocateRoute never spends past the ceiling; the rest stays in the vault', () => {
  const result = allocateRoute({
    proceedsLamports: 10_000_000,
    outputs: [{ type: 'holders', pct: 100, rowCount: 250 }],
    spendCeilingLamports: 2_000_000,
  });
  assert.equal(result.rows[0].lamports, 2_000_000);
  assert.equal(result.routedLamports, 2_000_000);
  assert.equal(result.retainedLamports, 8_000_000);
});

test('allocateRoute requires outputs summing to 100 and known types', () => {
  assert.throws(() => allocateRoute({ proceedsLamports: 1000, outputs: [], spendCeilingLamports: 1000 }), /summing to 100/);
  assert.throws(() => allocateRoute({ proceedsLamports: 1000, outputs: [{ type: 'add', pct: 100 }], spendCeilingLamports: 1000 }), /Unknown fee-routing output type/);
});

test('buybackNotional net-of-swap-fee, dust floors to zero', () => {
  assert.equal(buybackNotional({ lamports: 1_000_000, swapFeeBps: 25 }).net, 997_500);
  assert.equal(buybackNotional({ lamports: 500, swapFeeBps: 25 }).swap, 0, 'below dust');
});