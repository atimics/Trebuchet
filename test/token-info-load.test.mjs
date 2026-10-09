import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { geckoFetch, getGeckoTokenPrices } from '../tokenInfoService.js';

const read = (name) => fs.readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

test('GeckoTerminal requests wait their turn: one every 6.1 s, never a burst', async () => {
  let clock = 1_000_000;
  const sent = [];
  const options = { now: () => clock, wait: async (ms) => { clock += ms; }, fetchImpl: async (url) => { sent.push([url, clock]); return { ok: true }; } };
  await Promise.all(['a', 'b', 'c'].map((url) => geckoFetch(url, {}, options)));
  assert.deepEqual(sent.map(([url]) => url), ['a', 'b', 'c'], 'in order');
  assert.ok(sent[1][1] - sent[0][1] >= 6100 && sent[2][1] - sent[1][1] >= 6100, JSON.stringify(sent));
});

test('small tokens\' display prices are kept five minutes; SOL and the stablecoins one', () => {
  const source = read('tokenInfoService.js');
  assert.match(source, /const TOKEN_PRICE_TTL_MS = 5 \* 60 \* 1000;/);
  assert.match(source, /priceExpiresAt: Date\.now\(\) \+ \(FAST_PRICE_MINTS\.has\(mint\) \? PRICE_TTL_MS : TOKEN_PRICE_TTL_MS\)/);
  assert.equal((source.match(/await fetch\(`\$\{GECKO_BASE\}/g) || []).length, 0, 'every Gecko request goes through the queue');
});

test('opening a launch draft checks its pair tokens', () => {
  assert.match(read('public/v2/features/launch/workspace.js'), /if \(view === 'launch' && !chainCoinOnPage\(\)\) autoVerifyQuoteTokens\(\);/);
});

test('GeckoTerminal batches mints, shares pending reads, and retries fresh on the next poll', async (t) => {
  let clock = Date.now() + 1_000_000; t.mock.method(Date, 'now', () => clock += 31_000);
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requests.push(url);
    return { ok: true, json: async () => ({
      data: ['BatchMintA', 'BatchMintB', 'OutsideMint'].map((address) => ({ attributes: { address, price_usd: address === 'BatchMintA' ? '0.01' : '-1' },
        relationships: { top_pools: { data: [{ id: 'solana_pool' }] } } })),
      included: [{ id: 'solana_pool', attributes: { base_token_price_usd: '0.02', quote_token_price_usd: '110', reserve_in_usd: '10000' },
        relationships: { base_token: { data: { id: 'solana_BatchMintA' } }, quote_token: { data: { id: 'solana_SolMint' } } } }],
    }) };
  });
  const [a, b] = await Promise.all([getGeckoTokenPrices(['BatchMintA', 'BatchMintB', 'BatchMintA']), getGeckoTokenPrices(['BatchMintB', 'BatchMintA'])]);
  assert.equal(requests.length, 1); assert.equal(a, b);
  assert.match(requests[0], /tokens\/multi\/BatchMintA,BatchMintB\?include=top_pools$/);
  assert.equal(a.get('BatchMintA').toString(), '0.02'); assert.equal(a.has('BatchMintB'), false); assert.equal(a.has('OutsideMint'), false);
  assert.equal(a.get('BatchMintA').liquidityUsd.toString(), '10000');
  await getGeckoTokenPrices(['BatchMintA', 'BatchMintB'], { forceFresh: true });
  assert.equal(requests.length, 2);
});
