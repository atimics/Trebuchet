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

// Raydium CLMM pool state: 8-byte discriminator, bump, amm_config, owner, then
// the two mints (73, 105) and their vaults (137, 169). Pools are always stored
// with the mints in byte order, so the SOL pair is found by asking for both.
const CLMM_PROGRAM = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK';
const CLMM_POOL_SIZE = 1544;
const HELIUS_HOST_RE = /(^|\.)helius-rpc\.com$/i;

export function heliusUrl(url) {
  try { return HELIUS_HOST_RE.test(new URL(url).hostname) ? url : null; } catch { return null; }
}

// Asks the Helius RPC for the SOL pool straight from the chain, so a pool that
// the public indexers have not listed yet (or never will) is still found.
export async function findClmmSolPoolsOnChain(mint, rpcUrl, { fetchImpl = globalThis.fetch } = {}) {
  const rpc = async (method, params) => {
    const response = await fetchImpl(rpcUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) throw new Error(`RPC returned HTTP ${response.status}`);
    const body = await response.json();
    if (body.error) throw new Error(body.error.message || 'RPC error');
    return body.result;
  };
  const found = [];
  for (const [first, second] of [[mint, HUB_SOL_MINT], [HUB_SOL_MINT, mint]]) {
    const accounts = await rpc('getProgramAccounts', [CLMM_PROGRAM, {
      encoding: 'base64', dataSlice: { offset: 137, length: 64 },
      filters: [{ dataSize: CLMM_POOL_SIZE },
        { memcmp: { offset: 73, bytes: first } }, { memcmp: { offset: 105, bytes: second } }],
    }]);
    for (const account of accounts || []) {
      const data = Buffer.from(account.account.data[0], 'base64');
      const solVault = new PublicKey(data.subarray(first === HUB_SOL_MINT ? 0 : 32, first === HUB_SOL_MINT ? 32 : 64)).toBase58();
      let reserve = 0;
      try { reserve = Number((await rpc('getTokenAccountBalance', [solVault]))?.value?.uiAmount) || 0; } catch { /* ranked last */ }
      found.push({ address: account.pubkey, baseMint: mint, quoteMint: HUB_SOL_MINT, dex: 'raydium-clmm',
        source: 'Helius', solReserve: reserve, liquidityUsd: null, volume24hUsd: null, name: '', symbol: '' });
    }
  }
  return found.sort((a, b) => b.solReserve - a.solReserve || a.address.localeCompare(b.address));
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
export async function resolveFlywheelHub(value, { fetchImpl = globalThis.fetch, rpcUrl = null } = {}) {
  const mint = String(value || '').trim();
  if (!validAddress(mint)) throw new Error('Enter a valid Solana token CA.');
  if (mint === HUB_SOL_MINT) throw new Error('Choose a hub token to pair with SOL.');
  const sources = [
    [`https://api.dexscreener.com/token-pairs/v1/solana/${mint}`, parseDexSolPools],
    [`${GECKO_BASE}/tokens/${mint}/pools?include=base_token,quote_token,dex&page=1`, parseGeckoSolPools],
  ];
  let lookupFailed = false;
  const helius = heliusUrl(rpcUrl);
  const finish = (solPool) => {
    const known = DEFAULT_FLYWHEEL_HUBS.find((hub) => hub.mint === mint);
    return { mint, name: known?.name || solPool.name || mint, symbol: known?.symbol || solPool.symbol || 'HUB',
      solPool, checkedAt: new Date().toISOString(), network: 'mainnet-beta' };
  };
  // The chain is the best source: Helius first, the public indexers as backup.
  if (helius) {
    try {
      const pool = (await findClmmSolPoolsOnChain(mint, helius, { fetchImpl }))[0];
      if (pool) return finish(pool);
    } catch { lookupFailed = true; }
  }
  for (const [url, parse] of sources) {
    try {
      const response = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(6500) });
      if (response.status === 404) continue;
      if (!response.ok) throw new Error(`Pool index returned HTTP ${response.status}`);
      const solPool = parse(mint, await response.json())[0];
      if (!solPool) continue;
      return finish(solPool);
    } catch { lookupFailed = true; }
  }
  throw new Error(lookupFailed
    ? 'Pool lookup is incomplete. Try again shortly.'
    : 'A direct SOL pool is required. Try another token CA or refresh after its pool is indexed.');
}
