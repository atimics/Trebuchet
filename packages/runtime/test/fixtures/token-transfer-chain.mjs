import assert from 'node:assert/strict';
import { Keypair, PublicKey, SystemProgram, Transaction, VersionedTransaction } from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT,
  AccountLayout, MintLayout, ExtensionType, TransferFeeConfigLayout, TransferFeeAmountLayout,
  decodeTransferCheckedInstruction, decodeTransferCheckedWithFeeInstruction, getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { inspectSolanaTransaction } from '../../src/solana.js';
import { solSweepChain, sweepWallet, sweepDestination } from './sol-sweep-chain.mjs';

export { sweepWallet, sweepDestination };
const key = (seed) => Keypair.fromSeed(new Uint8Array(32).fill(seed)).publicKey;
const emptyKey = SystemProgram.programId;
const extension = (type, data) => {
  const header = Buffer.alloc(4); header.writeUInt16LE(type); header.writeUInt16LE(data.length, 2);
  return Buffer.concat([header, data]);
};

export function tokenTransferChain({ token2022 = false, transferFee = false, native = false, decimals = 6, sourceAmount = 5_000_000n, destinationExists = false, associatedSource = false, destinationWallet = sweepDestination } = {}) {
  const ledger = solSweepChain();
  const { state, connection } = ledger;
  const program = token2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  const mint = native ? NATIVE_MINT : key(34), source = associatedSource ? getAssociatedTokenAddressSync(mint, sweepWallet.publicKey, false, program) : key(35);
  const destination = getAssociatedTokenAddressSync(mint, new PublicKey(destinationWallet), false, program);
  Object.assign(state, { fee: 11000, decimals, sourceAmount, destinationAmount: 0n, destinationExists, sourceOwner: sweepWallet.publicKey, frozen: false,
    accountSlot: state.slot, rentSizes: [], native, sourceLamports: 2_100_000 + (native ? Number(sourceAmount) : 0), destinationLamports: destinationExists ? 2_100_000 : 0 });
  const feeSchedule = { epoch: 0n, maximumFee: 5000n, transferFeeBasisPoints: 250 };
  const feeData = Buffer.alloc(TransferFeeConfigLayout.span);
  TransferFeeConfigLayout.encode({ transferFeeConfigAuthority: emptyKey, withdrawWithheldAuthority: emptyKey, withheldAmount: 0n, olderTransferFee: feeSchedule, newerTransferFee: feeSchedule }, feeData);
  const mintData = () => {
    const base = Buffer.alloc(82);
    MintLayout.encode({ mintAuthorityOption: 0, mintAuthority: emptyKey, supply: sourceAmount, decimals: state.decimals, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: emptyKey }, base);
    return transferFee ? Buffer.concat([base, Buffer.alloc(165 - 82), Buffer.from([1]), extension(ExtensionType.TransferFeeConfig, feeData)]) : base;
  };
  const accountData = (owner, quantity) => {
    const base = Buffer.alloc(165);
    AccountLayout.encode({ mint, owner, amount: quantity, delegateOption: 0, delegate: emptyKey, state: state.frozen ? 2 : 1,
      isNativeOption: native ? 1 : 0, isNative: native ? 2_100_000n : 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: emptyKey }, base);
    if (!token2022) return base;
    const extensions = [extension(ExtensionType.ImmutableOwner, Buffer.alloc(0))];
    if (transferFee) {
      const feeAmount = Buffer.alloc(TransferFeeAmountLayout.span);
      TransferFeeAmountLayout.encode({ withheldAmount: 0n }, feeAmount);
      extensions.push(extension(ExtensionType.TransferFeeAmount, feeAmount));
    }
    return Buffer.concat([base, Buffer.from([2]), ...extensions]);
  };
  const accountInfo = (address) => {
    const value = address.toBase58();
    const base = { executable: false, rentEpoch: 0 };
    if (value === sweepWallet.publicKey.toBase58()) return { ...base, owner: SystemProgram.programId, lamports: state.balance, data: Buffer.alloc(0) };
    if (value === mint.toBase58()) return { ...base, owner: program, lamports: 3_000_000, data: mintData() };
    if (value === source.toBase58()) return { ...base, owner: program, lamports: state.sourceLamports, data: accountData(state.sourceOwner, state.sourceAmount) };
    if (value === destination.toBase58() && state.destinationExists) return { ...base, owner: program, lamports: state.destinationLamports, data: accountData(new PublicKey(destinationWallet), state.destinationAmount) };
    return null;
  };
  connection.getAccountInfo = async (key) => accountInfo(key);
  connection.getMultipleAccountsInfoAndContext = async (keys) => ({ context: { slot: state.accountSlot }, value: keys.map(accountInfo) });
  connection.getEpochInfo = async () => ({ epoch: 10, absoluteSlot: state.slot });
  connection.getMinimumBalanceForRentExemption = async (size) => { state.rentSizes.push(size); return (128 + size) * 6960; };
  connection.getBalance = async () => state.balance;
  connection.getParsedTokenAccountsByOwner = async (_owner, { programId }) => ({ value: programId.equals(program) ? [{ pubkey: source,
    account: { data: { program: token2022 ? 'spl-token-2022' : 'spl-token', space: 165, parsed: { type: 'account', info: { mint: mint.toBase58(), tokenAmount: { amount: state.sourceAmount.toString(), decimals: state.decimals, uiAmount: Number(state.sourceAmount) / 10 ** state.decimals } } } } },
  }] : [] });
  connection.sendRawTransaction = async (bytes) => {
    const inspected = inspectSolanaTransaction(bytes);
    await state.beforeSend?.(inspected);
    state.sends.push(inspected);
    if (!state.receipts.has(inspected.signature)) {
      const tx = Transaction.from(bytes), instruction = tx.instructions.at(-1);
      const decoded = transferFee ? decodeTransferCheckedWithFeeInstruction(instruction, program) : decodeTransferCheckedInstruction(instruction, program);
      assert.equal(decoded.keys.source.pubkey.toBase58(), source.toBase58());
      assert.equal(decoded.keys.destination.pubkey.toBase58(), destination.toBase58());
      const sent = decoded.data.amount, charged = decoded.data.fee || 0n;
      const creation = tx.instructions.some((ix) => ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID));
      const rent = creation && !state.destinationExists ? (128 + (token2022 ? transferFee ? 182 : 170 : 165)) * 6960 : 0;
      const message = VersionedTransaction.deserialize(bytes).message;
      const keys = message.staticAccountKeys;
      const sourceIndex = keys.findIndex((k) => k.equals(source)), destinationIndex = keys.findIndex((k) => k.equals(destination));
      const preBalances = keys.map((key) => accountInfo(key)?.lamports || 0);
      const tokenEntry = (index, owner, quantity) => ({ accountIndex: index, mint: mint.toBase58(), owner: owner.toBase58(), programId: program.toBase58(), uiTokenAmount: { amount: quantity.toString(), decimals: state.decimals, uiAmount: null } });
      const preTokenBalances = [tokenEntry(sourceIndex, sweepWallet.publicKey, state.sourceAmount)];
      if (state.destinationExists) preTokenBalances.push(tokenEntry(destinationIndex, new PublicKey(destinationWallet), state.destinationAmount));
      state.sourceAmount -= sent; state.destinationAmount += sent - charged;
      assert.ok(state.sourceAmount >= 0n);
      state.balance -= state.fee + rent;
      state.sourceLamports -= native ? Number(sent) : 0;
      state.destinationLamports += rent + (native ? Number(sent) : 0);
      state.destinationExists = true;
      const postBalances = keys.map((key) => accountInfo(key)?.lamports || 0);
      state.receipts.set(inspected.signature, { slot: state.slot, blockTime: 1700000000, transaction: { message, signatures: [inspected.signature] },
        meta: { err: null, fee: state.fee, preBalances, postBalances, preTokenBalances,
          postTokenBalances: [tokenEntry(sourceIndex, sweepWallet.publicKey, state.sourceAmount), tokenEntry(destinationIndex, new PublicKey(destinationWallet), state.destinationAmount)] },
      });
    }
    await state.afterSend?.(inspected);
    return inspected.signature;
  };
  return { ...ledger, mint, source, destination, program, feeSchedule };
}
