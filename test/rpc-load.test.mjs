import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { clearPoolDiscoveryCache, fetchVenuePoolsByMints } from '../venuePoolService.js';
import { appCaller, installRpcTrace } from '../rpcTrace.js';
import { WSOL_MINT, USDC_MINT, USDT_MINT } from '../onChainPriceService.js';

const read = (name) => fs.readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

const TOKEN = '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr';
const noPoolsConnection = (onRead = () => {}) => ({
  getProgramAccounts: async () => { throw new Error('Broad pool scan reached'); },
  getMultipleAccountsInfo: async (keys) => { onRead(keys); return keys.map(() => null); },
});
const indexedPair = (anchor = WSOL_MINT) => ({ chainId: 'solana', pairAddress: USDC_MINT,
  baseToken: { address: TOKEN }, quoteToken: { address: anchor }, liquidity: { usd: 1000 } });

test('one mint index covers all quote pairs and RPC connections while state reads stay fresh', async () => {
  clearPoolDiscoveryCache();
  let lookups = 0; let reads = 0; let now = 100_000;
  const options = { now: () => now, fetchImpl: async (url) => {
    lookups++; assert.ok(url.endsWith(`/solana/${TOKEN}`));
    return { ok: true, json: async () => [indexedPair()] };
  } };
  const connection = noPoolsConnection(() => { reads++; });
  for (const anchor of [WSOL_MINT, USDC_MINT, USDT_MINT, WSOL_MINT]) {
    await fetchVenuePoolsByMints(connection, TOKEN, anchor, options);
  }
  await fetchVenuePoolsByMints(noPoolsConnection(() => { reads++; }), TOKEN, WSOL_MINT, options);
  assert.equal(lookups, 1); assert.equal(reads, 5);
  now += 600_001;
  await fetchVenuePoolsByMints(connection, TOKEN, WSOL_MINT, options);
  assert.equal(lookups, 2, 'address discovery refreshes after ten minutes');
});

test('a failed mint index has a five minute cooldown shared across polls, anchors, and RPCs', async () => {
  let now = 100_000;
  clearPoolDiscoveryCache();
  let lookups = 0; let recover = false;
  const options = { now: () => now, fetchImpl: async () => {
    lookups++;
    return recover ? { ok: true, json: async () => [indexedPair()] } : { ok: false, status: 429 };
  } };
  await fetchVenuePoolsByMints(noPoolsConnection(), TOKEN, WSOL_MINT, options);
  for (let i = 0; i < 9; i++) {
    now += 30_000;
    await fetchVenuePoolsByMints(noPoolsConnection(), TOKEN, [WSOL_MINT, USDC_MINT, USDT_MINT][i % 3], options);
  }
  assert.equal(lookups, 1);
  now += 30_001; recover = true;
  await fetchVenuePoolsByMints(noPoolsConnection(), TOKEN, WSOL_MINT, options);
  await fetchVenuePoolsByMints(noPoolsConnection(), TOKEN, USDC_MINT, options);
  assert.equal(lookups, 2);
});

test('twenty concurrent price reads share a single mint index request', async () => {
  clearPoolDiscoveryCache();
  let lookups = 0;
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const options = { fetchImpl: async () => {
    lookups++; await pending; return { ok: true, json: async () => [indexedPair()] };
  } };
  const requests = Array.from({ length: 20 }, (_, i) => fetchVenuePoolsByMints(
    noPoolsConnection(), TOKEN, [WSOL_MINT, USDC_MINT, USDT_MINT][i % 3], options));
  assert.equal(lookups, 1);
  release();
  await Promise.all(requests);
  assert.equal(lookups, 1);
});

test('a failed index refresh keeps known addresses and still reads their current accounts', async () => {
  clearPoolDiscoveryCache();
  let now = 0; let lookups = 0; const batches = [];
  const options = { now: () => now, fetchImpl: async () => {
    lookups++; if (lookups > 1) throw new Error('index offline');
    return { ok: true, json: async () => [indexedPair()] };
  } };
  const connection = noPoolsConnection((keys) => batches.push(keys.map((key) => key.toBase58())));
  await fetchVenuePoolsByMints(connection, TOKEN, WSOL_MINT, options);
  now += 600_001;
  await fetchVenuePoolsByMints(connection, TOKEN, WSOL_MINT, options);
  now += 30_000;
  await fetchVenuePoolsByMints(connection, TOKEN, WSOL_MINT, options);
  assert.equal(lookups, 2); assert.equal(batches.length, 3);
  assert.ok(batches.every((batch) => batch.includes(USDC_MINT)));
});

test('an empty index checks again after one minute for newly listed pools', async () => {
  clearPoolDiscoveryCache();
  let now = 0; let lookups = 0;
  const options = { now: () => now, fetchImpl: async () => {
    lookups++; return { ok: true, json: async () => [] };
  } };
  await fetchVenuePoolsByMints(noPoolsConnection(), TOKEN, WSOL_MINT, options);
  now += 30_000;
  await fetchVenuePoolsByMints(noPoolsConnection(), TOKEN, WSOL_MINT, options);
  assert.equal(lookups, 1);
  now += 30_001;
  await fetchVenuePoolsByMints(noPoolsConnection(), TOKEN, WSOL_MINT, options);
  assert.equal(lookups, 2);
});

test('a pair token whose check failed waits a minute before the automatic re-check', () => {
  const prepare = read('public/v2/features/launch/prepare.js');
  const now = Date.parse('2026-10-04T12:00:00Z');
  const pools = [
    { id: 'fresh', quoteMint: 'M1' }, { id: 'ok', quoteMint: 'M2' },
    { id: 'just-failed', quoteMint: 'M3' }, { id: 'failed-long-ago', quoteMint: 'M4' }, { id: 'checking', quoteMint: 'M5' },
  ];
  const records = {
    ok: { info: { symbol: 'OK', compatible: true, freezeAuthorityBlock: false, swapRoute: 'jupiter' } },
    'just-failed': { error: '429', checkedAt: new Date(now - 10_000).toISOString() },
    'failed-long-ago': { error: '429', checkedAt: new Date(now - 61_000).toISOString() },
    checking: { loading: true },
  };
  const context = vm.createContext({ state: { customPools: pools }, customQuoteLookupValue: (pool) => pool.quoteMint, customQuoteInfoRecord: (pool) => records[pool.id] || null, Date });
  vm.runInContext(prepare.slice(prepare.indexOf('// A pair token is checked automatically once'), prepare.indexOf('function autoVerifyQuoteTokens')), context);
  assert.deepEqual(context.pairTokensNeedingCheck(now).map((pool) => pool.id), ['fresh', 'failed-long-ago']);
});

test('the server remembers that a token has no usable on-chain price for a minute', () => {
  const server = read('server.js');
  assert.match(server, /expiresAt: Date\.now\(\) \+ \(oc \? ON_CHAIN_PRICE_TTL_MS : ON_CHAIN_PRICE_MISS_TTL_MS\)/);
  assert.doesNotMatch(server, /if \(oc\) onChainPriceCache\.set/);
});

test('the RPC trace counts calls by method and the app code that made them', async () => {
  assert.match(appCaller('Error\n    at node:internal/x\n    at fn (file:///app/node_modules/@solana/web3.js/lib/index.cjs.js:1:1)\n    at readWalletContents (file:///app/server.js:2703:12)\n    at async other (file:///app/lpService.js:5881:3)'), /^server\.js:2703 readWalletContents ← lpService\.js:5881 other$/);
  const { Connection, PublicKey } = await import('@solana/web3.js');
  const logs = [];
  let clock = 0;
  const stop = installRpcTrace({ log: (line) => logs.push(line), now: () => clock });
  try {
    const connection = new Connection('http://127.0.0.1:1', { disableRetryOnRateLimit: true });
    await connection.getSlot().catch(() => null);
    clock = 10_000;
    await new Promise((resolve) => setTimeout(resolve, 10_050));
  } finally {
    stop();
  }
  assert.match(logs.join('\n'), /\[rpc-trace\] \d+ calls in 10s[\s\S]*getSlot ← /);
  assert.match(read('server.js'), /if \(process\.env\.TREBUCHET_RPC_TRACE === '1'\) installRpcTrace\(\);/);
});
