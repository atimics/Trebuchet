import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { AddressLookupTableAccount, PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { NATIVE_MINT, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token';
import { USDC_MINT, USDT_MINT } from '../../core/src/lp-constants.js';
import { reviewSwapBundle } from '../src/swap-bundle.js';
import { swapAccountDefinitions, projectSwapStep, verifySwapEffects } from '../src/swap-state.js';
import { inspectSolanaTransaction } from '../src/solana.js';

async function fixture() {
  const saved = JSON.parse(fs.readFileSync(new URL('./fixtures/raydium-multihop-receipt.json', import.meta.url), 'utf8'));
  const signed = inspectSolanaTransaction(saved.wire), transaction = VersionedTransaction.deserialize(Buffer.from(saved.wire, 'base64'));
  let writable = 0, readonly = 0;
  // Recover exactly the lookup indexes used by the captured signed message.
  const tables = transaction.message.addressTableLookups.map((lookup) => {
    const addresses = Array(Math.max(...lookup.writableIndexes, ...lookup.readonlyIndexes) + 1).fill(PublicKey.default);
    for (const index of lookup.writableIndexes) addresses[index] = new PublicKey(saved.meta.loadedAddresses.writable[writable++]);
    for (const index of lookup.readonlyIndexes) addresses[index] = new PublicKey(saved.meta.loadedAddresses.readonly[readonly++]);
    return new AddressLookupTableAccount({ key: lookup.accountKey, state: { deactivationSlot: 18446744073709551615n, lastExtendedSlot: 1, lastExtendedSlotStartIndex: 0, addresses } });
  });
  const wallet = new PublicKey(signed.walletPublicKey), source = getAssociatedTokenAddressSync(NATIVE_MINT, wallet), destination = getAssociatedTokenAddressSync(new PublicKey(USDC_MINT), wallet);
  const intermediate = getAssociatedTokenAddressSync(new PublicKey(USDT_MINT), wallet).toBase58();
  const intent = { network: 'localnet', walletPublicKey: wallet.toBase58(), sourceTokenAccount: source.toBase58(), destinationTokenAccount: destination.toBase58(),
    outputMint: USDC_MINT, outputProgramId: TOKEN_PROGRAM_ID.toBase58(), inputAmountRaw: '10000000', minimumOutputRaw: '1123498', maxSlippageBps: 500, rentCeilingLamports: 8000000,
    intermediateMints: [{ mint: USDT_MINT, programId: TOKEN_PROGRAM_ID.toBase58() }] };
  const review = await reviewSwapBundle({ transactions: [transaction], lookupTables: tables, intent }), definitions = swapAccountDefinitions(review), rent = 2039280;
  const mints = Object.fromEntries(definitions.map(({ mint, programId }) => [mint, { decimals: mint === NATIVE_MINT.toBase58() ? 9 : 6, programId, size: 165, rentLamports: rent }]));
  const before = { slot: saved.slot - 1, walletLamports: saved.meta.preBalances[0], mints, accounts: Object.fromEntries(definitions.map((def) => [def.address,
    { ...def, decimals: mints[def.mint].decimals, exists: false, lamports: 0, amountRaw: '0', nativeReserveLamports: 0 }])) };
  const receipt = { slot: saved.slot, meta: saved.meta, transaction: { message: transaction.message, signatures: [signed.signature] } };
  return { review, before, receipt, rent, intermediate, wallet, intent, transaction, tables };
}

test('captured real multi-hop receipt verifies exact intermediate rent refunds', async () => {
  const f = await fixture(), step = f.review.steps[0];
  assert.deepEqual(step.actions.filter((action) => action.kind === 'close-created'), [{ kind: 'close-created', address: f.intermediate }]);
  const result = verifySwapEffects({ ...f, step, feeCeilingLamports: 10000 });
  assert.equal(result.receivedRaw, '1182190'); assert.equal(result.rentLamports, 3 * f.rent);
  assert.equal(result.returnedLamports, 2 * f.rent); assert.equal(result.grossDebitLamports, 10000000 + 3 * f.rent + 6001);
  assert.equal(result.spentLamports, 10000000 + f.rent + 6001);
});

for (const amountRaw of ['0', '4321']) {
  test(`a pre-existing intermediate account retains its ${amountRaw} token units`, async () => {
    const f = await fixture(); Object.assign(f.before.accounts[f.intermediate], { exists: true, lamports: f.rent, amountRaw });
    const result = projectSwapStep(f.review, f.review.steps[0], f.before);
    assert.equal(result.accounts[f.intermediate].exists, true); assert.equal(result.accounts[f.intermediate].amountRaw, amountRaw);
    assert.equal(result.createdRentLamports, 2 * f.rent); assert.equal(result.returnedLamports, f.rent);
  });
}

test('an intermediate account created explicitly before the router remains available', async () => {
  const f = await fixture(), decoded = TransactionMessage.decompile(f.transaction.message, { addressLookupTableAccounts: f.tables });
  decoded.instructions.unshift(createAssociatedTokenAccountIdempotentInstruction(f.wallet, new PublicKey(f.intermediate), f.wallet, new PublicKey(USDT_MINT)));
  const transaction = new VersionedTransaction(decoded.compileToV0Message(f.tables));
  const review = await reviewSwapBundle({ transactions: [transaction], lookupTables: f.tables, intent: f.intent });
  const result = projectSwapStep(review, review.steps[0], f.before);
  assert.equal(result.accounts[f.intermediate].exists, true); assert.equal(result.accounts[f.intermediate].amountRaw, '0');
  assert.equal(result.createdRentLamports, 3 * f.rent); assert.equal(result.returnedLamports, f.rent);
});

test('System-account prefunding is returned from a new intermediate token account', async () => {
  const f = await fixture(); f.before.accounts[f.intermediate].lamports = 100000000;
  const result = projectSwapStep(f.review, f.review.steps[0], f.before);
  assert.equal(result.accounts[f.intermediate].exists, false); assert.equal(result.createdRentLamports, 2 * f.rent);
  assert.equal(result.returnedLamports, 100000000 + f.rent);
});

for (const changed of ['refund', 'remaining rent']) {
  test(`a changed real intermediate receipt ${changed} pauses recovery`, async () => {
    const f = await fixture(), step = f.review.steps[0];
    f.receipt.meta.postBalances[changed === 'refund' ? 0 : step.accountKeys.indexOf(f.intermediate)]++;
    assert.throws(() => verifySwapEffects({ ...f, step, feeCeilingLamports: 10000 }), { code: 'CHAIN_STATE_UNAVAILABLE' });
  });
}
