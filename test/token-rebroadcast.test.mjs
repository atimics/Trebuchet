import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, SystemProgram, Transaction } from '@solana/web3.js';
import { inspectSolanaTransaction } from '@trebuchet/runtime/solana';
import { sendPriorityTransaction, settleSignedTransaction, PRIORITY_FEE_CEIL_MICROLAMPORTS } from '../priorityFees.js';
import { createSplitSecret } from '@trebuchet/core/split-key';
import { scalarMintSigner, signWithScalarMint } from '../tokenService.js';

const payer = Keypair.fromSeed(new Uint8Array(32).fill(31));
const recipient = Keypair.fromSeed(new Uint8Array(32).fill(32)).publicKey;
const instructions = [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: recipient, lamports: 1 })];
const finalized = { slot: 10, err: null, confirmationStatus: 'finalized' };

function fixture() {
  const state = { sends: [], hashes: 0, height: 50, slot: 20, statuses: new Map(), reads: 0, ticks: 0, expiryChecks: 0 };
  const connection = {
    getRecentPrioritizationFees: async () => [],
    getLatestBlockhash: async () => ({ blockhash: Keypair.fromSeed(new Uint8Array(32).fill(++state.hashes)).publicKey.toBase58(), lastValidBlockHeight: state.height + 100 }),
    getSignatureStatuses: async ([signature]) => { state.reads++; return { context: { slot: state.slot }, value: [state.statuses.get(signature) || null] }; },
    getBlockHeight: async () => state.height,
    isBlockhashValid: async () => { state.expiryChecks++; return { context: { slot: state.slot }, value: false }; },
    sendRawTransaction: async (bytes, options) => {
      const record = inspectSolanaTransaction(bytes);
      state.sends.push({ ...record, bytes: Buffer.from(bytes), options });
      return record.signature;
    },
  };
  const options = { connection, payer, instructions, pollIntervalMs: 1, timeoutMs: 10,
    now: () => state.ticks, sleep: async () => { state.ticks++; } };
  return { state, connection, options };
}

test('a dropped send rebroadcasts identical signed bytes until finalized', async () => {
  const { state, connection, options } = fixture();
  const send = connection.sendRawTransaction;
  connection.sendRawTransaction = async (...args) => {
    const signature = await send(...args);
    if (state.sends.length === 3) state.statuses.set(signature, finalized);
    return signature;
  };
  const result = await sendPriorityTransaction(options);
  assert.equal(state.hashes, 1);
  assert.equal(state.sends.length, 3);
  assert.equal(result.signature, state.sends[0].signature);
  for (const sent of state.sends) {
    assert.ok(sent.bytes.equals(state.sends[0].bytes));
    assert.deepEqual(sent.options, { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 0 });
  }
});

test('chain acceptance followed by a lost RPC reply adopts the original signature', async () => {
  const { state, connection, options } = fixture();
  const send = connection.sendRawTransaction;
  connection.sendRawTransaction = async (...args) => {
    const signature = await send(...args);
    state.statuses.set(signature, finalized);
    throw new Error('fetch failed after acceptance');
  };
  const result = await sendPriorityTransaction(options);
  assert.equal(result.signature, state.sends[0].signature);
  assert.equal(state.hashes, 1);
  assert.equal(state.sends.length, 1);
});

test('a replacement uses a fresh blockhash and higher bounded fee after expiry proof', async () => {
  const { state, connection, options } = fixture();
  const send = connection.sendRawTransaction;
  let expirySaved = false;
  connection.sendRawTransaction = async (...args) => {
    const signature = await send(...args);
    if (state.sends.length === 1) state.height = 151;
    else state.statuses.set(signature, finalized);
    return signature;
  };
  const signed = [];
  await sendPriorityTransaction({ ...options,
    onSigned: (record) => { if (signed.length) assert.equal(expirySaved, true); signed.push(record); },
    onSettled: (record) => { if (record.state === 'expired') expirySaved = true; },
  });
  assert.equal(signed.length, 2);
  assert.equal(state.expiryChecks, 1);
  assert.notEqual(signed[0].signature, signed[1].signature);
  assert.notEqual(signed[0].blockhash, signed[1].blockhash);
  assert.equal(signed[1].microLamports, signed[0].microLamports * 2);
  assert.ok(signed[1].microLamports <= PRIORITY_FEE_CEIL_MICROLAMPORTS);
});

test('a late landing at the expiry boundary is adopted before signing a replacement', async () => {
  const { state, connection, options } = fixture();
  const send = connection.sendRawTransaction;
  connection.sendRawTransaction = async (...args) => { const signature = await send(...args); state.height = 151; return signature; };
  connection.isBlockhashValid = async () => {
    state.statuses.set(state.sends[0].signature, finalized);
    return { context: { slot: state.slot }, value: false };
  };
  await sendPriorityTransaction(options);
  assert.equal(state.hashes, 1);
  assert.equal(state.sends.length, 1);
});

test('processed and confirmed status retain the original message past its validity height', async () => {
  const { state, connection, options } = fixture();
  const send = connection.sendRawTransaction;
  connection.sendRawTransaction = async (...args) => {
    const signature = await send(...args);
    state.height = 151;
    state.statuses.set(signature, { ...finalized, confirmationStatus: 'processed' });
    return signature;
  };
  options.sleep = async () => {
    state.ticks++;
    state.statuses.set(state.sends[0].signature, { ...finalized, confirmationStatus: state.ticks < 3 ? 'confirmed' : 'finalized' });
  };
  await sendPriorityTransaction(options);
  assert.equal(state.hashes, 1);
  assert.equal(state.sends.length, 1);
  assert.equal(state.expiryChecks, 0);
});

test('a failed status read pauses with the saved signature and a single signed attempt', async () => {
  const { state, connection, options } = fixture();
  const read = connection.getSignatureStatuses;
  connection.getSignatureStatuses = async (...args) => {
    if (state.sends.length) throw new Error('RPC unavailable');
    return read(...args);
  };
  await assert.rejects(sendPriorityTransaction(options), (error) => error.code === 'CHAIN_STATE_UNAVAILABLE' && error.signature === state.sends[0].signature);
  assert.equal(state.hashes, 1);
  assert.equal(state.sends.length, 1);
});

test('a final state check after expiry can skip the replacement with the proof slot', async () => {
  const { state, connection, options } = fixture();
  const send = connection.sendRawTransaction;
  connection.sendRawTransaction = async (...args) => { const signature = await send(...args); state.height = 151; return signature; };
  const checks = [];
  const result = await sendPriorityTransaction({ ...options, alreadyDone: ({ minContextSlot }) => { checks.push(minContextSlot); return minContextSlot > 0; } });
  assert.equal(result.skipped, true);
  assert.deepEqual(checks, [0, 20]);
  assert.equal(state.hashes, 1);
});

test('a failed signed-byte journal write stops before the first broadcast', async () => {
  const { state, options } = fixture();
  await assert.rejects(sendPriorityTransaction({ ...options,
    onSigned: () => { throw Object.assign(new Error('disk full'), { code: 'RECOVERY_STORAGE_UNAVAILABLE' }); },
  }), { code: 'RECOVERY_STORAGE_UNAVAILABLE' });
  assert.equal(state.sends.length, 0);
});

test('a restarted sender rebroadcasts the saved signed bytes', async () => {
  const { state, connection, options } = fixture();
  const tx = new Transaction({ feePayer: payer.publicKey, ...(await connection.getLatestBlockhash()) }).add(...instructions);
  tx.sign(payer);
  const saved = { ...inspectSolanaTransaction(tx.serialize()), lastValidBlockHeight: 150 };
  const send = connection.sendRawTransaction;
  connection.sendRawTransaction = async (...args) => { const signature = await send(...args); state.statuses.set(signature, finalized); return signature; };
  const result = await settleSignedTransaction(connection, JSON.parse(JSON.stringify(saved)), options);
  assert.equal(result.state, 'confirmed');
  assert.equal(state.sends[0].wire, saved.wire);
  assert.equal(state.hashes, 1);
});

test('stale status after expiry proof pauses before a replacement is signed', async () => {
  const { state, connection, options } = fixture();
  const send = connection.sendRawTransaction;
  connection.sendRawTransaction = async (...args) => { const signature = await send(...args); state.height = 151; return signature; };
  connection.isBlockhashValid = async () => ({ context: { slot: state.slot + 1 }, value: false });
  await assert.rejects(sendPriorityTransaction(options), { code: 'CHAIN_STATE_UNAVAILABLE' });
  assert.equal(state.hashes, 1);
  assert.equal(state.sends.length, 1);
});

test('the retry fee stays within the ceiling after repeated expiry', async () => {
  const { state, connection, options } = fixture();
  connection.getRecentPrioritizationFees = async () => [{ prioritizationFee: 10000000 }];
  const send = connection.sendRawTransaction;
  connection.sendRawTransaction = async (...args) => { const signature = await send(...args); state.height += 101; return signature; };
  const fees = [];
  await assert.rejects(sendPriorityTransaction({ ...options, onSigned: (record) => fees.push(record.microLamports) }), { code: 'EXECUTION_RECOVERY_REQUIRED' });
  assert.deepEqual(fees, new Array(3).fill(PRIORITY_FEE_CEIL_MICROLAMPORTS));
  assert.equal(state.hashes, 3);
  assert.equal(state.expiryChecks, 3);
});

test('priority mint creation preserves valid payer and split-scalar signatures', async () => {
  const { state, connection, options } = fixture();
  const { secretScalar } = createSplitSecret();
  const signer = scalarMintSigner(secretScalar);
  const send = connection.sendRawTransaction;
  connection.sendRawTransaction = async (...args) => { const signature = await send(...args); state.statuses.set(signature, finalized); return signature; };
  await sendPriorityTransaction({ ...options,
    instructions: [SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: signer.publicKey,
      lamports: 1, space: 10, programId: SystemProgram.programId })],
    signTransaction: (tx) => signWithScalarMint(tx, payer, signer),
  });
  const decoded = Transaction.from(state.sends[0].bytes);
  assert.equal(decoded.verifySignatures(), true);
  assert.equal(decoded.signatures.length, 2);
});
