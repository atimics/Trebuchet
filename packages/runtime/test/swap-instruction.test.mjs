import test from 'node:test';
import assert from 'node:assert/strict';
import { readSwapInstruction, assertSwapInstruction } from '../src/swap-instruction.js';
import { key, wallet, mint, source, destination, meta, intent, raydium, jupiter } from './fixtures/swap-instructions.mjs';

test('Raydium SDK trade bytes bind their amount and selected router network', () => {
  for (const network of ['mainnet', 'devnet']) {
    const decoded = assertSwapInstruction(raydium(network), { ...intent, network });
    assert.equal(decoded.provider, 'raydium'); assert.equal(decoded.inputAmountRaw, '50000'); assert.equal(decoded.minimumOutputRaw, '1234');
    assert.equal(decoded.sourceTokenAccount, source.toBase58()); assert.equal(decoded.destinationTokenAccount, destination.toBase58());
  }
});

for (const shared of [false, true]) {
  test(`Jupiter ${shared ? 'shared' : 'ordinary'} routes bind the input and slippage-adjusted output`, () => {
    const decoded = assertSwapInstruction(jupiter({ shared }), intent);
    assert.equal(decoded.provider, 'jupiter'); assert.equal(decoded.inputAmountRaw, '50000'); assert.equal(decoded.minimumOutputRaw, '1237');
    assert.equal(decoded.quotedOutputRaw, '1250'); assert.equal(decoded.slippageBps, 100); assert.equal(decoded.outputMint, mint.toBase58());
  });
}

for (const provider of ['raydium', 'jupiter']) {
  for (const field of ['walletPublicKey', 'sourceTokenAccount', 'destinationTokenAccount', 'inputAmountRaw', 'minimumOutputRaw']) {
    test(`${provider} rejects a trade that differs from approved ${field}`, () => {
      const value = ['inputAmountRaw', 'minimumOutputRaw'].includes(field) ? '50001' : key(63).toBase58();
      assert.throws(() => assertSwapInstruction(provider === 'raydium' ? raydium() : jupiter(), { ...intent, [field]: value }), { code: 'SWAP_INTENT_MISMATCH' });
    });
  }
}

test('Jupiter checks the actual output mint and every output destination', () => {
  for (const shared of [false, true]) {
    const ix = jupiter({ shared }); ix.keys[shared ? 8 : 5].pubkey = key(64);
    assert.throws(() => assertSwapInstruction(ix, intent), { code: 'SWAP_INTENT_MISMATCH' });
  }
  const ix = jupiter(); ix.keys[4].pubkey = key(65);
  assert.throws(() => assertSwapInstruction(ix, intent), { code: 'SWAP_INTENT_MISMATCH' });
});

test('trade programs and declared authority belong to the selected network and wallet', () => {
  assert.throws(() => readSwapInstruction(raydium(), { network: 'devnet' }), { code: 'SWAP_INTENT_MISMATCH' });
  assert.throws(() => readSwapInstruction(raydium('devnet'), { network: 'mainnet' }), { code: 'SWAP_INTENT_MISMATCH' });
  assert.throws(() => readSwapInstruction(jupiter(), { network: 'devnet' }), { code: 'SWAP_INTENT_MISMATCH' });
  const unknown = jupiter(); unknown.programId = key(66);
  assert.throws(() => assertSwapInstruction(unknown, intent), { code: 'SWAP_INTENT_MISMATCH' });
  const unsigned = raydium(); unsigned.keys[4].isSigner = false;
  assert.throws(() => assertSwapInstruction(unsigned, intent), { code: 'SWAP_INTENT_MISMATCH' });
  const extraSigner = jupiter(); extraSigner.keys.push(meta(key(67), false, true));
  assert.throws(() => assertSwapInstruction(extraSigner, intent), { code: 'SWAP_INTENT_MISMATCH' });
});

test('a route can pass the same wallet authority to an inner swap', () => {
  const ix = jupiter(); ix.keys.push(meta(wallet, false, true));
  assert.equal(assertSwapInstruction(ix, intent).authority, wallet.toBase58());
});

test('Jupiter reads variable route fields before the actual amount fields', () => {
  const data = Buffer.alloc(4); data.writeUInt32LE(1);
  const cases = [
    Buffer.from([8, 1, 100, 0, 1]),
    Buffer.concat([Buffer.from([29]), Buffer.alloc(16, 1), Buffer.from([100, 0, 1])]),
    Buffer.concat([Buffer.from([33]), Buffer.alloc(4, 1), Buffer.from([100, 0, 1])]),
    Buffer.from([42, 4, 1, 0, 100, 0, 1]),
    Buffer.concat([Buffer.from([43]), Buffer.alloc(10, 1), Buffer.from([100, 0, 1])]),
    Buffer.from([44, 1, 1, 0, 0, 0, 100, 0, 1]),
    Buffer.from([47, 1, 0, 100, 0, 1]),
    Buffer.concat([Buffer.from([47, 1, 1]), data, Buffer.from([0, 2, 100, 0, 1])]),
    Buffer.from([61, 0, 100, 0, 1]),
  ];
  for (const step of cases) for (const shared of [false, true]) assert.equal(assertSwapInstruction(jupiter({ shared, steps: [step] }), intent).inputAmountRaw, '50000');
});

test('malformed Jupiter routes preserve their amount boundary', () => {
  const cases = [
    Buffer.from([90, 100, 0, 1]), Buffer.from([8, 2, 100, 0, 1]), Buffer.from([42, 0, 2, 0, 100, 0, 1]),
    Buffer.from([47, 1, 2, 100, 0, 1]), Buffer.from([47, 1, 1, 65, 0, 0, 0, 100, 0, 1]),
    Buffer.from([7, 0, 0, 1]), Buffer.from([7, 101, 0, 1]), Buffer.from([7, 100, 0, 0]),
  ];
  for (const step of cases) assert.throws(() => assertSwapInstruction(jupiter({ steps: [step] }), intent), { code: 'SWAP_INTENT_MISMATCH' });
  assert.throws(() => assertSwapInstruction(jupiter({ steps: [] }), intent), { code: 'SWAP_INTENT_MISMATCH' });
  assert.throws(() => assertSwapInstruction(jupiter({ steps: Array(65).fill(Buffer.from([7, 100, 0, 1])) }), intent), { code: 'SWAP_INTENT_MISMATCH' });
});

test('appended approved-looking amounts cannot hide a different Jupiter trade', () => {
  const ix = jupiter({ amount: 90000n, slippage: 5000 });
  ix.data = Buffer.concat([ix.data, jupiter().data.subarray(-19)]);
  assert.throws(() => assertSwapInstruction(ix, intent), { code: 'SWAP_INTENT_MISMATCH' });
});

test('truncated instructions and changed Raydium headers stop before signing', () => {
  for (const make of [raydium, jupiter]) {
    const original = make();
    for (let size = 0; size < original.data.length; size++) {
      const ix = make(); ix.data = ix.data.subarray(0, size);
      assert.throws(() => assertSwapInstruction(ix, intent));
    }
  }
  const ix = raydium(); ix.data[0] = 1;
  assert.throws(() => assertSwapInstruction(ix, intent), { code: 'SWAP_INTENT_MISMATCH' });
  const changedProgram = raydium(); changedProgram.keys[0].pubkey = key(68);
  assert.throws(() => assertSwapInstruction(changedProgram, intent), { code: 'SWAP_INTENT_MISMATCH' });
});

test('fees, slippage, and zero-output trades remain within the approved bounds', () => {
  for (const opts of [{ fee: 1 }, { slippage: 101 }, { slippage: 10001 }, { output: 0n }, { amount: 0n }]) {
    assert.throws(() => assertSwapInstruction(jupiter(opts), intent), { code: 'SWAP_INTENT_MISMATCH' });
  }
  assert.throws(() => assertSwapInstruction(jupiter(), { ...intent, minimumOutputRaw: '0' }), { code: 'SWAP_INTENT_MISMATCH' });
});

test('all 90 pinned Jupiter swap variants retain the actual trade amount boundary', async () => {
  const { readFile } = await import('node:fs/promises');
  const fixture = JSON.parse(await readFile(new URL('./fixtures/jupiter-v6-steps.json', import.meta.url), 'utf8'));
  assert.equal(fixture.steps.length, 90);
  for (const { name, wire } of fixture.steps) for (const shared of [false, true]) {
    const decoded = assertSwapInstruction(jupiter({ shared, steps: [Buffer.from(wire, 'hex')] }), intent);
    assert.equal(decoded.inputAmountRaw, '50000', name);
    assert.equal(decoded.minimumOutputRaw, '1237', name);
  }
});

test('newer Jupiter payloads require complete fields and canonical flags', () => {
  for (const step of [
    [64, 2, 100, 0, 1], [75, 65, 0, 0, 0, 100, 0, 1],
    [75, 1, 0, 0, 0, 9, 2, 100, 0, 1], [85, 2, 100, 0, 1], [86, 2, 0, 100, 0, 1],
    [87, 0, 0, 0, 0, 0, 0, 0, 0, 2, 100, 0, 1], [89, 2, 100, 0, 1],
  ]) assert.throws(() => assertSwapInstruction(jupiter({ steps: [Buffer.from(step)] }), intent), { code: 'SWAP_INTENT_MISMATCH' });
  const valid = jupiter({ steps: [Buffer.from([72, 100, 0, 1])] });
  valid.data[0] ^= 1;
  assert.throws(() => assertSwapInstruction(valid, intent), { code: 'SWAP_INTENT_MISMATCH' });
});

test('Jupiter pins its complete event, program, and optional fee accounts', () => {
  for (const shared of [false, true]) {
    for (const at of shared ? [9, 10, 11, 12] : [6, 7, 8]) {
      const ix = jupiter({ shared }); ix.keys[at].pubkey = key(70);
      assert.throws(() => assertSwapInstruction(ix, intent), { code: 'SWAP_INTENT_MISMATCH' });
    }
    const ix = jupiter({ shared }); ix.keys.pop();
    assert.throws(() => assertSwapInstruction(ix, intent), { code: 'SWAP_INTENT_MISMATCH' });
  }
});
