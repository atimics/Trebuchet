const fail = (message) => Object.assign(new Error(message), { code: 'QUOTE_UNAVAILABLE' });
const endpoints = Object.freeze({ raydium: 'https://transaction-v1.raydium.io', jupiter: 'https://api.jup.ag/swap/v1' });

// Providers return public quotes and unsigned messages. Spending belongs to
// the reviewed acquisition plan and its transaction engine.
export function createQuoteProvider({ fetchImpl = fetch, timeoutMs = 15000, maxResponseBytes = 1024 * 1024, jupiterApiKey = process.env.JUPITER_API_KEY, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const json = async (url, body) => {
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await fetchImpl(url, { method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
          headers: { accept: 'application/json', ...(new URL(url).hostname === 'api.jup.ag' && jupiterApiKey ? { 'x-api-key': jupiterApiKey } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
        if (!response.ok) throw Object.assign(fail(`Quote service returned HTTP ${response.status}`), { retryable: [408, 429].includes(response.status) || response.status >= 500 });
        const chunks = []; let length = 0;
        for await (const chunk of response.body) {
          length += chunk.byteLength;
          if (length > maxResponseBytes) throw fail('Use a bounded quote service response');
          chunks.push(Buffer.from(chunk));
        }
        try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { throw fail('Read a complete quote service response'); }
      } catch (cause) {
        if (attempt < 2 && (cause.retryable === true || ['TypeError', 'TimeoutError', 'AbortError'].includes(cause.name))) {
          await sleep(2000 * 2 ** attempt);
          continue;
        }
        throw cause.code === 'QUOTE_UNAVAILABLE' ? cause : Object.assign(fail('Read a current quote from the provider'), { cause });
      }
    }
  };
  return {
    async quote({ provider, inputMint, outputMint, inputAmountRaw, slippageBps }) {
      if (!Object.hasOwn(endpoints, provider)) throw fail('Choose a supported quote provider');
      const url = new URL(`${endpoints[provider]}/${provider === 'raydium' ? 'compute/swap-base-in' : 'quote'}`);
      for (const [key, value] of Object.entries({ inputMint, outputMint, amount: inputAmountRaw, slippageBps,
        ...(provider === 'raydium' ? { txVersion: 'V0' } : { restrictIntermediateTokens: 'true' }) })) url.searchParams.set(key, String(value));
      const result = await json(url);
      if (provider === 'raydium' ? result?.success !== true : !Array.isArray(result?.routePlan) || !result.routePlan.length) {
        throw fail('The quote provider needs a usable route for this mint');
      }
      return result;
    },
    async transactions({ provider, quote, walletPublicKey, priorityFeeMicroLamports }) {
      if (!Object.hasOwn(endpoints, provider)) throw fail('Choose a supported quote provider');
      const raydium = provider === 'raydium';
      const result = await json(`${endpoints[provider]}/${raydium ? 'transaction/swap-base-in' : 'swap'}`, raydium
        ? { swapResponse: quote, wallet: walletPublicKey, txVersion: 'V0', wrapSol: true, unwrapSol: false, computeUnitPriceMicroLamports: String(priorityFeeMicroLamports) }
        : { quoteResponse: quote, userPublicKey: walletPublicKey, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, computeUnitPriceMicroLamports: priorityFeeMicroLamports });
      const transactions = raydium && result?.success === true && Array.isArray(result.data) ? result.data.map((item) => item.transaction)
        : !raydium && typeof result?.swapTransaction === 'string' ? [result.swapTransaction] : null;
      if (!transactions?.length || transactions.length > 8 || transactions.some((wire) => typeof wire !== 'string' || wire.length > 1644
          || !/^[A-Za-z0-9+/]+={0,2}$/.test(wire) || Buffer.from(wire, 'base64').toString('base64') !== wire)) throw fail('Read a complete bounded unsigned swap bundle');
      return transactions;
    },
  };
}
