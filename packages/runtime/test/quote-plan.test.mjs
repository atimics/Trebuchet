import test from 'node:test';
import assert from 'node:assert/strict';
import { createQuotePlanBuilder, normalizeQuoteRequest } from '../src/quote-plan.js';
import { createQuoteProvider } from '../src/quote-provider.js';
import { quoteAcquisitionChain } from './fixtures/quote-acquisition-chain.mjs';
import { wallet, swapTransactions } from './fixtures/swap-chain.mjs';
import { NATIVE_MINT } from '@solana/spl-token';
import { SOLANA_GENESIS_HASHES } from '../src/solana.js';

function fixture() {
  const chain = quoteAcquisitionChain(), calls = [];
  const input = { walletPublicKey: wallet.toBase58(), autoSwapPlan: chain.purchases.map((purchase, allocationIndex) => ({ allocationIndex,
    quoteMint: purchase.intent.outputMint, quoteDecimals: 6, quoteSymbol: `Q${allocationIndex}`, targetRaw: '1250', minRaw: '1000', maxInputLamports: '50000', routeProvider: 'raydium' })) };
  const provider = {
    async quote(request) {
      calls.push({ kind: 'quote', ...request });
      const data = { inputMint: request.inputMint, outputMint: request.outputMint, inputAmount: request.inputAmountRaw, outputAmount: '1250',
        otherAmountThreshold: '1234', slippageBps: request.slippageBps, routePlan: [{ inputMint: request.inputMint, outputMint: request.outputMint }] };
      return request.provider === 'raydium' ? { success: true, data } : { ...data, inAmount: data.inputAmount, outAmount: data.outputAmount,
        routePlan: data.routePlan.map((swapInfo) => ({ swapInfo, percent: 100 })) };
    },
    async transactions(request) {
      calls.push({ kind: 'transactions', ...request });
      const mint = request.quote.data?.outputMint || request.quote.outputMint;
      const transactions = request.provider === 'jupiter' ? swapTransactions(true) : chain.purchases.find((item) => item.intent.outputMint === mint).transactions;
      return transactions.map((transaction) => Buffer.from(transaction.serialize()).toString('base64'));
    },
  };
  const options = { connection: chain.connection, network: 'mainnet', expectedGenesisHash: SOLANA_GENESIS_HASHES.mainnet, provider };
  return { ...chain, calls, input, provider, options, build: () => createQuotePlanBuilder(options).build(input) };
}

test('live purchase plans bind both quote mints, full bundles, exact input, fees, and rent', async () => {
  const f = fixture(), result = await f.build();
  assert.equal(result.purchases.length, 2); assert.equal(result.rows.length, 2);
  for (const purchase of result.purchases) {
    assert.equal(purchase.intent.inputAmountRaw, '50000'); assert.equal(purchase.intent.minimumOutputRaw, '1234');
    assert.equal(purchase.intent.rentCeilingLamports, 4078560); assert.equal(purchase.feeCeilingLamports, 10000);
  }
  assert.ok(result.rows.every((row) => row.state === 'purchase' && row.alreadyHadRaw === '0'));
  assert.ok(f.ledgers.every((ledger) => ledger.state.sends.length === 0));
});

test('held balances produce a saved observation and skip provider requests', async () => {
  const f = fixture(); for (const ledger of f.ledgers) ledger.state.destination = { lamports: ledger.rent(165), amount: 1100n };
  const result = await f.build(); assert.deepEqual(result.purchases, []); assert.equal(f.calls.length, 0);
  assert.ok(result.rows.every((row) => row.state === 'held' && row.alreadyHadRaw === '1100' && row.observedSlot === 200));
});

test('allocation rows for the same mint share one cumulative target and budget', () => {
  const f = fixture(), row = f.input.autoSwapPlan[0];
  const result = normalizeQuoteRequest([row, { ...row, allocationIndex: 4 }]);
  assert.equal(result.length, 1); assert.equal(result[0].targetRaw, '2500'); assert.equal(result[0].minRaw, '2000');
  assert.equal(result[0].maxInputLamports, 100000); assert.deepEqual(result[0].allocationIndices, [0, 4]);
  assert.throws(() => normalizeQuoteRequest([row, row]), /distinct allocations/);
});

for (const [field, value] of [['targetRaw', '-1'], ['targetRaw', '100'], ['minRaw', '0'], ['minRaw', '18446744073709551616'],
  ['quoteDecimals', 20], ['maxInputLamports', '1'], ['maxInputLamports', '9007199254740992'], ['allocationIndex', 0.5], ['quoteMint', NATIVE_MINT.toBase58()], ['quoteSymbol', 'x'.repeat(33)]]) {
  test(`quote plan rejects invalid ${field} ${value}`, () => {
    const f = fixture(), row = { ...f.input.autoSwapPlan[0], [field]: value };
    assert.throws(() => normalizeQuoteRequest([row])); assert.equal(f.calls.length, 0);
  });
}

test('a changed genesis hash stops quote building before provider access', async () => {
  const f = fixture(); f.connection.getGenesisHash = async () => SOLANA_GENESIS_HASHES.devnet;
  await assert.rejects(f.build(), { code: 'NETWORK_MISMATCH' }); assert.equal(f.calls.length, 0);
});

for (const changed of ['missing balance', 'wrong decimals', 'frozen', 'owner']) {
  test(`quote plan preserves uncertainty from ${changed}`, async () => {
    const f = fixture();
    if (changed === 'missing balance') f.connection.getMultipleAccountsInfoAndContext = async () => ({ context: { slot: 200 }, value: [] });
    if (changed === 'wrong decimals') f.input.autoSwapPlan[0].quoteDecimals = 9;
    if (changed === 'frozen' || changed === 'owner') for (const ledger of f.ledgers) ledger.state.destination = { lamports: ledger.rent(165), amount: 1n,
      ...(changed === 'frozen' ? { frozen: true } : { owner: NATIVE_MINT }) };
    await assert.rejects(f.build()); assert.equal(f.calls.length, 0);
  });
}

for (const field of ['inputMint', 'outputMint', 'inputAmount', 'otherAmountThreshold', 'slippageBps']) {
  test(`provider quote binds ${field}`, async () => {
    const f = fixture(), quote = f.provider.quote;
    f.provider.quote = async (input) => { const result = await quote(input); const data = result.data || result;
      data[field === 'inputAmount' && !result.data ? 'inAmount' : field] = field === 'slippageBps' ? 1000 : field === 'otherAmountThreshold' ? '10' : 'changed'; return result; };
    await assert.rejects(f.build()); assert.equal(f.calls.filter((call) => call.kind === 'transactions').length, 0);
  });
}

test('provider route failure can fall back to a reviewed unsigned Jupiter bundle', async () => {
  const f = fixture(), quote = f.provider.quote; f.input.autoSwapPlan = [f.input.autoSwapPlan[0]];
  f.provider.quote = async (input) => { if (input.provider === 'raydium') throw Object.assign(new Error('route unavailable'), { code: 'QUOTE_UNAVAILABLE' }); return quote(input); };
  const result = await f.build(); assert.equal(result.rows[0].routeProvider, 'jupiter'); assert.equal(result.purchases.length, 1);
  assert.ok(f.ledgers.every((ledger) => ledger.state.sends.length === 0));
});

test('RPC failures during bundle review stop before another provider is tried', async () => {
  const f = fixture(); f.connection.getFeeForMessage = async () => { throw new Error('RPC unavailable'); };
  await assert.rejects(f.build(), /RPC unavailable/);
  assert.equal(f.calls.filter((call) => call.kind === 'quote').length, 1);
});

test('provider transport uses fixed public endpoints and bounded unsigned results', async () => {
  const wire = Buffer.from(swapTransactions(true)[0].serialize()).toString('base64'), calls = [];
  const api = createQuoteProvider({ fetchImpl: async (url, options) => {
    calls.push({ url: String(url), ...options });
    return new Response(JSON.stringify(options.method === 'POST' ? { success: true, data: [{ transaction: wire }] } : { success: true, data: {} }));
  } });
  const quote = await api.quote({ provider: 'raydium', inputMint: 'input', outputMint: 'output', inputAmountRaw: '50000', slippageBps: 100 });
  assert.deepEqual(await api.transactions({ provider: 'raydium', quote, walletPublicKey: wallet.toBase58(), priorityFeeMicroLamports: 50000 }), [wire]);
  assert.equal(calls[0].url.startsWith('https://transaction-v1.raydium.io/compute/swap-base-in?'), true);
  assert.equal(calls[1].redirect, 'error'); assert.equal(JSON.parse(calls[1].body).wallet, wallet.toBase58());
  assert.equal(JSON.parse(calls[1].body).wrapSol, true);
});

for (const reply of [new Response('x'.repeat(50)), new Response('{bad'), new Response('{}', { status: 503 })]) {
  test(`provider transport rejects unusable response ${reply.status} ${reply.headers.get('content-type')}`, async () => {
    const api = createQuoteProvider({ maxResponseBytes: 40, fetchImpl: async () => reply });
    await assert.rejects(api.quote({ provider: 'raydium' }), { code: 'QUOTE_UNAVAILABLE' });
  });
}


test('Jupiter uses the current quote endpoint and sends its key only to Jupiter', async () => {
  const calls = [];
  const api = createQuoteProvider({ jupiterApiKey: 'fixture-key', fetchImpl: async (url, options) => {
    calls.push({ url: String(url), headers: options.headers });
    return new Response(JSON.stringify(String(url).includes('api.jup.ag') ? { routePlan: [{ swapInfo: { label: 'PumpSwap' } }] } : { success: true }));
  } });
  await api.quote({ provider: 'jupiter', inputMint: 'SOL', outputMint: 'TOKEN', inputAmountRaw: '50000', slippageBps: 100 });
  await api.quote({ provider: 'raydium', inputMint: 'SOL', outputMint: 'TOKEN', inputAmountRaw: '50000', slippageBps: 100 });
  assert.ok(calls[0].url.startsWith('https://api.jup.ag/swap/v1/quote?'));
  assert.equal(calls[0].headers['x-api-key'], 'fixture-key');
  assert.equal(calls[1].headers['x-api-key'], undefined);
});


test('unsigned quote requests retry a busy provider with bounded backoff', async () => {
  let calls = 0; const delays = [];
  const api = createQuoteProvider({ sleep: async (ms) => delays.push(ms), fetchImpl: async () => {
    calls++;
    return calls < 3 ? new Response('{}', { status: calls === 1 ? 429 : 503 })
      : new Response(JSON.stringify({ routePlan: [{ swapInfo: { label: 'PumpSwap' } }] }));
  } });
  const quote = await api.quote({ provider: 'jupiter' });
  assert.equal(quote.routePlan[0].swapInfo.label, 'PumpSwap');
  assert.equal(calls, 3); assert.deepEqual(delays, [2000, 4000]);
});
