import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import {
  computeCappedSupportTicks,
  tickForTokenPrice,
  tokenPriceAtTick,
} from '../lpMath.js';
import {
  previewSolSupport,
  setSdkFactoryForTests,
  setConnectionFactoryForTests,
  resetTestFactories,
} from '../lpService.js';

const WSOL = 'So11111111111111111111111111111111111111112';
const TOKEN = 'RUGx1zSD7LCVqFgTYQWNiJKSkDcfN3yRR5XoFoAXRUG';
const POOL = '2SV3NWgJes9mHkWdBeuHFg8kNqfJS1XQKtNb1eJStVDC';
const PAIR_POOL = '2r6EYWj5jSFbUNfLdJ8GRCvPdDxH3DcRMSdBDQAZNbTy';
const CLMM = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK';

afterEach(() => resetTestFactories());

test('support range stays under the current price and the cheapest other pool', () => {
  // RUGOWEEN SOL pool: RUG is mintA, SOL is mintB, tick spacing 1.
  const cap = tickForTokenPrice({ priceInQuote: 1.32e-6, launchedIsMintA: true, decimalsA: 9, decimalsB: 9 });
  const r = computeCappedSupportTicks({ currentTick: -132326, tickSpacing: 1, launchedIsMintA: true, capTick: cap, depthPct: 50 });
  assert.equal(r.capped, true);
  const top = tokenPriceAtTick({ tick: r.tickUpper, launchedIsMintA: true, decimalsA: 9, decimalsB: 9 });
  const bottom = tokenPriceAtTick({ tick: r.tickLower, launchedIsMintA: true, decimalsA: 9, decimalsB: 9 });
  assert.ok(top <= 1.32e-6, `top ${top} must not exceed the cap`);
  assert.ok(Math.abs(bottom / top - 0.5) < 0.01, 'depth 50% halves the price');

  // Token as mintB: support lives above the current tick, below the cap in price.
  const capB = tickForTokenPrice({ priceInQuote: 1.32e-6, launchedIsMintA: false, decimalsA: 9, decimalsB: 9 });
  const b = computeCappedSupportTicks({ currentTick: 132326, tickSpacing: 120, launchedIsMintA: false, capTick: capB, depthPct: 50 });
  assert.ok(b.tickLower > 132326 && b.tickLower % 120 === 0 && b.tickUpper > b.tickLower);
  assert.ok(tokenPriceAtTick({ tick: b.tickLower, launchedIsMintA: false, decimalsA: 9, decimalsB: 9 }) <= 1.32e-6);

  // No cap: just below the current price, like a launch support band.
  const free = computeCappedSupportTicks({ currentTick: -132326, tickSpacing: 1, launchedIsMintA: true, capTick: null, depthPct: 50 });
  assert.equal(free.tickUpper, -132327);
  assert.equal(free.capped, false);
});

function mockSdk({ currentTick = -132326, existingArrays = [], balance = 1_000_000_000, positions = [] } = {}) {
  const calls = { opened: [] };
  const poolInfo = {
    id: POOL,
    programId: CLMM,
    mintA: { address: TOKEN, decimals: 9, symbol: '' },
    mintB: { address: WSOL, decimals: 9, symbol: 'WSOL' },
    config: { tickSpacing: 1, tradeFeeRate: 400 },
  };
  const sqrtPriceX64 = (price) => new BN(BigInt(Math.floor(Math.sqrt(price) * 2 ** 64)).toString());
  const connection = {
    async getMultipleAccountsInfo(keys) {
      return keys.map((key) => (existingArrays.includes(key.toBase58()) ? { lamports: 1 } : null));
    },
    async getMinimumBalanceForRentExemption(bytes) { return (bytes + 128) * 5080; },
    async getBalance() { return balance; },
    async getRecentPrioritizationFees() { return []; },
  };
  const raydium = {
    connection,
    api: {
      async fetchPoolByMints() {
        return [
          { id: POOL, type: 'Concentrated', price: 1.79e-6, mintA: poolInfo.mintA, mintB: poolInfo.mintB, mintAmountA: 3e8, mintAmountB: 0 },
          // Same token, quoted in SOL through a cheaper pool: the cap.
          { id: PAIR_POOL, type: 'Standard', price: 1.32e-6, mintA: { address: TOKEN, decimals: 9, symbol: 'RUG' }, mintB: { address: WSOL, decimals: 9, symbol: 'WSOL' }, mintAmountA: 9.8e7, mintAmountB: 10 },
        ];
      },
    },
    clmm: {
      async getPoolInfoFromRpc() { return { poolInfo, poolKeys: { id: POOL } }; },
      async getRpcClmmPoolInfo() { return { tickCurrent: currentTick, sqrtPriceX64: sqrtPriceX64(1.79e-6) }; },
      async getOwnerPositionInfo() { return positions; },
      async openPositionFromBase(args) {
        calls.opened.push(args);
        return {
          extInfo: { nftMint: new PublicKey('11111111111111111111111111111112') },
          execute: async () => ({ txId: 'sig-support' }),
        };
      },
    },
  };
  return { raydium, calls };
}

test('preview caps the range, prices each new tick array, and checks the balance', async () => {
  const { raydium } = mockSdk({ balance: 50_000_000 });
  setConnectionFactoryForTests(() => raydium.connection);
  setSdkFactoryForTests(() => raydium);
  const plan = await previewSolSupport({ walletPublicKey: Keypair.generate().publicKey.toBase58(), poolId: POOL, solAmount: 0.1, depthPct: 50 });
  assert.equal(plan.token.symbol, 'RUG');
  assert.equal(plan.ceiling.poolId, PAIR_POOL);
  assert.equal(plan.capped, true);
  assert.ok(plan.topPriceSol <= 1.32e-6 * 0.99 * 1.0001);
  assert.equal(plan.newTickArrays, 2);
  assert.equal(plan.newArrayRentLamports, String(2 * (10240 + 128) * 5080));
  const expectedTotal = 100_000_000 + 2 * (10240 + 128) * 5080 + [281, 270, 170].reduce((sum, b) => sum + (b + 128) * 5080, 0) + 10_000_000;
  assert.equal(plan.totalLamports, String(expectedTotal));
  assert.equal(plan.enoughSol, false);
  assert.match(plan.warnings.join(' '), /cheaper in its RUG pool|cheaper in its .* pool/);
  assert.match(plan.warnings.join(' '), /The wallet has 0\.0500 SOL/);
  assert.equal(plan.locked, false);
});

test('positions list reads each wallet and prices what a position holds', async () => {
  const { listCoinPositions, setSdkFactoryForTests: setSdk, setConnectionFactoryForTests: setConn } = await import('../lpService.js');
  const owner = Keypair.generate().publicKey.toBase58();
  const { raydium } = mockSdk();
  // One SOL-only support position below the current tick.
  raydium.clmm.getOwnerPositionInfo = async () => [{
    poolId: new PublicKey(POOL), nftMint: new PublicKey('11111111111111111111111111111112'),
    tickLower: -139969, tickUpper: -133037, liquidity: new BN('1000000000000'),
  }];
  const state = await raydium.clmm.getRpcClmmPoolInfo();
  raydium.clmm.getRpcClmmPoolInfo = async () => ({ ...state, mintA: new PublicKey(TOKEN), mintB: new PublicKey(WSOL), mintDecimalsA: 9, mintDecimalsB: 9 });
  setConn(() => raydium.connection);
  setSdk(() => raydium);
  const positions = await listCoinPositions({ tokenMint: TOKEN, owners: [owner] });
  assert.equal(positions.length, 1);
  const [position] = positions;
  assert.equal(position.owner, owner);
  assert.equal(position.poolId, POOL);
  assert.equal(position.inRange, false, 'support below the price is out of range');
  assert.equal(position.tokenAmount, 0, 'below the price it holds only SOL');
  assert.ok(position.quoteAmount > 0);
  assert.ok(position.priceHigh <= 1.79e-6 && position.priceLow < position.priceHigh);
});
