// rpcLimiter.js
//
// Every Solana JSON-RPC request this process sends goes through one queue per RPC host, at
// most RPC_REQUESTS_PER_SECOND a second (6; TREBUCHET_RPC_RPS), and heavy methods through a
// second one at RPC_HEAVY_REQUESTS_PER_SECOND (1; TREBUCHET_RPC_HEAVY_RPS). Many parts of the app read the chain on their own;
// bursting past the provider's limit drew 429s that web3.js retried with growing delays,
// which stalled estimates for minutes and kept the RPC rate-limited. Queued requests wait
// their turn instead.
//
// web3.js captures globalThis.fetch when it loads, so this module must be imported before
// anything that loads web3.js: it is the first import of main.js and server.js.

const PER_SECOND = Math.max(1, Number(process.env.TREBUCHET_RPC_RPS) || 6);
// Providers cap some methods far below the general rate (Helius' free tier: a scan of every
// program account, and its asset API used for prices). They also wait in a slower queue.
const HEAVY_PER_SECOND = Math.max(0.2, Number(process.env.TREBUCHET_RPC_HEAVY_RPS) || 1);
const HEAVY_METHODS = new Set(['getProgramAccounts', 'getAsset', 'getAssetBatch', 'getAssetsByOwner', 'searchAssets', 'getTokenAccounts']);

const queues = new Map();

function isJsonRpc(init) {
  const body = init?.body;
  return String(init?.method || 'GET').toUpperCase() === 'POST'
    && typeof body === 'string' && body.includes('"jsonrpc"');
}

function hostOf(input) {
  try { return new URL(typeof input === 'string' ? input : input?.url || String(input)).host; } catch { return null; }
}

// The JSON-RPC method names in a request body (a single call or a batch).
export function rpcMethods(body) {
  try {
    const parsed = JSON.parse(body);
    return (Array.isArray(parsed) ? parsed : [parsed]).map((call) => String(call?.method || '')).filter(Boolean);
  } catch {
    return [];
  }
}

// A token bucket per key: `rate` tokens a second, refilled continuously; callers wait in order.
export function acquire(key, { rate = PER_SECOND, now = Date.now, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  let queue = queues.get(key);
  if (!queue) {
    queue = { tokens: Math.max(1, rate), at: now(), tail: Promise.resolve() };
    queues.set(key, queue);
  }
  const turn = queue.tail.then(async () => {
    for (;;) {
      const current = now();
      queue.tokens = Math.min(Math.max(1, rate), queue.tokens + ((current - queue.at) / 1000) * rate);
      queue.at = current;
      if (queue.tokens >= 1) { queue.tokens -= 1; return; }
      await wait(Math.ceil(((1 - queue.tokens) / rate) * 1000));
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
      if (host) {
        if (rpcMethods(init.body).some((method) => HEAVY_METHODS.has(method))) await acquire(`${host}#heavy`, { rate: HEAVY_PER_SECOND });
        await acquire(host);
      }
    }
    return original.call(this, input, init);
  };
  limited.__rpcLimited = true;
  target.fetch = limited;
}

export const RPC_REQUESTS_PER_SECOND = PER_SECOND;
export const RPC_HEAVY_REQUESTS_PER_SECOND = HEAVY_PER_SECOND;

installRpcLimiter();
