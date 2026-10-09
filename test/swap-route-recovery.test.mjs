import test from 'node:test';
import assert from 'node:assert/strict';
import Decimal from 'decimal.js';
import { discoverJupiterRoute } from '../swapService.js';
const options = { quoteMint: 'fixture-token', quoteDecimals: 6, solUsd: new Decimal(100), forceFresh: true };

test('Jupiter service outages stay distinct from an absent route', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 429 }));
  await assert.rejects(discoverJupiterRoute(options), (error) => /HTTP 429/.test(error.message) && !/no route/.test(error.message));
  globalThis.fetch = async () => new Response(JSON.stringify({ errorCode: 'COULD_NOT_FIND_ANY_ROUTE' }), { status: 400 });
  assert.equal(await discoverJupiterRoute(options), null);
});

test('a route can recover after a miss, and successful routes expire', async (t) => {
  let calls = 0, now = 100000;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return calls === 1 ? new Response(JSON.stringify({ errorCode: 'COULD_NOT_FIND_ANY_ROUTE' }), { status: 400 })
      : new Response(JSON.stringify({ inAmount: '1000000', outAmount: '1000000', routePlan: [{ swapInfo: { label: 'PumpSwap' } }] }));
  });
  const input = { ...options, quoteMint: 'cache-fixture', forceFresh: false };
  assert.equal(await discoverJupiterRoute(input), null);
  assert.deepEqual((await discoverJupiterRoute(input)).venues, ['PumpSwap']);
  await discoverJupiterRoute(input); assert.equal(calls, 2);
  now += 60001; await discoverJupiterRoute(input); assert.equal(calls, 3);
});
