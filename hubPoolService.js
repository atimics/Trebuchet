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

// A hub token completes its route through SOL directly, or through one of these
// tokens, which the swap layer then hops through (SOL -> USDC -> hub).
const BRIDGE_SYMBOLS = ['USDC', 'USDT', 'USD1', 'XLRT'];
export const BRIDGES = DEFAULT_FLYWHEEL_HUBS.filter((hub) => BRIDGE_SYMBOLS.includes(hub.symbol))
  .sort((a, b) => BRIDGE_SYMBOLS.indexOf(a.symbol) - BRIDGE_SYMBOLS.indexOf(b.symbol));
const QUOTES = [{ mint: HUB_SOL_MINT, symbol: 'SOL' }, ...BRIDGES];

function pairedWith(mint, pool, quote) {
  return mint !== quote && validAddress(mint) && validAddress(pool?.address)
    && ((pool.baseMint === mint && pool.quoteMint === quote) || (pool.quoteMint === mint && pool.baseMint === quote));
}

function directSolPool(mint, pool) {
  return mint !== HUB_SOL_MINT && validAddress(mint) && validAddress(pool?.address)
    && ((pool.baseMint === mint && pool.quoteMint === HUB_SOL_MINT)
      || (pool.quoteMint === mint && pool.baseMint === HUB_SOL_MINT));
}

function rankPools(mint, pools, quote = HUB_SOL_MINT) {
  return pools.filter((pool) => (quote === HUB_SOL_MINT ? directSolPool(mint, pool) : pairedWith(mint, pool, quote)))
    .sort((a, b) => (b.liquidityUsd || 0) - (a.liquidityUsd || 0)
      || (b.volume24hUsd || 0) - (a.volume24hUsd || 0)
      || a.address.localeCompare(b.address));
}

export function parseDexSolPools(mint, payload, quote = HUB_SOL_MINT) {
  return rankPools(mint, (Array.isArray(payload) ? payload : []).filter((pair) => pair?.chainId === 'solana').map((pair) => {
    const token = pair.baseToken?.address === mint ? pair.baseToken : pair.quoteToken;
    return {
      address: pair.pairAddress, baseMint: pair.baseToken?.address, quoteMint: pair.quoteToken?.address,
      dex: pair.dexId || 'DEX', source: 'DexScreener',
      liquidityUsd: amount(pair.liquidity?.usd), volume24hUsd: amount(pair.volume?.h24),
      name: String(token?.name || '').slice(0, 120), symbol: String(token?.symbol || '').slice(0, 24),
    };
  }), quote);
}

export function parseGeckoSolPools(mint, payload, quote = HUB_SOL_MINT) {
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
  })), quote);
}

// Pool account layouts: where each program stores its two mints and vaults.
// A pool stores its mints in a fixed order, so the SOL pair is found by
// asking for both orderings. CLMM state: 8-byte discriminator, bump, config,
// owner, then mints (73, 105) and vaults (137, 169).
const POOL_LAYOUTS = [
  { dex: 'raydium-clmm', program: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', size: 1544, mintA: 73, mintB: 105, vaultA: 137, vaultB: 169 },
  { dex: 'raydium-cpmm', program: 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C', size: 637, mintA: 168, mintB: 200, vaultA: 72, vaultB: 104 },
  { dex: 'raydium-amm', program: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', size: 752, mintA: 400, mintB: 432, vaultA: 336, vaultB: 368 },
  { dex: 'meteora-damm-v2', program: 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG', size: 1112, mintA: 168, mintB: 200, vaultA: 232, vaultB: 264 },
  { dex: 'meteora-dlmm', program: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', size: 904, mintA: 88, mintB: 120, vaultA: 152, vaultB: 184 },
  { dex: 'orca-whirlpool', program: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', size: 653, mintA: 101, mintB: 181, vaultA: 133, vaultB: 213 },
];
const HELIUS_HOST_RE = /(^|\.)helius-rpc\.com$/i;

export function heliusUrl(url) {
  try { return HELIUS_HOST_RE.test(new URL(url).hostname) ? url : null; } catch { return null; }
}

// Asks the Helius RPC for the SOL pool straight from the chain, so a pool that
// the public indexers have not listed yet (or never will) is still found.
export async function findSolPoolsOnChain(mint, rpcUrl, { fetchImpl = globalThis.fetch, quote = HUB_SOL_MINT } = {}) {
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
  const search = async (layout) => {
    const lo = Math.min(layout.vaultA, layout.vaultB);
    const length = Math.abs(layout.vaultA - layout.vaultB) + 32;
    const pools = [];
    for (const solFirst of [false, true]) {
      const [first, second] = solFirst ? [quote, mint] : [mint, quote];
      const accounts = await rpc('getProgramAccounts', [layout.program, {
        encoding: 'base64', dataSlice: { offset: lo, length },
        filters: [{ dataSize: layout.size },
          { memcmp: { offset: layout.mintA, bytes: first } }, { memcmp: { offset: layout.mintB, bytes: second } }],
      }]);
      for (const account of accounts || []) {
        const data = Buffer.from(account.account.data[0], 'base64');
        const at = (offset) => new PublicKey(data.subarray(offset - lo, offset - lo + 32)).toBase58();
        pools.push({ address: account.pubkey, baseMint: mint, quoteMint: quote, dex: layout.dex,
          source: 'Helius', solVault: at(solFirst ? layout.vaultA : layout.vaultB), solReserve: 0,
          liquidityUsd: null, volume24hUsd: null, name: '', symbol: '' });
      }
    }
    return pools;
  };
  // One failing program does not hide the pools found on the others.
  const settled = await Promise.allSettled(POOL_LAYOUTS.map(search));
  const found = settled.flatMap((result) => (result.status === 'fulfilled' ? result.value : []));
  if (!found.length && settled.every((result) => result.status === 'rejected')) throw settled[0].reason;
  let decimals = 9;
  if (quote !== HUB_SOL_MINT && found.length) {
    try { decimals = Number((await rpc('getTokenSupply', [quote]))?.value?.decimals ?? 6); } catch { decimals = 6; }
  }
  // Quote tokens in each pool's vault, read 100 vaults per call (the token amount sits at byte 64).
  for (let i = 0; i < found.length; i += 100) {
    const batch = found.slice(i, i + 100);
    try {
      const result = await rpc('getMultipleAccounts', [batch.map((pool) => pool.solVault), { encoding: 'base64', dataSlice: { offset: 64, length: 8 } }]);
      batch.forEach((pool, index) => {
        const raw = result?.value?.[index]?.data?.[0];
        if (raw) pool.solReserve = Number(Buffer.from(raw, 'base64').readBigUInt64LE(0)) / 10 ** decimals;
      });
    } catch { /* pools without a reading rank last */ }
  }
  found.forEach((pool) => { delete pool.solVault; });
  return found.sort((a, b) => b.solReserve - a.solReserve || a.address.localeCompare(b.address));
}
export const findClmmSolPoolsOnChain = findSolPoolsOnChain;

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
// A pool with SOL wins. Without one, a pool with USDC, USDT, USD1 or XLRT
// completes the route through that token.
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
  const finish = (pool, quote) => {
    const known = DEFAULT_FLYWHEEL_HUBS.find((hub) => hub.mint === mint);
    const via = quote.mint === HUB_SOL_MINT ? null : { mint: quote.mint, symbol: quote.symbol };
    return { mint, name: known?.name || pool.name || mint, symbol: known?.symbol || pool.symbol || 'HUB',
      solPool: pool, via, checkedAt: new Date().toISOString(), network: 'mainnet-beta' };
  };
  // The chain is the best source: Helius first, the public indexers as backup.
  const quotes = QUOTES.filter((quote) => quote.mint !== mint);
  if (helius) {
    for (const quote of quotes) {
      try {
        const pool = (await findSolPoolsOnChain(mint, helius, { fetchImpl, quote: quote.mint }))[0];
        if (pool) return finish(pool, quote);
      } catch { lookupFailed = true; }
    }
  }
  const payloads = [];
  for (const [url, parse] of sources) {
    try {
      const response = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(6500) });
      if (response.status === 404) continue;
      if (!response.ok) throw new Error(`Pool index returned HTTP ${response.status}`);
      payloads.push([parse, await response.json()]);
    } catch { lookupFailed = true; }
  }
  for (const quote of quotes) {
    for (const [parse, payload] of payloads) {
      const pool = parse(mint, payload, quote.mint)[0];
      if (pool) return finish(pool, quote);
    }
  }
  throw new Error(lookupFailed
    ? 'Pool lookup is incomplete. Try again shortly.'
    : 'No pool with SOL, USDC, USDT, USD1 or XLRT was found. Try another token CA or refresh after its pool is indexed.');
}
