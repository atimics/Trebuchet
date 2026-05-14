// lpService.js
//
// Handles Raydium CLMM pool and concentrated-liquidity position creation
// for the token launcher. Slots in between createTokenWithMetaplex and
// transferTokensAndSol as a new step in the existing flow.
//
// Per-launch flow (orchestrated by createPoolsAndPositions):
//   The flow is split into two phases so that no pool becomes tradable
//   while later pools are still being built. (A pool becomes tradable
//   only when it has in-range liquidity — the bootstrap position is what
//   provides that. If we bootstrapped each pool immediately after its
//   main positions, a swap on the now-live first pool could move its
//   price while later pools — configured to launch at the same USD price
//   — are still being built, breaking their economics.)
//
//   Phase 1 — for each "allocation" entry the user configures, we:
//     1. Compute the initial pool price so the launched token's USD value
//        matches the target market cap.
//     2. createPool — initializes the CLMM pool at that price. No liquidity yet.
//     3. For each "slice" of the allocation's distribution: open a main
//        position with the slice's share of the supply, in a range that
//        keeps the position 100% launched-token initially. Lock it via
//        Burn & Earn. If the slice has an external recipient, transfer
//        the resulting Fee Key NFT to that recipient. Otherwise the Fee
//        Key stays with the ephemeral wallet for the final sweep.
//
//   Phase 2 — once every pool's main positions are in place:
//     4. For each pool, open one bootstrap position straddling current
//        tick. This makes the pool tradable. Lock it. Bootstrap is never
//        split or transferred — its Fee Key stays with the ephemeral
//        wallet for the final sweep.
//
// Sequential execution within and across phases — failures are easy to
// recover from this way. On error we throw with partialResults and a
// failedPhase ('main_positions' or 'bootstrap') attached.
//
// Mint-ordering note: Raydium pools have an internal canonical mintA/mintB
// ordering. The launched token may end up as either side depending on the
// quote token's pubkey. We detect this AFTER createPool returns and flip
// position-range geometry accordingly so the position always starts 100%
// launched-token regardless of which side it sorted to. See computeMainTicks.

import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
  Raydium,
  TxVersion,
  CLMM_PROGRAM_ID,
} from '@raydium-io/raydium-sdk-v2';
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  unpackMint,
  getExtensionTypes,
  ExtensionType,
} from '@solana/spl-token';
import { transferTokenWithProgram } from './walletHelpers.js';
import { discoverRaydiumRoute } from './swapService.js';
import BN from 'bn.js';
import Decimal from 'decimal.js';
import { getRpcUrl } from './rpcConfig.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// RPC URL is sourced from rpcConfig.js (which manages a persistent JSON config
// file plus runtime UI selection). We read it fresh inside initSdk() so that
// changing the active RPC mid-session takes effect on the next launch.

// Raydium CLMM tick boundaries (from raydium-clmm/libraries/tick_math.rs).
// Tick range: -443636 to +443636. We snap to multiples of tickSpacing.
const MIN_TICK = -443636;
const MAX_TICK = 443636;

// Default Raydium AmmConfig index. Index 3 = 1% fee, tickSpacing 120 — the
// "exotic" tier. Matches the pattern used in past manual launches. Other
// tiers are available at runtime via raydium.api.getClmmConfigs():
//   index 0 = 0.25% fee, tickSpacing 60   (most volatile pairs)
//   index 1 = 0.05% fee, tickSpacing 10   (major pairs)
//   index 2 = 0.01% fee, tickSpacing 1    (stables)
//   index 3 = 1.00% fee, tickSpacing 120  (exotic / new tokens)  <-- default
const DEFAULT_AMM_CONFIG_INDEX = 3;

// Bootstrap geometry: how many tickSpacings on each side of currentTick the
// bootstrap range spans. Width must be wide enough to stay in-range against
// minute-scale price drift between phases. Phase 1 (main positions) and
// phase 2 (bootstraps) can be separated by tens of seconds across all the
// pools; a SOL pool's tick in particular drifts on its own clock since it
// reflects external SOL/USD reality.
//
// Old value (1*tickSpacing each side) gave ~2.4% total width on a 1% pool.
// That's well within real-world drift on a 30-60 second multi-pool launch,
// and a single drift event past tickUpper or below tickLower made the
// deposit math go single-sided in a way the SDK wasn't expecting and the
// transaction failed.
//
// New value (10*tickSpacing each side) gives ~24% total width. Still
// concentrated enough to be useful liquidity, wide enough that any drift
// short of catastrophic stays in-range.
const BOOTSTRAP_TICKS_BELOW = 10;
const BOOTSTRAP_TICKS_ABOVE = 10;

// Bootstrap funding: 1 whole token of each side. Just enough to make the
// pool tradable; intentionally negligible value.
const BOOTSTRAP_BASE_TOKENS_WHOLE = 1;

// Floor on the SOL allocation when a SOL pool is included. Aggregators
// (Jupiter, GeckoTerminal, etc.) work best with a non-trivial SOL pool.
const MIN_SOL_ALLOCATION_PCT = 1;

// SOL mint (wrapped SOL) — Raydium pools always use wSOL, not native SOL.
const WSOL_MINT = 'So11111111111111111111111111111111111111112';

// Convenience map for well-known quote tokens. The caller can pass any SPL
// mint as a quote — this is just to skip on-chain decimals lookup for common
// cases and to provide a friendly default symbol.
//
// imageUrl/name are pulled from the canonical Solana token list on GitHub.
// These three tokens are stable enough that hardcoding is safer than
// adding a Gecko round-trip for them on every launch — and the URLs have
// been served from the same path for years.
export const KNOWN_QUOTES = {
  SOL: {
    address: WSOL_MINT,
    programId: TOKEN_PROGRAM_ID.toBase58(),
    decimals: 9,
    symbol: 'SOL',
    name: 'Solana',
    imageUrl:
      'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png',
  },
  USDC: {
    address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    programId: TOKEN_PROGRAM_ID.toBase58(),
    decimals: 6,
    symbol: 'USDC',
    name: 'USD Coin',
    imageUrl:
      'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png',
  },
  USDT: {
    address: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    programId: TOKEN_PROGRAM_ID.toBase58(),
    decimals: 6,
    symbol: 'USDT',
    name: 'USDT',
    imageUrl:
      'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB/logo.svg',
  },
};

// ---------------------------------------------------------------------------
// USD price + metadata lookup
// ---------------------------------------------------------------------------
//
// Implementation lives in tokenInfoService.js; we re-export here so existing
// callers (server.js for the /api/quote-token-info endpoint, the launch
// orchestrator below for per-allocation price resolution) keep using the
// same import paths they always have.
//
// What changed: getTokenMetadata used to be GeckoTerminal-only, and would
// return null whenever a token wasn't indexed there — which happens often
// for low-volume quote tokens, including the flywheel tokens this app is
// designed around. The new implementation reads decimals + symbol on-chain
// (always works for any real mint) and tries GeckoTerminal first then
// Jupiter as a price fallback, with a small in-memory cache so the user
// can flip between dropdown options without burning API quota.

export { getTokenMetadata, getUsdPrice } from './tokenInfoService.js';

// ---------------------------------------------------------------------------
// Diagnostic helpers
// ---------------------------------------------------------------------------

/**
 * Read and log the wallet's actual on-chain SOL balance and launched-token
 * ATA balance. Used between slice operations to make precision/balance bugs
 * easy to spot in the server logs.
 */
async function logWalletBalances(connection, ownerPk, tokenMint, label) {
  try {
    const lamports = await connection.getBalance(ownerPk);
    const solBalance = (lamports / 1e9).toFixed(6);

    let tokenBalance = 'no ATA';
    try {
      const accounts = await connection.getParsedTokenAccountsByOwner(ownerPk, {
        mint: new PublicKey(tokenMint),
      });
      if (accounts.value.length > 0) {
        tokenBalance = accounts.value[0].account.data.parsed.info.tokenAmount.amount;
      }
    } catch (e) {
      tokenBalance = `lookup failed: ${e.message}`;
    }

    console.log(`    [balances ${label}] SOL=${solBalance}, launched-token raw=${tokenBalance}`);
  } catch (e) {
    console.warn(`    [balances ${label}] lookup error: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// CLMM fee tier listing (used by the UI dropdown)
// ---------------------------------------------------------------------------
//
// Raydium's CLMM uses a fixed set of AmmConfig PDAs created on-chain when
// the program was deployed. Each AmmConfig encodes a (tradeFeeRate,
// tickSpacing) pair plus protocol/fund fee shares; pools reference one
// at creation time via ammConfigIndex.
//
// The canonical list is published at api-v3.raydium.io/main/clmm-config.
// At launch time we use raydium.api.getClmmConfigs() (which hits the same
// endpoint via the SDK) but for the configuration UI we want the list
// before the user has a wallet to drive the SDK with. So this is a thin
// HTTP wrapper, with a process-lifetime cache and a hardcoded fallback
// for the case where the endpoint is unreachable.
//
// As of late 2025 there are eight tiers per Raydium's docs: 2%, 1%,
// 0.25%, 0.05%, 0.04%, 0.03%, 0.02%, 0.01%. We don't hardcode the
// indices because Raydium can add tiers; we let the API tell us.

const RAYDIUM_CLMM_CONFIG_URL = 'https://api-v3.raydium.io/main/clmm-config';

// Hardcoded fallback for when the Raydium API is unreachable. These are
// the indices that have been stable since CLMM launched; the broader
// list (including 2%) is only available via the live API. Keeping this
// minimal means it's safer to be wrong about what's still in the live
// set — the user's launch will fall back to a known-good tier.
const FALLBACK_FEE_TIERS = [
  { index: 0, tradeFeeRate:  2500, tickSpacing:  60 }, // 0.25%
  { index: 1, tradeFeeRate:   500, tickSpacing:  10 }, // 0.05%
  { index: 2, tradeFeeRate:   100, tickSpacing:   1 }, // 0.01%
  { index: 3, tradeFeeRate: 10000, tickSpacing: 120 }, // 1%
];

let cachedFeeTiers = null;

/**
 * Return the list of CLMM fee tiers available on Raydium. Each entry is
 * a normalized object with { index, tradeFeeRate, tickSpacing }; the
 * tradeFeeRate is in 1e-6 units (so 10000 = 1%).
 *
 * Caches the result for the process lifetime — Raydium adds new configs
 * rarely enough that re-fetching on every UI load would be wasteful.
 * Restart the server (or reload the Electron app) to pick up new tiers.
 */
export async function getClmmFeeTiers() {
  if (cachedFeeTiers) return cachedFeeTiers;
  try {
    const resp = await fetch(RAYDIUM_CLMM_CONFIG_URL, {
      headers: { Accept: 'application/json' },
    });
    if (!resp.ok) {
      console.warn(
        `getClmmFeeTiers: HTTP ${resp.status} from Raydium API, using fallback list`,
      );
      cachedFeeTiers = FALLBACK_FEE_TIERS;
      return cachedFeeTiers;
    }
    const json = await resp.json();
    // The endpoint wraps the array in { id, success, data } in some
    // versions and returns the bare array in others; accept both.
    const list = Array.isArray(json) ? json : (json.data || []);
    if (!Array.isArray(list) || list.length === 0) {
      console.warn(
        'getClmmFeeTiers: Raydium API returned empty/unexpected payload, using fallback list',
      );
      cachedFeeTiers = FALLBACK_FEE_TIERS;
      return cachedFeeTiers;
    }
    cachedFeeTiers = list
      .map((c) => ({
        index: c.index,
        tradeFeeRate: c.tradeFeeRate,
        tickSpacing: c.tickSpacing,
      }))
      .filter((c) => Number.isInteger(c.index) && Number.isInteger(c.tradeFeeRate))
      // Sort by ascending fee, the most natural way to display them.
      .sort((a, b) => a.tradeFeeRate - b.tradeFeeRate);
    return cachedFeeTiers;
  } catch (e) {
    console.warn(`getClmmFeeTiers: ${e.message}; using fallback list`);
    cachedFeeTiers = FALLBACK_FEE_TIERS;
    return cachedFeeTiers;
  }
}

// ---------------------------------------------------------------------------
// SDK initialization
// ---------------------------------------------------------------------------

/**
 * Build a fresh Raydium SDK instance for the given owner keypair. We don't
 * cache across calls because the owner changes per launch.
 */
async function initSdk(ownerKeypair) {
  const connection = new Connection(getRpcUrl(), {
    commitment: 'confirmed',
    confirmTransactionInitialTimeout: 60_000,
  });
  return Raydium.load({
    owner: ownerKeypair,
    connection,
    cluster: 'mainnet',
    disableFeatureCheck: true,
    disableLoadToken: true, // skip the multi-MB token-list fetch
    blockhashCommitment: 'finalized',
  });
}

// ---------------------------------------------------------------------------
// Quote-token resolution
// ---------------------------------------------------------------------------

// =============================================================================
// Raydium CLMM Token-2022 compatibility check
// =============================================================================
//
// Raydium's CLMM program enforces a strict allowlist of Token-2022 extensions
// in its on-chain `is_supported_mint` check. A mint with even one disallowed
// extension makes pool creation revert with `NotSupportMint` (or sometimes
// Anchor's ConstraintMintTokenProgram if a constraint catches it earlier).
//
// SOURCE OF TRUTH (verified against raydium-clmm/programs/amm/src/util/token.rs
// at github.com/raydium-io/raydium-clmm, function `is_supported_mint`):
//
//   - classic SPL Token mints are always supported (no extensions)
//   - Token-2022 mints with NO extensions are supported
//   - Token-2022 mints whose extensions are ALL in this allowlist are supported:
//       * TransferFeeConfig
//       * MetadataPointer
//       * TokenMetadata
//       * InterestBearingConfig
//       * ScaledUiAmount  (called ScaledUiAmountConfig in @solana/spl-token JS)
//   - escape hatches that work case-by-case but we can't rely on:
//       * hardcoded MINT_WHITELIST (a handful of specific stablecoin mints)
//       * a per-mint "support mint associated" account that has to be created
//         on chain by Raydium ahead of time
//       * Superstate special case (ScaledUI compat)
//
// Anything else — Permanent Delegate, Non-Transferable, Default Account State,
// Confidential Transfers, CPI Guard, Transfer Hooks, Pausable, Group Pointers,
// etc — will fail pool creation.
//
// pump.fun graduated tokens have only TransferFeeConfig + MetadataPointer +
// TokenMetadata, all of which are in this allowlist. They should always work.
// If pump.fun ever adds an extension to their template that isn't in this
// allowlist, this check is the trigger that tells us — and the user — clearly.
const RAYDIUM_CLMM_ALLOWED_TOKEN2022_EXTENSIONS = new Set([
  ExtensionType.TransferFeeConfig,
  ExtensionType.MetadataPointer,
  ExtensionType.TokenMetadata,
  ExtensionType.InterestBearingConfig,
  // The rust source spells this ScaledUiAmount; @solana/spl-token v0.4.x
  // exports it as ScaledUiAmountConfig. Same on-chain extension. Reference
  // both names so the check survives an SDK rename in either direction.
  ExtensionType.ScaledUiAmountConfig,
  ExtensionType.ScaledUiAmount,
].filter((v) => v !== undefined));

// Raydium's hardcoded MINT_WHITELIST. These 6 specific mints (mostly
// regulated stablecoins like PYUSD and AUSD) are accepted by the CLMM
// program even when they carry extensions that would otherwise fail the
// `is_supported_mint` check — Raydium specifically vetted them.
//
// We mirror the same whitelist here so our pre-flight doesn't falsely
// reject these tokens. Empirically: PYUSD has 8 extensions including
// PermanentDelegate, ConfidentialTransferMint, and TransferHook — none
// of which are in the generic allowlist — but it works as a Raydium pool
// quote token because it's in this list.
//
// Source-of-truth (kept in sync with raydium-clmm/programs/amm/src/util/token.rs):
const RAYDIUM_CLMM_MINT_WHITELIST = new Set([
  'HVbpJAQGNpkgBaYBZQBR1t7yFdvaYVp2vCQQfKKEN4tM',
  'Crn4x1Y2HUKko7ox2EZMT6N2t2ZyH7eKtwkBGVnhEq1g',
  'FrBfWJ4qE5sCzKm3k3JaAtqZcXUh4LvJygDeketsrsH4',
  '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo', // PYUSD
  'DAUcJBg4jSpVoEzASxYzdqHMUN8vuTpQyG2TvDcCHfZg',
  'AUSD1jCcCyPLybk1YnvPWsHQSrZ46dxwoMniN4N2UEB9', // AUSD
]);

// Friendly names for error messages. These get surfaced in the UI so a
// dev/user can google the extension name and understand why their token
// isn't compatible. Keep these aligned with the ExtensionType enum
// labels in @solana/spl-token; missing entries fall through to "#N".
//
// Note on numeric keys: @solana/spl-token v0.4.x doesn't export named
// constants for ConfidentialTransferFeeConfig (16) and
// ConfidentialTransferFeeAmount (17), so we hard-code those numbers.
// They were stable in the spl-token-2022 program from the start.
const EXTENSION_DISPLAY_NAMES = {
  [ExtensionType.TransferFeeAmount]:        'TransferFeeAmount (account-side)',
  [ExtensionType.MintCloseAuthority]:       'MintCloseAuthority',
  [ExtensionType.ConfidentialTransferMint]: 'ConfidentialTransferMint',
  [ExtensionType.DefaultAccountState]:      'DefaultAccountState (e.g. frozen-by-default)',
  [ExtensionType.ImmutableOwner]:           'ImmutableOwner',
  [ExtensionType.MemoTransfer]:             'MemoTransfer (memo required on transfer)',
  [ExtensionType.NonTransferable]:          'NonTransferable (soulbound)',
  [ExtensionType.CpiGuard]:                 'CpiGuard',
  [ExtensionType.PermanentDelegate]:        'PermanentDelegate',
  [ExtensionType.TransferHook]:             'TransferHook',
  16:                                       'ConfidentialTransferFeeConfig',
  17:                                       'ConfidentialTransferFeeAmount',
  [ExtensionType.GroupPointer]:             'GroupPointer',
  [ExtensionType.TokenGroup]:               'TokenGroup',
  [ExtensionType.GroupMemberPointer]:       'GroupMemberPointer',
  [ExtensionType.TokenGroupMember]:         'TokenGroupMember',
  [ExtensionType.PausableConfig]:           'PausableConfig',
  [ExtensionType.PausableAccount]:          'PausableAccount',
};

/**
 * Read a mint account and determine whether it can be used as either side of
 * a Raydium CLMM pool. Returns a richly-typed result so callers can decide
 * how to surface incompatibility — fail-fast on the server, warning chip in
 * the UI, etc.
 *
 * Returns:
 *   {
 *     programId:        PublicKey  (TOKEN_PROGRAM_ID or TOKEN_2022_PROGRAM_ID),
 *     decimals:         number,
 *     isToken2022:      bool,
 *     extensions:       ExtensionType[]   (Token-2022 only; classic = []),
 *     compatible:       bool,
 *     disallowed:       ExtensionType[]   (subset of extensions not in allowlist),
 *     disallowedNames:  string[]          (human-readable form of disallowed),
 *   }
 *
 * Throws if:
 *   - mint doesn't exist on chain
 *   - mint is owned by a program that isn't one of the two token programs
 *   - the account data can't be parsed as a mint (corrupt / not a mint)
 */
export async function getMintCompatibilityWithRaydiumClmm(connection, mintPk) {
  const accountInfo = await connection.getAccountInfo(mintPk, 'confirmed');
  if (!accountInfo) {
    throw new Error(`Mint ${mintPk.toBase58()} does not exist on chain`);
  }
  const owner = accountInfo.owner;
  if (!owner.equals(TOKEN_PROGRAM_ID) && !owner.equals(TOKEN_2022_PROGRAM_ID)) {
    throw new Error(
      `${mintPk.toBase58()} is owned by ${owner.toBase58()}, not a recognized ` +
        `token program — this isn't a token mint at all.`,
    );
  }

  // unpackMint validates the base mint struct and returns it; for Token-2022
  // it also exposes the trailing TLV bytes that hold extensions.
  const mint = unpackMint(mintPk, accountInfo, owner);
  const isToken2022 = owner.equals(TOKEN_2022_PROGRAM_ID);

  // Classic SPL Token mints have no extensions and are always supported.
  if (!isToken2022) {
    return {
      programId: owner,
      decimals: mint.decimals,
      isToken2022: false,
      extensions: [],
      compatible: true,
      whitelisted: false,
      disallowed: [],
      disallowedNames: [],
    };
  }

  // Token-2022 path: pull the extension list from the TLV data. Some token
  // accounts (with no extensions) have empty tlvData — getExtensionTypes
  // returns [] in that case, which is fine.
  const extensions = getExtensionTypes(mint.tlvData || Buffer.alloc(0));
  const disallowed = extensions.filter(
    (e) => !RAYDIUM_CLMM_ALLOWED_TOKEN2022_EXTENSIONS.has(e),
  );
  const disallowedNames = disallowed.map(
    (e) => EXTENSION_DISPLAY_NAMES[e] || `extension #${e}`,
  );

  // Whitelist short-circuit. Raydium's CLMM hard-codes 6 specific mints as
  // always-compatible — they have extensions that would otherwise fail the
  // generic check (e.g. PYUSD has PermanentDelegate, ConfidentialTransfer,
  // TransferHook, etc.) but the protocol team specifically vetted them.
  // We have to mirror this here, otherwise our pre-flight would falsely
  // reject these well-known stablecoins as quote tokens.
  const isWhitelisted = RAYDIUM_CLMM_MINT_WHITELIST.has(mintPk.toBase58());
  if (isWhitelisted && disallowed.length > 0) {
    return {
      programId: owner,
      decimals: mint.decimals,
      isToken2022: true,
      extensions,
      compatible: true,
      whitelisted: true,
      // Surface the extensions that WOULD be a problem if not whitelisted —
      // good for diagnostics ("yes I know PYUSD has PermanentDelegate, it's
      // fine because Raydium whitelisted it"). Empty for whitelisted mints
      // whose extensions happen to all be in the allowlist already.
      whitelistedDespite: disallowedNames,
      disallowed: [],
      disallowedNames: [],
    };
  }

  return {
    programId: owner,
    decimals: mint.decimals,
    isToken2022: true,
    extensions,
    compatible: disallowed.length === 0,
    whitelisted: false,
    disallowed,
    disallowedNames,
  };
}

/**
 * Resolve a quote-token spec to {address, programId, decimals, symbol}.
 * Accepts either a known symbol (SOL/USDC/USDT) or an arbitrary SPL mint
 * address. For arbitrary addresses we hit RPC for decimals unless an
 * override is supplied.
 */
async function resolveQuoteToken(connection, spec, overrides = {}) {
  // Symbol shortcut
  const upper = (spec || '').toUpperCase();
  if (KNOWN_QUOTES[upper]) {
    const base = { ...KNOWN_QUOTES[upper] };
    // Allow per-call overrides for symbol/decimals even on known tokens
    if (overrides.decimals !== undefined && overrides.decimals !== null) {
      base.decimals = Number(overrides.decimals);
    }
    if (overrides.symbol) base.symbol = overrides.symbol;
    return base;
  }

  // Treat as a mint address.
  //
  // We must detect (a) which token program owns this mint and (b) whether
  // its Token-2022 extensions are all in Raydium CLMM's allowlist. Both
  // checks are fail-fast safety nets — getting either wrong means the
  // pool-creation tx will revert later with an opaque on-chain error, after
  // we've already paid for it. One getAccountInfo + unpackMint roundtrip
  // covers both, so the cost is negligible.
  const mintPk = new PublicKey(spec);
  const compat = await getMintCompatibilityWithRaydiumClmm(connection, mintPk);

  if (!compat.compatible) {
    // Surface BOTH the unsupported extensions and the allowlist so the
    // user (or dev reading logs) knows exactly what changed.
    throw new Error(
      `Quote token ${spec} cannot be paired in a Raydium CLMM pool. ` +
        `Its Token-2022 mint has these unsupported extensions: ` +
        `${compat.disallowedNames.join(', ')}. ` +
        `Raydium CLMM only allows: TransferFeeConfig, MetadataPointer, ` +
        `TokenMetadata, InterestBearingConfig, ScaledUiAmount.`,
    );
  }

  // decimals: prefer caller override (helpful when Gecko returned them
  // and we want to skip the extra round-trip), else use what we just read
  // from the mint account.
  const decimals =
    overrides.decimals !== undefined && overrides.decimals !== null
      ? Number(overrides.decimals)
      : compat.decimals;

  return {
    address: mintPk.toBase58(),
    programId: compat.programId.toBase58(),
    decimals,
    symbol: overrides.symbol || spec.slice(0, 6),
    // Forward compatibility metadata so callers (e.g. progress logging,
    // bootstrap fee math) can react to Token-2022 specifics without
    // having to re-fetch the mint. Strictly informational — callers that
    // don't care can ignore these fields.
    isToken2022: compat.isToken2022,
    extensions: compat.extensions,
  };
}

// ---------------------------------------------------------------------------
// Tick math
// ---------------------------------------------------------------------------

function floorToSpacing(tick, tickSpacing) {
  return Math.floor(tick / tickSpacing) * tickSpacing;
}

function ceilToSpacing(tick, tickSpacing) {
  return Math.ceil(tick / tickSpacing) * tickSpacing;
}

/**
 * Compute the main position's tick range, asymmetric based on which side the
 * launched token sorted to. The goal is always: position starts at 100%
 * launched-token, holds it through the range.
 *
 * When launched=mintA: range goes ABOVE current tick (currentTick<tickLower
 *   means 100% mintA = 100% launched). Conversion happens as price RISES
 *   into range (= launched appreciating in quote terms).
 *
 * When launched=mintB: range goes BELOW current tick (currentTick>tickUpper
 *   means 100% mintB = 100% launched). Conversion happens as price DROPS
 *   into range (= absorbing buy demand on dips). The deposit math is
 *   identical but the economic mechanic differs.
 */
function computeMainTicks({ currentTick, tickSpacing, launchedIsMintA }) {
  const maxAligned = floorToSpacing(MAX_TICK, tickSpacing);
  const minAligned = ceilToSpacing(MIN_TICK, tickSpacing);

  if (launchedIsMintA) {
    return {
      tickLower: ceilToSpacing(currentTick + 1, tickSpacing),
      tickUpper: maxAligned,
    };
  } else {
    return {
      tickLower: minAligned,
      tickUpper: floorToSpacing(currentTick - 1, tickSpacing),
    };
  }
}

/**
 * Compute the bootstrap position's tick range. Symmetric — small band
 * straddling currentTick. Holds both tokens when current price is in range.
 */
function computeBootstrapTicks({ currentTick, tickSpacing }) {
  const center = floorToSpacing(currentTick, tickSpacing);
  return {
    tickLower: center - BOOTSTRAP_TICKS_BELOW * tickSpacing,
    tickUpper: center + BOOTSTRAP_TICKS_ABOVE * tickSpacing,
  };
}

// ---------------------------------------------------------------------------
// Distribution normalization
// ---------------------------------------------------------------------------

/**
 * Validate and normalize the distribution array for an allocation.
 * If absent or empty, returns [{ sharePercent: 100 }] — single slice, all
 * Fee Keys end up at the destination wallet via the normal sweep.
 *
 * Each slice can optionally specify a `recipient` (a base58 wallet address)
 * to transfer that slice's Fee Key NFT to instead of the default sweep.
 */
function normalizeDistribution(distribution) {
  if (!distribution || distribution.length === 0) {
    return [{ sharePercent: 100 }];
  }
  const slices = distribution.map((s) => ({
    sharePercent: Number(s.sharePercent),
    recipient: s.recipient || null,
  }));
  const total = slices.reduce((acc, s) => acc + s.sharePercent, 0);
  // Tolerate small floating-point drift but reject anything meaningfully off
  if (Math.abs(total - 100) > 0.01) {
    throw new Error(
      `Distribution shares sum to ${total}%, must sum to 100%`,
    );
  }
  if (slices.some((s) => s.sharePercent <= 0)) {
    throw new Error(`All distribution shares must be > 0%`);
  }
  // Validate any recipient addresses
  for (const s of slices) {
    if (s.recipient) {
      try {
        new PublicKey(s.recipient);
      } catch (e) {
        throw new Error(`Invalid recipient address: ${s.recipient}`);
      }
    }
  }
  return slices;
}

// ---------------------------------------------------------------------------
// NFT transfer (used to send Fee Keys to external recipients)
// ---------------------------------------------------------------------------

/**
 * Transfer 1 unit of an NFT from owner to recipient.
 *
 * IMPORTANT: Raydium CLMM position NFTs (and the Fee Key NFTs minted when
 * Burn & Earn locks them) are minted under the Token-2022 program, NOT
 * classic SPL Token. The transfer instruction must target the same program
 * the mint lives under, or the tx will fail with "incorrect program id".
 *
 * We don't know upfront which program the NFT lives under, so we look up
 * the mint owner first. This handles future cases where Raydium changes
 * which program they mint under, and works correctly for any NFT regardless
 * of source.
 */
async function transferNftToRecipient({
  connection,
  ownerKeypair,
  nftMint,
  recipient,
}) {
  const mintPk = new PublicKey(nftMint);
  const recipientPk = new PublicKey(recipient);

  // Look up which token program owns this mint
  const mintAccountInfo = await connection.getAccountInfo(mintPk);
  if (!mintAccountInfo) {
    throw new Error(`Mint ${nftMint} not found on-chain`);
  }
  const programId = mintAccountInfo.owner;
  if (
    !programId.equals(TOKEN_PROGRAM_ID) &&
    !programId.equals(TOKEN_2022_PROGRAM_ID)
  ) {
    throw new Error(
      `Mint ${nftMint} is owned by an unexpected program: ${programId.toBase58()}`,
    );
  }

  return transferTokenWithProgram({
    connection,
    ownerKeypair,
    mint: mintPk,
    destination: recipientPk,
    amount: 1n,
    decimals: 0,
    programId,
  });
}

// ---------------------------------------------------------------------------
// Per-pool orchestration
// ---------------------------------------------------------------------------

/**
 * Phase 1 of the per-pool flow: create one pool, open the main positions
 * (one per distribution slice), lock each, and optionally transfer Fee Keys
 * to external recipients.
 *
 * The bootstrap position — the one that makes the pool tradable — is
 * intentionally NOT opened here. The orchestrator runs bootstraps for all
 * pools as a separate phase, after every pool's main positions have landed,
 * so no pool becomes tradable while later pools are still being built. See
 * the long comment near the bottom of this function for the full reasoning.
 *
 * Returns:
 *   {
 *     poolId,
 *     launchedSide: 'mintA' | 'mintB',
 *     mainPositions: [
 *       { sliceIndex, sharePercent, nftMint, locked, recipient,
 *         transferredTo, txIds: { open, lock, transfer } }, ...
 *     ],
 *     txIds: { createPool },
 *     // Internal — orchestrator strips this before exposing the result
 *     _bootstrapContext: { poolId, poolInfo, poolKeys, currentTickAtCreation,
 *                          tickSpacing, launchedIsMintA, bootstrapBaseRaw,
 *                          initialPrice, quoteToken },
 *   }
 */
async function createSinglePool({
  raydium,
  ownerKeypair,
  ammConfig,
  launchedToken,
  quoteToken,
  initialPrice,
  totalMainBaseRaw,
  distribution,
  lockPositions,
  onProgress,
}) {
  const progress = (event) => onProgress && onProgress(event);
  const connection = raydium.connection;

  // -----------------------------------------------------------------------
  // 1. Create the pool. We pass the launched token as mint1 by convention;
  //    the SDK may reorder internally. We confirm via mintA after.
  // -----------------------------------------------------------------------
  console.log(`Creating CLMM pool: ${launchedToken.address} / ${quoteToken.address}`);
  progress({ stage: 'pool_create_start' });

  const createRes = await raydium.clmm.createPool({
    programId: CLMM_PROGRAM_ID,
    mint1: launchedToken,
    mint2: quoteToken,
    ammConfig,
    initialPrice,
    txVersion: TxVersion.V0,
    computeBudgetConfig: { units: 600_000, microLamports: 50_000 },
  });

  const createTx = await createRes.execute({ sendAndConfirm: true });
  // extInfo.address.id is already a base58 string (SDK calls .toString() internally
  // when building the extInfo). Don't call toBase58() on it.
  const poolId = createRes.extInfo.address.id;
  console.log(`  pool created: ${poolId}, tx: ${createTx.txId}`);
  progress({ stage: 'pool_create_done', poolId, txId: createTx.txId });

  // -----------------------------------------------------------------------
  // 2. Refresh pool info from RPC. Newly-created pools take ~5 minutes to
  //    appear in the API; getPoolInfoFromRpc reads on-chain state directly.
  // -----------------------------------------------------------------------
  await new Promise((r) => setTimeout(r, 2000));

  const { poolInfo, poolKeys } = await raydium.clmm.getPoolInfoFromRpc(poolId);
  const rpcData = await raydium.clmm.getRpcClmmPoolInfo({ poolId });

  const tickSpacing = poolInfo.config.tickSpacing;
  const currentTick = rpcData.tickCurrent;
  const launchedIsMintA = poolInfo.mintA.address === launchedToken.address;
  console.log(
    `  launched token sorted as ${launchedIsMintA ? 'mintA' : 'mintB'}, ` +
      `currentTick=${currentTick}, tickSpacing=${tickSpacing}`,
  );

  // -----------------------------------------------------------------------
  // 3. Compute the main range — same range for every slice in this pool.
  //    Then assert the range is correctly positioned on the right side of
  //    currentTick for single-sided launched-token deposit.
  //
  //    CLMM rules (Uniswap V3 conventions):
  //      currentTick <  tickLower  → position holds 100% token0
  //      tickLower <= currentTick < tickUpper  → position is in-range, holds both
  //      currentTick >= tickUpper  → position holds 100% token1
  //
  //    For single-sided launched-token deposit:
  //      - launched=mintA (token0): need currentTick < tickLower (range above)
  //      - launched=mintB (token1): need currentTick >= tickUpper (range below)
  //
  //    If these conditions aren't met (e.g., due to a tick alignment edge case),
  //    the position would be in-range and require quote-side liquidity, which
  //    would fail the deposit. Better to abort here than have the SDK fail.
  // -----------------------------------------------------------------------
  const mainTicks = computeMainTicks({ currentTick, tickSpacing, launchedIsMintA });
  console.log(`  main range: [${mainTicks.tickLower}, ${mainTicks.tickUpper}]`);

  if (launchedIsMintA && currentTick >= mainTicks.tickLower) {
    throw new Error(
      `Main range mispositioned for launched=mintA: tickLower (${mainTicks.tickLower}) ` +
        `must be > currentTick (${currentTick}) so the position is single-sided in the launched ` +
        `token. This shouldn't happen with the current tick logic — please report this.`,
    );
  }
  if (!launchedIsMintA && currentTick < mainTicks.tickUpper) {
    throw new Error(
      `Main range mispositioned for launched=mintB: tickUpper (${mainTicks.tickUpper}) ` +
        `must be <= currentTick (${currentTick}) so the position is single-sided in the launched ` +
        `token. This shouldn't happen with the current tick logic — please report this.`,
    );
  }
  console.log(
    `  range positioning verified: launched=${launchedIsMintA ? 'mintA' : 'mintB'}, ` +
      `position is ${launchedIsMintA ? 'above' : 'below'} currentTick by ` +
      `${launchedIsMintA ? mainTicks.tickLower - currentTick : currentTick - mainTicks.tickUpper} ticks`,
  );

  // -----------------------------------------------------------------------
  // 4. Open + lock + (optionally) transfer one position per slice
  // -----------------------------------------------------------------------
  const mainPositions = [];

  // Reserve 1 whole token for the bootstrap, deduct from total before slicing.
  // Also reserve 1 whole token of slack PER SLICE on top of that. The CLMM
  // contract uses mulDivCeil on the user-pays side, so the actual transferred
  // amount can be 1-2 raw units more than the input baseAmount. With a 100%
  // supply allocation across multiple slices, the wallet would otherwise hold
  // exactly the input amount with zero margin — any slice after the first
  // would fail with InsufficientFunds. Reserving 1 whole token per slice is
  // overkill mathematically (the actual rounding is sub-microtoken), but it
  // costs nothing meaningful (out of 1B supply, a few tokens is dust) and
  // bulletproofs us against any future SDK rounding changes. The reserved
  // tokens stay in the wallet and get swept to destination at the end.
  const oneTokenRaw = new BN(10).pow(new BN(launchedToken.decimals));
  const bootstrapBaseRaw = new BN(BOOTSTRAP_BASE_TOKENS_WHOLE).mul(oneTokenRaw);
  const sliceSlackRaw = oneTokenRaw.mul(new BN(distribution.length));
  const slicableRaw = totalMainBaseRaw.sub(bootstrapBaseRaw).sub(sliceSlackRaw);
  console.log(
    `  reserved: ${distribution.length} token(s) per-slice slack + 1 token bootstrap; ` +
      `slicableRaw=${slicableRaw.toString()}`,
  );

  // Diagnostic: log actual on-chain wallet balances so we can see what the
  // wallet has vs what we're about to deposit
  await logWalletBalances(connection, ownerKeypair.publicKey, launchedToken.address, 'before slicing');

  for (let i = 0; i < distribution.length; i++) {
    const slice = distribution[i];

    // Compute this slice's raw token amount.
    // sliceRaw = slicableRaw * sharePercent / 100, integer math.
    // Multiply by 100 first to keep 2 decimals of precision in sharePercent.
    const sliceRaw = slicableRaw
      .mul(new BN(Math.round(slice.sharePercent * 100)))
      .div(new BN(10000));

    console.log(
      `  opening slice ${i + 1}/${distribution.length} (${slice.sharePercent}%): ` +
        `${sliceRaw.toString()} raw`,
    );
    progress({ stage: 'main_open_start', sliceIndex: i });

    // Refresh the SDK's cached token account info between slices. The previous
    // slice changed the launched-token ATA balance, and the SDK may have cached
    // assumptions that need updating before building the next tx.
    if (i > 0) {
      try {
        await raydium.account.fetchWalletTokenAccounts({ forceUpdate: true });
        console.log('    refreshed SDK token account cache');
      } catch (e) {
        console.warn('    cache refresh failed (non-fatal):', e.message);
      }
      // Brief settle so the previous lock tx is fully visible to the RPC
      await new Promise((r) => setTimeout(r, 1500));
    }

    const openRes = await raydium.clmm.openPositionFromBase({
      poolInfo,
      poolKeys,
      ownerInfo: { useSOLBalance: true },
      tickLower: mainTicks.tickLower,
      tickUpper: mainTicks.tickUpper,
      base: launchedIsMintA ? 'MintA' : 'MintB',
      baseAmount: sliceRaw,
      // True single-sided: range is entirely on one side of the current tick
      // so the position genuinely needs ZERO of the other token. Pass 0 here —
      // when otherAmount is zero the SDK auto-creates the missing-side ATA.
      // (If we pass nonzero, the SDK assumes the ATA already has that balance,
      // which would fail for non-SOL quote pools where we haven't pre-created
      // the ATA.)
      otherAmountMax: new BN(0),
      txVersion: TxVersion.V0,
      computeBudgetConfig: { units: 600_000, microLamports: 50_000 },
    });
    const openTx = await openRes.execute({ sendAndConfirm: true });
    const nftMint = openRes.extInfo?.nftMint?.toBase58();
    console.log(`    opened: nft=${nftMint}, tx=${openTx.txId}`);
    progress({ stage: 'main_open_done', sliceIndex: i, nftMint, txId: openTx.txId });

    // Diagnostic: balance after open
    await logWalletBalances(connection, ownerKeypair.publicKey, launchedToken.address, `after slice ${i + 1} open`);

    // Lock this position via Burn & Earn.
    // The SDK's lockPosition uses a SEPARATE program (CLMM_LOCK_PROGRAM_ID) —
    // don't pass programId here (it would override the right default with the
    // CLMM program ID, which doesn't have the lock instructions). The function
    // only needs ownerPosition.nftMint; poolInfo/poolKeys are not parameters.
    let lockTxId = null;
    if (lockPositions) {
      const lockRes = await raydium.clmm.lockPosition({
        ownerPosition: { nftMint: new PublicKey(nftMint) },
        txVersion: TxVersion.V0,
      });
      const lockTx = await lockRes.execute({ sendAndConfirm: true });
      lockTxId = lockTx.txId;
      console.log(`    locked: tx=${lockTxId}`);
      progress({ stage: 'main_lock_done', sliceIndex: i, txId: lockTxId });
    }

    // Transfer Fee Key NFT to external recipient if specified.
    // After locking, the Fee Key NFT lives in the same ATA the position NFT
    // was originally minted to (locker mints the Fee Key to that owner).
    let transferTxId = null;
    let transferredTo = null;
    if (slice.recipient && lockPositions) {
      console.log(`    transferring Fee Key to ${slice.recipient}...`);
      transferTxId = await transferNftToRecipient({
        connection,
        ownerKeypair,
        nftMint,
        recipient: slice.recipient,
      });
      transferredTo = slice.recipient;
      console.log(`    transferred: tx=${transferTxId}`);
      progress({
        stage: 'main_transfer_done',
        sliceIndex: i,
        recipient: slice.recipient,
        txId: transferTxId,
      });
    }

    mainPositions.push({
      sliceIndex: i,
      sharePercent: slice.sharePercent,
      nftMint,
      locked: lockPositions,
      recipient: slice.recipient || null,
      transferredTo,
      txIds: {
        open: openTx.txId,
        lock: lockTxId,
        transfer: transferTxId,
      },
    });
  }

  // -----------------------------------------------------------------------
  // NOTE: the bootstrap position is intentionally NOT opened here.
  //
  // The bootstrap is the position that makes the pool tradable (it's the
  // only position straddling currentTick at launch time). If we opened
  // the bootstrap immediately after this pool's main slices, then for a
  // multi-pool launch the FIRST pool would become tradable while later
  // pools were still being built. A swap on the now-live first pool could
  // move its price, but more importantly the price discovery happening on
  // the first pool would mean later pools — which were configured to all
  // start at the same USD price — could end up with wildly mismatched
  // economics by the time their main positions land.
  //
  // Instead, we hand back the per-pool state needed for bootstrapping
  // (poolInfo/poolKeys/tick math/etc.) and let the orchestrator open all
  // bootstraps in a separate phase, AFTER every pool's main positions are
  // in place. By the time bootstrapping starts, the main positions are
  // already locked at their target ranges and immune to any subsequent
  // price drift the bootstraps might cause.
  // -----------------------------------------------------------------------

  return {
    poolId,
    launchedSide: launchedIsMintA ? 'mintA' : 'mintB',
    mainPositions,
    txIds: { createPool: createTx.txId },
    // Context the deferred bootstrap step needs. Not part of the user-facing
    // result shape — caller strips this before returning.
    _bootstrapContext: {
      poolId,
      poolInfo,
      poolKeys,
      // currentTick captured here is the phase-1 value. The bootstrap step
      // re-fetches the fresh on-chain tick at deposit time to absorb any
      // drift that happened between phases.
      currentTickAtCreation: currentTick,
      tickSpacing,
      launchedIsMintA,
      bootstrapBaseRaw,
      initialPrice,
      quoteToken,
    },
  };
}

// ---------------------------------------------------------------------------
// Bootstrap-position step (deferred, runs after all main positions land)
// ---------------------------------------------------------------------------

/**
 * Open and lock the bootstrap position for a single pool.
 *
 * This is the position that makes the pool tradable — a tiny (1 whole
 * launched token + a few raw units of quote) two-sided position straddling
 * currentTick. Without it, a freshly-launched pool with only single-sided
 * main positions would be untradable until somebody added in-range liquidity.
 *
 * Run sequentially across all pools at the END of a launch, after every
 * main position is in its final, locked range. See createSinglePool for
 * why this is deferred.
 */
async function openBootstrapPosition({
  raydium,
  ctx,
  lockPositions,
  onProgress,
}) {
  const progress = (event) => onProgress && onProgress(event);
  const {
    poolId,
    poolInfo,
    poolKeys,
    currentTickAtCreation,
    tickSpacing,
    launchedIsMintA,
    bootstrapBaseRaw,
    initialPrice,
    quoteToken,
  } = ctx;

  // Re-fetch the *current* on-chain tick rather than reusing the value
  // captured during phase 1. Phase 2 typically runs tens of seconds after
  // phase 1, and a SOL pool's tick in particular drifts on its own clock
  // since it reflects external SOL/USD reality. Computing the bootstrap
  // range against a stale tick was the proximate cause of bootstrap
  // failures observed in earlier multi-pool launches: the deposit math
  // ended up assuming current was inside the range when it was actually
  // a few ticks outside, and the SDK's amount calculation produced a
  // request the wallet couldn't fund.
  const fresh = await raydium.clmm.getRpcClmmPoolInfo({ poolId });
  const currentTick = fresh.tickCurrent;
  if (currentTick !== currentTickAtCreation) {
    console.log(
      `  bootstrap: tick drifted ${currentTickAtCreation} → ${currentTick} ` +
        `between phases; using fresh value`,
    );
  }

  const bsTicks = computeBootstrapTicks({ currentTick, tickSpacing });
  console.log(`  bootstrap range: [${bsTicks.tickLower}, ${bsTicks.tickUpper}]`);
  progress({ stage: 'bootstrap_open_start' });

  // Compute otherAmountMax for the bootstrap.
  //
  // Background on what otherAmountMax does inside the SDK:
  //
  //   - For SOL quote with useSOLBalance:true: the SDK pre-funds the
  //     wSOL ATA with `otherAmountMax` lamports BEFORE opening the
  //     position (refunding the unused remainder at the end). The
  //     wallet must hold this many lamports during the tx. Setting too
  //     high causes the SystemProgram::Transfer to the wSOL ATA to fail
  //     with InsufficientFunds.
  //
  //   - For non-SOL quote: the SDK does NOT pre-fund the quote ATA. It
  //     just transfers from the existing ATA up to the actual amount
  //     required by the position math. otherAmountMax is purely a
  //     slippage limit — the on-chain CLMM program checks
  //     `actual_required <= otherAmountMax` and fails with
  //     PriceSlippageCheck (custom error 6021) if it isn't. Setting
  //     too LOW causes that failure; setting too HIGH costs nothing
  //     because the actual transfer is bounded by the math, not by
  //     this number.
  //
  // The actual amount needed on the other side is approximately the
  // launched-token deposit's USD value converted to quote tokens, since
  // the bootstrap straddles the current tick. We compute that from
  // initialPrice (= quote per launched) and apply a 200x safety
  // multiplier to absorb edge-of-range scenarios after tick drift.
  //
  // The previous formula also capped at 0.01 of one whole quote token
  // (raw = 10^(decimals-2)) as an absolute safety brake. That made
  // sense as a SOL guardrail — 0.01 SOL ≈ $2, comfortably under any
  // reasonably-funded wallet — but it was WRONG for cheap quote tokens.
  // For a quote token where 1 launched ≈ 0.1 quote (memecoin quote at
  // similar USD scale to the launched token), the 200x multiplier wants
  // 20 quote whole, but the cap allowed only 0.01 quote whole. The
  // bootstrap deposit math then exceeds otherAmountMax and the
  // transaction reverts with PriceSlippageCheck. Several users hit
  // this on memecoin-quote launches.
  //
  // Fix: only apply the absolute cap when the quote is SOL (where the
  // wSOL pre-fund concern is real). For all other quotes, trust the
  // 200x multiplier — the SDK won't actually take more than necessary.
  const equivOtherRaw = initialPrice.mul(new Decimal(10).pow(quoteToken.decimals));
  const isQuoteSol = quoteToken.address === WSOL_MINT;
  let bsOtherMaxDecimal;
  if (isQuoteSol) {
    // SOL: keep the 0.01-SOL absolute cap to prevent wSOL pre-fund
    // exceeding wallet balance. The funding estimator budgets enough
    // SOL for this; the cap just prevents the otherAmountMax from
    // ballooning if initialPrice math somehow produces a huge value.
    bsOtherMaxDecimal = Decimal.min(
      equivOtherRaw.mul(200),
      new Decimal(10).pow(quoteToken.decimals - 2),
    );
  } else {
    // Non-SOL: no absolute cap. The SDK doesn't pre-fund the quote ATA,
    // so the wallet's actual balance is the only physical limit on
    // spend. A generous otherAmountMax protects against PriceSlippageCheck
    // failures during pool-price drift without changing the on-chain
    // outcome (actual spend = math result, not this number).
    bsOtherMaxDecimal = equivOtherRaw.mul(200);
  }
  // Floor at 1000 raw — handles extreme micro-price launches where the
  // computed value rounds to 0.
  const bsOtherMax = BN.max(new BN(bsOtherMaxDecimal.toFixed(0)), new BN(1000));
  console.log(
    `  bootstrap otherAmountMax: ${bsOtherMax.toString()} raw quote ` +
      `(actual need ~${equivOtherRaw.toFixed(0)} raw, isQuoteSol=${isQuoteSol})`,
  );

  const bsRes = await raydium.clmm.openPositionFromBase({
    poolInfo,
    poolKeys,
    ownerInfo: { useSOLBalance: true },
    tickLower: bsTicks.tickLower,
    tickUpper: bsTicks.tickUpper,
    base: launchedIsMintA ? 'MintA' : 'MintB',
    baseAmount: bootstrapBaseRaw,
    otherAmountMax: bsOtherMax,
    txVersion: TxVersion.V0,
    computeBudgetConfig: { units: 600_000, microLamports: 50_000 },
  });
  const bsTx = await bsRes.execute({ sendAndConfirm: true });
  const bsNftMint = bsRes.extInfo?.nftMint?.toBase58();
  console.log(`  bootstrap opened: nft=${bsNftMint}, tx=${bsTx.txId}`);
  progress({ stage: 'bootstrap_open_done', nftMint: bsNftMint, txId: bsTx.txId });

  // Lock the bootstrap. Bootstrap is never split or transferred to recipients
  // — the Fee Key just stays with the ephemeral wallet for the final sweep.
  // Same lockPosition shape as the main positions — no poolInfo/poolKeys/programId.
  let bsLockTxId = null;
  if (lockPositions) {
    const lockRes = await raydium.clmm.lockPosition({
      ownerPosition: { nftMint: new PublicKey(bsNftMint) },
      txVersion: TxVersion.V0,
    });
    const lockTx = await lockRes.execute({ sendAndConfirm: true });
    bsLockTxId = lockTx.txId;
    console.log(`  bootstrap locked: tx=${bsLockTxId}`);
    progress({ stage: 'bootstrap_lock_done', txId: bsLockTxId });
  }

  return {
    nftMint: bsNftMint,
    locked: lockPositions,
    txIds: { open: bsTx.txId, lock: bsLockTxId },
  };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Top-level orchestrator. Creates one pool + all main positions (one per
 * distribution slice) + bootstrap, with locking, per allocation. Sequential
 * execution for clean failure recovery.
 *
 * @param {Object}   params
 * @param {number[]} params.tempWalletSecretKey  ephemeral wallet keypair (array form)
 * @param {string}   params.tokenMint            launched token mint address
 * @param {number}   params.tokenDecimals        launched token decimals (default 9)
 * @param {number}   params.tokenTotalSupply     total supply in WHOLE units
 * @param {number}   params.targetMarketCapUsd   USD market cap target at launch
 * @param {Array}    params.allocations          per-pool config (see below)
 * @param {boolean}  params.lockPositions        lock all positions? (default true)
 * @param {Function} [params.onProgress]         optional progress callback
 *
 * Each allocation: {
 *   quoteToken:    'SOL' | 'USDC' | 'USDT' | <mint address>,
 *   supplyPercent: number (0-100),
 *   ammConfigIndex?:        number (default DEFAULT_AMM_CONFIG_INDEX),
 *   quoteUsdOverride?:      number (skip GeckoTerminal lookup if set),
 *   quoteDecimalsOverride?: number (skip RPC mint lookup if set),
 *   quoteSymbolOverride?:   string (display only),
 *   distribution?: [
 *     { sharePercent: number, recipient?: string }, ...
 *   ]  // omitted = single 100% slice, NFT goes to dest wallet via sweep
 * }
 */
export async function createPoolsAndPositions({
  tempWalletSecretKey,
  tokenMint,
  tokenDecimals = 9,
  tokenTotalSupply,
  targetMarketCapUsd,
  allocations,
  lockPositions = true,
  onProgress,
  // When resuming a partially-completed launch, pass the partialResults
  // array from the failed attempt. The orchestrator will:
  //   - For each allocation whose index appears in priorResults with a
  //     poolId: skip createSinglePool, rebuild the bootstrap context from
  //     chain state, and use the existing result entry.
  //   - For other allocations: do the full create flow as if fresh.
  //   - In Phase 2: skip allocations whose bootstrap is already populated
  //     in priorResults.
  // This means a single failed launch can be retried any number of times,
  // each retry only attempting the work that didn't complete before.
  priorResults = [],
}) {
  console.log(`\n=== Creating pools and positions for ${tokenMint} ===`);
  console.log(`Total supply: ${tokenTotalSupply}, target MC: $${targetMarketCapUsd}`);
  console.log(`Allocations: ${allocations.length}, lock: ${lockPositions}`);
  if (priorResults.length > 0) {
    console.log(`Resume mode: ${priorResults.length} allocation(s) carried over from prior attempt`);
  }

  // -----------------------------------------------------------------------
  // 1. Initialize SDK with the ephemeral wallet
  // -----------------------------------------------------------------------
  const ownerKeypair = Keypair.fromSecretKey(Uint8Array.from(tempWalletSecretKey));
  const raydium = await initSdk(ownerKeypair);
  const connection = raydium.connection;

  // -----------------------------------------------------------------------
  // 2. Compute launch USD price for the token: target_mc / supply
  // -----------------------------------------------------------------------
  const launchedTokenUsd = new Decimal(targetMarketCapUsd).div(tokenTotalSupply);
  console.log(`Launched-token USD price target: $${launchedTokenUsd.toString()}`);

  // -----------------------------------------------------------------------
  // 3. Validate allocations as a whole
  // -----------------------------------------------------------------------
  const totalPct = allocations.reduce((s, a) => s + Number(a.supplyPercent), 0);
  if (totalPct > 100) {
    // Tagging as pre_flight so the orchestrator's caller (server) and the
    // frontend treat this the same way as the Token-2022 compat check —
    // nothing on-chain has happened yet, so the user can fix the config
    // and retry without sweeping. Without this tag the frontend's
    // failedPhase fallback defaults to 'main_positions' and incorrectly
    // tells the user that pools may have been created.
    const err = new Error(`Allocations sum to ${totalPct}% — must be <= 100%`);
    err.failedPhase = 'pre_flight';
    err.partialResults = priorResults;
    throw err;
  }

  const solPct = allocations
    .filter((a) => (a.quoteToken || '').toUpperCase() === 'SOL')
    .reduce((s, a) => s + Number(a.supplyPercent), 0);

  if (solPct > 0 && solPct < MIN_SOL_ALLOCATION_PCT) {
    const err = new Error(
      `SOL allocation is ${solPct}%, must be >= ${MIN_SOL_ALLOCATION_PCT}% ` +
        `(aggregator/scanner integration depends on a non-trivial SOL pool).`,
    );
    err.failedPhase = 'pre_flight';
    err.partialResults = priorResults;
    throw err;
  }

  // -----------------------------------------------------------------------
  // 4. Fetch CLMM AmmConfigs once (used per-pool)
  // -----------------------------------------------------------------------
  const allConfigs = await raydium.api.getClmmConfigs();
  console.log(`Loaded ${allConfigs.length} AmmConfigs from Raydium API`);

  // -----------------------------------------------------------------------
  // 5. Build the launched-token info object the SDK expects
  // -----------------------------------------------------------------------
  const launchedToken = {
    address: tokenMint,
    programId: TOKEN_PROGRAM_ID.toBase58(),
    decimals: tokenDecimals,
  };

  // -----------------------------------------------------------------------
  // 5.5. PRE-FLIGHT: resolve and validate every quote token BEFORE we
  //      touch the chain for pool creation. This catches:
  //        - typos / non-mint addresses
  //        - Token-2022 mints with Raydium-incompatible extensions
  //          (e.g. PermanentDelegate, NonTransferable, TransferHook,
  //          DefaultAccountState — any of these cause pool creation to
  //          revert with NotSupportMint or an Anchor constraint error
  //          AFTER we've already spent SOL on rent for the pool state)
  //
  //      Doing this upfront means we either commit to the full launch or
  //      reject the whole thing — never the half-broken middle state the
  //      previous Cm6f...pump failure left us in.
  //
  //      We hold onto the resolved tokens so the per-allocation loop
  //      below can use them directly without re-resolving.
  // -----------------------------------------------------------------------
  console.log('Pre-flight: validating quote-token compatibility...');
  const resolvedAllocs = [];
  for (let i = 0; i < allocations.length; i++) {
    const alloc = allocations[i];
    try {
      const quoteToken = await resolveQuoteToken(connection, alloc.quoteToken, {
        decimals: alloc.quoteDecimalsOverride,
        symbol: alloc.quoteSymbolOverride,
      });
      const programLabel = quoteToken.isToken2022 ? 'Token-2022' : 'SPL Token';
      const extLabel = quoteToken.isToken2022
        ? ` (extensions: ${quoteToken.extensions.length === 0 ? 'none' : quoteToken.extensions.join(',')})`
        : '';
      console.log(
        `  [${i}] ${quoteToken.symbol} → ${programLabel}${extLabel} ✓`,
      );
      resolvedAllocs.push({ alloc, quoteToken });
    } catch (err) {
      // Annotate with which allocation failed so the caller can highlight
      // the right row in the UI. partialResults preserves any priorResults
      // we were given (resume case) so the user doesn't lose the
      // already-completed pools' state in their lpResult.
      err.failedAllocationIndex = i;
      err.failedAllocation = alloc;
      err.failedPhase = 'pre_flight';
      err.partialResults = priorResults;
      throw err;
    }
  }
  console.log(`Pre-flight passed for all ${allocations.length} allocation(s).`);

  // -----------------------------------------------------------------------
  // 6. Phase 1: iterate allocations sequentially, creating each pool and its
  //    main positions. Bootstrap is skipped here (queued for phase 2 below)
  //    so no pool becomes tradable until every pool's main positions are in
  //    place. Otherwise a swap on an early-completed pool could move its
  //    price relative to later pools that were configured to launch at the
  //    same USD-equivalent price.
  // -----------------------------------------------------------------------
  const results = [];
  const bootstrapQueue = [];

  for (let allocIdx = 0; allocIdx < allocations.length; allocIdx++) {
    const alloc = allocations[allocIdx];

    // RESUME CHECK: if this allocation completed Phase 1 in a prior attempt,
    // skip the create flow and just rebuild the bootstrap context from
    // on-chain state. The result entry from the prior attempt is reused
    // verbatim (poolId, mainPositions, txIds are all immutable once they
    // hit chain). Bootstrap context fields — poolInfo, poolKeys, current
    // tick, etc. — get re-fetched fresh because they may have drifted
    // between the prior attempt and this resume.
    const prior = priorResults.find(
      (p) => p.allocationIndex === allocIdx && p.poolId,
    );
    if (prior) {
      const quoteToken = resolvedAllocs[allocIdx].quoteToken;
      console.log(`\n[${quoteToken.symbol}] resume: pool ${prior.poolId} already created, rebuilding bootstrap context`);
      try {
        const { poolInfo, poolKeys } = await raydium.clmm.getPoolInfoFromRpc(prior.poolId);
        const rpcData = await raydium.clmm.getRpcClmmPoolInfo({ poolId: prior.poolId });
        const tickSpacing = poolInfo.config.tickSpacing;
        const currentTick = rpcData.tickCurrent;
        const launchedIsMintA = poolInfo.mintA.address === launchedToken.address;
        // initialPrice for the bootstrap math = quote per launched.
        // Recompute from the live on-chain price rather than reusing the
        // value from the prior attempt — pool prices drift, especially
        // SOL/USD-pegged pools.
        const initialPrice = launchedIsMintA
          ? new Decimal(poolInfo.price)
          : new Decimal(1).div(poolInfo.price);

        bootstrapQueue.push({
          allocationIndex: allocIdx,
          quoteSymbol: quoteToken.symbol,
          ctx: {
            poolId: prior.poolId,
            poolInfo,
            poolKeys,
            currentTickAtCreation: currentTick,
            tickSpacing,
            launchedIsMintA,
            bootstrapBaseRaw: new BN(BOOTSTRAP_BASE_TOKENS_WHOLE).mul(
              new BN(10).pow(new BN(launchedToken.decimals)),
            ),
            initialPrice,
            quoteToken,
          },
          // Stash any prior bootstrap result so Phase 2 can skip if done.
          // (Bootstrap-only retries reach here with prior.bootstrap === null;
          // main-positions-only retries that succeeded fully reach here
          // with bootstrap populated.)
          existingBootstrap: prior.bootstrap || null,
        });
        results.push(prior);
        continue;
      } catch (err) {
        // Couldn't rebuild context — surface clearly so the user knows
        // which prior pool is the blocker. Most likely cause: RPC
        // unreachable when we tried to read the pool state.
        const e = new Error(
          `Resume failed: couldn't read prior pool ${prior.poolId} from RPC ` +
            `(${err.message}). Retry once RPC connectivity recovers, or ` +
            `sweep the wallet to start over.`,
        );
        e.partialResults = results;
        e.failedAllocationIndex = allocIdx;
        e.failedPhase = 'main_positions';
        throw e;
      }
    }

    try {
      // 6a. Use the quote token we already resolved + validated in the
      //     pre-flight pass above. (Pre-flight has already verified the
      //     mint exists, lives in a recognized token program, and has
      //     only Raydium-supported Token-2022 extensions if any.)
      const quoteToken = resolvedAllocs[allocIdx].quoteToken;

      // 6b. Determine USD price for the quote
      let quoteUsd;
      if (alloc.quoteUsdOverride !== undefined && alloc.quoteUsdOverride !== null) {
        quoteUsd = new Decimal(alloc.quoteUsdOverride);
      } else {
        quoteUsd = await getUsdPrice(quoteToken.address);
        if (!quoteUsd) {
          throw new Error(
            `Couldn't resolve USD price for ${quoteToken.symbol} (${quoteToken.address}). ` +
              `Set quoteUsdOverride in the allocation to provide it manually.`,
          );
        }
      }

      // 6c. Validate distribution (defaults to single 100% slice)
      const distribution = normalizeDistribution(alloc.distribution);

      console.log(
        `\n[${quoteToken.symbol}] quote USD = $${quoteUsd.toString()}, ` +
          `allocation = ${alloc.supplyPercent}%, slices = ${distribution.length}`,
      );

      // 6d. Compute initial pool price = launched-in-terms-of-quote
      const initialPrice = launchedTokenUsd.div(quoteUsd);
      console.log(
        `  initialPrice (${quoteToken.symbol} per launched) = ${initialPrice.toString()}`,
      );

      // 6e. Compute total raw amount allocated to this pool
      const allocatedSupply = new Decimal(tokenTotalSupply)
        .mul(alloc.supplyPercent)
        .div(100);
      const totalMainBaseRaw = new BN(
        allocatedSupply.mul(new Decimal(10).pow(tokenDecimals)).toFixed(0),
      );
      console.log(
        `  total raw allocated: ${totalMainBaseRaw.toString()} ` +
          `(${allocatedSupply.toString()} tokens whole)`,
      );

      // 6f. Pick the AmmConfig
      const cfgIdx = alloc.ammConfigIndex ?? DEFAULT_AMM_CONFIG_INDEX;
      const baseCfg = allConfigs.find((c) => c.index === cfgIdx);
      if (!baseCfg) {
        throw new Error(`AmmConfig index ${cfgIdx} not found in Raydium configs`);
      }
      const ammConfig = {
        ...baseCfg,
        id: new PublicKey(baseCfg.id),
        fundOwner: '',
        description: '',
      };

      // 6g. Phase 1: create the pool and open + lock all main positions.
      //     Bootstrap is deliberately skipped here — see the long comment in
      //     createSinglePool for why. We gather the per-pool context in
      //     `bootstrapQueue` so phase 2 can open all bootstraps at the end.
      const poolResult = await createSinglePool({
        raydium,
        ownerKeypair,
        ammConfig,
        launchedToken,
        quoteToken,
        initialPrice,
        totalMainBaseRaw,
        distribution,
        lockPositions,
        onProgress: (event) =>
          onProgress && onProgress({ allocationIndex: allocIdx, ...event }),
      });

      // Strip the internal context out before exposing the result, but stash
      // it for phase 2 along with metadata we need for accurate progress events.
      const { _bootstrapContext: bsCtx, ...publicPoolResult } = poolResult;
      bootstrapQueue.push({
        allocationIndex: allocIdx,
        quoteSymbol: quoteToken.symbol,
        ctx: bsCtx,
      });

      results.push({
        allocationIndex: allocIdx,
        quoteSymbol: quoteToken.symbol,
        quoteAddress: quoteToken.address,
        supplyPercent: alloc.supplyPercent,
        ...publicPoolResult,
        // Bootstrap fields populated in phase 2. Predeclared as null so the
        // result shape is consistent if a bootstrap fails partway through.
        bootstrap: null,
      });
    } catch (err) {
      // Attach partial results to the error so the caller knows what
      // got created before the failure
      err.partialResults = results;
      err.failedAllocationIndex = allocIdx;
      err.failedAllocation = alloc;
      err.failedPhase = 'main_positions';
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // 7. Phase 2: bootstrap every pool, in order.
  //
  // At this point every pool's main positions are in place and locked, but
  // none of the pools is tradable yet (no in-range liquidity). Now we open
  // a bootstrap position in each pool. Once a bootstrap lands, that pool
  // becomes tradable — but every other pool's main positions are already
  // in their final ranges, so any subsequent swaps can't disturb them.
  // -------------------------------------------------------------------------
  console.log(`\n=== Phase 2: opening bootstrap positions for ${bootstrapQueue.length} pool(s) ===`);

  // Phase 1 ran many transactions that changed the wallet's token balances
  // and ATA inventory significantly. Refresh the SDK's cached token-account
  // info once before phase 2 so its assumptions match on-chain reality when
  // building the bootstrap-open instructions.
  try {
    await raydium.account.fetchWalletTokenAccounts({ forceUpdate: true });
    console.log('  refreshed SDK token account cache before phase 2');
  } catch (e) {
    console.warn('  cache refresh failed (non-fatal):', e.message);
  }
  // Brief settle so the last lock tx is fully visible to the RPC.
  await new Promise((r) => setTimeout(r, 1500));

  // Phase 2 runs every bootstrap independently — a single failure does
  // not abort the remaining attempts. The premise is that a freshly-locked
  // main position whose pool just couldn't get a bootstrap is still better
  // off than a main position whose pool was never even attempted because
  // an earlier pool's bootstrap had a transient RPC error. The caller
  // reports per-pool success/failure to the user so they can retry the
  // failed ones (or manually open a Raydium position to make them
  // tradable) without losing the successful pools.
  const bootstrapFailures = [];

  for (const item of bootstrapQueue) {
    const { allocationIndex: allocIdx, quoteSymbol, ctx } = item;

    // RESUME CHECK: if this allocation already has a bootstrap from a
    // prior successful attempt (carried in via priorResults), don't redo
    // it — the on-chain bootstrap position is locked and immutable.
    // The result entry already has the bootstrap field populated; the
    // resume-path took care of that when populating `results`.
    if (item.existingBootstrap) {
      console.log(`\n[${quoteSymbol}] resume: bootstrap already done, skipping`);
      continue;
    }

    console.log(`\n[${quoteSymbol}] bootstrap`);
    try {
      const bootstrap = await openBootstrapPosition({
        raydium,
        ctx,
        lockPositions,
        onProgress: (event) =>
          onProgress && onProgress({ allocationIndex: allocIdx, ...event }),
      });
      // Find the corresponding result entry and attach the bootstrap info.
      // (results was built in the same order as bootstrapQueue, so allocIdx
      // matches the entry's allocationIndex field.)
      const resultEntry = results.find((r) => r.allocationIndex === allocIdx);
      if (resultEntry) resultEntry.bootstrap = bootstrap;
    } catch (err) {
      // Record the failure, surface it via the progress callback, but keep
      // going — the next pool's bootstrap is independent.
      //
      // Be defensive about message extraction: the Raydium SDK sometimes
      // throws objects without a useful `.message` (e.g. simulation
      // failures where the error is the parsed sim-logs object, not a
      // standard Error). Fall back to String(err) so we don't end up
      // logging "(undefined)" and leaving the user with no information.
      // Also stringify the full error to the server console so we have
      // it for debugging even when the wire form is trimmed.
      const msg = (err && err.message)
        || (typeof err === 'string' ? err : null)
        || (err && err.toString && err.toString() !== '[object Object]' ? err.toString() : null)
        || 'unknown error (see server logs)';
      console.error(`  bootstrap FAILED for ${quoteSymbol}:`, msg);
      console.error(`  full error object:`, err);
      // If the error carries simulation logs (Raydium SDK convention),
      // dump them too — these are the only useful diagnostic when a tx
      // reverts inside the program.
      if (err && Array.isArray(err.logs)) {
        console.error(`  simulation logs:`, err.logs.join('\n'));
      }
      bootstrapFailures.push({
        allocationIndex: allocIdx,
        quoteSymbol,
        error: msg,
      });
      onProgress && onProgress({
        allocationIndex: allocIdx,
        stage: 'bootstrap_failed',
        error: msg,
      });
    }
  }

  if (bootstrapFailures.length > 0) {
    // Some bootstraps failed; throw a structured error so the caller can
    // present a partial-success result instead of an all-or-nothing.
    // Main positions are intact for every pool; only the bootstrap leg
    // is missing for the listed allocations.
    const summary = bootstrapFailures
      .map((f) => `${f.quoteSymbol} (${f.error})`)
      .join('; ');
    const err = new Error(
      `${bootstrapFailures.length} of ${bootstrapQueue.length} bootstrap(s) ` +
        `failed: ${summary}. Main positions are in place for every pool; ` +
        `only the bootstrap leg is missing for the listed pools.`,
    );
    err.partialResults = results;
    err.bootstrapFailures = bootstrapFailures;
    err.failedPhase = 'bootstrap';
    throw err;
  }

  console.log(`\n=== All ${results.length} pool(s) created and bootstrapped successfully ===`);
  return { results };
}

// ---------------------------------------------------------------------------
// Funding estimator (used by the funding step UI)
// ---------------------------------------------------------------------------

// Per-account rent costs (in SOL). These are reasonably stable on-chain rents
// for the account types involved. They're approximate but in the right
// ballpark — Solana account rent depends on size, which doesn't change often.
const COST_POOL_RENT_SOL    = 0.062;  // pool state account
const COST_TICK_ARRAY_SOL   = 0.072;  // each tick array account; typically 2 minimum
const COST_POSITION_SOL     = 0.022;  // position NFT mint + state per position
const COST_LOCK_SOL         = 0.005;  // Burn & Earn lock call (mints Fee Key NFT)
const COST_TRANSFER_SOL     = 0.005;  // NFT transfer (creates recipient ATA + transfer)
const COST_BS_QUOTE_SOL     = 0.001;  // bootstrap quote-side, when quote is SOL (auto-wrapped, dust)
const COST_TX_BUFFER_SOL    = 0.001;  // priority/network fees per pool
const COST_TOKEN_CREATE_SOL = 0.05;   // SPL mint + Metaplex metadata + Arweave fee
const SAFETY_BUFFER_PCT     = 0.20;   // overall safety margin

// Budget for the bootstrap quote-side when quote is NOT SOL: ~$1 worth
// of the quote token (in USD value). Real on-chain consumption at our
// launch prices is far less, this is just generous slack so the wallet
// definitely has enough to cover it. USD-denominated so the requirement
// stays the same regardless of whether the quote token is worth $0.0001
// or $100 each.
//
// This is the amount the MANUAL PREFUND branch shows — what the user
// has to send themselves if Raydium can't route their quote token.
const BS_BOOTSTRAP_USD = 1;

// Target USD value when ACQUIRING via auto-swap. Larger than the actual
// bootstrap need because swaps are subject to slippage and price drift
// between estimate and acquire time — if we aim for $1 and the swap
// fills at 95%, we end up with $0.95 of tokens and the row never goes
// "met". By aiming for $2 we have a fat buffer: even a 50% partial fill
// still leaves us with the $1 the bootstrap actually needs. The extra
// tokens get swept back to the user's destination wallet at the end of
// the launch by sweepAllTokensToDestination, so nothing is wasted.
const AUTOSWAP_TARGET_USD = 2;

// Fallback whole-unit amount used in the manual-prefund branch when we
// can't determine the quote token's USD price (oracle has no data and
// no Raydium route either). Same value as the old behavior — keeps the
// edge case predictable for tokens we know nothing about.
const BS_FALLBACK_WHOLE = 0.01;

// Multiplier on the SOL spend for an auto-swap. With the $2 acquire
// target, 2x means we spend ~$4 of SOL per swap. That covers pool fees
// + up to ~50% adverse slippage with margin. Leftover dust gets swept
// to the destination wallet at the end of the launch.
const AUTOSWAP_SIZING_MULTIPLIER = 2;

// USD price assumed per SOL when the live price oracle isn't available
// (offline, API down, etc.). Used only as a fallback for sizing the SOL
// equivalent of an auto-swap line; safety buffer absorbs any inaccuracy.
// Slightly conservative on the high side so we don't under-fund.
const FALLBACK_SOL_USD = 200;

/**
 * Estimate funding required for the configured pools, with a per-line
 * breakdown the UI can render so the user can see exactly what each cost
 * covers.
 *
 * NOTE: this is now async. For each non-SOL allocation we look up
 * whether a usable Raydium SOL pool exists for the quote token. If yes,
 * the bootstrap quote-side cost is rolled into the SOL bucket (the user
 * funds extra SOL, and we'll auto-swap on their behalf during the
 * funding step). If no, the existing pre-fund flow stays in place for
 * that allocation — the user sends the quote token themselves.
 *
 * The returned `autoSwapPlan` array tells the funding-step UI and the
 * acquire-quote-tokens endpoint which allocations need a swap, with the
 * per-allocation pool ID already resolved so the swap step doesn't
 * have to repeat the lookup.
 *
 * Returns:
 *   {
 *     solLamports:   <integer total SOL needed in lamports>,
 *     byQuote:       { <mintAddr>: <raw amount> }   // non-SOL pre-fund tokens
 *     totalSol:      <number, total SOL in whole units>,
 *     subtotalSol:   <number, total before safety buffer>,
 *     bufferSol:     <number, the safety buffer line>,
 *     solBreakdown:  [ { label, sol }, ... ]        // line items in SOL
 *     quoteBreakdown:[ { label, symbol, amount, mint }, ... ]  // pre-fund items
 *     autoSwapPlan:  [ {
 *       allocationIndex, quoteMint, quoteSymbol, quoteDecimals,
 *       targetRaw, quoteUsd, solUsd, poolId, poolKind,
 *       estSolSpend,    // approximate SOL we'll spend acquiring it
 *     }, ... ]
 *   }
 */
export async function estimateRequiredFunding({ allocations }) {
  const solBreakdown = [];
  const quoteBreakdown = [];
  const byQuote = {};
  const autoSwapPlan = [];
  let subtotal = 0;

  // Helper to add a SOL line to both the breakdown and running total
  const addSol = (label, sol) => {
    solBreakdown.push({ label, sol });
    subtotal += sol;
  };

  // Look up SOL price once. We use it for sizing the SOL equivalent of
  // every auto-swap line; one lookup per estimate call rather than per
  // allocation. Fallback constant if the price service is unavailable.
  let solUsd;
  try {
    // getUsdPrice returns a Decimal or null
    const p = await getUsdPrice(WSOL_MINT);
    solUsd = p || new Decimal(FALLBACK_SOL_USD);
  } catch (e) {
    console.warn(`estimateRequiredFunding: SOL price fallback (${e.message})`);
    solUsd = new Decimal(FALLBACK_SOL_USD);
  }

  for (const [poolIdx, a] of allocations.entries()) {
    const slices = (a.distribution && a.distribution.length > 0)
      ? a.distribution
      : [{ sharePercent: 100 }];

    // Resolve the quote token's basics (used for the SOL-vs-non-SOL branch)
    const qSym = (a.quoteToken || '').toUpperCase();
    const known = KNOWN_QUOTES[qSym];
    const isSol = (known && known.address === WSOL_MINT) || qSym === 'SOL';
    const quoteSymbol = known
      ? known.symbol
      : (a.quoteSymbolOverride || (a.quoteToken || '').slice(0, 6));
    const quoteAddr = known ? known.address : a.quoteToken;
    const quoteDecimals = known
      ? known.decimals
      : (a.quoteDecimalsOverride !== undefined && a.quoteDecimalsOverride !== null
          ? Number(a.quoteDecimalsOverride)
          : 6);

    const poolLabel = `Pool ${poolIdx + 1} (${quoteSymbol})`;

    // Pool creation: state account + 2 tick arrays (the minimum)
    addSol(`${poolLabel}: pool creation`, COST_POOL_RENT_SOL);
    addSol(`${poolLabel}: tick arrays (×2)`, 2 * COST_TICK_ARRAY_SOL);

    // Per-slice costs
    for (let s = 0; s < slices.length; s++) {
      addSol(
        `${poolLabel}: main slice ${s + 1}/${slices.length} (NFT mint + lock)`,
        COST_POSITION_SOL + COST_LOCK_SOL,
      );
      if (slices[s].recipient) {
        addSol(
          `${poolLabel}: slice ${s + 1} transfer to recipient`,
          COST_TRANSFER_SOL,
        );
      }
    }

    // Bootstrap position (always one per pool)
    addSol(
      `${poolLabel}: bootstrap position (NFT mint + lock)`,
      COST_POSITION_SOL + COST_LOCK_SOL,
    );

    // Bootstrap quote-side requirement: three branches.
    //   (1) SOL pool       → auto-wrapped from SOL balance, dust budget.
    //   (2) Trade API can route SOL→quoteMint (typical case)
    //                      → roll cost into SOL bucket; we'll swap during funding.
    //   (3) No route from Trade API
    //                      → fall back to manual pre-fund.
    if (isSol) {
      addSol(`${poolLabel}: bootstrap quote-side (SOL, dust)`, COST_BS_QUOTE_SOL);
    } else {
      // Try Raydium Trade API for route discovery. The probe quote also
      // gives us the effective price (USD per whole quote token), which
      // matters for low-volume tokens whose USD oracles often have no
      // data. If the Trade API can route the swap at all, the route is
      // viable and we get a usable price in the same call.
      let route = null;
      try {
        route = await discoverRaydiumRoute({
          quoteMint: quoteAddr,
          quoteDecimals,
          solUsd,
        });
      } catch (e) {
        console.warn(
          `estimateRequiredFunding: route discovery failed for ${quoteAddr}: ${e.message}`,
        );
      }

      // Resolve a USD price for the quote token. Priority:
      //   1. Explicit override on the allocation config
      //   2. Effective price from Trade API probe (covers low-volume tokens)
      //   3. Standard USD oracle fallback (Coingecko/Jupiter)
      // Used for sizing both the auto-swap and manual-prefund branches.
      let quoteUsd = null;
      if (a.quoteUsdOverride !== undefined && a.quoteUsdOverride !== null) {
        quoteUsd = new Decimal(a.quoteUsdOverride);
      } else if (route && route.effectiveQuoteUsd && route.effectiveQuoteUsd.gt(0)) {
        quoteUsd = route.effectiveQuoteUsd;
      } else {
        try {
          quoteUsd = await getUsdPrice(quoteAddr);
        } catch (e) {
          quoteUsd = null;
        }
      }

      // Pick a target USD value based on which branch we'll take. Auto-swap
      // gets the larger value ($2) so partial fills still cover the
      // bootstrap need. Manual prefund stays at $1 since the user can
      // send exactly what's needed without slippage concerns.
      const isAutoSwap = !!(route && route.available);
      const targetUsd = isAutoSwap ? AUTOSWAP_TARGET_USD : BS_BOOTSTRAP_USD;

      // Compute the target raw amount: targetUsd worth of quote token if
      // we know the price, else fixed fallback. ceil() ensures we don't
      // round down below the requirement.
      let targetWhole;
      if (quoteUsd && quoteUsd.gt(0)) {
        targetWhole = new Decimal(targetUsd).div(quoteUsd).toNumber();
      } else {
        // Fallback: scale the fixed amount up for auto-swap to keep the
        // same 2x relative buffer. The fallback path is rare (no price
        // data anywhere); this keeps the behaviour proportional.
        targetWhole = isAutoSwap ? BS_FALLBACK_WHOLE * 2 : BS_FALLBACK_WHOLE;
      }
      const rawAmt = Math.ceil(targetWhole * Math.pow(10, quoteDecimals));

      if (isAutoSwap) {
        // (2) Auto-swap branch.
        // SOL spend scales with the target: ~$2 of token × 2x multiplier
        // = ~$4 of SOL per swap. Constant regardless of quote-token price,
        // since both target and spend are USD-denominated.
        const estSolSpend = new Decimal(targetUsd)
          .mul(AUTOSWAP_SIZING_MULTIPLIER)
          .div(solUsd)
          .toNumber();
        addSol(
          `${poolLabel}: bootstrap quote-side (auto-swap → ~$${targetUsd} ${quoteSymbol})`,
          estSolSpend,
        );
        // Compute the actual bootstrap need (vs the ambitious acquire
        // target) so the frontend can mark a row "met" once we have
        // ENOUGH for the bootstrap, even if the swap underperformed
        // (e.g. 50% partial fill of a $2 target still leaves $1 — the
        // actual on-chain need). Without this, partial fills would
        // leave the row blocked even though the launch would succeed.
        let minWhole;
        if (quoteUsd && quoteUsd.gt(0)) {
          minWhole = new Decimal(BS_BOOTSTRAP_USD).div(quoteUsd).toNumber();
        } else {
          minWhole = BS_FALLBACK_WHOLE;
        }
        const minRaw = Math.ceil(minWhole * Math.pow(10, quoteDecimals));
        autoSwapPlan.push({
          allocationIndex: poolIdx,
          quoteMint: quoteAddr,
          quoteSymbol,
          quoteDecimals,
          // targetRaw is what swapSolForQuote tries to acquire
          // (oversize for slippage buffer). minRaw is the actual
          // bootstrap requirement on-chain. Frontend uses minRaw for
          // the "met" check, targetRaw for the display "≈ N" amount.
          targetRaw: String(rawAmt),
          minRaw: String(minRaw),
          // quoteUsd here is what swapSolForQuote uses to size the SOL
          // spend at swap time (re-computes the same formula). Pass the
          // effective price we used for the estimate so the budgets
          // stay consistent between estimate and swap.
          quoteUsd: quoteUsd.toString(),
          solUsd: solUsd.toString(),
          // poolId is informational only; the Trade API picks pools
          // internally (potentially multi-hop). 'trade-api' sentinel
          // makes that explicit in any logs the value flows into.
          poolId: 'trade-api',
          poolKind: 'route',
          estSolSpend,
        });
      } else {
        // (3) Manual pre-fund branch.
        byQuote[quoteAddr] = (byQuote[quoteAddr] || 0) + rawAmt;
        quoteBreakdown.push({
          label: `${poolLabel}: bootstrap quote-side`,
          symbol: quoteSymbol,
          // Display-friendly: trim long decimals while keeping enough
          // precision to be unambiguous (e.g. 33333.3 not 33333.333334).
          // targetWhole is a JS Number; toPrecision returns a string.
          amount: Number(Number(targetWhole).toPrecision(6)),
          mint: quoteAddr,
        });
      }
    }

    // Per-pool transaction buffer (priority fees, retries, etc.)
    addSol(`${poolLabel}: network/priority fees`, COST_TX_BUFFER_SOL);
  }

  // Token creation cost (was previously added by the frontend; now part of
  // the breakdown so the user sees it).
  addSol('Token creation (mint + metadata)', COST_TOKEN_CREATE_SOL);

  // Safety buffer applies to the whole subtotal
  const buffer = subtotal * SAFETY_BUFFER_PCT;
  solBreakdown.push({
    label: `Safety buffer (${(SAFETY_BUFFER_PCT * 100).toFixed(0)}%)`,
    sol: buffer,
  });
  const total = subtotal + buffer;

  return {
    solLamports: Math.ceil(total * LAMPORTS_PER_SOL),
    byQuote,
    totalSol: total,
    subtotalSol: subtotal,
    bufferSol: buffer,
    solBreakdown,
    quoteBreakdown,
    autoSwapPlan,
  };
}
