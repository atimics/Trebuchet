import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { geckoFetch } from '../tokenInfoService.js';

const read = (name) => fs.readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

test('GeckoTerminal requests wait their turn: one every 2.1 s, never a burst', async () => {
  let clock = 1_000_000;
  const sent = [];
  const options = { now: () => clock, wait: async (ms) => { clock += ms; }, fetchImpl: async (url) => { sent.push([url, clock]); return { ok: true }; } };
  await Promise.all(['a', 'b', 'c'].map((url) => geckoFetch(url, {}, options)));
  assert.deepEqual(sent.map(([url]) => url), ['a', 'b', 'c'], 'in order');
  assert.ok(sent[1][1] - sent[0][1] >= 2100 && sent[2][1] - sent[1][1] >= 2100, JSON.stringify(sent));
});

test('small tokens\' display prices are kept five minutes; SOL and the stablecoins one', () => {
  const source = read('tokenInfoService.js');
  assert.match(source, /const TOKEN_PRICE_TTL_MS = 5 \* 60 \* 1000;/);
  assert.match(source, /priceExpiresAt: Date\.now\(\) \+ \(FAST_PRICE_MINTS\.has\(mint\) \? PRICE_TTL_MS : TOKEN_PRICE_TTL_MS\)/);
  assert.equal((source.match(/await fetch\(`\$\{GECKO_BASE\}/g) || []).length, 0, 'every Gecko request goes through the queue');
});

test('pair tokens are checked when the coin being created is on screen, not at startup', () => {
  assert.match(read('public/v2/features/shell/connection.js'), /if \(state\.activeView === 'launch' && !chainCoinOnPage\(\)\) autoVerifyQuoteTokens\(\);/);
  assert.match(read('public/v2/features/launch/workspace.js'), /if \(view === 'launch' && !chainCoinOnPage\(\)\) autoVerifyQuoteTokens\(\);/);
});
