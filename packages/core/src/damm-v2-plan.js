// Meteora DAMM v2 lean launch: normalization, price model, depth and cost.
//
// Pure functions shared by the local API, the renderer and tests. Chain work
// lives in dammV2Service.js.
//
// The launch is one pool holding the whole supply in a single position, locked
// permanently inside the pool-creation transaction. It is single-sided: tokens
// only, no SOL seed. The price range starts at the starting market cap and runs
// up from there, so buyers supply the SOL. The new token is side A, SOL side B,
// and fees are collected in SOL only.

import {
  normalizeTokenDescription,
  normalizeTokenName,
  normalizeTokenSymbol,
  normalizeWholeTokenSupply,
  unsafeSweepDestinationReason,
} from './validators.js';
import { COST_TOKEN_CREATE_SOL, FALLBACK_SOL_USD } from './lp-constants.js';

export const DAMM_V2_VENUE = 'meteora-damm-v2';
export const DAMM_V2_PROGRAM_ID = 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG';
export const LAMPORTS_PER_SOL = 1_000_000_000;
export const TOKEN_DECIMALS = 9;

// Measured on a local validator running the mainnet DAMM v2 program
// (test/e2e/v2-damm-localnet.mjs asserts these exactly).
//   pool + position + position NFT + both vaults: rent only
export const DAMM_V2_POOL_RENT_LAMPORTS = 24_645_361;
//   two signatures: the launch wallet and the position NFT mint
export const DAMM_V2_POOL_TX_FEE_LAMPORTS = 10_000;
//   500k compute units at a 50k micro-lamport price
export const DAMM_V2_PRIORITY_FEE_LAMPORTS = 25_000;
//   the recipient's token account for the position NFT, plus one signature
export const DAMM_V2_KEY_TRANSFER_LAMPORTS = 2_074_080 + 5_000;
//   a claim also opens a token account for the pool's other token the first time
//   a wallet claims. It is refundable, and the launch wallet already has one.
export const DAMM_V2_FIRST_CLAIM_ACCOUNT_LAMPORTS = 2_074_080;
export const DAMM_V2_BUFFER_PCT = 0.2;

export const DAMM_V2_DEFAULTS = Object.freeze({
  startingMarketCapUsd: 250_000,
  rangeMultiple: 1000,
  feeBps: 25,
});
export const DAMM_V2_LIMITS = Object.freeze({
  startingMarketCapUsd: [1_000, 1_000_000_000],
  rangeMultiple: [10, 100_000],
  feeBps: [1, 1_000],
});

function bounded(name, value, [min, max], integer = false) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${name} must be a number`);
  if (integer && !Number.isInteger(number)) throw new Error(`${name} must be a whole number`);
  if (number < min || number > max) throw new Error(`${name} must be between ${min.toLocaleString('en-US')} and ${max.toLocaleString('en-US')}`);
  return number;
}

const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export function isAddress(value) {
  return BASE58_ADDRESS.test(String(value || ''));
}

/**
 * Validate and normalize a lean launch config. Throws with a message the
 * operator can read. `destination` receives the Fee Key (the position NFT that
 * claims the SOL fees); it is optional, and left empty the launch wallet keeps it.
 */
export function normalizeDammV2Config(input = {}) {
  const token = input.token || {};
  const supply = normalizeWholeTokenSupply(token.supply ?? '1000000000');
  const destination = String(input.destination || '').trim();
  if (destination) {
    if (!isAddress(destination)) throw new Error('Fee Key destination does not look like a Solana address');
    const unsafe = unsafeSweepDestinationReason(destination);
    if (unsafe) throw new Error(unsafe);
  }
  const selected = String(input.vanity?.selectedPublicKey || '').trim() || null;
  if (selected && !isAddress(selected)) throw new Error('Selected contract address does not look like a Solana address');
  return {
    venue: DAMM_V2_VENUE,
    token: {
      name: normalizeTokenName(token.name),
      symbol: normalizeTokenSymbol(token.symbol).toUpperCase(),
      supply,
      description: normalizeTokenDescription(token.description),
      decimals: TOKEN_DECIMALS,
    },
    pool: {
      startingMarketCapUsd: bounded('Starting market cap', input.startingMarketCapUsd ?? DAMM_V2_DEFAULTS.startingMarketCapUsd, DAMM_V2_LIMITS.startingMarketCapUsd),
      rangeMultiple: bounded('Price range', input.rangeMultiple ?? DAMM_V2_DEFAULTS.rangeMultiple, DAMM_V2_LIMITS.rangeMultiple, true),
      feeBps: bounded('Trading fee', input.feeBps ?? DAMM_V2_DEFAULTS.feeBps, DAMM_V2_LIMITS.feeBps, true),
    },
    destination: destination || null,
    vanity: { selectedPublicKey: selected },
  };
}

/**
 * The starting price and the curve above it, for display. The chain itself uses
 * exact integers (dammV2Service.dammV2PriceRange); these are the same numbers as
 * floats. Depth is the SOL a buyer pays to push the price to a multiple of the
 * start, before the trading fee.
 */
export function dammV2Pricing({ supply, startingMarketCapUsd, solUsd = FALLBACK_SOL_USD, rangeMultiple, feeBps = DAMM_V2_DEFAULTS.feeBps }) {
  const supplyWhole = Number(supply);
  const sol = Number(solUsd) > 0 ? Number(solUsd) : FALLBACK_SOL_USD;
  const startMarketCapSol = Number(startingMarketCapUsd) / sol;
  const startPrice = startMarketCapSol / supplyWhole; // SOL per token
  const k = Number(rangeMultiple);
  const sqrtStart = Math.sqrt(startPrice);
  const sqrtEnd = sqrtStart * Math.sqrt(k);
  // Constant-product liquidity over [start, end] that holds the whole supply as tokens.
  const liquidity = supplyWhole / (1 / sqrtStart - 1 / sqrtEnd);
  const fee = Number(feeBps) / 10_000;
  const toPrice = (multiple) => {
    const m = Math.min(Number(multiple), k);
    const sqrtPrice = sqrtStart * Math.sqrt(m);
    const netSol = liquidity * (sqrtPrice - sqrtStart);
    const tokensSold = supplyWhole - liquidity * (1 / sqrtPrice - 1 / sqrtEnd);
    return {
      multiple: m,
      marketCapUsd: Number(startingMarketCapUsd) * m,
      solToReach: netSol / (1 - fee),
      percentOfSupplySold: (tokensSold / supplyWhole) * 100,
    };
  };
  // What a buy of `solIn` (fee included) gets from the fresh pool, if nothing else has traded.
  const buy = (solIn) => {
    const netSol = Number(solIn) * (1 - fee);
    const sqrtPrice = Math.min(sqrtStart + netSol / liquidity, sqrtEnd);
    const tokens = liquidity * (1 / sqrtStart - 1 / sqrtPrice);
    return {
      solIn: Number(solIn),
      tokens,
      percentOfSupply: (tokens / supplyWhole) * 100,
      averagePriceMultiple: tokens > 0 ? (Number(solIn) / tokens) / startPrice : 1,
      endMarketCapUsd: Number(startingMarketCapUsd) * (sqrtPrice / sqrtStart) ** 2,
    };
  };
  return {
    solUsd: sol,
    startMarketCapSol,
    startPriceSol: startPrice,
    startPriceUsd: startPrice * sol,
    endMarketCapUsd: Number(startingMarketCapUsd) * k,
    toPrice,
    buy,
  };
}

export function dammV2DepthTable(pricing, multiples = [1.1, 1.5, 2, 5, 10]) {
  return multiples.map((multiple) => pricing.toPrice(multiple));
}

const solOf = (lamports) => lamports / LAMPORTS_PER_SOL;

/**
 * What the lean launch costs the launch wallet, line by line. Rent on the pool is
 * kept; there is no SOL seed. The token itself costs the same on any venue.
 */
export function dammV2CostModel({ keyTransfers = 0 } = {}) {
  const transfers = Math.max(0, Math.floor(Number(keyTransfers) || 0));
  const lines = [
    { id: 'token', label: 'Create the token and its metadata', sol: COST_TOKEN_CREATE_SOL, venue: false },
    {
      id: 'pool',
      label: 'Meteora pool, position and vaults (rent)',
      sol: solOf(DAMM_V2_POOL_RENT_LAMPORTS + DAMM_V2_POOL_TX_FEE_LAMPORTS + DAMM_V2_PRIORITY_FEE_LAMPORTS),
      venue: true,
    },
    ...(transfers
      ? [{ id: 'fee-key', label: `Send the Fee Key to ${transfers === 1 ? 'your wallet' : `${transfers} wallets`}`, sol: solOf(DAMM_V2_KEY_TRANSFER_LAMPORTS * transfers), venue: true }]
      : []),
  ];
  const subtotal = lines.reduce((sum, line) => sum + line.sol, 0);
  const buffer = subtotal * DAMM_V2_BUFFER_PCT;
  return {
    lines,
    buffer,
    total: subtotal + buffer,
    venueSol: lines.filter((line) => line.venue).reduce((sum, line) => sum + line.sol, 0),
    seedSol: 0,
  };
}

/** The same launch on both venues, venue cost only (the token costs the same on either). */
export function compareLaunchVenues({ raydiumVenueSol, dammVenueSol, solUsd = FALLBACK_SOL_USD }) {
  const raydium = Number(raydiumVenueSol);
  const damm = Number(dammVenueSol);
  const saved = Math.max(0, raydium - damm);
  return {
    raydiumVenueSol: raydium,
    dammVenueSol: damm,
    savedSol: saved,
    savedUsd: saved * Number(solUsd),
    savedPct: raydium > 0 ? Math.round((saved / raydium) * 100) : 0,
  };
}

/** Plain statements of what this venue does, for the review step. */
export function dammV2Facts(config) {
  const destination = config.destination ? 'the destination wallet' : 'the launch wallet';
  return [
    'The whole supply goes into one position on Meteora DAMM v2. No SOL is put in; buyers supply it.',
    'The position is locked permanently when the pool is created. Nobody can withdraw the liquidity.',
    `Trading fees (${(config.pool.feeBps / 100).toFixed(2)}%) are collected in SOL. ${destination.charAt(0).toUpperCase()}${destination.slice(1)} holds the Fee Key that claims them.`,
    'The first claim from a wallet opens a token account (about 0.002 SOL, refundable).',
  ];
}
