import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import bs58 from 'bs58';
import { Keypair, PublicKey, SystemProgram, AddressLookupTableAccount, VersionedTransaction, TransactionMessage, SystemInstruction, ComputeBudgetProgram } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, NATIVE_MINT, MintLayout, AccountLayout, getAssociatedTokenAddressSync,
  ExtensionType, TransferFeeConfigLayout, MintCloseAuthorityLayout, ASSOCIATED_TOKEN_PROGRAM_ID, unpackMint, getExtensionTypes, getAccountTypeOfMintType, getAccountLen } from '@solana/spl-token';
import { CLMM_PROGRAM_ID, PoolInfoLayout, PositionInfoLayout, getPdaPoolId, getPdaPoolVaultId, getPdaPersonalPositionAddress,
  getPdaProtocolPositionAddress, getPdaTickArrayAddress, TickUtils } from '@raydium-io/raydium-sdk-v2';
import BN from 'bn.js';
import { SOLANA_GENESIS_HASHES, inspectSolanaTransaction } from '../../src/solana.js';

export const withdrawalWallet = Keypair.fromSeed(new Uint8Array(32).fill(43));
const key = (seed) => Keypair.fromSeed(new Uint8Array(32).fill(seed)).publicKey;
export const encode = (layout, fields, name) => {
  const data = Buffer.alloc(layout.span); layout.encode({ ...layout.decode(data), ...fields }, data);
  if (name) createHash('sha256').update(`account:${name}`).digest().copy(data, 0, 0, 8);
  return data;
};
export const info = (owner, data, lamports = 2039280) => ({ owner, data, lamports, executable: false, rentEpoch: 0 });
const tlv = (type, data) => { const header = Buffer.alloc(4); header.writeUInt16LE(type); header.writeUInt16LE(data.length, 2); return Buffer.concat([header, data]); };
const mintData = (supply, decimals, authority = null) => encode(MintLayout, { mintAuthorityOption: 0, supply, decimals, isInitialized: true,
  freezeAuthorityOption: authority ? 1 : 0, freezeAuthority: authority || PublicKey.default });
const tokenData = (mint, owner, amount, native = false, frozen = false) => encode(AccountLayout, { mint, owner, amount, state: frozen ? 2 : 1,
  isNativeOption: native ? 1 : 0, isNative: native ? 2039280n : 0n });

export function withdrawalChain({ token2022 = false, nft2022 = false, frozenNft = false, rewards = false, existing = false, mintSeed = 60 } = {}) {
  const wallet = withdrawalWallet.publicKey, mint = key(mintSeed), nft = key(63), config = key(62), tableKey = key(70);
  const sorted = [mint, NATIVE_MINT].sort((a, b) => Buffer.compare(a.toBuffer(), b.toBuffer()));
  const poolId = getPdaPoolId(CLMM_PROGRAM_ID, config, sorted[0], sorted[1]).publicKey;
  const vaults = sorted.map((value) => getPdaPoolVaultId(CLMM_PROGRAM_ID, poolId, value).publicKey);
  const position = getPdaPersonalPositionAddress(CLMM_PROGRAM_ID, nft).publicKey;
  const nftProgram = nft2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID, outputProgram = token2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  const nftAccount = getAssociatedTokenAddressSync(nft, wallet, false, nftProgram), destination = getAssociatedTokenAddressSync(mint, wallet, false, outputProgram);
  const accounts = new Map(), set = (address, value) => accounts.set(address.toBase58(), value);
  set(wallet, info(SystemProgram.programId, Buffer.alloc(0), 1000000000));
  const pool = PoolInfoLayout.decode(Buffer.alloc(PoolInfoLayout.span));
  Object.assign(pool, { ammConfig: config, mintA: sorted[0], mintB: sorted[1], vaultA: vaults[0], vaultB: vaults[1], tickSpacing: 10,
    mintDecimalsA: sorted[0].equals(NATIVE_MINT) ? 9 : 6, mintDecimalsB: sorted[1].equals(NATIVE_MINT) ? 9 : 6, liquidity: new BN(1000000000), sqrtPriceX64: new BN(2).pow(new BN(64)) });
  if (rewards) {
    Object.assign(pool.rewardInfos[0], { tokenMint: key(71), tokenVault: key(72), rewardState: 1 });
    set(key(71), info(TOKEN_PROGRAM_ID, mintData(100000000000n, 6)));
    set(key(72), info(TOKEN_PROGRAM_ID, tokenData(key(71), poolId, 100000000000n)));
  }
  set(poolId, info(CLMM_PROGRAM_ID, encode(PoolInfoLayout, pool, 'PoolState'), 12000000));
  set(position, info(CLMM_PROGRAM_ID, encode(PositionInfoLayout, { nftMint: nft, poolId, liquidity: new BN(1000000000), tickLower: -100, tickUpper: 100 }, 'PersonalPositionState'), 4500000));
  let nftBytes = mintData(1n, 0, frozenNft ? poolId : null);
  if (nft2022) nftBytes = Buffer.concat([nftBytes, Buffer.alloc(165 - 82), Buffer.from([1]), tlv(ExtensionType.MintCloseAuthority,
    encode(MintCloseAuthorityLayout, { closeAuthority: position }))]);
  set(nft, info(nftProgram, nftBytes, 2500000));
  set(nftAccount, info(nftProgram, tokenData(nft, wallet, 1n, false, frozenNft)));
  let outputBytes = mintData(100000000000n, 6);
  if (token2022) {
    const schedule = { epoch: 0n, maximumFee: 1000000n, transferFeeBasisPoints: 250 };
    outputBytes = Buffer.concat([outputBytes, Buffer.alloc(165 - 82), Buffer.from([1]), tlv(ExtensionType.TransferFeeConfig,
      encode(TransferFeeConfigLayout, { olderTransferFee: schedule, newerTransferFee: schedule, transferFeeConfigAuthority: PublicKey.default, withdrawWithheldAuthority: PublicKey.default, withheldAmount: 0n }))]);
  }
  set(mint, info(outputProgram, outputBytes)); set(NATIVE_MINT, info(TOKEN_PROGRAM_ID, mintData(0n, 9)));
  for (const [index, value] of sorted.entries()) set(vaults[index], info(value.equals(mint) ? outputProgram : TOKEN_PROGRAM_ID,
    tokenData(value, poolId, 100000000000n, value.equals(NATIVE_MINT)), value.equals(NATIVE_MINT) ? 100002039280 : 2039280));
  if (existing) set(destination, info(outputProgram, tokenData(mint, wallet, 1234n)));
  const table = new AddressLookupTableAccount({ key: tableKey, state: { deactivationSlot: 18446744073709551615n, lastExtendedSlot: 0,
    lastExtendedSlotStartIndex: 0, authority: undefined, addresses: [...accounts.keys()].map((value) => new PublicKey(value)).concat([
      destination, getPdaProtocolPositionAddress(CLMM_PROGRAM_ID, poolId, -100, 100).publicKey,
      ...[-100, 100].map((tick) => getPdaTickArrayAddress(CLMM_PROGRAM_ID, poolId, TickUtils.getTickArrayStartIndexByTick(tick, 10)).publicKey) ]) } });
  const state = { slot: 200, accounts, fee: 75000, sends: [], reads: 0, accountTransform: (value) => value, genesisHash: SOLANA_GENESIS_HASHES.mainnet };
  const connection = { getGenesisHash: async () => state.genesisHash,
    getMultipleAccountsInfoAndContext: async (keys) => { state.reads++; return { context: { slot: state.slot }, value: keys.map((address) => state.accountTransform(accounts.get(address.toBase58()) || null, address)) }; },
    getEpochInfo: async () => ({ epoch: 100 }), getMinimumBalanceForRentExemption: async (size) => size * 10 + 2037630,
    getAddressLookupTable: async () => ({ context: { slot: state.slot }, value: table }),
    getLatestBlockhash: async () => ({ blockhash: key(80).toBase58(), lastValidBlockHeight: 400 }),
    getFeeForMessage: async () => ({ context: { slot: state.slot }, value: state.fee }) };
  const input = { connection, network: 'mainnet', expectedGenesisHash: SOLANA_GENESIS_HASHES.mainnet, walletPublicKey: wallet.toBase58(),
    poolId: poolId.toBase58(), nftMint: nft.toBase58(), expectedLiquidity: '1000000000', requestId: 'withdraw-one', lookupTables: [tableKey.toBase58()] };
  return { state, connection, input, table, mint, nft, poolId, position, nftAccount, destination, outputProgram, nftProgram, vaults, sorted, set };
}

// An instruction-driven RPC fixture for storage and recovery tests. The CLMM
// payout is fixed; wire layout and account effects are checked independently.
export function enableWithdrawalExecution(f) {
  const { state, connection, table, accounts = state.accounts } = f;
  Object.assign(state, { receipts: new Map(), beforeSend: null, afterSend: null, receiptTransform: (value) => value,
    status: 'finalized', fail: false, drop: false, blockhash: key(80).toBase58(), height: 200, valid: true, outputRaw: 5100000n });
  const get = (address) => accounts.get(address.toBase58());
  const balanceRows = (keys) => keys.flatMap((address, accountIndex) => {
    const account = get(address);
    if (!account || ![TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()].includes(account.owner.toBase58())
        || account.data.length < 165 || account.data.length > 165 && account.data[165] !== 2) return [];
    const row = AccountLayout.decode(account.data), mint = MintLayout.decode(get(row.mint).data);
    return [{ accountIndex, mint: row.mint.toBase58(), owner: row.owner.toBase58(), programId: account.owner.toBase58(),
      uiTokenAmount: { amount: row.amount.toString(), decimals: mint.decimals, uiAmount: null } }];
  });
  const move = (from, to, amount) => {
    const source = get(from), destination = get(to), a = AccountLayout.decode(source.data), b = AccountLayout.decode(destination.data);
    a.amount -= amount; b.amount += amount; AccountLayout.encode(a, source.data); AccountLayout.encode(b, destination.data);
    if (a.isNativeOption) { source.lamports -= Number(amount); destination.lamports += Number(amount); }
  };
  const close = (address) => { get(withdrawalWallet.publicKey).lamports += get(address).lamports; accounts.delete(address.toBase58()); };
  Object.assign(connection, {
    getLatestBlockhash: async () => ({ blockhash: state.blockhash, lastValidBlockHeight: state.height + 150 }),
    getBlockHeight: async () => state.height,
    isBlockhashValid: async () => ({ context: { slot: state.slot }, value: state.valid }),
    getSignatureStatuses: async ([signature]) => ({ context: { slot: state.slot }, value: [state.receipts.has(signature) && state.status
      ? { slot: state.receipts.get(signature).slot, confirmations: null, err: state.receipts.get(signature).meta.err, confirmationStatus: state.status } : null] }),
    getTransaction: async (signature) => state.receiptTransform(state.receipts.get(signature) || null),
    async sendRawTransaction(bytes) {
      const signed = inspectSolanaTransaction(bytes); await state.beforeSend?.(signed); state.sends.push(signed);
      if (!state.receipts.has(signed.signature) && !state.drop) {
        const tx = VersionedTransaction.deserialize(bytes), decoded = TransactionMessage.decompile(tx.message, { addressLookupTableAccounts: [table] });
        const resolved = tx.message.getAccountKeys({ addressLookupTableAccounts: [table] });
        const keys = Array.from({ length: resolved.length }, (_, i) => resolved.get(i));
        const preBalances = keys.map((key) => get(key)?.lamports || 0), preTokenBalances = balanceRows(keys);
        for (const ix of state.fail ? [] : decoded.instructions) {
          if (ix.programId.equals(SystemProgram.programId)) {
            const create = SystemInstruction.decodeCreateWithSeed(ix);
            assert.ok(create.basePubkey.equals(withdrawalWallet.publicKey)); assert.ok(create.fromPubkey.equals(withdrawalWallet.publicKey));
            assert.equal(get(create.newAccountPubkey), undefined); assert.equal(create.space, 165);
            f.set(create.newAccountPubkey, info(create.programId, Buffer.alloc(165), Number(create.lamports)));
            get(withdrawalWallet.publicKey).lamports -= Number(create.lamports);
          } else if (ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) {
            const [payer, destination, wallet, mint] = ix.keys.map((key) => key.pubkey), program = ix.keys[5].pubkey;
            assert.ok(payer.equals(withdrawalWallet.publicKey)); assert.ok(wallet.equals(withdrawalWallet.publicKey));
            const prior = get(destination);
            if (!prior || prior.owner.equals(SystemProgram.programId)) {
              const data = unpackMint(mint, get(mint), program), types = program.equals(TOKEN_2022_PROGRAM_ID)
                ? [...new Set([ExtensionType.ImmutableOwner, ...getExtensionTypes(data.tlvData).map(getAccountTypeOfMintType).filter((type) => type !== 0)])] : [];
              const size = getAccountLen(types), rent = size * 10 + 2037630, paid = Math.max(0, rent - (prior?.lamports || 0));
              const bytes = Buffer.alloc(size); tokenData(mint, wallet, 0n).copy(bytes); if (size > 165) bytes[165] = 2;
              f.set(destination, info(program, bytes, (prior?.lamports || 0) + paid)); get(wallet).lamports -= paid;
            }
          } else if (ix.programId.equals(TOKEN_PROGRAM_ID)) {
            const address = ix.keys[0].pubkey;
            if (ix.data[0] === 18) tokenData(NATIVE_MINT, withdrawalWallet.publicKey, 0n, true).copy(get(address).data);
            else if (ix.data[0] === 9) close(address);
            else assert.fail('Expected initialize or close native account');
          } else if (ix.programId.equals(CLMM_PROGRAM_ID)) {
            if (ix.data.length === 40) {
              assert.deepEqual([...ix.data.subarray(0, 8)], [58, 127, 188, 62, 79, 82, 196, 96]);
              const position = PositionInfoLayout.decode(get(f.position).data);
              assert.equal(ix.data.readBigUInt64LE(8), BigInt(position.liquidity.toString()));
              assert.equal(ix.data.readBigUInt64LE(16), 0n);
              assert.ok(ix.data.readBigUInt64LE(24) <= state.outputRaw); assert.ok(ix.data.readBigUInt64LE(32) <= state.outputRaw);
              for (const [source, destination] of [[5, 9], [6, 10]]) move(ix.keys[source].pubkey, ix.keys[destination].pubkey, state.outputRaw);
              const pool = PoolInfoLayout.decode(get(f.poolId).data);
              for (const reward of pool.rewardInfos.filter((row) => !row.tokenMint.equals(PublicKey.default))) {
                const destination = getAssociatedTokenAddressSync(reward.tokenMint, withdrawalWallet.publicKey);
                move(reward.tokenVault, destination, 1234n);
              }
              position.liquidity = new BN(0); PositionInfoLayout.encode(position, get(f.position).data);
            } else {
              assert.deepEqual([...ix.data], [123, 134, 81, 0, 49, 68, 98, 98]);
              close(f.position); close(f.nftAccount);
              if (f.nftProgram.equals(TOKEN_2022_PROGRAM_ID)) close(f.nft);
              else { const mint = MintLayout.decode(get(f.nft).data); mint.supply = 0n; MintLayout.encode(mint, get(f.nft).data); }
            }
          } else assert.ok(ix.programId.equals(ComputeBudgetProgram.programId));
        }
        get(withdrawalWallet.publicKey).lamports -= state.fee; state.slot++;
        const postBalances = keys.map((key) => get(key)?.lamports || 0), postTokenBalances = balanceRows(keys);
        state.receipts.set(signed.signature, { slot: state.slot, transaction: { signatures: tx.signatures.map((row) => bs58.encode(row)), message: tx.message },
          meta: { err: state.fail ? { InstructionError: [3, { Custom: 6001 }] } : null, fee: state.fee, preBalances, postBalances, preTokenBalances, postTokenBalances,
            loadedAddresses: tx.message.resolveAddressTableLookups([table]) } });
      }
      await state.afterSend?.(signed); return signed.signature;
    },
  });
  return f;
}
