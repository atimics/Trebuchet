import { Keypair, Transaction } from '@solana/web3.js';
import { createProfileJournalStore } from '../../packages/runtime/src/profile-stores.js';
import { tokenTransferChain, sweepWallet, sweepDestination } from '../../packages/runtime/test/fixtures/token-transfer-chain.mjs';
import { createWalletExecutionRuntime } from '../../walletExecution.js';
import { createAirdropExecutionRuntime } from '../../airdropExecution.js';

export { sweepWallet };
export const recipients = [sweepDestination, Keypair.fromSeed(new Uint8Array(32).fill(58)).publicKey.toBase58()].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
export const airdropInput = { tokenMint: Keypair.fromSeed(new Uint8Array(32).fill(34)).publicKey.toBase58(), tokenDecimals: 6,
  recipients: recipients.map((wallet) => ({ wallet, tokens: '2.5' })), tempWalletSecretKey: Array.from(sweepWallet.secretKey) };
export function airdropChain(options = {}) {
  const ledgers = recipients.map((destinationWallet) => tokenTransferChain({ associatedSource: true, destinationWallet, ...options }));
  const first = ledgers[0];
  for (const ledger of ledgers.slice(1)) {
    for (const property of ['balance', 'sourceAmount', 'receipts', 'sends', 'beforeSend', 'afterSend', 'status', 'slot', 'height', 'valid', 'blockhash', 'accountSlot']) {
      Object.defineProperty(ledger.state, property, { get: () => first.state[property], set: (value) => { first.state[property] = value; }, configurable: true });
    }
  }
  const reads = ledgers.map((ledger) => ledger.connection.getMultipleAccountsInfoAndContext);
  const sends = ledgers.map((ledger) => ledger.connection.sendRawTransaction);
  const connection = { ...first.connection,
    getMultipleAccountsInfoAndContext: (keys, options) => {
      const index = ledgers.findIndex((ledger) => keys.some((key) => key.equals(ledger.destination)));
      return reads[index < 0 ? 0 : index](keys, options);
    },
    sendRawTransaction: (wire) => {
      const tx = Transaction.from(wire), destination = tx.instructions.at(-1).keys[2].pubkey;
      const index = ledgers.findIndex((ledger) => ledger.destination.equals(destination));
      if (index < 0) throw new Error('Use a fixture recipient');
      return sends[index](wire);
    },
  };
  return { ...first, connection, ledgers };
}
export function airdropContext({ owner, connection, updateJournal, seedPlan = true }) {
  const journal = createProfileJournalStore(owner.profile), walletPublicKey = sweepWallet.publicKey.toBase58();
  if (!journal.activeForWallet(walletPublicKey)) {
    journal.start({ walletPublicKey });
    journal.upsertForWallet(walletPublicKey, { token: { mint: airdropInput.tokenMint },
      ...(seedPlan ? { poolPlan: { airdropPlan: { tokenMint: airdropInput.tokenMint, tokenDecimals: 6, recipients: airdropInput.recipients } } } : {}) });
  }
  const walletExecution = createWalletExecutionRuntime({ owner, getScopeId: (wallet) => journal.activeForWallet(wallet)?.id,
    networkForRequest: () => 'devnet', createConnection: () => connection, timeoutMs: 0 });
  const runtime = createAirdropExecutionRuntime({ owner, walletExecution, getJournal: (wallet) => journal.activeForWallet(wallet),
    createConnection: () => connection, updateJournal: updateJournal || ((wallet, patch, event) => journal.upsertForWallet(wallet, patch, event)), networkForRequest: () => 'devnet', paceMs: 0 });
  return { journal, walletExecution, runtime };
}
