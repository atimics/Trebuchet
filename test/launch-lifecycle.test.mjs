// test/launch-lifecycle.test.mjs
//
// Integration tests for the Raydium CLMM launch phases, driven through the
// mock SDK with NO network. Exercises the per-phase helpers that lpService's
// orchestrator composes (createSinglePool's create-pool step, the lock phase,
// and the fee-key transfer phase), and asserts RECOVERABLE state on partial
// failure rather than just "it logged an error" — matching issue #4's
// acceptance criterion.
//
// Why the phase helpers rather than the full createPoolsAndPositions(): the
// orchestrator interleaves heavy tick/USD/quote math with the SDK calls; the
// phase helpers (exposed via __testHooks) are the exact units that own the
// recoverable-state bookkeeping (lockFailures / transferFailures collectors
// and in-place mutation of `results`). Driving them directly gives precise,
// non-flaky assertions on what completed vs. what didn't.

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'treb-launch-'));
process.env.TREBUCHET_CONFIG_DIR = TMP;

const journal = await import('../launchJournal.js');
const lp = await import('../lpService.js');
const { makeMockRaydium, makeResultEntry } = await import('./helpers/mockRaydium.mjs');

const hooks = lp.__testHooks;

// A valid base58 recipient pubkey for fee-key transfer tests.
const RECIPIENT = 'So11111111111111111111111111111111111111112';

test('lpService exposes test-only DI seams without affecting production defaults', () => {
  assert.equal(typeof lp.setSdkFactoryForTests, 'function');
  assert.equal(typeof lp.setConnectionFactoryForTests, 'function');
  assert.equal(typeof lp.resetTestFactories, 'function');
  assert.equal(typeof hooks.lockAllPositions, 'function');
  assert.equal(typeof hooks.transferFeeKeys, 'function');
  // Resetting is a no-op-safe operation.
  assert.doesNotThrow(() => lp.resetTestFactories());
});

// ---------------------------------------------------------------------------
// Phase 3 (lock) — happy path
// ---------------------------------------------------------------------------
test('lock phase happy path: all positions + bootstrap lock, txIds recorded, zero failures', async () => {
  const raydium = makeMockRaydium();
  const results = [makeResultEntry({ mainCount: 2, withBootstrap: true })];

  const stages = [];
  const { lockFailures } = await hooks.lockAllPositions({
    raydium,
    results,
    onProgress: (e) => stages.push(e.stage),
  });

  assert.equal(lockFailures.length, 0, 'no lock failures on happy path');
  for (const pos of results[0].mainPositions) {
    assert.equal(pos.locked, true, 'each main position locked');
    assert.ok(pos.txIds.lock, 'lock txId recorded for main position');
  }
  assert.equal(results[0].bootstrap.locked, true, 'bootstrap locked');
  assert.ok(results[0].bootstrap.txIds.lock, 'bootstrap lock txId recorded');
  assert.ok(stages.includes('phase3_start') && stages.includes('phase3_done'));
});

// ---------------------------------------------------------------------------
// Phase 3 (lock) — partial failure leaves RECOVERABLE state
// ---------------------------------------------------------------------------
test('lock phase partial failure: one lock fails, recoverable state recorded (what locked vs not)', async () => {
  // Inject a single lockPosition failure. lockAllPositions is fail-soft, so it
  // collects the failure and keeps locking the rest. We don't hardcode WHICH
  // slice fails (the mock counts call sites); instead we assert the recoverable
  // invariant: exactly one failure, the failed slice stays unlocked, and every
  // other position locks — which is precisely the "what completed vs what
  // didn't" recovery state the resume flow relies on.
  const raydium = makeMockRaydium({ fail: { lockPosition: 1 } });
  const results = [makeResultEntry({ mainCount: 2, withBootstrap: true })];

  const { lockFailures } = await hooks.lockAllPositions({ raydium, results });

  assert.equal(lockFailures.length, 1, 'exactly one lock failure collected (fail-soft, did not abort)');
  const f = lockFailures[0];
  assert.ok(['main', 'bootstrap'].includes(f.positionType), 'failure identifies the position TYPE that did not lock');
  assert.ok(f.error, 'failure carries an error message for the user');

  // RECOVERABLE STATE: count locked vs unlocked across all positions.
  const allPositions = [...results[0].mainPositions, results[0].bootstrap];
  const unlocked = allPositions.filter((p) => p && !p.locked);
  const locked = allPositions.filter((p) => p && p.locked);
  assert.equal(unlocked.length, 1, 'exactly one position remains unlocked (the retryable failure)');
  assert.equal(locked.length, allPositions.length - 1, 'every other position locked successfully');
  // The unlocked one is the one the resume flow must re-attempt.
  assert.ok(unlocked[0], 'the unlocked position is preserved for resume');
});

// ---------------------------------------------------------------------------
// Phase 1 (createSinglePool) — pool-create step happy path
// ---------------------------------------------------------------------------
test('createSinglePool create-step happy path: returns a pool id and create tx', async () => {
  // We drive only as far as the SDK calls the create + RPC-read steps require;
  // createSinglePool then proceeds into tick math which needs realistic pool
  // info. The mock returns plausible pool info, so we assert the create step
  // produced a poolId and a createPool txId via the progress events.
  const raydium = makeMockRaydium();
  const launchedToken = { address: '__LAUNCHED__', decimals: 9, programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' };
  const quoteToken = { address: 'So11111111111111111111111111111111111111112', decimals: 9, programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' };

  const stages = [];
  let createPoolEvent = null;
  try {
    await hooks.createSinglePool({
      raydium,
      ownerKeypair: { publicKey: { toBase58: () => 'owner' } },
      ammConfig: { id: 'mock-config', tickSpacing: 60 },
      launchedToken,
      quoteToken,
      initialPrice: 0.0001,
      wideBaseRaw: 1000n,
      bootstrapBaseRaw: 1n,
      bootstrapMode: 'minimal',
      distribution: [100],
      ladderMode: 'off',
      ladderBands: [],
      ladderCeiling: 1,
      onProgress: (e) => {
        stages.push(e.stage);
        if (e.stage === 'pool_create_done') createPoolEvent = e;
      },
    });
  } catch (e) {
    // Tick/liquidity math beyond the SDK surface may not complete against the
    // simplified mock; that's fine — we only assert the create step landed.
    void e;
  }

  assert.ok(stages.includes('pool_create_start'), 'pool create started');
  assert.ok(createPoolEvent, 'pool_create_done emitted');
  assert.ok(createPoolEvent.poolId, 'poolId returned from createPool');
  assert.ok(createPoolEvent.txId, 'createPool tx id returned');
});

// ---------------------------------------------------------------------------
// Phase 1 (createSinglePool) — createPool failure is surfaced, nothing locked
// ---------------------------------------------------------------------------
test('createSinglePool create-step failure: pool creation throws, no recoverable position state created', async () => {
  const raydium = makeMockRaydium({ fail: { createPool: true } });
  const launchedToken = { address: '__LAUNCHED__', decimals: 9, programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' };
  const quoteToken = { address: 'So11111111111111111111111111111111111111112', decimals: 9, programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' };

  const stages = [];
  await assert.rejects(() => hooks.createSinglePool({
    raydium,
    ownerKeypair: { publicKey: { toBase58: () => 'owner' } },
    ammConfig: { id: 'mock-config', tickSpacing: 60 },
    launchedToken,
    quoteToken,
    initialPrice: 0.0001,
    wideBaseRaw: 1000n,
    bootstrapBaseRaw: 1n,
    bootstrapMode: 'minimal',
    distribution: [100],
    ladderMode: 'off',
    ladderBands: [],
    ladderCeiling: 1,
    onProgress: (e) => stages.push(e.stage),
  }), /createPool failed/);

  // Recoverable: it never emitted pool_create_done, so no pool/positions exist
  // to track — the caller retries the whole allocation cleanly.
  assert.ok(!stages.includes('pool_create_done'), 'no pool reported created on failure');
});

// ---------------------------------------------------------------------------
// Phase 4 (transferFeeKeys) — transfer failure leaves Fee Key recoverable
// ---------------------------------------------------------------------------
test('transfer phase: unlocked position cannot transfer Fee Key, surfaced as recoverable failure', async () => {
  const raydium = makeMockRaydium();
  // Position has a recipient but is NOT locked -> no Fee Key exists yet.
  const results = [makeResultEntry({ mainCount: 1, withBootstrap: false, recipients: [RECIPIENT] })];
  results[0].mainPositions[0].locked = false;

  const { transferFailures } = await hooks.transferFeeKeys({
    raydium,
    ownerKeypair: { publicKey: { toBase58: () => 'owner' } },
    results,
  });

  assert.equal(transferFailures.length, 1, 'transfer failure collected for unlocked position');
  assert.equal(transferFailures[0].recipient, RECIPIENT, 'failure names the intended recipient');
  assert.match(transferFailures[0].error, /not locked/, 'failure explains no Fee Key exists');
  // Recoverable: the position is untouched (transferredTo still null), so the
  // final sweep / a retry can still deliver the Fee Key.
  assert.equal(results[0].mainPositions[0].transferredTo, null, 'no transfer recorded (recoverable)');
});

test('transfer phase: no recipients short-circuits cleanly (no failures)', async () => {
  const raydium = makeMockRaydium();
  const results = [makeResultEntry({ mainCount: 2, withBootstrap: true })]; // no recipients
  const stages = [];
  const { transferFailures } = await hooks.transferFeeKeys({
    raydium,
    ownerKeypair: { publicKey: { toBase58: () => 'owner' } },
    results,
    onProgress: (e) => stages.push(e.stage),
  });
  assert.equal(transferFailures.length, 0);
  assert.ok(stages.includes('phase4_skipped'), 'phase 4 skipped when nothing to transfer');
});

// ---------------------------------------------------------------------------
// Journal: a partial launch failure is persisted as recoverable state.
// This mirrors how server.js records the orchestrator's failedPhase +
// partialResults so a crash/close leaves an audit/recovery trail.
// ---------------------------------------------------------------------------
test('journal records a recoverable partial-launch (failedPhase=locks) rather than only logging', () => {
  const walletPk = `LpWallet${Math.random().toString(36).slice(2, 10)}`;
  journal.start({ walletPublicKey: walletPk });

  // Simulate what the orchestrator throws on a lock-phase partial failure and
  // what the server persists from it.
  const partialResults = [makeResultEntry({ mainCount: 2, withBootstrap: true })];
  partialResults[0].mainPositions[1].locked = false; // one slice didn't lock

  journal.upsertForWallet(
    walletPk,
    {
      stage: 'lp_failed',
      lp: { failedPhase: 'locks', partialResults },
      error: '1 position(s) failed to lock; retry to complete the locks.',
    },
    { stage: 'lp_partial_failure', failedPhase: 'locks' },
  );

  const j = journal.activeForWallet(walletPk);
  assert.ok(j, 'journal entry persisted');
  assert.notEqual(j.status, 'completed', 'partial failure is NOT completed');
  assert.equal(j.lp.failedPhase, 'locks', 'failed phase recorded for recovery');
  assert.ok(Array.isArray(j.lp.partialResults), 'partialResults persisted for resume');
  assert.equal(j.lp.partialResults[0].mainPositions[1].locked, false,
    'recoverable detail: which slice still needs locking is preserved');
  assert.ok(j.error, 'human-readable error recorded');
});
