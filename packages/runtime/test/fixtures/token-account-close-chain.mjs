import assert from 'node:assert/strict';
import { Keypair, PublicKey, SystemProgram, Transaction, VersionedTransaction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, AccountLayout, ExtensionType, TransferFeeAmountLayout, decodeCloseAccountInstruction } from '@solana/spl-token';
import { SOLANA_GENESIS_HASHES, inspectSolanaTransaction } from '../../src/solana.js';

export const wallet = Keypair.fromSeed(new Uint8Array(32).fill(41));
export const walletPublicKey = wallet.publicKey.toBase58();
export const key = (seed) => Keypair.fromSeed(new Uint8Array(32).fill(seed)).publicKey;
const extension = (type, data) => { const head = Buffer.alloc(4); head.writeUInt16LE(type); head.writeUInt16LE(data.length, 2); return Buffer.concat([head, data]); };

function accountData({ owner = wallet.publicKey, amount = 0n, closeAuthority = null, token2022 = false, withheld = null }) {
  const base = Buffer.alloc(165);
  AccountLayout.encode({ mint: key(50), owner, amount, delegateOption: 0, delegate: SystemProgram.programId, state: 1,
    isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: closeAuthority ? 1 : 0, closeAuthority: closeAuthority || SystemProgram.programId }, base);
  if (!token2022) return base;
  const extensions = [extension(ExtensionType.ImmutableOwner, Buffer.alloc(0))];
  if (withheld !== null) { const fee = Buffer.alloc(TransferFeeAmountLayout.span); TransferFeeAmountLayout.encode({ withheldAmount: withheld }, fee); extensions.push(extension(ExtensionType.TransferFeeAmount, fee)); }
  return Buffer.concat([base, Buffer.from([2]), ...extensions]);
}

// A local ledger: token accounts, the wallet's SOL, and real signed close transactions.
export function closeChain() {
  const state = { balance: 1_000_000, fee: 5000, slot: 300, status: 'finalized', genesisHash: SOLANA_GENESIS_HASHES.devnet,
    accounts: new Map(), sends: [], receipts: new Map(), afterSend: null, receiptTransform: (receipt) => receipt };
  const add = (seed, options = {}) => {
    const address = key(seed).toBase58();
    state.accounts.set(address, { owner: options.token2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID, lamports: options.token2022 ? 2_074_080 : 2_039_280, data: accountData(options) });
    return address;
  };
  const info = (address) => {
    if (address === walletPublicKey) return { owner: SystemProgram.programId, lamports: state.balance, data: Buffer.alloc(0), executable: false, rentEpoch: 0 };
    const row = state.accounts.get(address);
    return row ? { ...row, executable: false, rentEpoch: 0 } : null;
  };
  const connection = {
    getGenesisHash: async () => state.genesisHash,
    getBalanceAndContext: async () => ({ context: { slot: state.slot }, value: state.balance }),
    getRecentPrioritizationFees: async () => [],
    getTokenAccountsByOwner: async (owner, { programId }) => ({ context: { slot: state.slot }, value: [...state.accounts.entries()]
      .filter(([, row]) => row.owner.equals(programId)).map(([address, row]) => ({ pubkey: new PublicKey(address), account: { ...row, executable: false, rentEpoch: 0 } })) }),
    getMultipleAccountsInfoAndContext: async (keys) => ({ context: { slot: state.slot }, value: keys.map((value) => info(value.toBase58())) }),
    getLatestBlockhash: async () => ({ blockhash: key(51).toBase58(), lastValidBlockHeight: 900 }),
    getBlockHeight: async () => state.slot,
    isBlockhashValid: async () => ({ context: { slot: state.slot }, value: true }),
    getFeeForMessage: async () => ({ context: { slot: state.slot }, value: state.fee }),
    getSignatureStatuses: async ([signature]) => ({ context: { slot: state.slot }, value: [state.receipts.has(signature) && state.status
      ? { slot: state.slot, confirmations: null, err: null, confirmationStatus: state.status } : null] }),
    async sendRawTransaction(bytes) {
      const inspected = inspectSolanaTransaction(bytes);
      state.sends.push(inspected);
      if (!state.receipts.has(inspected.signature)) {
        const message = VersionedTransaction.deserialize(bytes).message, keys = message.staticAccountKeys.map((value) => value.toBase58());
        const pre = keys.map((value) => info(value)?.lamports || 0);
        for (const instruction of Transaction.from(bytes).instructions.slice(2)) {
          const decoded = decodeCloseAccountInstruction(instruction, instruction.programId);
          const address = decoded.keys.account.pubkey.toBase58(), row = state.accounts.get(address);
          assert.equal(decoded.keys.destination.pubkey.toBase58(), walletPublicKey);
          assert.equal(decoded.keys.authority.pubkey.toBase58(), walletPublicKey);
          state.balance += row.lamports; state.accounts.delete(address);
        }
        state.balance -= state.fee;
        const post = keys.map((value) => info(value)?.lamports || 0);
        state.receipts.set(inspected.signature, { slot: state.slot, meta: { err: null, fee: state.fee, preBalances: pre, postBalances: post }, transaction: { message, signatures: [inspected.signature] } });
      }
      await state.afterSend?.(inspected);
      return inspected.signature;
    },
    getTransaction: async (signature) => state.receiptTransform(state.receipts.get(signature) || null),
  };
  return { state, connection, add, info };
}

