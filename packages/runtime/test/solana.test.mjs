import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, SendTransactionError, SystemProgram, Transaction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { createSolanaChain, createSolanaSigner, inspectSolanaTransaction } from '../src/solana.js';

const payer = Keypair.fromSeed(new Uint8Array(32).fill(4));
const recipient = Keypair.fromSeed(new Uint8Array(32).fill(5));
const blockhash = recipient.publicKey.toBase58();
async function signed(version = 'legacy') {
  const instruction = SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: recipient.publicKey, lamports: 4 });
  const transaction = version === 'legacy'
    ? new Transaction({ feePayer: payer.publicKey, recentBlockhash: blockhash }).add(instruction)
    : new VersionedTransaction(new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: [instruction] }).compileToV0Message());
  const wire = await createSolanaSigner({ getSigners: async () => [payer] }).signTransaction({ transaction });
  return { ...inspectSolanaTransaction(wire), lastValidBlockHeight: 100 };
}
function adapter(overrides = {}) {
  const connection = {
    getGenesisHash: async () => 'local-genesis',
    getSignatureStatuses: async (_signatures, options) => { assert.equal(options.searchTransactionHistory, true); return { context: { slot: 120 }, value: [null] }; },
    getBlockHeight: async (commitment) => { assert.equal(commitment, 'finalized'); return 80; },
    isBlockhashValid: async (_hash, options) => { assert.equal(options.commitment, 'finalized'); return { context: { slot: 120 }, value: false }; },
    ...overrides,
  };
  return createSolanaChain({ connection, network: 'localnet', expectedGenesisHash: 'local-genesis' });
}
const status = (confirmationStatus, err = null) => ({ slot: 42, confirmationStatus, err, confirmations: confirmationStatus === 'finalized' ? null : 1 });

test('signer and byte inspection verify both legacy and v0 Solana transactions', async () => {
  for (const version of ['legacy', 0]) {
    const tx = await signed(version);
    assert.equal(tx.walletPublicKey, payer.publicKey.toBase58());
    assert.equal(tx.blockhash, blockhash);
    assert.deepEqual(inspectSolanaTransaction(tx.wire), { signature: tx.signature, wire: tx.wire, blockhash, walletPublicKey: payer.publicKey.toBase58() });
    const bytes = Buffer.from(tx.wire, 'base64');
    bytes[bytes.length - 1] ^= 1;
    assert.throws(() => inspectSolanaTransaction(bytes), { code: 'TRANSACTION_INVALID' });
    assert.throws(() => inspectSolanaTransaction(tx.wire + '\n'), { code: 'TRANSACTION_INVALID' });
    assert.throws(() => inspectSolanaTransaction(Buffer.concat([Buffer.from(tx.wire, 'base64'), Buffer.from([0])])), { code: 'TRANSACTION_INVALID' });
  }
});

test('every required signer must supply a valid signature', async () => {
  const transaction = new Transaction({ feePayer: payer.publicKey, recentBlockhash: blockhash }).add(SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: recipient.publicKey, lamports: 1, space: 0, programId: SystemProgram.programId }));
  const partial = await createSolanaSigner({ getSigners: async () => [payer] }).signTransaction({ transaction });
  assert.throws(() => inspectSolanaTransaction(partial), { code: 'TRANSACTION_INVALID' });
  const complete = await createSolanaSigner({ getSigners: async () => [payer, recipient] }).signTransaction({ transaction });
  assert.equal(inspectSolanaTransaction(complete).walletPublicKey, payer.publicKey.toBase58());
});

test('byte inspection enforces size and recent blockhash transaction rules', async () => {
  assert.throws(() => inspectSolanaTransaction(new Uint8Array(1233)), { code: 'TRANSACTION_INVALID' });
  const transaction = new Transaction({ feePayer: payer.publicKey, recentBlockhash: blockhash }).add(SystemProgram.nonceAdvance({ noncePubkey: recipient.publicKey, authorizedPubkey: payer.publicKey }));
  const bytes = await createSolanaSigner({ getSigners: async () => [payer] }).signTransaction({ transaction });
  assert.throws(() => inspectSolanaTransaction(bytes), { code: 'TRANSACTION_INVALID' });
});

test('only finalized status produces a terminal transaction result', async () => {
  const tx = await signed();
  for (const [commitment, error, expected] of [
    ['processed', null, 'pending'], ['confirmed', null, 'pending'], ['confirmed', { InstructionError: [0, 'Custom'] }, 'pending'],
    ['finalized', null, 'confirmed'], ['finalized', { InstructionError: [0, 'Custom'] }, 'failed'],
  ]) {
    const chain = adapter({ getSignatureStatuses: async () => ({ context: { slot: 50 }, value: [status(commitment, error)] }) });
    assert.equal((await chain.readTransaction(tx)).state, expected);
  }
});

test('missing status within the valid window permits rebroadcast of the same bytes', async () => {
  const tx = await signed();
  assert.equal((await adapter().readTransaction(tx)).state, 'rebroadcast');
});

test('expiry requires finalized height, invalid blockhash, and another history lookup', async () => {
  const tx = await signed();
  let reads = 0;
  const chain = adapter({
    getBlockHeight: async () => 101,
    getSignatureStatuses: async (_signatures, options) => { reads++; assert.equal(options.searchTransactionHistory, true); return { context: { slot: 120 }, value: [null] }; },
  });
  assert.equal((await chain.readTransaction(tx)).state, 'expired');
  assert.equal(reads, 2);
  const valid = adapter({ getBlockHeight: async () => 101, isBlockhashValid: async () => ({ context: { slot: 120 }, value: true }) });
  assert.equal((await valid.readTransaction(tx)).state, 'rebroadcast');
});

test('a late receipt wins over expiry and prevents replacement signing', async () => {
  const tx = await signed();
  let reads = 0;
  const chain = adapter({
    getBlockHeight: async () => 101,
    getSignatureStatuses: async () => ({ context: { slot: 120 }, value: [++reads === 1 ? null : status('finalized')] }),
  });
  assert.equal((await chain.readTransaction(tx)).state, 'confirmed');
  assert.equal(reads, 2);
});

test('incomplete or stale history responses leave recovery pending', async () => {
  const tx = await signed();
  for (const value of [undefined, [], [undefined], [null, null], [{ slot: 1, err: null }]]) {
    await assert.rejects(adapter({ getSignatureStatuses: async () => ({ context: { slot: 120 }, value }) }).readTransaction(tx), { code: 'CHAIN_STATE_UNAVAILABLE' });
  }
  let reads = 0;
  const stale = adapter({ getBlockHeight: async () => 101, getSignatureStatuses: async () => ({ context: { slot: ++reads === 1 ? 120 : 119 }, value: [null] }) });
  await assert.rejects(stale.readTransaction(tx), { code: 'CHAIN_STATE_UNAVAILABLE' });
  await assert.rejects(adapter({ getSignatureStatuses: async () => { throw new Error('RPC timeout'); } }).readTransaction(tx), /RPC timeout/);
});

test('RPC identity and saved transaction identity are checked before a send', async () => {
  const tx = await signed();
  let sends = 0;
  const sendRawTransaction = async (bytes, options) => {
    sends++;
    assert.equal(Buffer.from(bytes).toString('base64'), tx.wire);
    assert.equal(options.maxRetries, 0);
    assert.equal(options.skipPreflight, false);
    return tx.signature;
  };
  const wrongChain = adapter({ getGenesisHash: async () => 'another-chain', sendRawTransaction });
  await assert.rejects(wrongChain.sendTransaction(tx), { code: 'NETWORK_MISMATCH' });
  await assert.rejects(wrongChain.readTransaction(tx), { code: 'NETWORK_MISMATCH' });
  const chain = adapter({ sendRawTransaction });
  await assert.rejects(chain.sendTransaction({ ...tx, signature: 'changed' }), { code: 'TRANSACTION_INVALID' });
  assert.equal(sends, 0);
  assert.equal(await chain.sendTransaction(tx), tx.signature);
  assert.equal(sends, 1);
});


test('duplicate preflight replies keep the saved signature pending until finalized status', async () => {
  const tx = await signed();
  let confirmation = null, sends = 0;
  const chain = adapter({
    getSignatureStatuses: async () => ({ context: { slot: 120 }, value: [confirmation] }),
    sendRawTransaction: async (bytes) => {
      sends++; assert.equal(Buffer.from(bytes).toString('base64'), tx.wire);
      throw new SendTransactionError({ action: 'simulate', signature: '', transactionMessage: 'Transaction simulation failed: This transaction has already been processed', logs: [] });
    },
  });
  assert.equal(await chain.sendTransaction(tx), tx.signature);
  assert.equal((await chain.readTransaction(tx)).state, 'rebroadcast');
  confirmation = status('confirmed'); assert.equal((await chain.readTransaction(tx)).state, 'pending');
  confirmation = status('finalized'); assert.equal((await chain.readTransaction(tx)).state, 'confirmed');
  confirmation = status('finalized', { InstructionError: [0, 'Custom'] }); assert.equal((await chain.readTransaction(tx)).state, 'failed');
  assert.equal(sends, 1);
});

for (const error of [new Error('This transaction has already been processed'),
  new SendTransactionError({ action: 'simulate', signature: '', transactionMessage: 'Transaction simulation failed: Blockhash not found', logs: [] }),
  new SendTransactionError({ action: 'simulate', signature: '', transactionMessage: 'Transaction simulation failed: Error processing Instruction 0: custom program error: 0x1', logs: [] })]) {
  test(`submission preserves other errors: ${error.transactionError?.message || error.message}`, async () => {
    const tx = await signed(), chain = adapter({ sendRawTransaction: async () => { throw error; } });
    await assert.rejects(chain.sendTransaction(tx), (actual) => actual === error);
  });
}

test('a finalized blockhash check waits for finality to reach the status slot instead of failing', async () => {
  const tx = await signed();
  let checks = 0;
  const chain = adapter({
    getBlockHeight: async () => 101,
    isBlockhashValid: async (_hash, options) => {
      assert.equal(options.minContextSlot, 120);
      if (++checks < 3) throw Object.assign(new Error('failed to determine if the blockhash is valid: Minimum context slot has not been reached'), { code: -32016 });
      return { context: { slot: 120 }, value: false };
    },
  });
  assert.equal((await chain.readTransaction(tx)).state, 'expired');
  assert.equal(checks, 3);
  const broken = adapter({ getBlockHeight: async () => 101, isBlockhashValid: async () => { throw Object.assign(new Error('rpc down'), { code: -32000 }); } });
  await assert.rejects(broken.readTransaction(tx), /rpc down/);
});
