// A Meteora DAMM v2 pool as one of a launch's pools: priced like the others, made once, adopted on
// a resume, and costed without Raydium's tick arrays or bootstrap.
import test from 'node:test';
import assert from 'node:assert/strict';
import Decimal from 'decimal.js';
import { Keypair, PublicKey } from '@solana/web3.js';
import * as lp from '../lpService.js';
import { WSOL_MINT } from '../lpConstants.js';

const hooks = lp.__testHooks;
const MINT = 'So11111111111111111111111111111111111111112'.replace('So1', 'Mt1');

test('a Meteora pool opens at its start price, whatever its share of the supply or its quote', () => {
  const supply = 1_000_000_000;
  for (const [share, price, quoteDecimals] of [[100, 0.000001, 9], [80, 0.000001, 9], [5, 0.0025, 6]]) {
    const { poolRaw, poolMcapLamports } = lp.meteoraPoolParams({ tokenTotalSupply: supply, tokenDecimals: 9, supplyPercent: share, startPrice: price, quoteDecimals });
    // Price the service sets: value over tokens, in quote raw per token raw. Back to whole units:
    const whole = (Number(poolMcapLamports) / Number(poolRaw)) * 10 ** (9 - quoteDecimals);
    assert.ok(Math.abs(whole - price) / price < 1e-6, `share ${share}: ${whole} vs ${price}`);
  }
});

test('the position key comes from the wallet and the mint, so a resume finds the same pool', () => {
  const wallet = Keypair.generate();
  const a = lp.meteoraPositionSeed(wallet.secretKey, 'MintA');
  assert.deepEqual(a, lp.meteoraPositionSeed(wallet.secretKey, 'MintA'));
  assert.notDeepEqual(a, lp.meteoraPositionSeed(wallet.secretKey, 'MintB'));
  assert.notDeepEqual(a, lp.meteoraPositionSeed(Keypair.generate().secretKey, 'MintA'));
});

function fakeDamm({ poolExists = false, positionExists = false, verified = true } = {}) {
  const calls = [];
  return {
    calls,
    async findExistingPool({ positionNft }) {
      calls.push(['find', positionNft.toBase58()]);
      return { pool: new PublicKey(WSOL_MINT), position: Keypair.generate().publicKey, poolExists, positionExists };
    },
    async verifyLockedPool() { calls.push(['verify']); return { passed: verified }; },
    async createLockedPool(args) {
      calls.push(['create', args.supplyRaw.toString(), args.startingMarketCapLamports.toString(), args.feeBps, args.rangeMultiple, args.positionNft.publicKey.toBase58()]);
      return { signature: 'sig-meteora', pool: 'PoolMeteora', position: 'PositionMeteora', positionNft: args.positionNft.publicKey.toBase58(), verification: { passed: true } };
    },
  };
}

const owner = Keypair.generate();
const base = {
  connection: {}, ownerKeypair: owner, tokenMint: Keypair.generate().publicKey.toBase58(), tokenTotalSupply: '1000000000',
  tokenDecimals: 9, allocIdx: 0, quote: { address: WSOL_MINT, decimals: 9, symbol: 'SOL' }, startPrice: '0.000001',
};

test('a fresh Meteora pool is created once, locked, and recorded as one locked position', async () => {
  const damm = fakeDamm();
  lp.setDammServiceForTests(damm);
  const events = [];
  try {
    const result = await hooks.createMeteoraPoolForAllocation({ ...base, alloc: { venue: 'meteora-damm-v2', supplyPercent: 80, damm: { feeBps: 50, rangeMultiple: 100 } }, progress: (e) => events.push(e.stage) });
    const create = damm.calls.find((call) => call[0] === 'create');
    assert.ok(create);
    assert.equal(create[1], (1_000_000_000n * 10n ** 9n * 8000n / 10000n).toString());
    assert.equal(create[3], 50);
    assert.equal(create[4], 100);
    assert.equal(result.venue, 'meteora-damm-v2');
    assert.equal(result.poolId, 'PoolMeteora');
    assert.equal(result.mainPositions.length, 1);
    assert.equal(result.mainPositions[0].locked, true);
    assert.equal(result.bootstrap, null);
    assert.deepEqual(events.filter((stage) => stage.startsWith('meteora')), ['meteora_pool_start', 'meteora_pool_done']);
    // The same wallet and mint give the same position key on a second run.
    const again = fakeDamm();
    lp.setDammServiceForTests(again);
    await hooks.createMeteoraPoolForAllocation({ ...base, alloc: { venue: 'meteora-damm-v2', supplyPercent: 80 }, progress: () => {} });
    assert.equal(again.calls[0][1], damm.calls[0][1]);
  } finally { lp.resetTestFactories(); }
});

test('a resume adopts the pool it already made, and refuses one it did not make', async () => {
  const adopted = fakeDamm({ poolExists: true, positionExists: true });
  lp.setDammServiceForTests(adopted);
  try {
    const result = await hooks.createMeteoraPoolForAllocation({ ...base, alloc: { venue: 'meteora-damm-v2', supplyPercent: 100 }, progress: () => {} });
    assert.equal(result.damm.adopted, true);
    assert.ok(!adopted.calls.some((call) => call[0] === 'create'), 'nothing is created twice');
    lp.setDammServiceForTests(fakeDamm({ poolExists: true, positionExists: false }));
    await assert.rejects(hooks.createMeteoraPoolForAllocation({ ...base, alloc: { venue: 'meteora-damm-v2', supplyPercent: 100 }, progress: () => {} }), /already exists and is not this launch/);
    lp.setDammServiceForTests(fakeDamm({ poolExists: true, positionExists: true, verified: false }));
    await assert.rejects(hooks.createMeteoraPoolForAllocation({ ...base, alloc: { venue: 'meteora-damm-v2', supplyPercent: 100 }, progress: () => {} }), /not the locked single-sided pool/);
  } finally { lp.resetTestFactories(); }
});

test('the funding estimate costs a Meteora pool as its rent and fees, with no Raydium rent or bootstrap', async () => {
  lp.setPriceOracleForTests(async (mint) => (mint === WSOL_MINT ? new Decimal(150) : null));
  lp.setRouteDiscoveryForTests(async () => null);
  try {
    const result = await lp.estimateRequiredFunding({
      allocations: [{ quoteToken: 'SOL', venue: 'meteora-damm-v2', supplyPercent: 100, distribution: [{ sharePercent: 100 }], bootstrap: { mode: 'minimal' }, ladder: { mode: 'off' }, support: { mode: 'off' } }],
    });
    const labels = result.solBreakdown.map((line) => line.label).join(' | ');
    assert.match(labels, /Meteora pool, locked/);
    assert.doesNotMatch(labels, /price-range rent|bootstrap position|main slice/);
  } finally { lp.resetTestFactories(); }
});

import { buildV2LaunchPlan } from '../v2LaunchPlan.js';

test('the plan keeps a Meteora SOL pool as one locked position next to Raydium pairs', () => {
  const plan = buildV2LaunchPlan({
    token: { name: 'New', symbol: 'NEW', supply: '1000000000' },
    poolTopology: { targetMarketCapUsd: 25000, pools: [
      { id: 'sol-main', quoteToken: 'SOL', quoteSymbol: 'SOL', supplyPercent: 80, venue: 'meteora-damm-v2', damm: { feeBps: 100, rangeMultiple: 100 },
        distribution: [{ sharePercent: 50 }, { sharePercent: 50 }], ladder: { mode: 'simple', bandCount: 3 }, support: { mode: 'custom', solValue: 2 } },
      { id: 'custom-pool-1', quoteToken: 'USDC', quoteSymbol: 'USDC', supplyPercent: 10, ammConfigIndex: 1, distribution: [{ sharePercent: 100 }], ladder: { mode: 'off' }, support: { mode: 'off' } },
    ] },
  }, { demoMode: true });
  const [sol, usdc] = plan.poolTopology.pools;
  assert.equal(sol.venue, 'meteora-damm-v2');
  assert.deepEqual(sol.damm, { feeBps: 100, rangeMultiple: 100 });
  assert.deepEqual(sol.distribution.map((slice) => slice.sharePercent), [100]);
  assert.equal(sol.ladder.mode, 'off');
  assert.equal(sol.support.mode, 'off');
  assert.equal(usdc.venue, undefined, 'Raydium pools carry no venue, so their fingerprints do not change');
  // Any pool can be on Meteora, not only the SOL pool.
  const other = buildV2LaunchPlan({ token: { name: 'N', symbol: 'N', supply: '1000' }, poolTopology: { pools: [{ quoteToken: 'USDC', quoteSymbol: 'USDC', supplyPercent: 50, venue: 'meteora-damm-v2' }] } }, { demoMode: true });
  assert.equal(other.poolTopology.pools[0].venue, 'meteora-damm-v2');
});
