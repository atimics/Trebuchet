import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey, SystemProgram, ComputeBudgetProgram, TransactionMessage, VersionedTransaction, AddressLookupTableAccount } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, NATIVE_MINT, createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction, createCloseAccountInstruction,
  createTransferInstruction, createInitializeAccount3Instruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { reviewSwapBundle } from '../src/swap-bundle.js';
import { key, wallet, mint, source, destination, intent, raydium, jupiter } from './fixtures/swap-instructions.mjs';

const compile = (instructions, { legacy = false, tables = [] } = {}) => {
  const message = new TransactionMessage({ payerKey: wallet, recentBlockhash: key(52).toBase58(), instructions });
  return new VersionedTransaction(legacy ? message.compileToLegacyMessage() : message.compileToV0Message(tables));
};
const setup = () => [
  createAssociatedTokenAccountIdempotentInstruction(wallet, source, wallet, NATIVE_MINT),
  createAssociatedTokenAccountIdempotentInstruction(wallet, destination, wallet, mint),
  SystemProgram.transfer({ fromPubkey: wallet, toPubkey: source, lamports: 50000 }),
  createSyncNativeInstruction(source),
];
const cleanup = () => createCloseAccountInstruction(source, wallet, wallet);
const budget = () => [ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50000 })];
const review = (instructions, options = {}) => reviewSwapBundle({ transactions: [compile(instructions)], intent, ...options });

test('complete Raydium and Jupiter swaps preserve one approved trade and their account funding', async () => {
  for (const trade of [raydium, jupiter]) for (const legacy of [false, true]) {
    const transaction = compile([...budget(), ...setup(), trade(), cleanup()], { legacy }), before = Buffer.from(transaction.serialize());
    const plan = await reviewSwapBundle({ transactions: [transaction], intent });
    assert.equal(plan.steps.length, 1); assert.equal(plan.steps[0].kind, 'swap'); assert.equal(plan.steps[0].closesSource, true);
    assert.equal(plan.explicitLamports, 50000); assert.equal(plan.creations.length, 2); assert.equal(plan.trade.inputAmountRaw, '50000');
    assert.deepEqual(Buffer.from(transaction.serialize()), before, 'review preserves provider bytes');
    assert.equal(VersionedTransaction.deserialize(Buffer.from(plan.steps[0].template, 'base64')).message.recentBlockhash, PublicKey.default.toBase58());
  }
});

test('setup, swap, and cleanup keep stable ordered templates across blockhash changes', async () => {
  const transactions = [compile(setup()), compile([jupiter()]), compile([cleanup()])];
  const plan = await reviewSwapBundle({ transactions, intent });
  assert.deepEqual(plan.steps.map((step) => step.kind), ['setup', 'swap', 'cleanup']);
  for (const tx of transactions) tx.message.recentBlockhash = key(53).toBase58();
  assert.deepEqual(await reviewSwapBundle({ transactions, intent }), plan);
});

test('lookup-table accounts are resolved before trade and funding review', async () => {
  const ix = [...setup(), raydium(), cleanup()], entries = new Map();
  for (const item of ix) for (const account of item.keys) if (!account.pubkey.equals(wallet)) entries.set(account.pubkey.toBase58(), account.pubkey);
  const table = new AddressLookupTableAccount({ key: key(54), state: { deactivationSlot: 18446744073709551615n, lastExtendedSlot: 1, lastExtendedSlotStartIndex: 0, authority: wallet, addresses: [...entries.values()] } });
  const transaction = compile(ix, { tables: [table] });
  assert.ok(transaction.message.addressTableLookups.length);
  const plan = await reviewSwapBundle({ transactions: [transaction], lookupTables: [table], intent });
  assert.equal(plan.trade.destinationTokenAccount, destination.toBase58());
  await assert.rejects(reviewSwapBundle({ transactions: [transaction], intent }), { code: 'SWAP_INTENT_MISMATCH' });
  const changed = new AddressLookupTableAccount({ key: table.key, state: { ...table.state, addresses: table.state.addresses.map((address) => address.equals(destination) ? key(55) : address) } });
  await assert.rejects(reviewSwapBundle({ transactions: [transaction], lookupTables: [changed], intent }), { code: 'SWAP_INTENT_MISMATCH' });
});

test('a seeded wrapped-SOL account keeps its exact owner, mint, and funding', async () => {
  const seed = 'saved-swap', seeded = await PublicKey.createWithSeed(wallet, seed, TOKEN_PROGRAM_ID), trade = raydium();
  trade.keys[5].pubkey = seeded;
  const instructions = [SystemProgram.createAccountWithSeed({ fromPubkey: wallet, basePubkey: wallet, newAccountPubkey: seeded, seed,
    lamports: 2089280, space: 165, programId: TOKEN_PROGRAM_ID }), createInitializeAccount3Instruction(seeded, NATIVE_MINT, wallet), trade,
    createCloseAccountInstruction(seeded, wallet, wallet)];
  const plan = await review(instructions, { intent: { ...intent, sourceTokenAccount: seeded.toBase58() } });
  assert.equal(plan.creations[0].seed, seed); assert.equal(plan.explicitLamports, 2089280);
  await assert.rejects(review(instructions.filter((_, index) => index !== 1), { intent: { ...intent, sourceTokenAccount: seeded.toBase58() } }), { code: 'SWAP_INTENT_MISMATCH' });
  const changed = [...instructions]; changed[1] = createInitializeAccount3Instruction(seeded, mint, wallet);
  await assert.rejects(review(changed, { intent: { ...intent, sourceTokenAccount: seeded.toBase58() } }), { code: 'SWAP_INTENT_MISMATCH' });
});

for (const attack of ['foreign-sol', 'excess-funding', 'duplicate-funding', 'token-transfer', 'foreign-close', 'extra-trade', 'early-close', 'late-setup', 'compute-only']) {
  test(`complete swap review stops ${attack}`, async () => {
    let instructions = [...setup(), jupiter(), cleanup()];
    if (attack === 'foreign-sol') instructions.unshift(SystemProgram.transfer({ fromPubkey: wallet, toPubkey: key(56), lamports: 1 }));
    if (attack === 'excess-funding') instructions[2] = SystemProgram.transfer({ fromPubkey: wallet, toPubkey: source, lamports: 50001 });
    if (attack === 'duplicate-funding') instructions.splice(3, 0, SystemProgram.transfer({ fromPubkey: wallet, toPubkey: source, lamports: 50000 }));
    if (attack === 'token-transfer') instructions.unshift(createTransferInstruction(destination, key(57), wallet, 1n));
    if (attack === 'foreign-close') instructions[instructions.length - 1] = createCloseAccountInstruction(source, key(58), wallet);
    if (attack === 'extra-trade') instructions.splice(4, 0, jupiter());
    if (attack === 'early-close') instructions = [...setup(), cleanup(), jupiter()];
    if (attack === 'late-setup') instructions = [...setup(), jupiter(), createSyncNativeInstruction(source), cleanup()];
    if (attack === 'compute-only') instructions = budget();
    await assert.rejects(review(instructions), { code: 'SWAP_INTENT_MISMATCH' });
  });
}

test('account creation is limited to the saved route and wallet', async () => {
  const otherMint = key(59), otherAccount = getAssociatedTokenAddressSync(otherMint, wallet);
  const instructions = [createAssociatedTokenAccountIdempotentInstruction(wallet, otherAccount, wallet, otherMint), ...setup(), raydium(), cleanup()];
  await assert.rejects(review(instructions), { code: 'SWAP_INTENT_MISMATCH' });
  const plan = await review(instructions, { intent: { ...intent, intermediateMints: [{ mint: otherMint.toBase58(), programId: TOKEN_PROGRAM_ID.toBase58() }] } });
  assert.equal(plan.creations.length, 3);
  instructions[0] = createAssociatedTokenAccountIdempotentInstruction(wallet, otherAccount, key(60), otherMint);
  await assert.rejects(review(instructions, { intent: { ...intent, intermediateMints: [{ mint: otherMint.toBase58(), programId: TOKEN_PROGRAM_ID.toBase58() }] } }), { code: 'SWAP_INTENT_MISMATCH' });
});

test('bundles require one approved payer and one trade before completion', async () => {
  const transaction = compile([...setup(), jupiter(), cleanup()]);
  transaction.message.staticAccountKeys[0] = key(61);
  await assert.rejects(reviewSwapBundle({ transactions: [transaction], intent }), { code: 'SWAP_INTENT_MISMATCH' });
  await assert.rejects(reviewSwapBundle({ transactions: [], intent }), { code: 'SWAP_INTENT_MISMATCH' });
  await assert.rejects(review(setup()), { code: 'SWAP_INTENT_MISMATCH' });
  await assert.rejects(review([...setup(), jupiter(), cleanup()], { intent: { ...intent, destinationTokenAccount: key(62).toBase58() } }), { code: 'SWAP_INTENT_MISMATCH' });
});


test('invalid compute limits stop before a swap transaction is signed', async () => {
  for (const instruction of [ComputeBudgetProgram.setComputeUnitLimit({ units: 0 }), ComputeBudgetProgram.setComputeUnitLimit({ units: 1400001 }), ComputeBudgetProgram.requestHeapFrame({ bytes: 32769 })]) {
    await assert.rejects(review([instruction, ...setup(), jupiter(), cleanup()]), { code: 'SWAP_INTENT_MISMATCH' });
  }
  await assert.rejects(review([...budget(), ...budget(), ...setup(), jupiter(), cleanup()]), { code: 'SWAP_INTENT_MISMATCH' });
});

test('saved review identity includes its network, limits, token program, and resolved accounts', async () => {
  const transaction = compile([...setup(), raydium(), cleanup()]);
  const baseline = await reviewSwapBundle({ transactions: [transaction], intent });
  assert.equal(baseline.intent.outputProgramId, TOKEN_PROGRAM_ID.toBase58());
  assert.equal(baseline.steps[0].accountKeys[0], wallet.toBase58());
  for (const changed of [{ network: 'localnet' }, { minimumOutputRaw: '1200' }, { rentCeilingLamports: 4000000 }, { maxSlippageBps: 50 }]) {
    const next = await reviewSwapBundle({ transactions: [transaction], intent: { ...intent, ...changed } });
    assert.notEqual(next.digest, baseline.digest);
  }
  const address = key(54);
  const table = new AddressLookupTableAccount({ key: address, state: { deactivationSlot: 18446744073709551615n, lastExtendedSlot: 1, lastExtendedSlotStartIndex: 0, authority: wallet, addresses: [key(45)] } });
  const tx = compile([...setup(), raydium(), cleanup()], { tables: [table] });
  assert.equal(tx.message.addressTableLookups.length, 1);
  const first = await reviewSwapBundle({ transactions: [tx], lookupTables: [table], intent });
  const changed = new AddressLookupTableAccount({ key: address, state: { ...table.state, addresses: [key(74)] } });
  const second = await reviewSwapBundle({ transactions: [tx], lookupTables: [changed], intent });
  assert.equal(first.steps[0].template, second.steps[0].template);
  assert.notEqual(first.digest, second.digest, 'lookup changes alter the saved review identity even when serialized indexes match');
  await assert.rejects(reviewSwapBundle({ transactions: [tx], lookupTables: [table, changed], intent }), { code: 'SWAP_INTENT_MISMATCH' });
});
