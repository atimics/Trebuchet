// rpcConnection.js
//
// Connections for launch execution. A load-balanced RPC answers a read that carries
// minContextSlot from whichever node it picks; a node (or the finalized view) that has not
// reached that slot yet refuses with -32016 "Minimum context slot has not been reached".
// That is a wait, not a failure: the fetch below resends the same request until the node
// catches up, so no caller has to treat it as an error.
import { Connection } from '@solana/web3.js';
import { getRpcUrl } from './rpcConfig.js';

const NOT_REACHED = -32016;

export function minContextSlotRetryFetch({ attempts = 60, delayMs = 1000, fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  return async function fetchWithMinSlotRetry(input, init) {
    for (let attempt = 1; ; attempt += 1) {
      const response = await fetchImpl(input, init);
      if (!response.ok || attempt >= attempts) return response;
      let body;
      try { body = JSON.parse(await response.clone().text()); } catch { return response; }
      const notReached = [].concat(body).some((reply) => reply?.error?.code === NOT_REACHED);
      if (!notReached) return response;
      await sleep(delayMs);
    }
  };
}

export function createExecutionConnection(commitment = 'finalized', url = getRpcUrl()) {
  return new Connection(url, { commitment, fetch: minContextSlotRetryFetch() });
}
