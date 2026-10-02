import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { PublicKey } from '@solana/web3.js';
import { HUB_SOL_MINT as SOL, listFlywheelHubs, parseDexSolPools, parseGeckoSolPools, resolveFlywheelHub } from '../hubPoolService.js';
import { parseDiscoveryMarketPool } from '../discoveryService.js';
import { TOKEN_REGISTRY } from '../tokenRegistry.js';

const defaults = listFlywheelHubs().defaults;
const MINT = defaults[0].mint;
const EXTRA = '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo';
const POOL = '57RyRYVULC8fy8AeZhiVkpAxNdt4NBQdcfaS78EwvwWP';
const POOL2 = 'FpmpAMAKiZKNxqe7Qw7kW2JHxRBpm5D4ThpEoFNcB4X4';
function dex(base = MINT, quote = SOL, liquidity = 100, address = POOL) {
  return { chainId: 'solana', pairAddress: address, baseToken: { address: base, name: 'Seige', symbol: 'SEIGE' },
    quoteToken: { address: quote, name: 'Quote', symbol: 'Q' }, liquidity: { usd: liquidity }, dexId: 'raydium' };
}
function gecko(base = MINT, quote = SOL) {
  return { attributes: { address: POOL, reserve_in_usd: '50', base_token_price_usd: '1' },
    relationships: { base_token: { data: { id: `solana_${base}` } }, quote_token: { data: { id: `solana_${quote}` } }, dex: { data: { id: 'raydium-clmm' } } } };
}
const response = (body, status = 200) => ({ ok: status === 200, status, json: async () => body });

test('defaults are ordered and Discovery adds only unique direct SOL pairs', () => {
  assert.deepEqual(defaults.map((hub) => hub.name), ['SEIGE', 'RUGOWEEN', 'RATICOIN', 'FLOOFY DOG', 'XRAT', 'Degen Unit', 'XLRT', 'wBTC', 'wETH', 'USDC', 'USDT', 'USD1']);
  const record = (mint, quoteMint) => ({ mint, symbol: 'X', market: { pool: { address: POOL, quoteMint } } });
  const catalog = listFlywheelHubs({ knownTokens: [record(MINT, SOL), record(EXTRA, SOL)],
    candidates: [record(EXTRA, SOL), record(defaults[1].mint, EXTRA), record(SOL, SOL)] });
  assert.equal(catalog.defaults.length, 12);
  assert.equal(catalog.defaults.find((hub) => hub.symbol === 'DGU').mint, '7AL5rfx4Jf1DLFzZpQEPHkmR9BJjpcmWwne1f9xqfmTu');
  assert.deepEqual(catalog.discovery.map((hub) => hub.mint), [EXTRA]);
  assert.equal(listFlywheelHubs(null).discovery.length, 0);
  const defaultMints = new Set(defaults.map((hub) => hub.mint));
  for (const key of ['XLRT', 'WBTC', 'WETH', 'USDC', 'USDT', 'USD1']) {
    assert.equal(TOKEN_REGISTRY[key].network, 'mainnet');
    assert.ok(defaultMints.has(TOKEN_REGISTRY[key].address), `${key} uses the curated CA`);
  }
  for (const key of ['KYRO', 'RATI', 'RUBY']) {
    assert.equal(TOKEN_REGISTRY[key].network, 'devnet');
    assert.equal(defaultMints.has(TOKEN_REGISTRY[key].address), false, `${key} stays on devnet`);
  }
});

test('pool matching checks both mints and the chain, then ranks by liquidity', () => {
  const pools = parseDexSolPools(MINT, [dex(MINT, EXTRA, 99999), dex(EXTRA, SOL),
    { ...dex(), chainId: 'ethereum' }, dex(SOL, MINT, 200, POOL2), dex()]);
  assert.deepEqual(pools.map((pool) => pool.address), [POOL2, POOL]);
  assert.equal(parseDexSolPools(SOL, [dex()]).length, 0);
  assert.equal(parseDexSolPools(MINT, [dex(MINT, SOL, 50, 'invalid')]).length, 0);
});

test('Discovery retains a SOL pool even when its main market uses another quote', () => {
  const payload = { data: [gecko(MINT, EXTRA), gecko(SOL, MINT)] };
  const market = parseDiscoveryMarketPool(MINT, payload);
  assert.equal(market.pool.quoteMint, EXTRA);
  assert.equal(market.solPool.baseMint, SOL);
  assert.equal(market.solPool.quoteMint, MINT);
  assert.equal(parseGeckoSolPools(MINT, { data: [gecko(EXTRA, SOL)] }).length, 0);
});

test('CA lookup uses GeckoTerminal when DexScreener has no direct SOL pair', async () => {
  const calls = [];
  const result = await resolveFlywheelHub(defaults[3].mint, { fetchImpl: async (url, options) => {
    calls.push(url);
    assert.ok(options.signal);
    return response(url.includes('dexscreener') ? [] : { data: [gecko(defaults[3].mint, SOL)] });
  } });
  assert.equal(calls.length, 2);
  assert.equal(result.name, 'FLOOFY DOG');
  assert.equal(result.solPool.address, POOL);
});

test('bad CA, empty results, and index failures remain distinct and retryable', async () => {
  await assert.rejects(resolveFlywheelHub('wrong', { fetchImpl: () => assert.fail('invalid mint fetched') }), /valid Solana/);
  await assert.rejects(resolveFlywheelHub(SOL), /hub token/);
  await assert.rejects(resolveFlywheelHub(MINT, { fetchImpl: async () => response([]) }), /No pool with SOL, USDC/);
  await assert.rejects(resolveFlywheelHub(MINT, { fetchImpl: async () => response({}, 429) }), /incomplete/);
  const result = await resolveFlywheelHub(MINT, { fetchImpl: async (url) => url.includes('dexscreener')
    ? response({}, 429) : response({ data: [gecko()] }) });
  assert.equal(result.solPool.address, POOL);
});

const app = readFileSync(new URL('../public/v2/app.js', import.meta.url), 'utf8');
function pickerHarness() {
  const pending = [];
  const added = [];
  const field = { value: '', focus() {}, scrollIntoView() {} };
  const sandbox = { DEFAULT_SOL_MINT: SOL, escapeHtml: String, shortAddress: (x) => x, isProbablySolanaAddress: () => true,
    $: () => field, document: { querySelector: () => field }, ownTokenMint: () => null,
    state: { discovery: { records: [] }, customPools: [], apiClient: {
      resolveFlywheelHub: () => new Promise((resolve) => pending.push(resolve)),
      listFlywheelHubs: async () => ({ defaults, discovery: [] }),
    } },
    addCustomPool: (hub) => { added.push(hub); return 'new-pool'; }, resolveCustomQuoteToken: async () => ({}),
  };
  const source = app.slice(app.indexOf('let hubPicker ='), app.indexOf('function addCustomPool('));
  vm.runInNewContext(source + '\nthis.getPicker = () => hubPicker;', sandbox);
  return { sandbox, pending, added };
}

test('picker keeps defaults first and filters local Discovery tokens by SOL pair', () => {
  const { sandbox } = pickerHarness();
  const records = [{ mint: EXTRA, market: { solPool: { address: POOL, baseMint: SOL, quoteMint: EXTRA } } },
    { mint: POOL, market: { pool: { address: POOL2, quoteMint: EXTRA } } }, { ...defaults[0], market: { pool: { address: POOL, quoteMint: SOL } } }];
  const rows = sandbox.hubPickerRows({ defaults, discovery: [] }, records);
  assert.deepEqual(Array.from(rows, (hub) => hub.mint), [...defaults.map((hub) => hub.mint), EXTRA]);
});

test('late lookup results and closed pickers cannot select a stale token', async () => {
  const { sandbox, pending, added } = pickerHarness();
  await sandbox.openHubPicker();
  const first = sandbox.findHubPool(MINT);
  const second = sandbox.findHubPool(EXTRA);
  pending[1]({ mint: EXTRA, symbol: 'X', solPool: { address: POOL } });
  await second;
  pending[0]({ mint: MINT, symbol: 'S', solPool: { address: POOL2 } });
  await first;
  assert.equal(sandbox.getPicker().result.mint, EXTRA);
  assert.equal(added.length, 0, 'lookup awaits explicit selection');
  sandbox.useHubToken();
  assert.equal(added[0].mint, EXTRA);
  await sandbox.openHubPicker();
  const third = sandbox.findHubPool(MINT);
  sandbox.closeHubPicker();
  pending[2]({ mint: MINT, solPool: { address: POOL } });
  await third;
  assert.equal(sandbox.getPicker().result, null);
});

test('a Helius RPC finds the SOL pool on chain before the public indexers are asked', async () => {
  const vault = new PublicKey(Buffer.alloc(32, 7)).toBase58();
  // CLMM: vault 0 at 137, vault 1 at 169, so the slice holds both; SOL is the second mint here.
  const data = Buffer.concat([Buffer.alloc(32, 1), new PublicKey(Buffer.alloc(32, 7)).toBytes()]).toString('base64');
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(url);
    if (!String(url).includes('helius-rpc.com')) throw new Error('indexer should not be asked');
    const { method, params } = JSON.parse(init.body);
    if (method === 'getProgramAccounts') {
      // The SOL pair is stored with the mints in byte order: only one ordering holds a pool.
      return response({ result: params[0] === 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK' && params[1].filters[1].memcmp.bytes === MINT ? [{ pubkey: POOL, account: { data: [data, 'base64'] } }] : [] });
    }
    assert.deepEqual(params[0], [vault]);
    const amountBytes = Buffer.alloc(8);
    amountBytes.writeBigUInt64LE(12_500_000_000n);
    return response({ result: { value: [{ data: [amountBytes.toString('base64'), 'base64'] }] } });
  };
  const hub = await resolveFlywheelHub(MINT, { fetchImpl, rpcUrl: 'https://mainnet.helius-rpc.com/?api-key=x' });
  assert.equal(hub.solPool.address, POOL);
  assert.equal(hub.solPool.source, 'Helius');
  assert.equal(hub.solPool.solReserve, 12.5);
  assert.ok(calls.every((url) => url.includes('helius-rpc.com')));
  // A non-Helius RPC is never asked to scan the program.
  await assert.rejects(resolveFlywheelHub(MINT, { fetchImpl: async () => response([], 404), rpcUrl: 'https://api.mainnet-beta.solana.com' }), /No pool with SOL/);
});

test('without a SOL pool the hub routes through USDC, then XLRT, and SOL still wins', async () => {
  const USDC = defaults.find((hub) => hub.symbol === 'USDC').mint;
  const XLRT = defaults.find((hub) => hub.symbol === 'XLRT').mint;
  const feed = (...pairs) => async (url) => response(url.includes('dexscreener') ? pairs : { data: [] });
  const viaUsdc = await resolveFlywheelHub(MINT, { fetchImpl: feed(dex(MINT, USDC, 10, POOL2)) });
  assert.equal(viaUsdc.solPool.address, POOL2);
  assert.deepEqual(viaUsdc.via, { mint: USDC, symbol: 'USDC' });
  const viaXlrt = await resolveFlywheelHub(MINT, { fetchImpl: feed(dex(XLRT, MINT, 10, POOL2)) });
  assert.equal(viaXlrt.via.symbol, 'XLRT');
  const both = await resolveFlywheelHub(MINT, { fetchImpl: feed(dex(MINT, USDC, 999, POOL2), dex(MINT, SOL, 1, POOL)) });
  assert.equal(both.via, null);
  assert.equal(both.solPool.address, POOL);
  // A token is never routed through itself.
  await assert.rejects(resolveFlywheelHub(USDC, { fetchImpl: feed(dex(USDC, USDC)) }), /No pool/);
});
