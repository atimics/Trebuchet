// venuePoolService.js
//
// Find and read a token's pools on PumpSwap, Orca, and Meteora, plus
// active Pump curves, for on-chain pricing (see onChainPriceService.js).
// Raydium pools come from Raydium's pool index. DexScreener supplies candidate
// addresses for other venues; RPC account owners and layouts identify them.
//
// Account layouts are from each program's on-chain Anchor IDL (Whirlpool,
// lb_clmm LbPair, cp_amm Pool). Offsets include the 8-byte discriminator.
// Prices and reserves come from current RPC account reads.

import { PublicKey } from '@solana/web3.js';

export const VENUE_PROGRAMS = Object.freeze({
  ORCA_WHIRLPOOL: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
  METEORA_DLMM: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
  METEORA_DAMM_V2: 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG',
  PUMP_SWAP: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
  PUMP_CURVE: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
});

const PUMP_POOL_DISCRIMINATOR = Buffer.from([241, 154, 109, 4, 17, 177, 109, 188]);
const PUMP_CURVE_DISCRIMINATOR = Buffer.from([23, 183, 248, 55, 96, 216, 172, 96]);
const WSOL = 'So11111111111111111111111111111111111111112';

const VENUES = [
  {
    venue: 'pump-swap', programId: VENUE_PROGRAMS.PUMP_SWAP,
    discriminator: PUMP_POOL_DISCRIMINATOR, decode: decodePumpSwapPool,
  },
  {
    venue: 'orca-whirlpool',
    programId: VENUE_PROGRAMS.ORCA_WHIRLPOOL,
    discriminator: Buffer.from([63, 149, 209, 12, 225, 128, 99, 9]),
    size: 653,
    decode: decodeWhirlpool,
  },
  {
    venue: 'meteora-dlmm',
    programId: VENUE_PROGRAMS.METEORA_DLMM,
    discriminator: Buffer.from([33, 11, 49, 98, 181, 101, 177, 13]),
    size: 904,
    decode: decodeDlmmPair,
  },
  {
    venue: 'meteora-damm-v2',
    programId: VENUE_PROGRAMS.METEORA_DAMM_V2,
    discriminator: PUMP_POOL_DISCRIMINATOR,
    size: 1112,
    decode: decodeDammV2Pool,
  },
];

const pubkeyAt = (data, offset) => new PublicKey(data.subarray(offset, offset + 32)).toBase58();
const u128At = (data, offset) => data.readBigUInt64LE(offset) + (data.readBigUInt64LE(offset + 8) << 64n);

// Pump's official pump_amm and pump IDLs: pump-fun/pump-public-docs/idl.
// Pool: discriminator (8), bump (1), index (2), creator (32), then mints at
// 43 and 75. Current fields use 287 bytes; allocated accounts can include
// padding (301 bytes). Legacy pools start at 211 bytes.
export function decodePumpSwapPool(data) {
  if (data.length < 211 || !data.subarray(0, 8).equals(PUMP_POOL_DISCRIMINATOR)) throw new Error('Invalid PumpSwap pool');
  const virtualQuote = data.length >= 261 ? BigInt.asIntN(128, u128At(data, 245)) : 0n;
  // Official PumpSwap SDK 2.1.0: vault + signed virtual reserve sets price;
  // vault - pending protocol/creator fees measures the spendable quote side.
  return {
    kind: 'reserve', mintA: pubkeyAt(data, 43), mintB: pubkeyAt(data, 75),
    vaultA: pubkeyAt(data, 139), vaultB: pubkeyAt(data, 171),
    virtualQuote,
    quoteFees: data.length >= 287 ? data.readBigUInt64LE(271) + data.readBigUInt64LE(279) : 0n,
  };
}

export function decodePumpCurve(data, mint) {
  if (data.length < 49 || !data.subarray(0, 8).equals(PUMP_CURVE_DISCRIMINATOR)) throw new Error('Invalid Pump bonding curve');
  const quote = data.length >= 115 ? pubkeyAt(data, 83) : '11111111111111111111111111111111';
  return {
    kind: 'reserve', mintA: mint, mintB: quote === '11111111111111111111111111111111' ? WSOL : quote,
    priceReserveA: data.readBigUInt64LE(8), priceReserveB: data.readBigUInt64LE(16),
    reserveA: data.readBigUInt64LE(24), reserveB: data.readBigUInt64LE(32), status: data[48] ? 1 : 0,
  };
}

export function pumpPoolAddresses(mint, anchor) {
  const base = new PublicKey(mint); const quote = new PublicKey(anchor);
  const pump = new PublicKey(VENUE_PROGRAMS.PUMP_CURVE);
  const [authority] = PublicKey.findProgramAddressSync([Buffer.from('pool-authority'), base.toBuffer()], pump);
  const [pool] = PublicKey.findProgramAddressSync([Buffer.from('pool'), Buffer.from([0, 0]), authority.toBuffer(), base.toBuffer(), quote.toBuffer()], new PublicKey(VENUE_PROGRAMS.PUMP_SWAP));
  const [curve] = PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), base.toBuffer()], pump);
  return [
    { id: pool.toBase58(), venue: 'pump-swap', programId: VENUE_PROGRAMS.PUMP_SWAP },
    { id: curve.toBase58(), venue: 'pump-curve', programId: VENUE_PROGRAMS.PUMP_CURVE },
  ];
}

// Orca Whirlpool: concentrated liquidity, price from sqrt_price (Q64.64).
export function decodeWhirlpool(data) {
  return {
    kind: 'sqrt',
    liquidity: u128At(data, 49),
    sqrtPriceX64: u128At(data, 65),
    mintA: pubkeyAt(data, 101),
    vaultA: pubkeyAt(data, 133),
    mintB: pubkeyAt(data, 181),
    vaultB: pubkeyAt(data, 213),
  };
}

// Meteora DLMM (LbPair): price bins; the active bin sets the price.
export function decodeDlmmPair(data) {
  return {
    kind: 'bin',
    activeId: data.readInt32LE(76),
    binStep: data.readUInt16LE(80),
    status: data[82],
    mintA: pubkeyAt(data, 88),
    mintB: pubkeyAt(data, 120),
    vaultA: pubkeyAt(data, 152),
    vaultB: pubkeyAt(data, 184),
  };
}

// Meteora DAMM v2 (cp_amm Pool): price from sqrt_price (Q64.64).
export function decodeDammV2Pool(data) {
  return {
    kind: 'sqrt',
    mintA: pubkeyAt(data, 168),
    mintB: pubkeyAt(data, 200),
    vaultA: pubkeyAt(data, 232),
    vaultB: pubkeyAt(data, 264),
    liquidity: u128At(data, 360),
    sqrtPriceX64: u128At(data, 456),
    status: data[481],
  };
}

// SPL and Token-2022 share these offsets: mint decimals at 44, token
// account amount at 64.
const mintDecimals = (data) => (data && data.length >= 45 ? data[44] : null);
const tokenAmount = (data) => (data && data.length >= 72 ? data.readBigUInt64LE(64) : null);

async function accountsByKey(connection, keys) {
  const unique = [...new Set(keys)];
  const out = new Map();
  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100);
    const infos = await connection.getMultipleAccountsInfo(chunk.map((key) => new PublicKey(key)));
    chunk.forEach((key, index) => out.set(key, infos[index] || null));
  }
  return out;
}

// One mint lookup covers all venues and quote pairs. Cache addresses for ten
// minutes; each price read still fetches current pool state and vault balances.
const POOL_DISCOVERY_TTL_MS = 10 * 60 * 1000;
const POOL_DISCOVERY_EMPTY_TTL_MS = 60 * 1000;
const POOL_DISCOVERY_RETRY_MS = 5 * 60 * 1000;
const POOL_DISCOVERY_CACHE_LIMIT = 256;
const MAX_INDEXED_POOLS = 128;
const MAX_PAIR_POOLS = 32;
const poolDiscoveryCache = new Map();

export function clearPoolDiscoveryCache() {
  poolDiscoveryCache.clear();
}

function indexedPools(payload, mint) {
  if (!Array.isArray(payload)) throw new Error('Pool index returned an invalid response');
  const pools = payload.flatMap((pair) => {
    if (pair?.chainId !== 'solana') return [];
    try {
      const id = new PublicKey(pair.pairAddress).toBase58();
      const mintA = new PublicKey(pair.baseToken?.address).toBase58();
      const mintB = new PublicKey(pair.quoteToken?.address).toBase58();
      if (mintA === mintB || ![mintA, mintB].includes(mint)) return [];
      return [{ id, mintA, mintB, liquidity: Number(pair.liquidity?.usd) || 0 }];
    } catch { return []; }
  });
  pools.sort((a, b) => b.liquidity - a.liquidity);
  return [...new Map(pools.map((pool) => [pool.id, pool])).values()].slice(0, MAX_INDEXED_POOLS);
}

async function discoverVenuePools(mint, { fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const hit = poolDiscoveryCache.get(mint);
  if (hit?.pending) return hit.pending;
  if (hit && hit.expiresAt > now()) return hit.pools;
  const entry = {};
  poolDiscoveryCache.delete(mint);
  poolDiscoveryCache.set(mint, entry);
  while (poolDiscoveryCache.size > POOL_DISCOVERY_CACHE_LIMIT) {
    poolDiscoveryCache.delete(poolDiscoveryCache.keys().next().value);
  }
  entry.pending = (async () => {
    let pools = hit?.pools || [];
    let ttl = POOL_DISCOVERY_RETRY_MS;
    try {
      const response = await fetchImpl(`https://api.dexscreener.com/token-pairs/v1/solana/${encodeURIComponent(mint)}`, {
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) throw new Error(`Pool index HTTP ${response.status}`);
      pools = indexedPools(await response.json(), mint);
      ttl = pools.length ? POOL_DISCOVERY_TTL_MS : POOL_DISCOVERY_EMPTY_TTL_MS;
    } catch (error) {
      console.warn(`venue pools: mint lookup failed; retry in five minutes: ${error?.message || error}`);
    }
    if (poolDiscoveryCache.get(mint) === entry) {
      poolDiscoveryCache.set(mint, { pools, expiresAt: now() + ttl });
    }
    return pools;
  })();
  return entry.pending;
}

export async function fetchVenuePoolsByMints(connection, mint, anchor, discoveryOptions) {
  if (!connection || !mint || !anchor || mint === anchor) return [];
  try { new PublicKey(mint); new PublicKey(anchor); } catch { return []; }
  const discovered = (await discoverVenuePools(mint, discoveryOptions))
    .filter((pool) => [pool.mintA, pool.mintB].includes(anchor)).slice(0, MAX_PAIR_POOLS);
  const canonical = pumpPoolAddresses(mint, anchor);
  const candidates = [...new Map([...discovered, ...canonical].map((pool) => [pool.id, pool])).values()];
  if (!candidates.length) return [];
  // Cache addresses, then read current sqrt price, active bin, and curve state each time.
  const current = await accountsByKey(connection, candidates.map((pool) => pool.id));
  const pools = candidates.flatMap((pool) => {
    const account = current.get(pool.id);
    const programId = account?.owner?.toString();
    if (!programId || (pool.programId && programId !== pool.programId)) return [];
    try {
      const venue = VENUES.find((candidate) => candidate.programId === programId);
      if (pool.venue !== 'pump-curve' && (!venue
        || (venue.size && account.data.length !== venue.size)
        || !account.data.subarray(0, 8).equals(venue.discriminator))) return [];
      const state = pool.venue === 'pump-curve' ? decodePumpCurve(account.data, mint) : venue.decode(account.data);
      if (![state.mintA, state.mintB].includes(mint) || ![state.mintA, state.mintB].includes(anchor)) return [];
      return [{ id: pool.id, programId, venue: pool.venue === 'pump-curve' ? pool.venue : venue.venue, state }];
    } catch { return []; }
  });
  if (!pools.length) return [];

  const extra = await accountsByKey(connection, [
    mint,
    anchor,
    ...pools.flatMap((pool) => [pool.state.vaultA, pool.state.vaultB].filter(Boolean)),
  ]);
  return pools.map((pool) => ({
    ...pool,
    mintA: { address: pool.state.mintA, decimals: mintDecimals(extra.get(pool.state.mintA)?.data) },
    mintB: { address: pool.state.mintB, decimals: mintDecimals(extra.get(pool.state.mintB)?.data) },
    state: {
      ...pool.state,
      ...(pool.state.virtualQuote !== undefined ? {
        priceReserveB: (() => {
          const raw = tokenAmount(extra.get(pool.state.vaultB)?.data);
          return raw == null ? 0n : raw + pool.state.virtualQuote;
        })(),
      } : {}),
      reserveA: pool.state.reserveA ?? tokenAmount(extra.get(pool.state.vaultA)?.data),
      reserveB: pool.state.reserveB ?? (() => {
        const raw = tokenAmount(extra.get(pool.state.vaultB)?.data);
        return raw == null ? null : raw - (pool.state.quoteFees || 0n);
      })(),
    },
  })).filter((pool) => pool.mintA.decimals != null && pool.mintB.decimals != null);
}
