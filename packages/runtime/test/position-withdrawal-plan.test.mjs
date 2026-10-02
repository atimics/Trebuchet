import test from 'node:test';
import assert from 'node:assert/strict';
import { TransactionMessage, SystemProgram, ComputeBudgetProgram } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, NATIVE_MINT, AccountLayout } from '@solana/spl-token';
import { CLMM_PROGRAM_ID } from '@raydium-io/raydium-sdk-v2';
import { buildPositionWithdrawalPlan } from '../src/position-withdrawal-plan.js';
import { withdrawalChain, withdrawalWallet, encode, info } from './fixtures/position-withdrawal-chain.mjs';

for (const options of [{}, { token2022: true }, { nft2022: true }, { frozenNft: true }, { rewards: true }, { existing: true }]) {
  test(`withdrawal plan binds complete account identities and costs: ${JSON.stringify(options)}`, async () => {
    const f = withdrawalChain(options), { plan, transaction } = await buildPositionWithdrawalPlan(f.input);
    assert.equal(plan.nftMint, f.input.nftMint); assert.equal(plan.poolId, f.input.poolId); assert.equal(plan.liquidity, '1000000000');
    assert.equal(plan.maxSpendLamports, plan.feeCeilingLamports + plan.rentCeilingLamports); assert.equal(plan.feeCeilingLamports, 80000);
    assert.ok(plan.tokens.every((row) => BigInt(row.minimumRaw) >= 0n)); assert.equal(plan.tokens.length, options.rewards ? 3 : 2);
    assert.ok(transaction.signatures.every((signature) => signature.every((byte) => byte === 0))); assert.ok(transaction.serialize().length <= 1232);
    const instructions = TransactionMessage.decompile(transaction.message, { addressLookupTableAccounts: [f.table] }).instructions;
    const actions = instructions.filter((ix) => ix.programId.equals(CLMM_PROGRAM_ID));
    assert.equal(actions.length, 2); assert.deepEqual([...actions[0].data.subarray(0, 8)], [58, 127, 188, 62, 79, 82, 196, 96]);
    assert.equal(actions[0].data.length, 40); assert.equal(actions[0].data.readBigUInt64LE(8), 1000000000n);
    assert.deepEqual([...actions[1].data], [123, 134, 81, 0, 49, 68, 98, 98]);
    assert.equal(actions[1].keys[1].pubkey.toBase58(), plan.nftMint); assert.equal(actions[1].keys[2].pubkey.toBase58(), plan.nftAccount);
    assert.ok(actions[1].keys[5].pubkey.equals(options.nft2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID));
    if (options.frozenNft) assert.ok(actions[1].keys[6].pubkey.equals(f.poolId));
    const sol = plan.tokens.find((row) => row.native), token = plan.tokens.find((row) => !row.native);
    assert.equal(sol.mint, NATIVE_MINT.toBase58()); assert.equal(sol.created, true); assert.equal(token.created, !options.existing);
    assert.equal(token.alreadyHadRaw, options.existing ? '1234' : '0');
    assert.ok(instructions[0].programId.equals(ComputeBudgetProgram.programId));
    assert.equal(instructions.filter((ix) => ix.programId.equals(SystemProgram.programId)).length, 1);
    const nativeClose = instructions.at(-1); assert.ok(nativeClose.programId.equals(TOKEN_PROGRAM_ID)); assert.equal(nativeClose.data[0], 9);
    assert.equal(nativeClose.keys[0].pubkey.toBase58(), sol.destination); assert.ok(nativeClose.keys[1].pubkey.equals(withdrawalWallet.publicKey));
    assert.ok(plan.refundAccounts.includes(plan.positionAddress)); assert.equal(plan.refundAccounts.includes(plan.nftMint), !!options.nft2022);
  });
}

test('transfer fees reduce the approved token minimum before slippage', async () => {
  const plain = await buildPositionWithdrawalPlan(withdrawalChain().input), fee = await buildPositionWithdrawalPlan(withdrawalChain({ token2022: true }).input);
  const minimum = (value) => BigInt(value.plan.tokens.find((row) => !row.native).minimumRaw);
  assert.ok(minimum(fee) < minimum(plain)); assert.ok(minimum(fee) > minimum(plain) * 97n / 100n);
});

for (const changed of ['network', 'liquidity', 'pool owner', 'position layout', 'nft owner', 'nft delegate', 'destination owner', 'partial accounts', 'fee', 'lookup slot']) {
  test(`withdrawal preparation preserves uncertainty: ${changed}`, async () => {
    const f = withdrawalChain({ existing: true });
    if (changed === 'network') f.state.genesisHash = 'another-chain';
    if (changed === 'liquidity') f.input.expectedLiquidity = '1';
    if (changed === 'pool owner') f.state.accounts.get(f.poolId.toBase58()).owner = SystemProgram.programId;
    if (changed === 'position layout') f.state.accounts.get(f.position.toBase58()).data[0] ^= 1;
    if (changed === 'nft owner') f.set(f.nftAccount, info(TOKEN_PROGRAM_ID, encode(AccountLayout, { mint: f.nft, owner: f.poolId, amount: 1n, state: 1 })));
    if (changed === 'nft delegate') f.set(f.nftAccount, info(TOKEN_PROGRAM_ID, encode(AccountLayout, { mint: f.nft, owner: withdrawalWallet.publicKey, amount: 1n, state: 1, delegateOption: 1, delegate: f.poolId })));
    if (changed === 'destination owner') f.set(f.destination, info(TOKEN_PROGRAM_ID, encode(AccountLayout, { mint: f.mint, owner: f.poolId, amount: 0n, state: 1 })));
    if (changed === 'partial accounts') f.connection.getMultipleAccountsInfoAndContext = async () => ({ context: { slot: 200 }, value: [] });
    if (changed === 'fee') f.state.fee = null;
    if (changed === 'lookup slot') f.connection.getAddressLookupTable = async () => ({ context: { slot: 199 }, value: f.table });
    await assert.rejects(buildPositionWithdrawalPlan(f.input)); assert.equal(f.state.sends.length, 0);
  });
}

test('a pre-funded output account reduces reserved rent and preserves its destination', async () => {
  const f = withdrawalChain(); f.set(f.destination, info(SystemProgram.programId, Buffer.alloc(0), 1000000));
  const { plan } = await buildPositionWithdrawalPlan(f.input);
  assert.equal(plan.rentCeilingLamports, 2 * 2039280 - 1000000);
});

test('the approved native destination stays stable within the request identity', async () => {
  const f = withdrawalChain(), first = await buildPositionWithdrawalPlan(f.input), second = await buildPositionWithdrawalPlan(f.input);
  assert.deepEqual(first.plan, second.plan); assert.deepEqual(first.transaction.serialize(), second.transaction.serialize());
  const other = await buildPositionWithdrawalPlan({ ...f.input, requestId: 'another-review' });
  assert.notEqual(first.plan.tokens.find((row) => row.native).destination, other.plan.tokens.find((row) => row.native).destination);
});
