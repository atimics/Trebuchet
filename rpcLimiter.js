// rpcLimiter.js
//
// Every Solana JSON-RPC request this process sends goes through one queue per RPC host, at
// most RPC_REQUESTS_PER_SECOND a second. Many parts of the app read the chain on their own;
// bursting past the provider's limit drew 429s that web3.js retried with growing delays,
// which stalled estimates for minutes and kept the RPC rate-limited. Queued requests wait
// their turn instead.
//
// web3.js captures globalThis.fetch when it loads, so this module must be imported before
// anything that loads web3.js: it is the first import of main.js and server.js.

const PER_SECOND = Math.max(1, Number(process.env.TREBUCHET_RPC_RPS) || 8);

const queues = new Map();

function isJsonRpc(init) {
  const body = init?.body;
  return String(init?.method || 'GET').toUpperCase() === 'POST'
    && typeof body === 'string' && body.includes('"jsonrpc"');
}

function hostOf(input) {
  try { return new URL(typeof input === 'string' ? input : input?.url || String(input)).host; } catch { return null; }
}

// A token bucket per host: PER_SECOND tokens, refilled continuously; callers wait in order.
export function acquire(host, { now = Date.now, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  let queue = queues.get(host);
  if (!queue) {
    queue = { tokens: PER_SECOND, at: now(), tail: Promise.resolve() };
    queues.set(host, queue);
  }
  const turn = queue.tail.then(async () => {
    for (;;) {
      const current = now();
      queue.tokens = Math.min(PER_SECOND, queue.tokens + ((current - queue.at) / 1000) * PER_SECOND);
      queue.at = current;
      if (queue.tokens >= 1) { queue.tokens -= 1; return; }
      await wait(Math.ceil(((1 - queue.tokens) / PER_SECOND) * 1000));
    }
  });
  queue.tail = turn.catch(() => {});
  return turn;
}

export function installRpcLimiter(target = globalThis) {
  const original = target.fetch;
  if (typeof original !== 'function' || original.__rpcLimited) return;
  const limited = async function limitedFetch(input, init) {
    if (isJsonRpc(init)) {
      const host = hostOf(input);
      if (host) await acquire(host);
    }
    return original.call(this, input, init);
  };
  limited.__rpcLimited = true;
  target.fetch = limited;
}

export const RPC_REQUESTS_PER_SECOND = PER_SECOND;

installRpcLimiter();
