import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DAMM_V2_DEFAULTS, DAMM_V2_POOL_RENT_LAMPORTS, DAMM_V2_VENUE, compareLaunchVenues, dammV2CostModel, dammV2DepthTable,
  dammV2Facts, dammV2Pricing, normalizeDammV2Config,
} from '@trebuchet/core/damm-v2-plan';
import { buildV2LaunchPlan } from '@trebuchet/core/launch-plan';

const GOOD = { token: { name: 'Trebuchet', symbol: 'treb', supply: '1,000,000,000', description: 'x' } };

test('a lean launch config takes the app defaults and uppercases the symbol', () => {
  const config = normalizeDammV2Config(GOOD);
  assert.equal(config.venue, DAMM_V2_VENUE);
  assert.equal(config.token.symbol, 'TREB');
  assert.equal(config.token.supply, '1000000000');
  assert.equal(config.token.decimals, 9);
  assert.deepEqual(config.pool, {
    startingMarketCapUsd: DAMM_V2_DEFAULTS.startingMarketCapUsd,
    rangeMultiple: DAMM_V2_DEFAULTS.rangeMultiple,
    feeBps: DAMM_V2_DEFAULTS.feeBps,
  });
  assert.equal(config.destination, null);
});

test('config validation says what is wrong in plain words', () => {
  assert.throws(() => normalizeDammV2Config({ token: { name: '', symbol: 'X' } }), /name is required/);
  assert.throws(() => normalizeDammV2Config({ ...GOOD, feeBps: 0 }), /Trading fee must be between 1 and 1,000/);
  assert.throws(() => normalizeDammV2Config({ ...GOOD, feeBps: 12.5 }), /whole number/);
  assert.throws(() => normalizeDammV2Config({ ...GOOD, rangeMultiple: 5 }), /Price range must be between 10/);
  assert.throws(() => normalizeDammV2Config({ ...GOOD, startingMarketCapUsd: 5 }), /Starting market cap must be between/);
  assert.throws(() => normalizeDammV2Config({ ...GOOD, startingMarketCapUsd: 'lots' }), /must be a number/);
  assert.throws(() => normalizeDammV2Config({ ...GOOD, destination: 'nope' }), /does not look like a Solana address/);
  assert.throws(() => normalizeDammV2Config({ ...GOOD, destination: '11111111111111111111111111111111' }), /./, 'a placeholder destination would lose the Fee Key');
  assert.throws(() => normalizeDammV2Config({ ...GOOD, vanity: { selectedPublicKey: 'short' } }), /contract address/);
  const ok = normalizeDammV2Config({ ...GOOD, destination: 'AtPVyHp52LqHy1rnMu5fUx9eWpDMrr2DnC3C3mdFc54j', vanity: { selectedPublicKey: '8fFf5jzUp1jtAf6bX3zM9nNSb8VJRfZdt6TtrEbUcHET' } });
  assert.equal(ok.destination, 'AtPVyHp52LqHy1rnMu5fUx9eWpDMrr2DnC3C3mdFc54j');
  assert.equal(ok.vanity.selectedPublicKey, '8fFf5jzUp1jtAf6bX3zM9nNSb8VJRfZdt6TtrEbUcHET');
});

test('the price model reproduces what the real program did on a local validator', () => {
  // 2,100 SOL starting market cap over 1B tokens, range x1000, 0.25% fee: a 20 SOL buy
  // got 9,413,400.634 tokens at 1.0117x the starting price (test/e2e/v2-damm-localnet.mjs).
  const pricing = dammV2Pricing({ supply: '1000000000', startingMarketCapUsd: 2100 * 200, solUsd: 200, rangeMultiple: 1000, feeBps: 25 });
  assert.equal(pricing.startMarketCapSol, 2100);
  const buy = pricing.buy(20);
  assert.ok(Math.abs(buy.tokens - 9_413_400.634) / 9_413_400.634 < 1e-4, `model says ${buy.tokens}`);
  assert.ok(Math.abs(buy.averagePriceMultiple - 1.0117) < 0.0005, `model says ${buy.averagePriceMultiple}`);
  assert.ok(Math.abs(buy.percentOfSupply - 0.94134) < 0.001);
});

test('depth: what it costs to push the price up', () => {
  const pricing = dammV2Pricing({ supply: '1000000000', startingMarketCapUsd: 250_000, solUsd: 118, rangeMultiple: 1000, feeBps: 25 });
  const table = dammV2DepthTable(pricing);
  assert.deepEqual(table.map((row) => row.multiple), [1.1, 1.5, 2, 5, 10]);
  for (let i = 1; i < table.length; i += 1) assert.ok(table[i].solToReach > table[i - 1].solToReach, 'monotonic in the multiple');
  // Doubling the price takes (sqrt(2) - 1) / (1 - 1/sqrt(1000)) = 0.4277 of the starting market cap in SOL, plus the 0.25% fee.
  const double = table[2];
  assert.ok(Math.abs(double.solToReach / pricing.startMarketCapSol - 0.4277 / 0.9975) < 0.001, `${double.solToReach / pricing.startMarketCapSol}`);
  // Closed form for a range this wide: (1 - 1/sqrt(2)) / (1 - 1/sqrt(1000)) = 30.25% of the supply.
  assert.ok(Math.abs(double.percentOfSupplySold - 30.25) < 0.05, `${double.percentOfSupplySold}`);
  // The same SOL through buy() and toPrice() agree.
  const viaBuy = pricing.buy(double.solToReach);
  assert.ok(Math.abs(viaBuy.endMarketCapUsd - double.marketCapUsd) / double.marketCapUsd < 1e-6);
  // The price never goes past the top of the range.
  assert.equal(pricing.toPrice(1e9).multiple, 1000);
  assert.equal(pricing.endMarketCapUsd, 250_000 * 1000);
});

test('the cost model uses the measured rent and has no SOL seed', () => {
  const cost = dammV2CostModel();
  assert.equal(cost.seedSol, 0);
  const pool = cost.lines.find((line) => line.id === 'pool');
  assert.equal(pool.venue, true);
  const rentSol = DAMM_V2_POOL_RENT_LAMPORTS / 1e9;
  assert.ok(pool.sol > rentSol && pool.sol < rentSol + 0.0001, 'rent plus the two signatures and a priority fee');
  assert.ok(cost.lines.find((line) => line.id === 'token').venue === false, 'the token costs the same on any venue');
  assert.ok(Math.abs(cost.total - (cost.lines.reduce((s, l) => s + l.sol, 0) * 1.2)) < 1e-12, 'a 20% buffer on top');
  const withKey = dammV2CostModel({ keyTransfers: 1 });
  assert.ok(withKey.venueSol > cost.venueSol);
  assert.ok(Math.abs((withKey.venueSol - cost.venueSol) - (2_074_080 + 5_000) / 1e9) < 1e-12);
});

test('comparison against the Raydium path in the app, using the app\'s own estimate', () => {
  const raydium = buildV2LaunchPlan({
    token: { name: 'Trebuchet', symbol: 'TREB', supply: '1000000000' }, mode: 'dry-run', launchSol: 0,
    poolTopology: { pools: [{ quoteSymbol: 'SOL', quoteMint: 'So11111111111111111111111111111111111111112', supplyPercent: 100, distribution: [{ sharePercent: 100 }], ladder: { mode: 'off' }, support: { mode: 'off' } }] },
  }).operations;
  const raydiumVenue = raydium.filter((op) => /pool|Fee Key/i.test(op.label)).reduce((sum, op) => sum + op.costSol, 0);
  assert.ok(raydiumVenue > 0.1, `Raydium venue cost ${raydiumVenue}`);
  const compared = compareLaunchVenues({ raydiumVenueSol: raydiumVenue, dammVenueSol: dammV2CostModel({ keyTransfers: 1 }).venueSol, solUsd: 118 });
  assert.ok(compared.savedSol > 0.09, `saves ${compared.savedSol} SOL`);
  assert.ok(compared.savedPct >= 60 && compared.savedPct <= 95, `${compared.savedPct}%`);
  assert.equal(compareLaunchVenues({ raydiumVenueSol: 0.01, dammVenueSol: 0.05 }).savedSol, 0, 'never reports a negative saving');
});

test('the review facts state the lock, the SOL-only fees and who holds the Fee Key', () => {
  const facts = dammV2Facts(normalizeDammV2Config(GOOD));
  assert.match(facts.join(' '), /No SOL is put in/);
  assert.match(facts.join(' '), /locked permanently/);
  assert.match(facts.join(' '), /collected in SOL/);
  assert.match(facts[2], /The launch wallet holds the Fee Key/);
  const dest = dammV2Facts(normalizeDammV2Config({ ...GOOD, destination: 'AtPVyHp52LqHy1rnMu5fUx9eWpDMrr2DnC3C3mdFc54j' }));
  assert.match(dest[2], /The destination wallet holds the Fee Key/);
});
