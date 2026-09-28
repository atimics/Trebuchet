// venuePoolService.js
//
// Find and read a token's pools on Orca Whirlpools, Meteora DLMM, and
// Meteora DAMM v2, for on-chain pricing (see onChainPriceService.js).
// Raydium pools come from Raydium's own pool index; these venues are found
// directly on-chain with getProgramAccounts, filtered by the two mints.
//
// Account layouts are from each program's on-chain Anchor IDL (Whirlpool,
// lb_clmm LbPair, cp_amm Pool). Offsets include the 8-byte discriminator.
// This module only reads: it never builds a transaction for these venues.

import { PublicKey } from '@solana/web3.js';

export const VENUE_PROGRAMS = Object.freeze({
  ORCA_WHIRLPOOL: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
  METEORA_DLMM: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
  METEORA_DAMM_V2: 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG',
});

const VENUES = [
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
    chunk.forEach((key, index) => out.set(key, infos[index]?.data || null));
  }
  return out;
}

async function findVenuePools(connection, venue, first, second) {
  const accounts = await connection.getProgramAccounts(new PublicKey(venue.programId), {
    filters: [
      { dataSize: venue.size },
      { memcmp: { offset: venue.mintA, bytes: first } },
      { memcmp: { offset: venue.mintB, bytes: second } },
    ],
  });
  return accounts.map(({ pubkey, account }) => ({
    id: pubkey.toBase58(),
    programId: venue.programId,
    venue: venue.venue,
    state: venue.decode(account.data),
  }));
}

/**
 * Pools on Orca and Meteora pairing `mint` with `anchor`, in the shape
 * onChainPriceService.evaluatePool reads: { id, programId, venue,
 * mintA: { address, decimals }, mintB: { address, decimals }, state }.
 * state carries the decoded price fields plus reserveA/reserveB (raw vault
 * amounts). A venue whose lookup fails is skipped, not fatal.
 */
export async function fetchVenuePoolsByMints(connection, mint, anchor) {
  if (!connection || !mint || !anchor || mint === anchor) return [];
  const lookups = VENUES.flatMap((venue) => [
    findVenuePools(connection, venue, mint, anchor),
    findVenuePools(connection, venue, anchor, mint),
  ]);
  const settled = await Promise.allSettled(lookups);
  const pools = [];
  settled.forEach((result) => {
    if (result.status === 'fulfilled') pools.push(...result.value);
    else console.warn(`venue pools: lookup failed: ${result.reason?.message || result.reason}`);
  });
  if (!pools.length) return [];

  const extra = await accountsByKey(connection, [
    mint,
    anchor,
    ...pools.flatMap((pool) => [pool.state.vaultA, pool.state.vaultB]),
  ]);
  return pools.map((pool) => ({
    ...pool,
    mintA: { address: pool.state.mintA, decimals: mintDecimals(extra.get(pool.state.mintA)) },
    mintB: { address: pool.state.mintB, decimals: mintDecimals(extra.get(pool.state.mintB)) },
    state: {
      ...pool.state,
      reserveA: tokenAmount(extra.get(pool.state.vaultA)),
      reserveB: tokenAmount(extra.get(pool.state.vaultB)),
    },
  })).filter((pool) => pool.mintA.decimals != null && pool.mintB.decimals != null);
}
