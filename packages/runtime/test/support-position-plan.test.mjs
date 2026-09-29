import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey, SystemProgram, TransactionMessage, SystemInstruction } from '@solana/web3.js';
import { NATIVE_MINT, TOKEN_PROGRAM_ID, AccountLayout } from '@solana/spl-token';
import { CLMM_PROGRAM_ID, PoolInfoLayout, TickArrayLayout, getPdaPoolVaultId } from '@raydium-io/raydium-sdk-v2';
import { buildSupportPositionPlan } from '../src/support-position-plan.js';
import { supportChain, supportWallet } from './fixtures/support-position-chain.mjs';
import { info, encode } from './fixtures/position-withdrawal-chain.mjs';
const input = (f) => ({ ...f.input, connection: f.connection, network: 'mainnet', expectedGenesisHash: f.state.genesisHash });

for (const options of [{}, { nft2022: false }, { token2022: true }, { existing: true }, { mintSeed: 58 }]) {
  test(`support plan fixes the full one-sided transaction: ${JSON.stringify(options)}`, async () => {
    const f = supportChain(options), { plan, transaction } = await buildSupportPositionPlan(input(f));
    assert.equal(plan.nativeIsA, options.mintSeed !== 58); assert.equal(plan.nftMint, f.input.nftMint);
    assert.equal(plan.maxSpendLamports, Number(plan.depositLamports) + plan.rentCeilingLamports + plan.feeCeilingLamports);
    assert.ok(transaction.serialize().length <= 1232); assert.equal(transaction.message.header.numRequiredSignatures, 2);
    assert.ok(transaction.signatures.every((row) => row.every((byte) => byte === 0)));
    const instructions = TransactionMessage.decompile(transaction.message).instructions, create = SystemInstruction.decodeCreateWithSeed(instructions[2]);
    assert.equal(create.lamports, Number(plan.depositLamports) + plan.temporaryRentLamports); assert.ok(create.fromPubkey.equals(supportWallet.publicKey));
    assert.equal(create.newAccountPubkey.toBase58(), plan.temporaryAccount);
    const open = instructions.find((ix) => ix.programId.equals(CLMM_PROGRAM_ID));
    assert.equal(open.data.readBigUInt64LE(plan.nativeIsA ? 40 : 48), 10000000n); assert.equal(open.data.readBigUInt64LE(plan.nativeIsA ? 48 : 40), 0n);
    assert.equal(open.keys[2].pubkey.toBase58(), plan.nftMint); assert.equal(open.data[56], 0);
    assert.ok(instructions.at(-1).programId.equals(TOKEN_PROGRAM_ID)); assert.equal(instructions.at(-1).data[0], 9);
    assert.equal(instructions.at(-1).keys[0].pubkey.toBase58(), plan.temporaryAccount);
  });
}

for (const changed of ['network', 'pool owner', 'pool layout', 'pool address', 'pool paused', 'range', 'spacing', 'deposit', 'deposit precision', 'nft identity',
  'mint decimals', 'vault owner', 'vault frozen', 'token owner', 'token frozen', 'token delegate', 'tick owner', 'partial accounts', 'fee', 'fee slot', 'lookup slot']) {
  test(`support preparation stops before signing on changed ${changed}`, async () => {
    const f = supportChain({ existing: true }), request = input(f), account = f.state.accounts.get(f.poolId.toBase58()), pool = PoolInfoLayout.decode(account.data);
    const mutateToken = (address, fields) => { const account = f.state.accounts.get(address), data = AccountLayout.decode(account.data); AccountLayout.encode({ ...data, ...fields }, account.data); };
    if (changed === 'network') f.state.genesisHash = 'different-chain';
    if (changed === 'pool owner') account.owner = SystemProgram.programId;
    if (changed === 'pool layout') account.data[0] ^= 1;
    if (changed === 'pool address') { request.poolId = f.mint.toBase58(); f.set(f.mint, account); }
    if (changed === 'pool paused') { pool.status = 1; PoolInfoLayout.encode(pool, account.data); }
    if (changed === 'range') { request.tickLower = -100; request.tickUpper = 100; }
    if (changed === 'spacing') request.tickLower = 101;
    if (changed === 'deposit') request.depositLamports = '0';
    if (changed === 'deposit precision') request.depositLamports = '9007199254740992';
    if (changed === 'nft identity') f.set(f.nft, info(SystemProgram.programId, Buffer.alloc(0), 1));
    if (changed === 'mint decimals') { pool.mintDecimalsB = 19; PoolInfoLayout.encode(pool, account.data); }
    if (changed === 'vault owner') mutateToken(f.vaults[0].toBase58(), { owner: supportWallet.publicKey });
    if (changed === 'vault frozen') mutateToken(f.vaults[0].toBase58(), { state: 2 });
    if (changed === 'token owner') mutateToken(f.destination.toBase58(), { owner: f.poolId });
    if (changed === 'token frozen') mutateToken(f.destination.toBase58(), { state: 2 });
    if (changed === 'token delegate') mutateToken(f.destination.toBase58(), { delegateOption: 1, delegate: f.poolId });
    if (changed === 'tick owner') {
      const { plan } = await buildSupportPositionPlan(request), row = plan.rents.find((row) => row.type === 'tick-array');
      f.set(new PublicKey(row.address), info(SystemProgram.programId, Buffer.alloc(TickArrayLayout.span)));
    }
    if (changed === 'partial accounts') f.connection.getMultipleAccountsInfoAndContext = async () => ({ context: { slot: 200 }, value: [] });
    if (changed === 'fee') f.state.fee = null;
    if (changed === 'fee slot') f.connection.getFeeForMessage = async () => ({ context: { slot: 0 }, value: 80000 });
    if (changed === 'lookup slot') { request.lookupTables = [f.table.key.toBase58()]; f.connection.getAddressLookupTable = async () => ({ context: { slot: 0 }, value: f.table }); }
    await assert.rejects(buildSupportPositionPlan(request)); assert.equal(f.state.sends.length, 0);
  });
}

test('existing support tick arrays have zero reserved creation rent', async () => {
  const f = supportChain(), first = await buildSupportPositionPlan(input(f));
  const arrays = first.plan.rents.filter((row) => row.type === 'tick-array');
  for (const row of arrays) f.set(new PublicKey(row.address), info(CLMM_PROGRAM_ID, encode(TickArrayLayout, { poolId: f.poolId, startTickIndex: row.startIndex }, 'TickArrayState'), f.rent(TickArrayLayout.span)));
  const second = await buildSupportPositionPlan(input(f)); assert.equal(second.plan.rentCeilingLamports, first.plan.rentCeilingLamports - arrays.reduce((sum, row) => sum + row.rentCeilingLamports, 0));
  assert.equal(second.plan.liquidity, first.plan.liquidity);
});

test('indexed CLMM pool identity is bound to its stored seed and canonical vaults', async () => {
  const f = supportChain(), account = f.state.accounts.get(f.poolId.toBase58()), pool = PoolInfoLayout.decode(account.data);
  const seed = Buffer.from([7, 0]), indexed = PublicKey.findProgramAddressSync([Buffer.from('pool'), pool.ammConfig.toBuffer(), pool.mintA.toBuffer(), pool.mintB.toBuffer(), seed], CLMM_PROGRAM_ID)[0];
  for (const side of ['A', 'B']) {
    const old = pool[`vault${side}`], vault = getPdaPoolVaultId(CLMM_PROGRAM_ID, indexed, pool[`mint${side}`]).publicKey;
    const info = f.state.accounts.get(old.toBase58()), token = AccountLayout.decode(info.data); token.owner = indexed; AccountLayout.encode(token, info.data);
    f.set(vault, info); pool[`vault${side}`] = vault;
  }
  PoolInfoLayout.encode(pool, account.data); seed.copy(account.data, PoolInfoLayout.offsetOf('status') + 2); f.set(indexed, account);
  const { plan } = await buildSupportPositionPlan({ ...input(f), poolId: indexed.toBase58() });
  assert.equal(plan.poolSeedIndex, 7); assert.equal(plan.poolId, indexed.toBase58()); assert.equal(plan.nativeIsA, true);
});
