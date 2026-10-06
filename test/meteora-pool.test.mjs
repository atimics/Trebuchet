// A Meteora DAMM v2 pool as one of a launch's pools: priced like the others, made once, adopted on
// a resume, and costed without Raydium's tick arrays or bootstrap.
import test from 'node:test';
import fs from 'node:fs';
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
  // The allocations the engine receives carry the venue: without it a Meteora pool was opened as Raydium CLMM.
  const [solAllocation, usdcAllocation] = plan.poolTopology.allocations;
  assert.equal(solAllocation.venue, 'meteora-damm-v2');
  assert.deepEqual(solAllocation.damm, { feeBps: 100, rangeMultiple: 100 });
  assert.equal(usdcAllocation.venue, undefined);
});

test('each Meteora pool in a launch gets its own position key; the SOL pool keeps the original', async () => {
  const rug = 'RUGx1zSD7LCVqFgTYQWNiJKSkDcfN3yRR5XoFoAXRUG';
  const usdc = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const original = lp.meteoraPositionSeed(owner.secretKey, base.tokenMint);
  assert.deepEqual(lp.meteoraPositionSeed(owner.secretKey, base.tokenMint, WSOL_MINT), original, 'SOL pools made before still resume');
  assert.notDeepEqual(lp.meteoraPositionSeed(owner.secretKey, base.tokenMint, rug), original);
  assert.notDeepEqual(lp.meteoraPositionSeed(owner.secretKey, base.tokenMint, rug), lp.meteoraPositionSeed(owner.secretKey, base.tokenMint, usdc));
  // Three pools in one launch: three different position NFTs created.
  const damm = fakeDamm();
  lp.setDammServiceForTests(damm);
  try {
    for (const [index, quote] of [[0, { address: WSOL_MINT, decimals: 9, symbol: 'SOL' }], [1, { address: rug, decimals: 9, symbol: 'RUG' }], [2, { address: usdc, decimals: 6, symbol: 'USDC' }]]) {
      await hooks.createMeteoraPoolForAllocation({ ...base, allocIdx: index, quote, alloc: { venue: 'meteora-damm-v2', supplyPercent: 5 }, progress: () => {} });
    }
  } finally { lp.setDammServiceForTests(null); }
  const nfts = damm.calls.filter((call) => call[0] === 'create').map((call) => call[5]);
  assert.equal(new Set(nfts).size, 3, 'no two pools share a position NFT');
});

test('a pair pool made with the original key is adopted on a resume', async () => {
  const rug = 'RUGx1zSD7LCVqFgTYQWNiJKSkDcfN3yRR5XoFoAXRUG';
  const originalNft = Keypair.fromSeed(lp.meteoraPositionSeed(owner.secretKey, base.tokenMint)).publicKey.toBase58();
  const calls = [];
  lp.setDammServiceForTests({
    async findExistingPool({ positionNft }) {
      calls.push(positionNft.toBase58());
      return { pool: new PublicKey(rug), position: Keypair.generate().publicKey, poolExists: true, positionExists: positionNft.toBase58() === originalNft };
    },
    async verifyLockedPool() { return { passed: true }; },
    async createLockedPool() { throw new Error('must not create a second pool'); },
  });
  try {
    const result = await hooks.createMeteoraPoolForAllocation({ ...base, allocIdx: 1, quote: { address: rug, decimals: 9, symbol: 'RUG' }, alloc: { venue: 'meteora-damm-v2', supplyPercent: 5 }, progress: () => {} });
    assert.equal(calls.length, 2, 'looked for the new key, then the original');
    assert.equal(calls[1], originalNft);
    assert.equal(result.damm.adopted, true);
    assert.equal(result.mainPositions[0].nftMint, originalNft, 'the Fee Key is the NFT the pool was made with');
  } finally { lp.setDammServiceForTests(null); }
});

test('a position is only adopted when it belongs to the pool being checked', () => {
  const source = fs.readFileSync(new URL('../dammV2Service.js', import.meta.url), 'utf8');
  assert.match(source, /positionInPool: positionState\.pool\.equals\(pool\)/);
  assert.match(source, /checks\.passed = checks\.positionInPool && /);
});

test('a coin\'s Meteora pools appear among its markets, read from the chain by address', async () => {
  const rugMint = 'RUGx1zSD7LCVqFgTYQWNiJKSkDcfN3yRR5XoFoAXRUG';
  const reads = [];
  lp.setDammServiceForTests({
    async readPoolMarket({ pool }) {
      reads.push(pool);
      if (pool === 'PoolSol') return { poolId: 'PoolSol', venue: 'meteora-damm-v2', quoteMint: WSOL_MINT, tokenReserve: 448000, quoteReserve: 0, quotePerToken: 0.0001656, feeRate: 0.02 };
      if (pool === 'PoolRug') return { poolId: 'PoolRug', venue: 'meteora-damm-v2', quoteMint: rugMint, tokenReserve: 50000, quoteReserve: 0, quotePerToken: 2, feeRate: 0.0025 };
      return null;
    },
  });
  try {
    const rows = await hooks.meteoraMarketRows({ connection: {}, tokenMint: 'Mint', poolIds: ['PoolSol', 'PoolRug', 'NotAPool'], getUsd: async (mint) => (mint === WSOL_MINT ? 120 : 0.006) });
    assert.deepEqual(reads, ['PoolSol', 'PoolRug', 'NotAPool']);
    assert.equal(rows.length, 2, 'an address that is not this token\'s pool is left out');
    assert.deepEqual([rows[0].type, rows[0].isSolPool, rows[0].quoteSymbol, rows[0].priceSol], ['Meteora DAMM v2', true, 'SOL', 0.0001656]);
    assert.equal(rows[1].isSolPool, false);
    assert.ok(Math.abs(rows[1].priceSol - 2 * (0.006 / 120)) < 1e-12, 'a pair pool is priced in SOL through its quote');
  } finally { lp.setDammServiceForTests(null); }
  const server = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(server, /listTokenMarkets\(mint, \{ meteoraPoolIds: meteoraPoolIdsFor\(journals\) \}\)/);
  assert.match(server, /result\?\.venue === 'meteora-damm-v2' && result\.poolId/);
});

test('the verification counts Meteora vaults as pool supply and reads the pool\'s permanent lock', () => {
  const source = fs.readFileSync(new URL('../tokenMarketEvidence.js', import.meta.url), 'utf8');
  assert.match(source, /row\.owner === METEORA_POOL_AUTHORITY[\s\S]*?row\.kind = 'meteora-damm-v2-vault';\n      poolAmount \+= BigInt\(row\.amount\);/);
  assert.match(source, /if \(info\?\.owner\?\.equals\(CP_AMM_PROGRAM_ID\)\) return readMeteoraPoolEvidence/);
  assert.match(source, /kind: 'meteora-permanent-lock', lockedPercent/);
});
