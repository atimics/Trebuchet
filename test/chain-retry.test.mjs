// Unit tests for chainRetry.js — error classification and the retry loop.
// No chain, no SDK: send() is a stub, sleep is a no-op, so these are fast and
// deterministic.

import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyChainError, landTxWithRetry } from '../chainRetry.js';

const noSleep = () => Promise.resolve();

// ---- classifyChainError ----

test('classifies lamport shortfalls as insufficient_funds', () => {
  for (const msg of [
    'Transfer: insufficient lamports 100, need 5000',
    'Error: insufficient funds',
    'Attempt to debit an account but found no record of a prior credit.',
    'Transaction simulation failed: insufficient funds for rent',
  ]) {
    assert.equal(classifyChainError(new Error(msg)), 'insufficient_funds', msg);
  }
});

test('custom program error 0x1771 is NOT treated as a lamport shortfall', () => {
  // This pin previously asserted the opposite, matching a speculative pattern
  // in chainRetry.js whose own comment carried a question mark. 0x1771 is
  // 6001, and Anchor custom errors start at 6000 — so it is some Anchor
  // program's second custom error (a state/approval error for the CLMM
  // program), not a lamport shortfall. SPL Token isn't an Anchor program;
  // its InsufficientFunds is plain 0x1.
  //
  // Retry behaviour is unchanged either way — 'deterministic' and
  // 'insufficient_funds' both stop the retry. What changes is that the
  // classifier no longer implies "add more SOL" for a failure that more SOL
  // cannot fix.
  assert.equal(
    classifyChainError(new Error('custom program error: 0x1771')),
    'deterministic',
  );
  // A genuine lamport shortfall reported alongside a program error must still
  // classify as insufficient_funds — the text patterns win.
  assert.equal(
    classifyChainError(new Error('insufficient lamports; custom program error: 0x1771')),
    'insufficient_funds',
  );
});

test('classifies cluster/RPC weather as transient', () => {
  for (const msg of [
    'Blockhash not found',
    'TransactionExpiredBlockheightExceededError: block height exceeded',
    'Transaction was not confirmed in 30.00 seconds',
    'failed to get recent blockhash: 429 Too Many Requests',
    'fetch failed',
    'socket hang up',
    'Node is behind by 152 slots',
    'server responded with 503 Service Unavailable',
  ]) {
    assert.equal(classifyChainError(new Error(msg)), 'transient', msg);
  }
});

test('classifies everything else as deterministic', () => {
  for (const msg of [
    'account already in use',
    'invalid tick range',
    'Provided owner is not allowed',
    'custom program error: 0x1786',
  ]) {
    assert.equal(classifyChainError(new Error(msg)), 'deterministic', msg);
  }
  assert.equal(classifyChainError(null), 'deterministic');
  assert.equal(classifyChainError(undefined), 'deterministic');
});

test('reads error detail from nested fields (logs, cause, error.message)', () => {
  const withLogs = Object.assign(new Error('Transaction failed'), {
    logs: ['Program log: Error', 'Program log: insufficient lamports for transfer'],
  });
  assert.equal(classifyChainError(withLogs), 'insufficient_funds');

  const withCause = Object.assign(new Error('send failed'), {
    cause: new Error('Blockhash not found'),
  });
  assert.equal(classifyChainError(withCause), 'transient');

  const withErrField = Object.assign(new Error('rpc error'), {
    error: { message: 'Node is behind' },
  });
  assert.equal(classifyChainError(withErrField), 'transient');
});

// ---- landTxWithRetry ----

test('returns the value on first-try success without retrying', async () => {
  let calls = 0;
  const { value, skipped, attempts } = await landTxWithRetry({
    send: async () => { calls += 1; return 'ok'; },
    sleep: noSleep,
  });
  assert.equal(value, 'ok');
  assert.equal(skipped, false);
  assert.equal(attempts, 1);
  assert.equal(calls, 1);
});

test('retries a transient failure then succeeds', async () => {
  let calls = 0;
  const retries = [];
  const { value, attempts } = await landTxWithRetry({
    send: async () => {
      calls += 1;
      if (calls < 3) throw new Error('Blockhash not found');
      return 'landed';
    },
    onRetry: async (attempt) => retries.push(attempt),
    sleep: noSleep,
  });
  assert.equal(value, 'landed');
  assert.equal(attempts, 3);
  assert.equal(calls, 3);
  assert.deepEqual(retries, [1, 2]); // onRetry fires after attempts 1 and 2
});

test('does NOT retry an insufficient_funds failure', async () => {
  let calls = 0;
  await assert.rejects(
    landTxWithRetry({
      send: async () => { calls += 1; throw new Error('insufficient lamports'); },
      sleep: noSleep,
    }),
    (err) => { assert.equal(err.kind, 'insufficient_funds'); return true; },
  );
  assert.equal(calls, 1); // stopped immediately, no wasted attempts
});

test('does NOT retry a deterministic failure', async () => {
  let calls = 0;
  await assert.rejects(
    landTxWithRetry({
      send: async () => { calls += 1; throw new Error('account already in use'); },
      sleep: noSleep,
    }),
    (err) => { assert.equal(err.kind, 'deterministic'); return true; },
  );
  assert.equal(calls, 1);
});

test('allows a caller-proven propagation race to retry without weakening global classification', async () => {
  let calls = 0;
  const { value, attempts } = await landTxWithRetry({
    send: async () => {
      calls += 1;
      if (calls === 1) throw new Error('Program log: Error: InvalidAccountData');
      return 'landed-after-propagation';
    },
    retryIf: (error) => /InvalidAccountData/.test(error.message),
    sleep: noSleep,
  });
  assert.equal(classifyChainError(new Error('InvalidAccountData')), 'deterministic');
  assert.equal(value, 'landed-after-propagation');
  assert.equal(attempts, 2);
});

test('exhausts retries on a persistent transient and rethrows tagged', async () => {
  let calls = 0;
  await assert.rejects(
    landTxWithRetry({
      send: async () => { calls += 1; throw new Error('fetch failed'); },
      maxAttempts: 3,
      sleep: noSleep,
    }),
    (err) => { assert.equal(err.kind, 'transient'); return true; },
  );
  assert.equal(calls, 3);
});

test('alreadyDone short-circuits without sending (idempotency)', async () => {
  let calls = 0;
  const { skipped, value, attempts } = await landTxWithRetry({
    alreadyDone: async () => true,
    send: async () => { calls += 1; return 'should-not-run'; },
    sleep: noSleep,
  });
  assert.equal(skipped, true);
  assert.equal(value, null);
  assert.equal(attempts, 0);
  assert.equal(calls, 0); // never sent — prevents double-mint on a landed-but-threw tx
});

test('a failed chain check pauses before the first send', async () => {
  let calls = 0;
  const cause = new Error('RPC is unavailable');
  await assert.rejects(landTxWithRetry({
    alreadyDone: async () => { throw cause; },
    send: async () => { calls += 1; },
    sleep: noSleep,
  }), (error) => error.code === 'CHAIN_STATE_UNAVAILABLE' && error.cause === cause && error.attempts === 0);
  assert.equal(calls, 0);
});

test('a failed chain check after a send timeout preserves the uncertain operation', async () => {
  let calls = 0;
  let checks = 0;
  await assert.rejects(landTxWithRetry({
    alreadyDone: async () => { if (++checks > 1) throw new Error('RPC timeout'); return false; },
    send: async () => { calls += 1; throw new Error('Transaction was not confirmed'); },
    sleep: noSleep,
  }), (error) => error.code === 'CHAIN_STATE_UNAVAILABLE' && error.attempts === 1);
  assert.equal(calls, 1);
});

test('a failed retry preparation pauses before the next send', async () => {
  let calls = 0;
  const cause = new Error('Recovery journal commit failed');
  await assert.rejects(landTxWithRetry({
    alreadyDone: async () => false,
    send: async () => { calls += 1; throw new Error('Blockhash not found'); },
    onRetry: async () => { throw cause; },
    sleep: noSleep,
  }), (error) => error === cause);
  assert.equal(calls, 1);
});

test('alreadyDone re-checked between retries adopts a tx that landed mid-retry', async () => {
  let calls = 0;
  let landed = false;
  const { skipped, attempts } = await landTxWithRetry({
    alreadyDone: async () => landed,
    send: async () => {
      calls += 1;
      // First attempt "lands" on-chain but throws a confirm timeout. On the
      // next loop, alreadyDone sees it and skips re-sending.
      landed = true;
      throw new Error('Transaction was not confirmed in 30s');
    },
    sleep: noSleep,
  });
  assert.equal(skipped, true);
  assert.equal(calls, 1);   // sent once; the retry was short-circuited by the guard
  assert.equal(attempts, 1);
});

test('a storage failure keeps its recovery code and stops transaction retries', async () => {
  for (const message of ['database write timed out', 'checkpoint failed']) {
    const failure = Object.assign(new Error(message), { code: 'RECOVERY_STORAGE_UNAVAILABLE' });
    let sends = 0;
    await assert.rejects(landTxWithRetry({
      send: async () => { sends++; throw failure; },
      retryIf: async () => true,
      sleep: noSleep,
    }), (error) => error === failure);
    assert.equal(sends, 1);
  }
});
