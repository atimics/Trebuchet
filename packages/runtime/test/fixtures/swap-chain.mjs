import assert from 'node:assert/strict';
import { Keypair, PublicKey, SystemProgram, SystemInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, NATIVE_MINT, ASSOCIATED_TOKEN_PROGRAM_ID, AccountLayout, MintLayout, getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction, createCloseAccountInstruction } from '@solana/spl-token';
import { inspectSolanaTransaction, SOLANA_GENESIS_HASHES } from '../../src/solana.js';
import { readSwapInstruction, SWAP_PROGRAMS } from '../../src/swap-instruction.js';
import { key, wallet, mint, source, destination, intent, jupiter, raydium, raydiumAccount } from './swap-instructions.mjs';

export const swapWallet = Keypair.fromSeed(new Uint8Array(32).fill(43));
export { wallet, mint, source, destination, intent };
export const compileSwap = (instructions) => new VersionedTransaction(new TransactionMessage({ payerKey: wallet, recentBlockhash: key(80).toBase58(), instructions }).compileToLegacyMessage());
const output = (token2022) => {
  const program = token2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  return { program, account: getAssociatedTokenAddressSync(mint, wallet, false, program), size: token2022 ? 170 : 165 };
};
export const swapSetup = (token2022 = false) => {
  const out = output(token2022);
  return [createAssociatedTokenAccountIdempotentInstruction(wallet, source, wallet, NATIVE_MINT),
    createAssociatedTokenAccountIdempotentInstruction(wallet, out.account, wallet, mint, out.program),
    SystemProgram.transfer({ fromPubkey: wallet, toPubkey: source, lamports: 50000 }), createSyncNativeInstruction(source)];
};
export const swapCleanup = () => createCloseAccountInstruction(source, wallet, wallet);
export const swapTransactions = (combined = false, { token2022 = false, provider = 'jupiter' } = {}) => {
  const out = output(token2022), trade = provider.startsWith('raydium') ? raydium('mainnet', { outputProgram: out.program, outputAccount: out.account }) : jupiter();
  if (provider === 'jupiter') {
    trade.keys[3].pubkey = out.account;
    if (token2022) trade.keys.push({ pubkey: out.program, isWritable: false, isSigner: false });
  }
  const setup = provider === 'raydium-api' ? [raydiumAccount('wrap')] : swapSetup(token2022);
  const cleanup = provider === 'raydium-api' ? raydiumAccount('close') : swapCleanup();
  return combined ? [compileSwap([...setup, trade, cleanup])]
    : [compileSwap(setup), compileSwap([trade]), compileSwap([cleanup])];
};

export function swapChain({ token2022 = false } = {}) {
  const out = output(token2022), destinationAddress = out.account;
  const state = { slot: 200, fee: 5000, walletLamports: 20000000, sends: [], receipts: new Map(), status: 'finalized',
    source: null, destination: null, beforeSend: null, afterSend: null, genesisHash: SOLANA_GENESIS_HASHES.mainnet,
    failAt: null, blockhash: key(80).toBase58(), height: 200, valid: true, outputRaw: 1250n, drop: false, receiptTransform: (r) => r };
  const rent = (size) => (128 + size) * 6960;
  const mints = new Map([[NATIVE_MINT.toBase58(), 9], [mint.toBase58(), 6]]);
  const info = (address) => {
    const pk = address.toBase58(), base = { executable: false, rentEpoch: 0 };
    if (pk === wallet.toBase58()) return { ...base, owner: SystemProgram.programId, lamports: state.walletLamports, data: Buffer.alloc(0) };
    if (mints.has(pk)) {
      const data = Buffer.alloc(82);
      MintLayout.encode({ mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply: 1000000000000n, decimals: mints.get(pk), isInitialized: true,
        freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, data);
      return { ...base, owner: pk === NATIVE_MINT.toBase58() ? TOKEN_PROGRAM_ID : out.program, lamports: rent(82), data };
    }
    const native = pk === source.toBase58(), record = native ? state.source : pk === destinationAddress.toBase58() ? state.destination : null;
    if (!record) return null;
    if (record.system) return { ...base, owner: SystemProgram.programId, lamports: record.lamports, data: Buffer.alloc(0) };
    const data = Buffer.alloc(165);
    AccountLayout.encode({ mint: native ? NATIVE_MINT : mint, owner: record.owner || wallet, amount: record.amount, delegateOption: 0,
      delegate: PublicKey.default, state: record.frozen ? 2 : 1, isNativeOption: native ? 1 : 0, isNative: native ? BigInt(rent(165)) : 0n,
      delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default }, data);
    return { ...base, owner: native ? TOKEN_PROGRAM_ID : out.program, lamports: record.lamports, data: !native && token2022 ? Buffer.concat([data, Buffer.from([2, 7, 0, 0, 0])]) : data };
  };
  const tokenBalances = (keys) => keys.flatMap((address, accountIndex) => {
    const native = address.equals(source), record = native ? state.source : address.equals(destinationAddress) ? state.destination : null;
    return record && !record.system ? [{ accountIndex, mint: (native ? NATIVE_MINT : mint).toBase58(), owner: (record.owner || wallet).toBase58(), programId: (native ? TOKEN_PROGRAM_ID : out.program).toBase58(),
      uiTokenAmount: { amount: record.amount.toString(), decimals: native ? 9 : 6, uiAmount: null } }] : [];
  });
  const connection = {
    getGenesisHash: async () => state.genesisHash,
    getMultipleAccountsInfoAndContext: async (keys) => ({ context: { slot: state.slot }, value: keys.map(info) }),
    getMinimumBalanceForRentExemption: async (size) => rent(size),
    getLatestBlockhash: async () => ({ blockhash: state.blockhash, lastValidBlockHeight: state.height + 150 }),
    getFeeForMessage: async () => ({ context: { slot: state.slot }, value: state.fee }),
    getBlockHeight: async () => state.height,
    isBlockhashValid: async () => ({ context: { slot: state.slot }, value: state.valid }),
    getSignatureStatuses: async ([signature]) => ({ context: { slot: state.slot }, value: [state.receipts.has(signature) && state.status
      ? { slot: state.receipts.get(signature).slot, confirmations: null, err: state.receipts.get(signature).meta.err, confirmationStatus: state.status } : null] }),
    getTransaction: async (signature) => state.receiptTransform(state.receipts.get(signature) || null),
    async sendRawTransaction(bytes) {
      const saved = inspectSolanaTransaction(bytes); await state.beforeSend?.(saved); state.sends.push(saved);
      if (!state.receipts.has(saved.signature) && !state.drop) {
        const tx = VersionedTransaction.deserialize(bytes), decoded = TransactionMessage.decompile(tx.message), keys = tx.message.staticAccountKeys;
        const preBalances = keys.map((key) => info(key)?.lamports || 0), preTokenBalances = tokenBalances(keys);
        const failed = state.failAt === state.sends.length - 1;
        const createAssociated = (name) => {
          if (!state[name] || state[name].system) {
            const reserve = rent(name === 'source' ? 165 : out.size), prior = state[name]?.lamports || 0, added = Math.max(0, reserve - prior);
            state[name] = { amount: name === 'source' ? BigInt(prior + added - reserve) : 0n, lamports: prior + added }; state.walletLamports -= added;
          }
        };
        for (const ix of failed ? [] : decoded.instructions) {
          if (ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) {
            const name = ix.keys[1].pubkey.equals(source) ? 'source' : 'destination';
            createAssociated(name);
          } else if (ix.programId.equals(SystemProgram.programId)) {
            const transfer = SystemInstruction.decodeTransfer(ix);
            assert.equal(transfer.toPubkey.toBase58(), source.toBase58());
            state.walletLamports -= Number(transfer.lamports); state.source.lamports += Number(transfer.lamports);
          } else if (ix.programId.equals(TOKEN_PROGRAM_ID)) {
            if (ix.data[0] === 17) state.source.amount = BigInt(state.source.lamports - rent(165));
            else if (ix.data[0] === 9) { state.walletLamports += state.source.lamports; state.source = null; }
            else assert.fail('reviewed token fixture instruction');
          } else if ([SWAP_PROGRAMS.jupiter, SWAP_PROGRAMS.raydium].includes(ix.programId.toBase58())) {
            if (ix.programId.toBase58() === SWAP_PROGRAMS.raydium && ix.data[0] === 5) {
              createAssociated('source');
              const lamports = Number(ix.data.readBigUInt64LE(1)); state.walletLamports -= lamports; state.source.lamports += lamports;
              state.source.amount = BigInt(state.source.lamports - rent(165)); continue;
            }
            if (ix.programId.toBase58() === SWAP_PROGRAMS.raydium && ix.data[0] === 6) { state.walletLamports += state.source.lamports; state.source = null; continue; }
            if (ix.programId.toBase58() === SWAP_PROGRAMS.raydium) createAssociated('destination');
            const trade = readSwapInstruction(ix, intent);
            state.source.amount -= BigInt(trade.inputAmountRaw); state.source.lamports -= Number(trade.inputAmountRaw);
            assert.ok(state.source.amount >= 0n); state.destination.amount += state.outputRaw;
          } else if (ix.programId.toBase58() === 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr') {
            assert.equal(ix.keys.length, 0); assert.match(ix.data.toString(), /^trebuchet-swap-cleanup:[a-f0-9]{64}$/);
          } else assert.fail('reviewed fixture instruction');
        }
        state.walletLamports -= state.fee; state.slot++;
        state.receipts.set(saved.signature, { slot: state.slot, transaction: { message: tx.message, signatures: [saved.signature] }, meta: {
          err: failed ? { InstructionError: [0, { Custom: 1 }] } : null, fee: state.fee, preBalances, postBalances: keys.map((key) => info(key)?.lamports || 0), preTokenBalances, postTokenBalances: tokenBalances(keys),
        } });
      }
      await state.afterSend?.(saved); return saved.signature;
    },
  };
  return { connection, state, rent, intent: { ...intent, outputProgramId: out.program.toBase58(), destinationTokenAccount: out.account.toBase58() } };
}
