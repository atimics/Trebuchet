import test from 'node:test';
import assert from 'node:assert/strict';
import { fundingTokenCoverage, formatFundingTokenAmount } from '../packages/core/src/funding-balance.js';

const route = (minRaw = '1000000') => ({ quoteMint: 'MINT', quoteSymbol: 'OWL', quoteDecimals: 6,
  minRaw, targetRaw: String(BigInt(minRaw) * 2n), estSolSpend: 0.04 });

test('balances cover cumulative pool requirements and reduce only outstanding swap cost', () => {
  const estimate = { autoSwapPlan: [route(), route()] };
  const result = fundingTokenCoverage(estimate, { tokens: { MINT: { amountRaw: '1500000' } } });
  assert.equal(result.rows[0].required, '2'); assert.equal(result.rows[0].held, '1.5');
  assert.equal(result.rows[0].missing, '0.5'); assert.equal(result.rows[0].funded, false);
  assert.equal(result.swapCreditSol, 0.03, 'the remaining purchase uses the combined four-token target');
  assert.equal(fundingTokenCoverage(estimate, { tokens: { MINT: { amountRaw: '2000000' } } }).swapCreditSol, 0.08);
});

test('manual requirements reserve their share of a balance before swap credit', () => {
  const estimate = { byQuote: { MINT: '1000000' }, autoSwapPlan: [route()], quoteBreakdown: [{ mint: 'MINT', symbol: 'OWL', decimals: 6 }] };
  const result = fundingTokenCoverage(estimate, { tokens: { MINT: { amountRaw: '1000000' } } });
  assert.equal(result.rows[0].missing, '1'); assert.equal(result.swapCreditSol, 0);
});

test('absent token accounts still show exact decimals from the estimate', () => {
  const result = fundingTokenCoverage({ byQuote: { MINT: '3333334' }, quoteBreakdown: [{ mint: 'MINT', symbol: 'OWL', decimals: 6 }] });
  assert.equal(result.rows[0].missing, '3.333334'); assert.equal(result.rows[0].held, '0');
  assert.equal(formatFundingTokenAmount('18446744073709551615', 9), '18446744073.709551615');
  assert.equal(formatFundingTokenAmount('12', undefined), '12 raw units');
});
