import { Keypair } from '@solana/web3.js';
import { swapChain, swapTransactions } from './swap-chain.mjs';

export function quoteAcquisitionChain({ combined = true } = {}) {
  const mints = [44, 45].map((seed) => Keypair.fromSeed(new Uint8Array(32).fill(seed)).publicKey);
  const ledgers = mints.map((outputMint) => swapChain({ outputMint }));
  const purchases = ledgers.map((ledger, index) => ({ intent: ledger.intent, feeCeilingLamports: 10000,
    transactions: swapTransactions(combined, { provider: 'raydium-api', outputMint: mints[index] }) }));
  let current = 0;
  const state = { advanceBlockhash: true, blockhash: ledgers[0].state.blockhash };
  const findLedger = (signature) => ledgers.find((ledger) => ledger.state.receipts.has(signature)) || ledgers[current];
  const connection = { ...ledgers[0].connection,
    getMultipleAccountsInfoAndContext: async (keys) => {
      const index = ledgers.findIndex((ledger) => keys.some((key) => key.toBase58() === ledger.intent.outputMint));
      if (index >= 0 && index !== current) {
        ledgers[index].state.walletLamports = ledgers[current].state.walletLamports;
        ledgers[index].state.source = ledgers[current].state.source;
        ledgers[index].state.slot = ledgers[current].state.slot;
        current = index;
      }
      return ledgers[current].connection.getMultipleAccountsInfoAndContext(keys);
    },
    getFeeForMessage: (...args) => ledgers[current].connection.getFeeForMessage(...args),
    getLatestBlockhash: async () => ({ blockhash: state.blockhash, lastValidBlockHeight: ledgers[current].state.height + 150 }),
    getSignatureStatuses: ([signature]) => findLedger(signature).connection.getSignatureStatuses([signature]),
    getTransaction: (signature) => findLedger(signature).connection.getTransaction(signature),
    async sendRawTransaction(bytes) {
      try { return await ledgers[current].connection.sendRawTransaction(bytes); }
      finally {
        if (state.advanceBlockhash) state.blockhash = Keypair.fromSeed(new Uint8Array(32).fill(80 + ledgers.reduce((count, ledger) => count + ledger.state.receipts.size, 0))).publicKey.toBase58();
      }
    },
  };
  return { ledgers, purchases, connection, state, slot: () => ledgers[current].state.slot };
}
