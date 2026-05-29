// test/helpers/mockTradeApi.mjs
//
// Network-free fake of the Raydium Trade API surface that swapService.js
// drives during SOL→quote acquisition. Wired in through the
// setTradeApiFactoryForTests DI seam.
//
// Covers:
//   - fetchQuote:  returns plausible success/no-route responses
//   - fetchTransactions: returns base64-encoded transactions that
//     VersionedTransaction.deserialize can parse, with the caller's
//     wallet as fee payer so signAndSendTradeApiTx works end-to-end.
//   - Failure injection: RPC timeout, no-route, HTTP 5xx, partial fill

import { Transaction, VersionedTransaction, PublicKey } from '@solana/web3.js';

// ---------------------------------------------------------------------------
// Build a base64-encoded VersionedTransaction with the given wallet as fee
// payer. The transaction has no instructions (just fee payer + blockhash)
// which is enough for signAndSendTradeApiTx to deserialize + sign + submit.
// ---------------------------------------------------------------------------
function makeBase64TxForWallet(walletPubkey) {
  const payer = new PublicKey(walletPubkey);
  const tx = new Transaction();
  tx.feePayer = payer;
  tx.recentBlockhash = 'GfVcyD4kkTrj4bKc7WA9sZCYoRn3Qh8bBLqxMcV2mEr';
  const message = tx.compileMessage();
  const vtx = new VersionedTransaction(message);
  return Buffer.from(vtx.serialize()).toString('base64');
}

// ---------------------------------------------------------------------------
// Trade API mock builder
// ---------------------------------------------------------------------------

/**
 * Build a fake Trade API for injection via setTradeApiFactoryForTests.
 *
 * Options:
 *   - quoteResult: 'success' (default) | 'no-route' | 'http-error' | 'timeout'
 *   - quoteOutputAmount: raw token amount returned (string, default '500000')
 *   - txResult: 'success' (default) | 'http-error' | 'timeout'
 */
export function makeMockTradeApi({
  quoteResult = 'success',
  quoteOutputAmount = '500000',
  txResult = 'success',
} = {}) {
  let quoteCalls = 0;
  let txCalls = 0;

  async function fetchQuote({ inputMint, outputMint, amountLamports, slippageBps }) {
    quoteCalls += 1;
    void inputMint, outputMint, amountLamports, slippageBps;

    if (quoteResult === 'timeout') {
      throw new Error('The operation was aborted');
    }
    if (quoteResult === 'http-error') {
      throw new Error('Trade API quote: HTTP 503');
    }
    if (quoteResult === 'no-route') {
      throw new Error('Trade API quote failed: no route found');
    }

    return {
      success: true,
      data: {
        inputAmount: amountLamports || '1000000',
        outputAmount: quoteOutputAmount,
      },
    };
  }

  async function fetchTransactions({ swapResponse, walletPubkey, priorityFeeMicroLamports }) {
    txCalls += 1;
    void swapResponse, priorityFeeMicroLamports;

    if (txResult === 'timeout') {
      throw new Error('The operation was aborted');
    }
    if (txResult === 'http-error') {
      throw new Error('Trade API build: HTTP 503');
    }

    // Build transactions where the caller's wallet is the fee payer,
    // so signAndSendTradeApiTx doesn't fail with "non signer key".
    const tx = makeBase64TxForWallet(walletPubkey);
    return [tx, tx];
  }

  return { fetchQuote, fetchTransactions };
}
