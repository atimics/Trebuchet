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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One token per key, refilled at `rate` tokens a second. Pace the first calls too:
// six calls at startup plus five refills could exceed a provider's 10 calls per second.
export function acquire(key, { rate = PER_SECOND, now = Date.now, wait = sleep } = {}) {
  let queue = queues.get(key);
  if (!queue) {
    queue = { tokens: 1, at: now(), blockedUntil: 0, tail: Promise.resolve() };
    queues.set(key, queue);
  }
  const turn = queue.tail.then(async () => {
    for (;;) {
      const current = now();
      if (current < queue.blockedUntil) {
        await wait(queue.blockedUntil - current);
        continue;
      }
      queue.tokens = Math.min(1, queue.tokens + (Math.max(0, current - queue.at) / 1000) * rate);
      queue.at = current;
      if (queue.tokens >= 1) { queue.tokens -= 1; return; }
      await wait(Math.ceil(((1 - queue.tokens) / rate) * 1000));
    }
  });
  queue.tail = turn.catch(() => {});
  return turn;
}

function pauseAfterRateLimit(host, response, now) {
  if (response?.status !== 429) return;
  const header = response.headers?.get?.('retry-after');
  const seconds = header == null ? NaN : Number(header);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - now();
  const queue = queues.get(host);
  queue.blockedUntil = Math.max(queue.blockedUntil, now() + (Number.isFinite(delay) && delay > 0 ? delay : 1000));
  queue.tokens = 0;
  queue.at = now();
}

export function installRpcLimiter(target = globalThis, { now = Date.now, wait = sleep } = {}) {
  const original = target.fetch;
  if (typeof original !== 'function' || original.__rpcLimited) return;
  const admissions = new Map();
  const limited = async function limitedFetch(input, init) {
    if (isJsonRpc(init)) {
      const host = hostOf(input);
      if (host) {
        let result;
        const turn = (admissions.get(host) || Promise.resolve()).then(async () => {
          init?.signal?.throwIfAborted();
          if (rpcMethods(init.body).some((method) => HEAVY_METHODS.has(method))) {
            await acquire(`${host}#heavy`, { rate: HEAVY_PER_SECOND, now, wait });
          }
          await acquire(host, { now, wait });
          init?.signal?.throwIfAborted();
          // Reserve both rates at send time. Release the queue while the response is in flight.
          result = Promise.resolve(original.call(this, input, init)).then((response) => {
            pauseAfterRateLimit(host, response, now);
            return response;
          });
        });
        const tail = turn.catch(() => {});
        admissions.set(host, tail);
        tail.then(() => { if (admissions.get(host) === tail) admissions.delete(host); });
        await turn;
        return result;
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
