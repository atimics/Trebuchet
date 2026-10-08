import test from 'node:test';
import assert from 'node:assert/strict';
import { minContextSlotRetryFetch } from '../rpcConnection.js';

const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('an RPC reply of "minimum context slot not reached" is retried until the node catches up', async () => {
  let calls = 0;
  const fetch = minContextSlotRetryFetch({ sleep: async () => {}, fetchImpl: async () => (++calls < 3
    ? reply({ jsonrpc: '2.0', id: 1, error: { code: -32016, message: 'Minimum context slot has not been reached' } })
    : reply({ jsonrpc: '2.0', id: 1, result: { context: { slot: 9 }, value: [] } })) });
  const body = await (await fetch('http://rpc', { method: 'POST' })).json();
  assert.equal(calls, 3);
  assert.equal(body.result.context.slot, 9);
});

test('other RPC errors and HTTP failures are returned at once', async () => {
  let calls = 0;
  const other = minContextSlotRetryFetch({ sleep: async () => {}, fetchImpl: async () => { calls++; return reply({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'down' } }); } });
  assert.equal((await (await other('http://rpc')).json()).error.code, -32000);
  assert.equal(calls, 1);
  const http = minContextSlotRetryFetch({ sleep: async () => {}, fetchImpl: async () => reply({}, 429) });
  assert.equal((await http('http://rpc')).status, 429);
});

test('a batch with one not-reached reply is retried; retries stop at the limit', async () => {
  let calls = 0;
  const fetch = minContextSlotRetryFetch({ attempts: 4, sleep: async () => {}, fetchImpl: async () => { calls++; return reply([{ id: 1, result: 1 }, { id: 2, error: { code: -32016, message: 'x' } }]); } });
  const body = await (await fetch('http://rpc')).json();
  assert.equal(calls, 4);
  assert.equal(body[1].error.code, -32016);
});
