import test from 'node:test';
import assert from 'node:assert/strict';

import BN from 'bn.js';
import Decimal from 'decimal.js';

import {
  classifySwapError,
  computeSwapSpendLamports,
  SWAP_DEFAULT_MAX_SPEND_LAMPORTS,
  SWAP_MIN_SPEND_LAMPORTS,
  SWAP_TX_FEE_HEADROOM_LAMPORTS,
} from '../swapMath.js';

test('classifies terminal funding and routing swap failures', () => {
  assert.equal(classifySwapError(new Error('insufficient lamports for transfer')), 'balance');
  assert.equal(classifySwapError(new Error('Trade API quote failed: no route')), 'no_route');
  assert.equal(classifySwapError(new Error('cannot find route for pair')), 'no_route');
});

test('classifies retryable swap failures conservatively', () => {
  assert.equal(classifySwapError(new Error('amount out below minimum')), 'transient');
  assert.equal(classifySwapError(new Error('blockhash not found')), 'transient');
  assert.equal(classifySwapError(new Error('HTTP 503')), 'transient');
  assert.equal(classifySwapError(new Error('unexpected Raydium response')), 'unknown');
});

test('computes swap spend from missing quote-token value', () => {
  const result = computeSwapSpendLamports({
    targetRaw: new BN('2000000'),
    initialQuoteRaw: new BN(0),
    quoteDecimals: 6,
    quoteUsd: new Decimal(2),
    solUsd: new Decimal(200),
    sizingMultiplier: 2,
  });

  assert.equal(result.missingRaw.toString(), '2000000');
  assert.equal(result.missingWhole.toString(), '2');
  assert.equal(result.spendLamports.toString(), '40000000');
  assert.equal(
    result.requiredLamports.toString(),
    new BN('40000000').add(SWAP_TX_FEE_HEADROOM_LAMPORTS).toString(),
  );
});

test('floors tiny swaps so Raydium gets a meaningful quote amount', () => {
  const result = computeSwapSpendLamports({
    targetRaw: new BN(1),
    initialQuoteRaw: new BN(0),
    quoteDecimals: 6,
    quoteUsd: new Decimal('0.000001'),
    solUsd: new Decimal(200),
    sizingMultiplier: 2,
  });

  assert.equal(result.spendLamports.toString(), SWAP_MIN_SPEND_LAMPORTS.toString());
});

test('caps default spend and allows caller-provided custom caps', () => {
  const defaultCapped = computeSwapSpendLamports({
    targetRaw: new BN('100000000'),
    initialQuoteRaw: new BN(0),
    quoteDecimals: 6,
    quoteUsd: new Decimal(2),
    solUsd: new Decimal(100),
    sizingMultiplier: 2,
  });
  assert.equal(defaultCapped.spendLamports.toString(), SWAP_DEFAULT_MAX_SPEND_LAMPORTS.toString());

  const customCapped = computeSwapSpendLamports({
    targetRaw: new BN('100000000'),
    initialQuoteRaw: new BN(0),
    quoteDecimals: 6,
    quoteUsd: new Decimal(2),
    solUsd: new Decimal(100),
    sizingMultiplier: 2,
    maxSpendLamports: new BN('250000000'),
  });
  assert.equal(customCapped.spendLamports.toString(), '250000000');
});
