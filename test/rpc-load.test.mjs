import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { clearPoolDiscoveryCache, fetchVenuePoolsByMints } from '../venuePoolService.js';
import { appCaller, installRpcTrace } from '../rpcTrace.js';

const read = (name) => fs.readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

test('a pair\'s pools are scanned once per 10 minutes, not on every price read', async () => {
  clearPoolDiscoveryCache();
  let scans = 0;
  const connection = {
    rpcEndpoint: 'rpc-a',
    getProgramAccounts: async () => { scans += 1; return []; },
    getMultipleAccountsInfo: async (keys) => keys.map(() => null),
  };
  await fetchVenuePoolsByMints(connection, 'MintA', 'So11111111111111111111111111111111111111112');
  const first = scans;
  assert.ok(first > 0, 'the first read scans');
  await fetchVenuePoolsByMints(connection, 'MintA', 'So11111111111111111111111111111111111111112');
  await fetchVenuePoolsByMints(connection, 'MintA', 'So11111111111111111111111111111111111111112');
  assert.equal(scans, first, 'later reads reuse the scan');
  await fetchVenuePoolsByMints({ ...connection, rpcEndpoint: 'rpc-b' }, 'MintA', 'So11111111111111111111111111111111111111112');
  assert.equal(scans, first * 2, 'another RPC is scanned on its own');
});

test('a failed scan waits a minute, then a fresh read can recover', async (t) => {
  let now = 100_000;
  t.mock.method(Date, 'now', () => now);
  clearPoolDiscoveryCache();
  let scans = 0;
  const connection = {
    rpcEndpoint: 'rpc-c',
    getProgramAccounts: async () => { scans += 1; throw new Error('429 Too Many Requests'); },
    getMultipleAccountsInfo: async (keys) => keys.map(() => null),
  };
  await fetchVenuePoolsByMints(connection, 'MintB', 'So11111111111111111111111111111111111111112');
  const first = scans;
  await fetchVenuePoolsByMints(connection, 'MintB', 'So11111111111111111111111111111111111111112');
  assert.equal(scans, first, 'repeated reads share the cooldown');
  now += 60_001;
  await fetchVenuePoolsByMints(connection, 'MintB', 'So11111111111111111111111111111111111111112');
  assert.equal(scans, first * 2);
});

test('concurrent price reads share one pool scan in either mint order', async () => {
  clearPoolDiscoveryCache();
  let scans = 0;
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const connection = {
    rpcEndpoint: 'rpc-concurrent',
    getProgramAccounts: async () => { scans += 1; await pending; return []; },
  };
  const a = fetchVenuePoolsByMints(connection, 'MintC', 'MintD');
  const b = fetchVenuePoolsByMints(connection, 'MintD', 'MintC');
  const c = fetchVenuePoolsByMints(connection, 'MintC', 'MintD');
  release();
  await Promise.all([a, b, c]);
  assert.equal(scans, 6, 'three venues in two mint orders');
});

test('a pair token whose check failed waits a minute before the automatic re-check', () => {
  const prepare = read('public/v2/features/launch/prepare.js');
  const now = Date.parse('2026-10-04T12:00:00Z');
  const pools = [
    { id: 'fresh', quoteMint: 'M1' }, { id: 'ok', quoteMint: 'M2' },
    { id: 'just-failed', quoteMint: 'M3' }, { id: 'failed-long-ago', quoteMint: 'M4' }, { id: 'checking', quoteMint: 'M5' },
  ];
  const records = {
    ok: { info: { symbol: 'OK' } },
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
