import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import Decimal from 'decimal.js';
import * as lp from '../lpService.js';
import { restoreLaunchJournalArt } from '../coinService.js';
import { buildV2ExecutionReadiness, v2FundingEstimateFingerprint } from '../v2LaunchPlan.js';

const QUOTE = { address: '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr', symbol: 'SI', decimals: 6 };
const ESTIMATED = '0.00334932548175887';
const CURRENT = '0.0009239751643386215079';
const SDK = { api: { fetchPoolByMints: async () => [] }, clmm: { getRpcClmmPoolInfo: async () => null },
  liquidity: { getRpcPoolInfos: async () => ({}) }, cpmm: { getRpcPoolInfos: async () => ({}) } };
const allocation = { quoteToken: QUOTE.address, quoteDecimalsOverride: 6, quoteSymbolOverride: 'SI',
  supplyPercent: 100, distribution: [{ sharePercent: 100 }], bootstrap: { mode: 'minimal' } };
const poolPrice = (price) => ({ priceUsd: new Decimal(price), anchorSymbol: 'SOL', poolId: 'pool', kind: 'clmm',
  liquidityUsd: new Decimal(10000), spreadPct: new Decimal(0), qualifyingCount: 1, discoveredCount: 1 });

test.beforeEach(() => {
  lp.setSdkFactoryForTests(async () => SDK);
  lp.setPriceOracleForTests(async () => new Decimal(200));
  lp.setRouteDiscoveryForTests(async () => ({ available: true, effectiveQuoteUsd: new Decimal(ESTIMATED) }));
  lp.setLaunchOnChainPriceForTests(async () => poolPrice(CURRENT));
});
test.afterEach(() => lp.resetTestFactories());

const estimate = (alloc = allocation) => lp.estimateRequiredFunding({ allocations: [alloc], onChainPrice: lp.getQuoteTokenOnChainPrice });

test('funding refresh uses the LP pool price for the reported SI mismatch', async () => {
  const result = await estimate({ ...allocation, quoteUsdOverride: ESTIMATED });
  assert.equal(result.resolvedPrices[0].quoteUsd, CURRENT);
  assert.equal(result.resolvedPrices[0].source, 'on-chain:SOL');
  assert.equal(result.autoSwapPlan[0].targetRaw, String(Math.ceil(new Decimal(2).div(CURRENT).toNumber() * 1e6)));
  const price = await lp.resolveQuoteUsdForCreate({ quoteToken: QUOTE,
    alloc: { ...allocation, quoteUsdOverride: result.resolvedPrices[0].quoteUsd }, solUsd: new Decimal(200), raydium: SDK });
  assert.equal(price.driftPct, 0);
});

test('a second estimate reads fresh pool state and the real drift guard remains active', async () => {
  const first = await estimate();
  lp.setLaunchOnChainPriceForTests(async () => poolPrice('0.0012'));
  const second = await estimate({ ...allocation, quoteUsdOverride: first.resolvedPrices[0].quoteUsd });
  assert.equal(second.resolvedPrices[0].quoteUsd, '0.0012');
  assert.notEqual(second.autoSwapPlan[0].targetRaw, first.autoSwapPlan[0].targetRaw);
  lp.setLaunchOnChainPriceForTests(async () => poolPrice('0.005'));
  await assert.rejects(lp.resolveQuoteUsdForCreate({ quoteToken: QUOTE,
    alloc: { quoteUsdOverride: second.resolvedPrices[0].quoteUsd }, solUsd: new Decimal(200), raydium: SDK }), /Price drift/);
});

test('a Meteora estimate also refreshes its price while budgeting only pool rent and fees', async () => {
  const result = await estimate({ ...allocation, venue: 'meteora-damm-v2', quoteUsdOverride: ESTIMATED });
  assert.equal(result.resolvedPrices[0].quoteUsd, CURRENT);
  assert.equal(result.autoSwapPlan.length, 0);
  assert.equal(Object.keys(result.byQuote).length, 0);
  assert.ok(result.solBreakdown.some((line) => line.label.includes('Meteora pool')));
  assert.ok(result.solBreakdown.every((line) => !/bootstrap|price-range rent/.test(line.label)));
});

test('an unavailable pool falls back to a fresh route price instead of an earlier automatic reference', async () => {
  lp.setLaunchOnChainPriceForTests(async () => { throw Object.assign(new Error('none'), { code: 'NO_POOLS' }); });
  const result = await estimate({ ...allocation, quoteUsdOverride: '10' });
  assert.equal(result.resolvedPrices[0].quoteUsd, ESTIMATED);
  assert.equal(result.resolvedPrices[0].source, 'raydium-probe');
});

test('funding surfaces a pool spread finding even when a swap route offers a price', async () => {
  lp.setLaunchOnChainPriceForTests(async () => { throw Object.assign(new Error('pool prices disagree'), { code: 'POOL_SPREAD' }); });
  await assert.rejects(estimate(), { code: 'POOL_SPREAD' });
});

test('an explicitly hand-set funding price keeps its intent', async () => {
  const result = await estimate({ ...allocation, quoteUsdOverride: '0.002', priceEnteredByUser: true });
  assert.equal(result.resolvedPrices[0].quoteUsd, '0.002');
  assert.equal(result.resolvedPrices[0].source, 'user-override');
});

function readiness({ rowMint = QUOTE.address, price = CURRENT, manual = false } = {}) {
  const input = { token: { name: 'Token', symbol: 'TOK', supply: '1000000000' },
    poolTopology: { targetMarketCapUsd: 25000, pools: [{ ...allocation, quoteUsdOverride: ESTIMATED,
      ...(manual ? { priceEnteredByUser: true } : {}) }] } };
  return buildV2ExecutionReadiness(input, { demoMode: true, walletPublicKey: 'wallet', tokenMint: 'mint',
    fundingEstimate: { totalSol: 1, v2FundingFingerprint: v2FundingEstimateFingerprint(input),
      resolvedPrices: [{ allocationIndex: 0, quoteMint: rowMint, quoteUsd: price }] } });
}

test('the funded price reaches preflight, creation, and resume while the input stays intact', () => {
  const result = readiness();
  for (const name of ['preflightCreateLp', 'createLp', 'resumeLaunch']) {
    assert.equal(result.classicPayloads[name].allocations[0].quoteUsdOverride, CURRENT);
  }
  assert.equal(result.classicPayloads.estimateFunding.allocations[0].quoteUsdOverride, Number(ESTIMATED));
});

test('a price from another quote mint or an invalid price keeps the original reference', () => {
  for (const options of [{ rowMint: 'different' }, { price: 'NaN' }, { price: '-1' }]) {
    assert.equal(readiness(options).classicPayloads.createLp.allocations[0].quoteUsdOverride, Number(ESTIMATED));
  }
});

test('a manual price survives plan normalization and LP payload construction', () => {
  const result = readiness({ manual: true });
  assert.equal(result.classicPayloads.createLp.allocations[0].priceEnteredByUser, true);
  assert.equal(result.classicPayloads.createLp.allocations[0].quoteUsdOverride, Number(ESTIMATED));
});

const art = 'data:image/png;base64,' + 'A'.repeat(4000);
const journal = { walletPublicKey: 'wallet', token: { mint: 'mint', sealedLaunch: true },
  launchConfig: { token: { name: 'Token', symbol: 'TOK', logo: { name: 'art.png' } } } };

test('sealed recovery restores the full local image and keeps the durable journal compact', () => {
  const restored = restoreLaunchJournalArt(journal, { sealedIdentity: { mint: 'mint', logoDataUrl: art } });
  assert.equal(restored.launchConfig.token.logo.dataUrl, art);
  assert.equal(journal.launchConfig.token.logo.dataUrl, undefined);
});

test('saved draft art is restored only for the matching wallet or mint and identity', () => {
  const saved = { config: { walletPublicKey: 'wallet', token: { name: 'Token', symbol: 'TOK', logo: { dataUrl: art } } } };
  assert.equal(restoreLaunchJournalArt(journal, { launches: [saved] }).launchConfig.token.logo.dataUrl, art);
  assert.equal(restoreLaunchJournalArt(journal, { launches: [{ config: { ...saved.config, walletPublicKey: 'another' } }] }), journal);
  assert.equal(restoreLaunchJournalArt(journal, { launches: [{ config: { ...saved.config,
    vanity: { selectedPublicKey: 'another' } } }] }), journal);
  assert.equal(restoreLaunchJournalArt(journal, { sealedIdentity: { mint: 'another', logoDataUrl: art } }), journal);
});

const read = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
test('an earlier compact proof gains restored art while its saved plan stays bound', () => {
  const source = read('public/v2/features/proof/evidence.js').match(/function mergeLaunchConfigSnapshot\([^]*?\n\}/)[0];
  const context = vm.createContext({ proofReportArtifactFinalizesDestination: () => false,
    transferHasFinalSweepEvidence: () => false });
  vm.runInContext(source, context);
  const original = { token: { name: 'Token', logo: { name: 'art.png' } }, poolTopology: { targetMarketCapUsd: 25000 } };
  const result = context.mergeLaunchConfigSnapshot(original, { token: { logo: { name: 'art.png', dataUrl: art } },
    poolTopology: { targetMarketCapUsd: 99999 } });
  assert.equal(result.token.logo.dataUrl, art);
  assert.equal(result.poolTopology.targetMarketCapUsd, 25000);
  assert.equal(original.token.logo.dataUrl, undefined);
});

test('editing an active launch keeps its proof and requires fresh authorization', () => {
  const source = read('public/v2/features/launch/funding.js').match(/function invalidateClassicOutputs\(\) \{[\s\S]*?\n\}/)[0];
  const proof = { token: { mint: 'mint', mintAuthorityRenounced: true } };
  const state = { launchProof: proof, lastRunEnvelope: { id: 'old' }, classicFundingEstimate: {} };
  const context = vm.createContext({ state, liveLaunchInProgress: () => Boolean(state.launchProof?.token?.mint),
    clearLaunchProof: () => { state.launchProof = null; }, resetQuoteAcquireState() {}, resetManualPrefundState() {} });
  vm.runInContext(source, context);
  context.invalidateClassicOutputs();
  assert.equal(state.launchProof, proof);
  assert.equal(state.lastRunEnvelope, null);
  assert.equal(state.classicFundingEstimate, null);
});

test('token completion clears cached zero-supply facts and reads the displayed coin again', async () => {
  const source = read('public/v2/features/discovery/coins.js');
  const state = { coins: { key: 'mint:mint', detail: { mint: 'mint', account: { supply: '0' } } } };
  const calls = [];
  const context = vm.createContext({ state, loadCoinDetail: async (mint) => { calls.push(mint); } });
  for (const name of ['rememberCoinPage', 'refreshCoinAfterExecution']) {
    vm.runInContext(source.match(new RegExp(`function ${name}\\([^]*?\\n\\}`))[0], context);
  }
  vm.runInContext('const coinPageCache = new Map(); rememberCoinPage("mint", {detail: state.coins.detail});', context);
  context.refreshCoinAfterExecution('mint');
  assert.equal(state.coins.detail, null);
  assert.deepEqual(calls, ['mint']);
  assert.equal(vm.runInContext('coinPageCache.has("mint")', context), false);
});
