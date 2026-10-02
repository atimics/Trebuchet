import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import bs58 from 'bs58';
import BN from 'bn.js';
import { Keypair, PublicKey, SystemProgram, SystemInstruction, ComputeBudgetProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, AccountLayout, MintLayout,
  ExtensionType, unpackMint, getAccountLen, getAccountTypeOfMintType, getExtensionTypes } from '@solana/spl-token';
import { CLMM_PROGRAM_ID, PoolInfoLayout, PositionInfoLayout, TickArrayLayout, LiquidityMath, SqrtPriceMath } from '@raydium-io/raydium-sdk-v2';
import { withdrawalChain, withdrawalWallet, encode, info } from './position-withdrawal-chain.mjs';
import { inspectSolanaTransaction } from '../../src/solana.js';
export const supportWallet = withdrawalWallet;
export const supportNft = Keypair.fromSeed(new Uint8Array(32).fill(63));
const hashTag = (name) => createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
const rent = (size) => 890880 + size * 6960;
const key = (seed) => Keypair.fromSeed(new Uint8Array(32).fill(seed)).publicKey;

export function supportChain({ nft2022 = true, ...options } = {}) {
  const f = withdrawalChain({ ...options, nft2022 }), { state, connection } = f, accounts = state.accounts, wallet = supportWallet.publicKey;
  const get = (address) => accounts.get(address.toBase58());
  const nftMintData = Buffer.from(get(f.nft).data);
  for (const address of [f.nft, f.nftAccount, f.position]) accounts.delete(address.toBase58());
  state.fee = 80000;
  const input = { scopeId: 'wallet/support', key: 'support-one', walletPublicKey: wallet.toBase58(), poolId: f.poolId.toBase58(), nftMint: f.nft.toBase58(),
    depositLamports: '10000000', tickLower: f.sorted[0].equals(NATIVE_MINT) ? 100 : -1000, tickUpper: f.sorted[0].equals(NATIVE_MINT) ? 1000 : -100, requestId: 'support-one', nft2022, lookupTables: [] };
  Object.assign(state, { receipts: new Map(), beforeSend: null, afterSend: null, receiptTransform: (value) => value, status: 'finalized',
    fail: false, drop: false, blockhash: key(80).toBase58(), height: 200, valid: true });
  const tokenBytes = (mint, owner, amount, size = 165, native = false) => {
    const data = Buffer.alloc(size); encode(AccountLayout, { mint, owner, amount, state: 1, isNativeOption: native ? 1 : 0, isNative: native ? BigInt(rent(165)) : 0n }).copy(data);
    if (size > 165) data[165] = 2; return data;
  };
  const create = (address, owner, data) => {
    const prior = get(address), cost = Math.max(0, rent(data.length) - (prior?.lamports || 0));
    f.set(address, info(owner, data, (prior?.lamports || 0) + cost)); get(wallet).lamports -= cost;
  };
  const rows = (keys) => keys.flatMap((address, accountIndex) => {
    const account = get(address);
    if (!account || ![TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()].includes(account.owner.toBase58())
        || account.data.length < 165 || account.data.length > 165 && account.data[165] !== 2) return [];
    const token = AccountLayout.decode(account.data), mint = MintLayout.decode(get(token.mint).data);
    return [{ accountIndex, mint: token.mint.toBase58(), owner: token.owner.toBase58(), programId: account.owner.toBase58(), uiTokenAmount: { amount: token.amount.toString(), decimals: mint.decimals, uiAmount: null } }];
  });
  Object.assign(connection, {
    getMinimumBalanceForRentExemption: async (size) => rent(size),
    getLatestBlockhash: async () => ({ blockhash: state.blockhash, lastValidBlockHeight: state.height + 150 }),
    getBlockHeight: async () => state.height,
    isBlockhashValid: async () => ({ context: { slot: state.slot }, value: state.valid }),
    getSignatureStatuses: async ([signature]) => ({ context: { slot: state.slot }, value: [state.receipts.has(signature) && state.status
      ? { slot: state.receipts.get(signature).slot, confirmations: null, err: state.receipts.get(signature).meta.err, confirmationStatus: state.status } : null] }),
    getTransaction: async (signature) => state.receiptTransform(state.receipts.get(signature) || null),
    async sendRawTransaction(bytes) {
      const signed = inspectSolanaTransaction(bytes); await state.beforeSend?.(signed); state.sends.push(signed);
      if (!state.receipts.has(signed.signature) && !state.drop) {
        const tx = VersionedTransaction.deserialize(bytes), decoded = TransactionMessage.decompile(tx.message, { addressLookupTableAccounts: [f.table] });
        const resolved = tx.message.getAccountKeys({ addressLookupTableAccounts: [f.table] }), keys = Array.from({ length: resolved.length }, (_, i) => resolved.get(i));
        const preBalances = keys.map((key) => get(key)?.lamports || 0), preTokenBalances = rows(keys);
        for (const ix of state.fail ? [] : decoded.instructions) {
          if (ix.programId.equals(SystemProgram.programId)) {
            const value = SystemInstruction.decodeCreateWithSeed(ix);
            assert.ok(value.fromPubkey.equals(wallet)); assert.ok(value.basePubkey.equals(wallet)); assert.equal(value.space, 165); assert.ok(value.programId.equals(TOKEN_PROGRAM_ID));
            assert.equal(get(value.newAccountPubkey), undefined);
            f.set(value.newAccountPubkey, info(value.programId, Buffer.alloc(165), Number(value.lamports))); get(wallet).lamports -= Number(value.lamports);
          } else if (ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) {
            const [payer, destination, owner, mint] = ix.keys.map((row) => row.pubkey), program = ix.keys[5].pubkey;
            assert.ok(payer.equals(wallet)); assert.ok(owner.equals(wallet));
            if (!get(destination) || get(destination).owner.equals(SystemProgram.programId)) {
              const data = unpackMint(mint, get(mint), program), types = program.equals(TOKEN_2022_PROGRAM_ID)
                ? [...new Set([ExtensionType.ImmutableOwner, ...getExtensionTypes(data.tlvData).map(getAccountTypeOfMintType).filter((type) => type !== 0)])] : [];
              create(destination, program, tokenBytes(mint, wallet, 0n, getAccountLen(types)));
            }
          } else if (ix.programId.equals(TOKEN_PROGRAM_ID)) {
            const address = ix.keys[0].pubkey;
            if (ix.data[0] === 18) tokenBytes(NATIVE_MINT, wallet, BigInt(get(address).lamports - rent(165)), 165, true).copy(get(address).data);
            else if (ix.data[0] === 9) { get(wallet).lamports += get(address).lamports; accounts.delete(address.toBase58()); }
            else assert.fail('Expected native account initialize or close');
          } else if (ix.programId.equals(CLMM_PROGRAM_ID)) {
            assert.ok(ix.data.subarray(0, 8).equals(hashTag(nft2022 ? 'open_position_with_token22_nft' : 'open_position_v2')));
            assert.equal(ix.data.length, 59); assert.equal(ix.data[56], 0); assert.equal(ix.data[57], 0);
            const offset = nft2022 ? 0 : 1, addresses = ix.keys.map((row) => row.pubkey);
            assert.ok(addresses[0].equals(wallet)); assert.ok(addresses[1].equals(wallet)); assert.ok(addresses[2].equals(f.nft));
            const tickLower = ix.data.readInt32LE(8), tickUpper = ix.data.readInt32LE(12), liquidity = new BN(ix.data.subarray(24, 40), 'le');
            const pool = PoolInfoLayout.decode(get(addresses[4 + offset]).data), amounts = LiquidityMath.getAmountsFromLiquidity(pool.sqrtPriceX64,
              SqrtPriceMath.getSqrtPriceX64FromTick(tickLower), SqrtPriceMath.getSqrtPriceX64FromTick(tickUpper), liquidity, true);
            for (const [side, amount] of [[0, amounts.amountA], [1, amounts.amountB]]) {
              assert.ok(BigInt(amount.toString()) <= ix.data.readBigUInt64LE(40 + side * 8));
              if (amount.isZero()) continue;
              const source = get(addresses[9 + offset + side]), destination = get(addresses[11 + offset + side]);
              const a = AccountLayout.decode(source.data), b = AccountLayout.decode(destination.data), delta = BigInt(amount.toString());
              assert.ok(a.mint.equals(NATIVE_MINT)); assert.ok(b.mint.equals(NATIVE_MINT)); assert.ok(a.amount >= delta);
              a.amount -= delta; b.amount += delta; AccountLayout.encode(a, source.data); AccountLayout.encode(b, destination.data);
              source.lamports -= Number(delta); destination.lamports += Number(delta);
            }
            for (const [address, startIndex] of [[addresses[6 + offset], ix.data.readInt32LE(16)], [addresses[7 + offset], ix.data.readInt32LE(20)]]) {
              if (!get(address) || get(address).owner.equals(SystemProgram.programId)) create(address, CLMM_PROGRAM_ID, encode(TickArrayLayout, { poolId: f.poolId, startTickIndex: startIndex }, 'TickArrayState'));
            }
            create(f.nft, f.nftProgram, nftMintData);
            create(f.nftAccount, f.nftProgram, tokenBytes(f.nft, wallet, 1n, nft2022 ? getAccountLen([ExtensionType.ImmutableOwner]) : 165));
            create(f.position, CLMM_PROGRAM_ID, encode(PositionInfoLayout, { poolId: f.poolId, nftMint: f.nft, tickLower, tickUpper, liquidity }, 'PersonalPositionState'));
          } else assert.ok(ix.programId.equals(ComputeBudgetProgram.programId));
        }
        get(wallet).lamports -= state.fee; state.slot++;
        state.receipts.set(signed.signature, { slot: state.slot, transaction: { signatures: tx.signatures.map((value) => bs58.encode(value)), message: tx.message },
          meta: { err: state.fail ? { InstructionError: [4, { Custom: 6001 }] } : null, fee: state.fee, preBalances, postBalances: keys.map((key) => get(key)?.lamports || 0),
            preTokenBalances, postTokenBalances: rows(keys), loadedAddresses: tx.message.resolveAddressTableLookups([f.table]) } });
      }
      await state.afterSend?.(signed); return signed.signature;
    },
  });
  return { ...f, input, rent };
}
