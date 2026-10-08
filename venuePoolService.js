// venuePoolService.js
//
// Find and read a token's pools on PumpSwap, Orca, and Meteora, plus
// active Pump curves, for on-chain pricing (see onChainPriceService.js).
// Raydium pools come from Raydium's own pool index; these venues are found
// directly on-chain with getProgramAccounts, filtered by the two mints.
//
// Account layouts are from each program's on-chain Anchor IDL (Whirlpool,
// lb_clmm LbPair, cp_amm Pool). Offsets include the 8-byte discriminator.
// This module only reads: it never builds a transaction for these venues.

import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

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
    discriminator: PUMP_POOL_DISCRIMINATOR, mintA: 43, mintB: 75, decode: decodePumpSwapPool,
  },
  {
    venue: 'orca-whirlpool',
    programId: VENUE_PROGRAMS.ORCA_WHIRLPOOL,
    size: 653,
    mintA: 101,
    mintB: 181,
    decode: decodeWhirlpool,
  },
  {
    venue: 'meteora-dlmm',
    programId: VENUE_PROGRAMS.METEORA_DLMM,
    size: 904,
    mintA: 88,
    mintB: 120,
    decode: decodeDlmmPair,
  },
  {
    venue: 'meteora-damm-v2',
    programId: VENUE_PROGRAMS.METEORA_DAMM_V2,
    size: 1112,
    mintA: 168,
    mintB: 200,
    decode: decodeDammV2Pool,
  },
];

const pubkeyAt = (data, offset) => new PublicKey(data.subarray(offset, offset + 32)).toBase58();
const u128At = (data, offset) => data.readBigUInt64LE(offset) + (data.readBigUInt64LE(offset + 8) << 64n);

// Pump's official pump_amm and pump IDLs: pump-fun/pump-public-docs/idl.
export function decodePumpSwapPool(data) {
  if (data.length < 211 || !data.subarray(0, 8).equals(PUMP_POOL_DISCRIMINATOR)) throw new Error('Invalid PumpSwap pool');
  const virtualQuote = data.length >= 261 ? BigInt.asIntN(128, u128At(data, 245)) : 0n;
  // Extended virtual-reserve pools need their own curve rules. Price the regular AMM here.
  if (virtualQuote !== 0n) throw new Error('PumpSwap virtual-reserve price requires a market quote');
  return {
    kind: 'reserve', mintA: pubkeyAt(data, 43), mintB: pubkeyAt(data, 75),
    vaultA: pubkeyAt(data, 139), vaultB: pubkeyAt(data, 171),
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

async function findVenuePools(connection, venue, first, second) {
  const accounts = await connection.getProgramAccounts(new PublicKey(venue.programId), {
    filters: [
      ...(venue.size ? [{ dataSize: venue.size }] : [{ memcmp: { offset: 0, bytes: bs58.encode(venue.discriminator) } }]),
      { memcmp: { offset: venue.mintA, bytes: first } },
      { memcmp: { offset: venue.mintB, bytes: second } },
    ],
  });
  return accounts.flatMap(({ pubkey, account }) => {
    try { return [{
    id: pubkey.toBase58(),
    programId: venue.programId,
    venue: venue.venue,
    state: venue.decode(account.data),
    }]; } catch { return []; }
  });
}

/**
 * Pools on Orca and Meteora pairing `mint` with `anchor`, in the shape
 * onChainPriceService.evaluatePool reads: { id, programId, venue,
 * mintA: { address, decimals }, mintB: { address, decimals }, state }.
 * state carries the decoded price fields plus reserveA/reserveB (raw vault
 * amounts). A venue whose lookup fails is skipped, not fatal.
 */
// Which pools exist for a pair changes rarely, and finding them is a scan of every pool account
// (getProgramAccounts, the heaviest RPC call). Keep a complete scan for 10 minutes; reserves are
// and price state are read fresh on every call. Partial scans wait a minute before retrying.
const POOL_DISCOVERY_TTL_MS = 10 * 60 * 1000;
const POOL_DISCOVERY_RETRY_MS = 60 * 1000;
const poolDiscoveryCache = new Map();

export function clearPoolDiscoveryCache() {
  poolDiscoveryCache.clear();
}

async function discoverVenuePools(connection, mint, anchor) {
  const key = `${connection.rpcEndpoint || ''}|${[mint, anchor].sort().join('|')}`;
  const hit = poolDiscoveryCache.get(key);
  if (hit?.pending) return hit.pending;
  if (hit && hit.expiresAt > Date.now()) return hit.pools;
  const entry = {};
  poolDiscoveryCache.set(key, entry);
  entry.pending = (async () => {
    const lookups = VENUES.flatMap((venue) => [
      findVenuePools(connection, venue, mint, anchor),
      findVenuePools(connection, venue, anchor, mint),
    ]);
    const settled = await Promise.allSettled(lookups);
    const pools = [];
    let complete = true;
    settled.forEach((result) => {
      if (result.status === 'fulfilled') pools.push(...result.value);
      else {
        complete = false;
        console.warn(`venue pools: lookup failed: ${result.reason?.message || result.reason}`);
      }
    });
    if (poolDiscoveryCache.get(key) === entry) {
      poolDiscoveryCache.set(key, { pools, expiresAt: Date.now() + (complete ? POOL_DISCOVERY_TTL_MS : POOL_DISCOVERY_RETRY_MS) });
    }
    return pools;
  })();
  return entry.pending;
}

export async function fetchVenuePoolsByMints(connection, mint, anchor) {
  if (!connection || !mint || !anchor || mint === anchor) return [];
  const discovered = await discoverVenuePools(connection, mint, anchor);
  let canonical = [];
  try { canonical = pumpPoolAddresses(mint, anchor); } catch { /* invalid mint is handled by the caller */ }
  const candidates = [...new Map([...discovered, ...canonical].map((pool) => [pool.id, pool])).values()];
  if (!candidates.length) return [];
  // Cache addresses, then read current sqrt price, active bin, and curve state each time.
  const current = await accountsByKey(connection, candidates.map((pool) => pool.id));
  const pools = candidates.flatMap((pool) => {
    const account = current.get(pool.id);
    if (account?.owner?.toString() !== pool.programId) return [];
    try {
      const state = pool.venue === 'pump-curve' ? decodePumpCurve(account.data, mint)
        : VENUES.find((venue) => venue.programId === pool.programId).decode(account.data);
      if (![state.mintA, state.mintB].includes(mint) || ![state.mintA, state.mintB].includes(anchor)) return [];
      return [{ ...pool, state }];
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
      reserveA: pool.state.reserveA ?? tokenAmount(extra.get(pool.state.vaultA)?.data),
      reserveB: pool.state.reserveB ?? (() => {
        const raw = tokenAmount(extra.get(pool.state.vaultB)?.data);
        return raw == null ? null : raw - (pool.state.quoteFees || 0n);
      })(),
    },
  })).filter((pool) => pool.mintA.decimals != null && pool.mintB.decimals != null);
}
