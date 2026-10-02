import assert from 'node:assert/strict';
import { Keypair, SystemInstruction, Transaction, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { SOLANA_GENESIS_HASHES, inspectSolanaTransaction } from '../../src/solana.js';

export const sweepWallet = Keypair.fromSeed(new Uint8Array(32).fill(31));
export const sweepDestination = Keypair.fromSeed(new Uint8Array(32).fill(32)).publicKey.toBase58();

// Real signed Solana messages, with a local ledger for balances and receipts.
export function solSweepChain() {
  const state = {
    balance: 10_000_000, fee: 6000, slot: 200, status: 'finalized',
    genesisHash: SOLANA_GENESIS_HASHES.devnet, sends: [], receipts: new Map(),
    beforeSend: null, afterSend: null, receiptTransform: (receipt) => receipt,
  };
  const connection = {
    getGenesisHash: async () => state.genesisHash,
    getBalanceAndContext: async () => ({ context: { slot: state.slot }, value: state.balance }),
    getLatestBlockhash: async () => ({ blockhash: Keypair.fromSeed(new Uint8Array(32).fill(33)).publicKey.toBase58(), lastValidBlockHeight: 400 }),
    getBlockHeight: async () => state.slot,
    isBlockhashValid: async () => ({ context: { slot: state.slot }, value: true }),
    getFeeForMessage: async () => ({ context: { slot: state.slot }, value: state.fee }),
    getMinimumBalanceForRentExemption: async () => 890880,
    getRecentPrioritizationFees: async () => [],
    getSignatureStatuses: async ([signature], options) => {
      assert.equal(options.searchTransactionHistory, true);
      return { context: { slot: state.slot }, value: [state.receipts.has(signature) && state.status
        ? { slot: state.slot, confirmations: null, err: null, confirmationStatus: state.status } : null] };
    },
    async sendRawTransaction(bytes) {
      const inspected = inspectSolanaTransaction(bytes);
      await state.beforeSend?.(inspected);
      state.sends.push(inspected);
      if (!state.receipts.has(inspected.signature)) {
        const transaction = Transaction.from(bytes);
        const transfer = SystemInstruction.decodeTransfer(transaction.instructions[2]);
        const amount = Number(transfer.lamports);
        assert.equal(transfer.fromPubkey.toBase58(), sweepWallet.publicKey.toBase58());
        const message = VersionedTransaction.deserialize(bytes).message;
        const keys = message.staticAccountKeys;
        const destinationIndex = keys.findIndex((key) => key.equals(transfer.toPubkey));
        const preBalances = keys.map((_, index) => index === 0 ? state.balance : 1000);
        const postBalances = [...preBalances];
        postBalances[0] -= amount + state.fee;
        postBalances[destinationIndex] += amount;
        assert.ok(postBalances[0] >= 0);
        state.balance = postBalances[0];
        state.receipts.set(inspected.signature, {
          slot: state.slot, blockTime: 1700000000,
          meta: { err: null, fee: state.fee, preBalances, postBalances },
          transaction: { message, signatures: [inspected.signature] },
        });
      }
      await state.afterSend?.(inspected);
      return inspected.signature;
    },
    async getTransaction(signature) {
      return state.receiptTransform(state.receipts.get(signature) || null);
    },
  };
  const rpcReceipt = (signature) => {
    const receipt = state.receipts.get(signature);
    if (!receipt) return null;
    const message = receipt.transaction.message;
    return { ...receipt, transaction: { signatures: receipt.transaction.signatures, message: {
      header: message.header, accountKeys: message.staticAccountKeys.map((key) => key.toBase58()), recentBlockhash: message.recentBlockhash,
      instructions: message.compiledInstructions.map((instruction) => ({ programIdIndex: instruction.programIdIndex, accounts: instruction.accountKeyIndexes, data: bs58.encode(instruction.data) })),
    } } };
  };
  return { state, connection, rpcReceipt };
}
