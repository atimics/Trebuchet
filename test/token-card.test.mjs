import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenCardFromMarkets } from '../tokenCard.js';

test('the token card prices the coin from its main SOL pool and splits liquidity by pool value', () => {
  const card = tokenCardFromMarkets({ mint: 'M', pools: [
    { poolId: 'sol', isSolPool: true, isMainSolPool: true, quoteSymbol: 'SOL', quoteReserve: 2, tokenReserve: 1000, priceSol: 0.002 },
    { poolId: 'usdc', isSolPool: false, quoteSymbol: 'USDC', quoteReserve: 100, quoteReserveSol: 0.5, tokenReserve: 250, priceSol: 0.002 },
    { poolId: 'cold', isSolPool: false, quoteSymbol: 'RUG', quoteReserve: 0, quoteReserveSol: null, tokenReserve: 0, priceSol: null },
  ] }, { solUsd: 150 });
  assert.equal(card.priceSol, 0.002);
  assert.equal(card.priceUsd, 0.3);
  assert.equal(card.liquiditySol, 5); // 2 + 1000 * 0.002, then 0.5 + 250 * 0.002
  assert.equal(card.liquidityUsd, 750);
  assert.deepEqual(card.pools.map((pool) => [pool.poolId, pool.valueSol, pool.share]), [['sol', 4, 0.8], ['usdc', 1, 0.2], ['cold', 0, 0]]);
});

test('a single-sided pool is valued at the coin price, and no SOL price leaves USD empty', () => {
  const card = tokenCardFromMarkets({ pools: [
    { poolId: 'a', isSolPool: true, isMainSolPool: true, quoteReserve: 0, tokenReserve: 500, priceSol: 0.01 },
    { poolId: 'b', isSolPool: false, quoteReserveSol: 0, tokenReserve: 100, priceSol: null },
  ] });
  assert.deepEqual(card.pools.map((pool) => pool.valueSol), [5, 1]);
  assert.equal(card.priceUsd, null);
  assert.equal(card.liquidityUsd, null);
});

test('a coin without pools has no price', () => {
  const card = tokenCardFromMarkets({ pools: [] }, { solUsd: 150 });
  assert.equal(card.priceSol, null);
  assert.equal(card.priceUsd, null);
  assert.deepEqual(card.pools, []);
});
