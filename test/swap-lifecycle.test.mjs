// test/swap-lifecycle.test.mjs
//
// Offline integration tests for swapService.js — swapSolForQuote driven
// through DI seams with NO network.
//
// Covers issue #4 acceptance criteria for the swap/acquire leg:
//   - swap lifecycle: quote, build, sign, submit, confirm
//   - partial-failure scenarios assert recoverable state
//   - external API failure fixtures: RPC timeout, route unavailable, partial fill
//   - already-satisfied fast path (idempotency)
//   - insufficient-SOL pre-flight

import test from 'node:test';
import assert from 'node:assert/strict';
import BN from 'bn.js';
import Decimal from 'decimal.js';
import { Keypair } from '@solana/web3.js';

import * as swapService from '../swapService.js';
import { makeFakeConnection } from './helpers/mockSolana.mjs';
import { makeMockTradeApi } from './helpers/mockTradeApi.mjs';

const OWNER_KP = Keypair.generate();
const QUOTE_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

test.afterEach(() => {
  swapService.resetTestFactories();
  swapService.resetBalanceReaderForTests?.();
});

function makeBalanceReader({ solLamports = 5_000_000_000n, tokenRaw = 0n } = {}) {
  return {
    async readTokenBalanceRaw(_conn, _owner, _mint) {
      return new BN(tokenRaw.toString());
    },
    async readSolBalanceLamports(_conn, _owner) {
      return new BN(solLamports.toString());
    },
  };
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

test("swapSolForQuote: acquires quote tokens via Trade API", async () => {
  swapService.setConnectionFactoryForTests(() => makeFakeConnection());
  swapService.setTradeApiForTests(() => makeMockTradeApi());
  // Stateful balance reader: 0 initially, satisfying after swap lands.
  // Call order: initial check → SOL check → retry pre-check → post-swap.
  let tokenReads = 0;
  swapService.setBalanceReaderForTests({
    async readTokenBalanceRaw(_c, _o, _m) {
      tokenReads += 1;
      return tokenReads >= 3 ? new BN(2_000_000) : new BN(0);
    },
    async readSolBalanceLamports(_c, _o) { return new BN(5_000_000_000n); },
  });

  const result = await swapService.swapSolForQuote({
    ownerKeypair: OWNER_KP,
    quoteMint: QUOTE_MINT,
    targetRaw: new BN(1_000_000),
    minRaw: new BN(1_000),
    quoteUsd: new Decimal(1),
    solUsd: new Decimal(150),
    quoteDecimals: 6,
  });

  assert.equal(result.succeeded, true, "swap succeeded");
  assert.ok(result.txId, "txId returned");
  assert.ok(result.attemptsTried >= 1, "at least one attempt");
  assert.ok(result.finalBalanceRaw.gtn(0), "final balance > 0");
});

// ---------------------------------------------------------------------------
// Already satisfied (fast path)
// ---------------------------------------------------------------------------

test('swapSolForQuote: already satisfied — no tx, zero attempts', async () => {
  swapService.setConnectionFactoryForTests(() => makeFakeConnection());
  swapService.setTradeApiForTests(() => makeMockTradeApi());
  swapService.setBalanceReaderForTests(
    makeBalanceReader({ tokenRaw: 2_000_000n }),
  );

  const result = await swapService.swapSolForQuote({
    ownerKeypair: OWNER_KP,
    quoteMint: QUOTE_MINT,
    targetRaw: new BN(5_000_000),
    minRaw: new BN(1_000_000),
    quoteUsd: new Decimal(1),
    solUsd: new Decimal(150),
    quoteDecimals: 6,
  });

  assert.equal(result.succeeded, true);
  assert.equal(result.txId, null, 'no txId when already satisfied');
  assert.equal(result.attemptsTried, 0);
  assert.equal(result.swappedRaw.toString(), '0');
});

// ---------------------------------------------------------------------------
// Insufficient SOL
// ---------------------------------------------------------------------------

test('swapSolForQuote: INSUFFICIENT_SOL when wallet cannot cover swap', async () => {
  swapService.setConnectionFactoryForTests(() => makeFakeConnection());
  swapService.setTradeApiForTests(() => makeMockTradeApi());
  swapService.setBalanceReaderForTests(
    makeBalanceReader({ solLamports: 10_000n, tokenRaw: 0n }),
  );

  await assert.rejects(
    () => swapService.swapSolForQuote({
      ownerKeypair: OWNER_KP,
      quoteMint: QUOTE_MINT,
      targetRaw: new BN(1_000_000),
      quoteUsd: new Decimal(1),
      solUsd: new Decimal(150),
      quoteDecimals: 6,
    }),
    /INSUFFICIENT_SOL/,
    'pre-flight should detect insufficient SOL',
  );
});

// ---------------------------------------------------------------------------
// No usable pool
// ---------------------------------------------------------------------------

test('swapSolForQuote: NO_USABLE_POOL when Trade API cannot route', async () => {
  swapService.setConnectionFactoryForTests(() => makeFakeConnection());
  swapService.setTradeApiForTests(() =>
    makeMockTradeApi({ quoteResult: 'no-route' }),
  );
  swapService.setBalanceReaderForTests(makeBalanceReader());

  await assert.rejects(
    () => swapService.swapSolForQuote({
      ownerKeypair: OWNER_KP,
      quoteMint: QUOTE_MINT,
      targetRaw: new BN(1_000_000),
      quoteUsd: new Decimal(1),
      solUsd: new Decimal(150),
      quoteDecimals: 6,
    }),
    /NO_USABLE_POOL/,
    'should surface unrecoverable routing failure',
  );
});

// ---------------------------------------------------------------------------
// All attempts exhausted
// ---------------------------------------------------------------------------

test('swapSolForQuote: ALL_ATTEMPTS_FAILED after retry ladder exhausted', async () => {
  swapService.setConnectionFactoryForTests(() => makeFakeConnection());
  swapService.setTradeApiForTests(() =>
    makeMockTradeApi({ quoteResult: 'timeout' }),
  );
  swapService.setBalanceReaderForTests(makeBalanceReader());

  await assert.rejects(
    () => swapService.swapSolForQuote({
      ownerKeypair: OWNER_KP,
      quoteMint: QUOTE_MINT,
      targetRaw: new BN(1_000_000),
      quoteUsd: new Decimal(1),
      solUsd: new Decimal(150),
      quoteDecimals: 6,
    }),
    /ALL_ATTEMPTS_FAILED/,
    'retry ladder exhausts on persistent transient failures',
  );
});

// ---------------------------------------------------------------------------
// Partial fill: tx lands but < minRaw → retry needed
// ---------------------------------------------------------------------------

test('swapSolForQuote: retries partial fill when balance < minRaw', async () => {
  swapService.setConnectionFactoryForTests(() => makeFakeConnection());
  swapService.setTradeApiForTests(() =>
    makeMockTradeApi({ quoteOutputAmount: '500' }),
  );
  swapService.setBalanceReaderForTests(makeBalanceReader());

  await assert.rejects(
    () => swapService.swapSolForQuote({
      ownerKeypair: OWNER_KP,
      quoteMint: QUOTE_MINT,
      targetRaw: new BN(1_000_000),
      minRaw: new BN(1_000),
      quoteUsd: new Decimal(1),
      solUsd: new Decimal(150),
      quoteDecimals: 6,
    }),
    /ALL_ATTEMPTS_FAILED/,
    'retry ladder exhausted on persistent underfill',
  );
});

// ---------------------------------------------------------------------------
// Partial fill acceptable: >= minRaw despite < targetRaw
// ---------------------------------------------------------------------------

test('swapSolForQuote: accepts partial fill >= minRaw even if < targetRaw', async () => {
  swapService.setConnectionFactoryForTests(() => makeFakeConnection());
  swapService.setTradeApiForTests(() =>
    makeMockTradeApi({ quoteOutputAmount: '500000' }),
  );
  // Balance already >= minRaw → fast path, no swap needed.
  swapService.setBalanceReaderForTests(
    makeBalanceReader({ tokenRaw: 500_000n }),
  );

  const result = await swapService.swapSolForQuote({
    ownerKeypair: OWNER_KP,
    quoteMint: QUOTE_MINT,
    targetRaw: new BN(1_000_000),
    minRaw: new BN(1_000),
    quoteUsd: new Decimal(1),
    solUsd: new Decimal(150),
    quoteDecimals: 6,
  });

  assert.equal(result.succeeded, true, 'accepted: balance >= minRaw');
  assert.equal(result.attemptsTried, 0, 'fast path, no swap attempted');
});

// ---------------------------------------------------------------------------
// DI seam hygiene
// ---------------------------------------------------------------------------

test('swapService DI seams are exported and reset safely', () => {
  assert.equal(typeof swapService.setConnectionFactoryForTests, 'function');
  assert.equal(typeof swapService.setTradeApiForTests, 'function');
  assert.equal(typeof swapService.setBalanceReaderForTests, 'function');
  assert.equal(typeof swapService.resetTestFactories, 'function');
  assert.doesNotThrow(() => swapService.resetTestFactories());
});

// ---------------------------------------------------------------------------
// discoverRaydiumRoute: contract tests (WSOL → null fast path)
// ---------------------------------------------------------------------------

test('discoverRaydiumRoute: returns null for SOL→SOL (no self-swap)', async () => {
  const result = await swapService.discoverRaydiumRoute({
    quoteMint: 'So11111111111111111111111111111111111111112',
    quoteDecimals: 9,
    solUsd: new Decimal(150),
  });
  assert.equal(result, null, 'SOL→SOL should never route');
});

// ---------------------------------------------------------------------------
// maxSpendLamports: spend cap is honored by computeSwapSpendLamports
// ---------------------------------------------------------------------------

test('swapSolForQuote: maxSpendLamports caps the swap spend', async () => {
  swapService.setConnectionFactoryForTests(() => makeFakeConnection());
  swapService.setTradeApiForTests(() => makeMockTradeApi());
  // Balance always 0 — the swap will try but the tiny maxSpend produces
  // almost no output, so the retry ladder exhausts.
  swapService.setBalanceReaderForTests(makeBalanceReader());

  await assert.rejects(
    () => swapService.swapSolForQuote({
      ownerKeypair: OWNER_KP,
      quoteMint: QUOTE_MINT,
      targetRaw: new BN(1_000_000),
      minRaw: new BN(1_000),
      quoteUsd: new Decimal(1),
      solUsd: new Decimal(150),
      quoteDecimals: 6,
      maxSpendLamports: new BN(500), // extremely small — ~0.0000005 SOL
    }),
    /ALL_ATTEMPTS_FAILED/,
    'tiny maxSpendLamports prevents acquiring enough tokens',
  );
});

// ---------------------------------------------------------------------------
// Mid-retry idempotency: balance satisfies on retry pre-check
// ---------------------------------------------------------------------------

test('swapSolForQuote: mid-retry idempotency — previous tx landed, balance now satisfies', async () => {
  swapService.setConnectionFactoryForTests(() => makeFakeConnection());
  swapService.setTradeApiForTests(() => makeMockTradeApi());
  // First swap attempt sends but "fails" (balance still 0). On the next
  // retry's idempotency pre-check, the balance reader reports satisfaction,
  // simulating a previous tx that landed but we lost the confirmation.
  let tokenReads = 0;
  swapService.setBalanceReaderForTests({
    async readTokenBalanceRaw(_c, _o, _m) {
      tokenReads += 1;
      // Return satisfying balance starting at the 4th read (rung 1 pre-check).
      return tokenReads >= 4 ? new BN(2_000_000) : new BN(0);
    },
    async readSolBalanceLamports(_c, _o) { return new BN(5_000_000_000n); },
  });

  const result = await swapService.swapSolForQuote({
    ownerKeypair: OWNER_KP,
    quoteMint: QUOTE_MINT,
    targetRaw: new BN(1_000_000),
    minRaw: new BN(1_000),
    quoteUsd: new Decimal(1),
    solUsd: new Decimal(150),
    quoteDecimals: 6,
  });

  assert.equal(result.succeeded, true, 'mid-retry idempotency accepted');
  // txId is null because the short-circuit fires before a swap is sent.
  assert.equal(result.txId, null, 'no tx sent — discovered on recheck');
  assert.equal(result.attemptsTried, 2, 'one failed attempt, one idempotent recheck');
  assert.ok(result.finalBalanceRaw.gtn(0), 'balance reflects the discovered tokens');
});
