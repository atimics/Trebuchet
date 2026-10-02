import { PublicKey } from '@solana/web3.js';
import { DEFAULT_FLYWHEEL_HUBS } from './packages/core/src/flywheel-pools.js';

export const HUB_SOL_MINT = 'So11111111111111111111111111111111111111112';
const GECKO_BASE = 'https://api.geckoterminal.com/api/v2/networks/solana';

function validAddress(value) {
  try { return typeof value === 'string' && new PublicKey(value).toBase58() === value; } catch { return false; }
}

function amount(value) {
  const number = Number(value);
  return value != null && value !== '' && Number.isFinite(number) && number >= 0 ? number : null;
}

function directSolPool(mint, pool) {
  return mint !== HUB_SOL_MINT && validAddress(mint) && validAddress(pool?.address)
    && ((pool.baseMint === mint && pool.quoteMint === HUB_SOL_MINT)
      || (pool.quoteMint === mint && pool.baseMint === HUB_SOL_MINT));
}

function rankPools(mint, pools) {
  return pools.filter((pool) => directSolPool(mint, pool))
    .sort((a, b) => (b.liquidityUsd || 0) - (a.liquidityUsd || 0)
      || (b.volume24hUsd || 0) - (a.volume24hUsd || 0)
      || a.address.localeCompare(b.address));
}

export function parseDexSolPools(mint, payload) {
  return rankPools(mint, (Array.isArray(payload) ? payload : []).filter((pair) => pair?.chainId === 'solana').map((pair) => {
    const token = pair.baseToken?.address === mint ? pair.baseToken : pair.quoteToken;
    return {
      address: pair.pairAddress, baseMint: pair.baseToken?.address, quoteMint: pair.quoteToken?.address,
      dex: pair.dexId || 'DEX', source: 'DexScreener',
      liquidityUsd: amount(pair.liquidity?.usd), volume24hUsd: amount(pair.volume?.h24),
      name: String(token?.name || '').slice(0, 120), symbol: String(token?.symbol || '').slice(0, 24),
    };
  }));
}

export function parseGeckoSolPools(mint, payload) {
  const token = payload?.included?.find((entry) => entry?.id === `solana_${mint}`)?.attributes;
  const address = (relationship) => {
    const id = relationship?.data?.id;
    return typeof id === 'string' && id.startsWith('solana_') ? id.slice(7) : null;
  };
  return rankPools(mint, (Array.isArray(payload?.data) ? payload.data : []).map((pool) => ({
    address: pool?.attributes?.address,
    baseMint: address(pool?.relationships?.base_token), quoteMint: address(pool?.relationships?.quote_token),
    dex: pool?.relationships?.dex?.data?.id || 'DEX', source: 'GeckoTerminal',
    liquidityUsd: amount(pool?.attributes?.reserve_in_usd), volume24hUsd: amount(pool?.attributes?.volume_usd?.h24),
    name: String(token?.name || '').slice(0, 120), symbol: String(token?.symbol || '').slice(0, 24),
  })));
}

export function listFlywheelHubs(snapshot = {}) {
  const defaults = DEFAULT_FLYWHEEL_HUBS.map((hub) => ({ ...hub, source: 'default' }));
  const seen = new Set(defaults.map((hub) => hub.mint));
  const discovery = [];
  for (const token of [...(snapshot?.knownTokens || []), ...(snapshot?.candidates || [])]) {
    const mint = token?.mint;
    const pool = token?.market?.solPool || (token?.market?.pool?.quoteMint === HUB_SOL_MINT
      ? { ...token.market.pool, baseMint: mint, liquidityUsd: token.market.liquidityUsd } : null);
    if (seen.has(mint) || !directSolPool(mint, pool)) continue;
    seen.add(mint);
    discovery.push({ mint, name: String(token.name || token.symbol || mint).slice(0, 120),
      symbol: String(token.symbol || '').slice(0, 24), solPool: pool, source: 'discovery' });
  }
  return { defaults, discovery };
}

// Each selection refreshes the index. Pool presence is a discovery hint;
// quote-token checks and the launch estimate establish execution readiness.
//
// Each source ends in one of three ways: it found a direct SOL pool, it
// definitively has none, or it failed (rate limit, timeout, server error, bad
// reply). Failures are named, because "try again" means something different for
// a rate limit (wait a minute) than for a timeout (try again now).
const SOURCES = [
  { name: 'DexScreener', url: (mint) => `https://api.dexscreener.com/token-pairs/v1/solana/${mint}`, parse: parseDexSolPools },
  { name: 'GeckoTerminal', url: (mint) => `${GECKO_BASE}/tokens/${mint}/pools?include=base_token,quote_token,dex&page=1`, parse: parseGeckoSolPools },
];
const RETRY_DELAY_MS = 800;
const MAX_RETRY_AFTER_MS = 2500;

const FAILURE_TEXT = {
  'rate-limited': 'is rate-limiting requests',
  timeout: 'did not answer in time',
  unavailable: 'is having a problem',
  network: 'could not be reached',
  'bad-reply': 'sent a reply that could not be read',
};

function failureKind(error) {
  if (error?.kind) return error.kind;
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'timeout';
  if (error instanceof SyntaxError) return 'bad-reply';
  return 'network';
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function askSource(source, mint, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(source.url(mint), { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(6500) });
  } catch (error) {
    throw Object.assign(new Error(error?.message || 'request failed'), { kind: failureKind(error) });
  }
  if (response.status === 404) return null;
  if (response.status === 429) {
    const wait = Number(response.headers?.get?.('retry-after')) * 1000;
    throw Object.assign(new Error('HTTP 429'), { kind: 'rate-limited', retryAfterMs: Number.isFinite(wait) ? wait : null });
  }
  if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { kind: response.status >= 500 ? 'unavailable' : 'bad-reply' });
  let payload;
  try { payload = await response.json(); } catch (error) { throw Object.assign(new Error('reply was not JSON'), { kind: 'bad-reply' }); }
  return source.parse(mint, payload)[0] || null;
}

// One quick retry for the failures that often clear on their own. A rate limit
// waits for Retry-After when it is short; anything longer is reported, not waited out.
async function askSourceWithRetry(source, mint, fetchImpl, retryDelayMs) {
  try {
    return await askSource(source, mint, fetchImpl);
  } catch (error) {
    const transient = ['rate-limited', 'timeout', 'unavailable'].includes(error.kind);
    const wait = error.retryAfterMs ?? retryDelayMs;
    if (!transient || wait > MAX_RETRY_AFTER_MS) throw error;
    await pause(wait);
    return askSource(source, mint, fetchImpl);
  }
}

export async function resolveFlywheelHub(value, { fetchImpl = globalThis.fetch, log = console.warn, retryDelayMs = RETRY_DELAY_MS } = {}) {
  const mint = String(value || '').trim();
  if (!validAddress(mint)) throw new Error('Enter a valid Solana token CA.');
  if (mint === HUB_SOL_MINT) throw new Error('Choose a hub token to pair with SOL.');
  const failures = [];
  const empty = [];
  for (const source of SOURCES) {
    try {
      const solPool = await askSourceWithRetry(source, mint, fetchImpl, retryDelayMs);
      if (!solPool) { empty.push(source.name); continue; }
      const known = DEFAULT_FLYWHEEL_HUBS.find((hub) => hub.mint === mint);
      return { mint, name: known?.name || solPool.name || mint, symbol: known?.symbol || solPool.symbol || 'HUB',
        solPool, checkedAt: new Date().toISOString(), network: 'mainnet-beta' };
    } catch (error) {
      failures.push({ source: source.name, kind: error.kind || failureKind(error), detail: error.message });
      log(`hub pool lookup: ${source.name} failed (${error.kind || failureKind(error)}: ${error.message})`);
    }
  }
  if (!failures.length) {
    throw Object.assign(new Error('A direct SOL pool is required. Try another token CA or refresh after its pool is indexed.'), { code: 'HUB_NO_SOL_POOL' });
  }
  const causes = failures.map((f) => `${f.source} ${FAILURE_TEXT[f.kind] || 'failed'}`).join('; ');
  const said = empty.length ? ` ${empty.join(' and ')} found no direct SOL pool.` : '';
  const wait = failures.some((f) => f.kind === 'rate-limited') ? 'Wait a minute and try again.' : 'Try again shortly.';
  throw Object.assign(new Error(`Pool lookup is incomplete: ${causes}.${said} ${wait}`), {
    code: 'HUB_LOOKUP_INCOMPLETE', retryable: true, failures,
  });
}
