import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
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
  await assert.rejects(resolveFlywheelHub(MINT, { fetchImpl: async () => response([]) }), /direct SOL pool is required/);
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

// ---- the failure messages say what actually failed ------------------------------------------------
const quiet = { retryDelayMs: 0, log: () => {} };
const limited = (retryAfter) => ({ ok: false, status: 429, headers: { get: (name) => (name === 'retry-after' ? retryAfter : null) }, json: async () => ({}) });
const isDex = (url) => url.includes('dexscreener');

test('a rate-limited source is named, the other source\'s answer is kept, and the user is told to wait', async () => {
  const error = await resolveFlywheelHub(MINT, { ...quiet, fetchImpl: async (url) => (isDex(url) ? response([]) : limited(null)) })
    .then(() => null, (e) => e);
  assert.match(error.message, /^Pool lookup is incomplete: GeckoTerminal is rate-limiting requests\./);
  assert.match(error.message, /DexScreener found no direct SOL pool\./);
  assert.match(error.message, /Wait a minute and try again\./);
  assert.equal(error.code, 'HUB_LOOKUP_INCOMPLETE');
  assert.equal(error.retryable, true);
  assert.deepEqual(error.failures.map((f) => [f.source, f.kind]), [['GeckoTerminal', 'rate-limited']]);
});

test('a timeout, a server error and an unreadable reply each get their own words', async () => {
  const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  const a = await resolveFlywheelHub(MINT, { ...quiet, fetchImpl: async (url) => { if (isDex(url)) throw timeout; return response({}, 404); } }).then(() => null, (e) => e);
  assert.match(a.message, /DexScreener did not answer in time/);
  assert.match(a.message, /Try again shortly\./);
  const b = await resolveFlywheelHub(MINT, { ...quiet, fetchImpl: async (url) => (isDex(url) ? { ok: false, status: 503, json: async () => ({}) } : response([])) }).then(() => null, (e) => e);
  assert.match(b.message, /DexScreener is having a problem/);
  const c = await resolveFlywheelHub(MINT, { ...quiet, fetchImpl: async (url) => (isDex(url) ? { ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } } : response({}, 404)) }).then(() => null, (e) => e);
  assert.match(c.message, /DexScreener sent a reply that could not be read/);
  const d = await resolveFlywheelHub(MINT, { ...quiet, fetchImpl: async () => { throw new TypeError('fetch failed'); } }).then(() => null, (e) => e);
  assert.match(d.message, /DexScreener could not be reached; GeckoTerminal could not be reached/);
  assert.equal(d.failures.length, 2);
});

test('both sources having no direct SOL pool is still the plain "pool required" answer, not "incomplete"', async () => {
  const error = await resolveFlywheelHub(MINT, { ...quiet, fetchImpl: async (url) => (isDex(url) ? response([]) : response({}, 404)) }).then(() => null, (e) => e);
  assert.match(error.message, /^A direct SOL pool is required/);
  assert.equal(error.code, 'HUB_NO_SOL_POOL');
});

test('a rate limit that clears on the first retry still resolves, and costs one extra request', async () => {
  let dexCalls = 0;
  const result = await resolveFlywheelHub(MINT, { ...quiet, fetchImpl: async (url) => {
    if (!isDex(url)) return response({}, 404);
    dexCalls += 1;
    return dexCalls === 1 ? limited('0') : response([dex()]);
  } });
  assert.equal(dexCalls, 2);
  assert.equal(result.solPool.address, POOL);
});

test('a long Retry-After is reported, not waited out, and each failure is logged without secrets', async () => {
  const lines = [];
  let dexCalls = 0;
  const error = await resolveFlywheelHub(MINT, { retryDelayMs: 0, log: (line) => lines.push(line), fetchImpl: async (url) => {
    if (isDex(url)) { dexCalls += 1; return limited('30'); }
    return response({}, 404);
  } }).then(() => null, (e) => e);
  assert.equal(dexCalls, 1, '30 seconds is too long to wait inside a click, so it does not retry');
  assert.match(error.message, /DexScreener is rate-limiting requests/);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^hub pool lookup: DexScreener failed \(rate-limited: HTTP 429\)$/);
});

test('a source that fails does not hide a pool the other source finds', async () => {
  const result = await resolveFlywheelHub(MINT, { ...quiet, fetchImpl: async (url) => { if (isDex(url)) throw new TypeError('fetch failed'); return response({ data: [gecko()] }); } });
  assert.equal(result.solPool.address, POOL);
  assert.equal(result.solPool.source, 'GeckoTerminal');
});
