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
import {
  computeBootstrapTicks,
  computeLadderTicks,
  computeLadderTicksManual,
  computeMainTicks,
} from './lpMath.js';
import BN from 'bn.js';
import Decimal from 'decimal.js';
import { getRpcUrl } from './rpcConfig.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// RPC URL is sourced from rpcConfig.js (which manages a persistent JSON config
// file plus runtime UI selection). We read it fresh inside initSdk() so that
// changing the active RPC mid-session takes effect on the next launch.

// Default Raydium AmmConfig index. Index 3 = 1% fee, tickSpacing 120 — the
// "exotic" tier. Matches the pattern used in past manual launches. Other
// tiers are available at runtime via raydium.api.getClmmConfigs():
//   index 0 = 0.25% fee, tickSpacing 60   (most volatile pairs)
//   index 1 = 0.05% fee, tickSpacing 10   (major pairs)
//   index 2 = 0.01% fee, tickSpacing 1    (stables)
//   index 3 = 1.00% fee, tickSpacing 120  (exotic / new tokens)  <-- default
const DEFAULT_AMM_CONFIG_INDEX = 3;

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
async function defaultInitSdk(ownerKeypair) {
  const connection = _connectionFactory();
  return Raydium.load({
    owner: ownerKeypair,
    connection,
    cluster: 'mainnet',
    disableFeatureCheck: true,
    disableLoadToken: true, // skip the multi-MB token-list fetch
    blockhashCommitment: 'finalized',
  });
}

function defaultConnectionFactory() {
  return new Connection(getRpcUrl(), {
    commitment: 'confirmed',
    confirmTransactionInitialTimeout: 60_000,
  });
}

// ---------------------------------------------------------------------------
// Dependency-injection seams (TEST-ONLY).
//
// Production default is unchanged: `_sdkFactory` builds a real Raydium SDK
// over a real Connection. Tests may swap `_sdkFactory` for one that returns
// a mock raydium object (see test/helpers/mockRaydium.mjs), and/or
// `_connectionFactory` for a fake connection, to drive createPoolsAndPositions
// and the phase helpers without touching mainnet. These do nothing unless a
// test explicitly calls a setter.
// ---------------------------------------------------------------------------
let _connectionFactory = defaultConnectionFactory;
let _sdkFactory = defaultInitSdk;

// initSdk delegates to the (overridable) factory. Production code paths that
// call initSdk are unchanged when no test factory is set.
async function initSdk(ownerKeypair) {
  return _sdkFactory(ownerKeypair);
}

// TEST-ONLY: override the Raydium SDK builder (returns the mock raydium).
export function setSdkFactoryForTests(fn) {
  _sdkFactory = fn;
}

// TEST-ONLY: override the Connection builder used by the default SDK factory.
export function setConnectionFactoryForTests(fn) {
  _connectionFactory = fn;
}

// TEST-ONLY: restore the real SDK + connection factories.
export function resetTestFactories() {
  _sdkFactory = defaultInitSdk;
  _connectionFactory = defaultConnectionFactory;
}

// TEST-ONLY: expose the private phase helpers so integration tests can drive
// each launch phase through a mock SDK and assert recoverable state. These are
// not used by production code.
export const __testHooks = {
  get createSinglePool() { return createSinglePool; },
  get openBootstrapPosition() { return openBootstrapPosition; },
  get lockAllPositions() { return lockAllPositions; },
  get transferFeeKeys() { return transferFeeKeys; },
};

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
  // mainBaseRaw is the raw token amount available for the main positions
  // ONLY. The caller (orchestrator) has already subtracted out whatever
  // supply is destined for the bootstrap, so this function doesn't need
  // wideBaseRaw is the raw token amount available for the wide main
  // positions (sliced by the distribution array). The caller has
  // already subtracted out the bootstrap AND the ladder allocations,
  // so this function doesn't need to know about either carve-out
  // when computing slice sizes.
  //
  // For a no-ladder launch this equals (allocation.supplyPercent −
  // bootstrap.supplyPercent) × totalSupply. For a launch with the
  // ladder enabled, it equals that minus (ladder.supplyPercent% × main).
  // (Renamed from mainBaseRaw to disambiguate from the broader "main"
  // concept that now includes both wide and ladder positions.)
  wideBaseRaw,
  // bootstrapBaseRaw is the raw token amount the bootstrap will consume.
  // Threaded through to the deferred Phase 2 step via _bootstrapContext.
  bootstrapBaseRaw,
  // bootstrapMode is 'minimal' or 'custom'; controls the tick range in
  // Phase 2 (minimal = narrow band, custom = full range).
  bootstrapMode,
  distribution,
  // Ladder parameters.
  //   ladderMode: 'off' | 'simple' | 'manual'
  //   ladderBands: per-band data. Each entry has baseRaw (the BN raw
  //                token amount for this band). Simple-mode entries
  //                have only baseRaw and the function computes ticks
  //                via log-spacing math from ladderCeiling. Manual-mode
  //                entries also carry lowerMultiplier and upperMultiplier
  //                which the function uses to compute ticks directly.
  //   ladderCeiling: ceiling multiplier (simple mode only; ignored for
  //                  manual since the tick range is per-band).
  ladderMode,
  ladderBands,
  ladderCeiling,
  // NOTE: this function no longer takes lockPositions. Locking and
  // Fee Key transfers are deferred to dedicated phases in the
  // orchestrator (lockAllPositions, transferFeeKeys). The orchestrator
  // makes the lock-or-skip decision after every position is open.
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
  //
  // The bootstrap and any ladder reserves have already been carved out
  // by the caller — wideBaseRaw is what's available for slicing into
  // the WIDE main positions (the existing single big-range positions
  // sized by the distribution array), and bootstrapBaseRaw is reserved
  // separately for Phase 2. Ladder bands are handled in the ladder
  // loop below this one and don't touch wideBaseRaw.
  //
  // We still need a small per-slice slack buffer for SDK rounding. The
  // CLMM contract uses mulDivCeil on the user-pays side, so the actual
  // transferred amount can be 1-2 raw units more than the input baseAmount.
  // With a 100% supply allocation across multiple slices, the wallet would
  // otherwise hold exactly the input amount with zero margin — any slice
  // after the first would fail with InsufficientFunds. Reserving 1 whole
  // token per slice is overkill mathematically (real rounding is sub-
  // microtoken) but costs nothing meaningful (a few tokens out of 1B is
  // dust) and bulletproofs us against future SDK rounding changes. The
  // reserved tokens stay in the wallet and get swept to destination at
  // the end.
  //
  // Edge case: if wideBaseRaw is zero or rounds to less than the slice
  // slack, the user has allocated the entire pool to the bootstrap and
  // (optionally) the ladder — a valid choice. Skip the slice loop;
  // mainPositions stays empty and the pool relies on bootstrap + ladder
  // for liquidity.
  // -----------------------------------------------------------------------
  const mainPositions = [];

  const oneTokenRaw = new BN(10).pow(new BN(launchedToken.decimals));
  const sliceSlackRaw = oneTokenRaw.mul(new BN(distribution.length));
  const slicableRaw = wideBaseRaw.sub(sliceSlackRaw);

  // Use BN's lte(0) check rather than negative-aware math — if the caller
  // sent wideBaseRaw smaller than sliceSlackRaw, the subtraction would
  // produce a negative BN that would mistakenly look like a tiny positive
  // sliceRaw after the per-slice mul/div. Guarding here keeps the loop
  // honest.
  const hasMainSupply = slicableRaw.gt(new BN(0));

  if (!hasMainSupply) {
    console.log(
      `  no wide main positions to open: wideBaseRaw=${wideBaseRaw.toString()} ` +
        `≤ sliceSlackRaw=${sliceSlackRaw.toString()}. ` +
        `Bootstrap + any ladder bands will provide all liquidity for this pool.`,
    );
  } else {
    console.log(
      `  reserved: ${distribution.length} token(s) per-slice slack; ` +
        `slicableRaw=${slicableRaw.toString()}, ` +
        `bootstrapBaseRaw=${bootstrapBaseRaw.toString()} ` +
        `(${bootstrapMode || 'minimal'} mode)` +
        (ladderMode === 'simple'
          ? `, ladder=${ladderBandCount} bands × ${ladderPerBandRaw.toString()} each`
          : ''),
    );
  }

  // Diagnostic: log actual on-chain wallet balances so we can see what the
  // wallet has vs what we're about to deposit
  await logWalletBalances(connection, ownerKeypair.publicKey, launchedToken.address, 'before slicing');

  // Loop body is unchanged; the guard above is what skips it entirely for
  // bootstrap-only pools.
  for (let i = 0; hasMainSupply && i < distribution.length; i++) {
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

    // Locking and Fee Key transfer are deferred to dedicated phases later
    // in the orchestrator. We capture the open result here and move on to
    // the next slice. This is the "open all, lock all at end" reordering:
    // it means a Phase 1 failure leaves positions that the ephemeral
    // wallet can still close (recoverable), rather than scattered
    // permanently-locked positions across pools that succeeded plus
    // pending opens that didn't. See createPoolsAndPositions for the
    // phase orchestration; lockAllPositions and transferFeeKeys are
    // the post-open phases.
    mainPositions.push({
      sliceIndex: i,
      sharePercent: slice.sharePercent,
      nftMint,
      // Phase 3 will flip this to true (or push to lockFailures if it
      // can't). When lockPositions is false (test/manual launches),
      // Phase 3 is skipped and these stay false; downstream consumers
      // already handle the locked: false case.
      locked: false,
      recipient: slice.recipient || null,
      // Phase 4 will populate this when the slice has a recipient AND
      // its lock succeeded in Phase 3.
      transferredTo: null,
      txIds: {
        open: openTx.txId,
        lock: null,
        transfer: null,
      },
    });
  }

  // -----------------------------------------------------------------------
  // Ladder bands.
  //
  // For each band, open a single-sided position at the band's tick range
  // with ladderPerBandRaw launched tokens. Each band is its own NFT and
  // gets locked in Phase 3, just like wide main positions and the
  // bootstrap. Ladder positions never have recipients (Fee Keys stay
  // with the launch wallet and sweep to the user's destination).
  //
  // Ladder bands open INSIDE the createSinglePool function rather than
  // in a separate orchestrator phase because the band tick math is
  // pool-local (depends on the tickSpacing the pool's AmmConfig
  // determined) and the price is fresh (the pool was just created).
  // Splitting would add coordination overhead with no benefit.
  // -----------------------------------------------------------------------
  const ladderPositions = [];
  if (
    (ladderMode === 'simple' || ladderMode === 'manual') &&
    Array.isArray(ladderBands) &&
    ladderBands.length > 0
  ) {
    // Compute tick ranges for each band. For simple mode we use the
    // log-spaced helper (band count = ladderBands.length, all bands
    // equal-supply); for manual mode we use the multipliers carried in
    // each band entry.
    let bandTicks;
    if (ladderMode === 'simple') {
      bandTicks = computeLadderTicks({
        currentTick,
        tickSpacing,
        bandCount: ladderBands.length,
        ceilingMultiplier: ladderCeiling,
        launchedIsMintA,
      });
    } else {
      bandTicks = computeLadderTicksManual({
        currentTick,
        tickSpacing,
        bands: ladderBands.map((b) => ({
          lowerMultiplier: b.lowerMultiplier,
          upperMultiplier: b.upperMultiplier,
        })),
        launchedIsMintA,
      });
    }

    const ceilingLabel = ladderMode === 'simple'
      ? `ceiling ${ladderCeiling}×`
      : 'manual band ranges';
    console.log(`  opening ${ladderBands.length} ladder bands (${ceilingLabel}):`);

    for (let bi = 0; bi < ladderBands.length; bi++) {
      const { tickLower, tickUpper } = bandTicks[bi];
      const bandBaseRaw = ladderBands[bi].baseRaw;
      if (!bandBaseRaw || bandBaseRaw.lte(new BN(0))) {
        // Defensive: a band with 0 supply is pointless; the SDK would
        // also reject it. Pre-flight should catch this for manual mode,
        // and simple mode never produces it (perBandRaw > 0 if
        // ladderTotalBaseRaw > 0). Skip rather than throw, so the rest
        // of the ladder can still open.
        console.log(`    band ${bi + 1}/${ladderBands.length}: skipped (0 supply)`);
        continue;
      }
      console.log(
        `    band ${bi + 1}/${ladderBands.length} ticks=[${tickLower}, ${tickUpper}], ` +
          `base=${bandBaseRaw.toString()}`,
      );
      progress({ stage: 'ladder_open_start', bandIndex: bi });

      const ladderRes = await raydium.clmm.openPositionFromBase({
        poolInfo,
        poolKeys,
        tickLower,
        tickUpper,
        base: launchedIsMintA ? 'MintA' : 'MintB',
        baseAmount: bandBaseRaw,
        // Single-sided in the launched token: the band starts above
        // current tick (or below, for mintB), so the position holds 0
        // of the other side at deposit time. otherAmountMax = 0 is
        // exact and the SDK won't fund a non-existent ATA.
        otherAmountMax: new BN(0),
        ownerInfo: { useSOLBalance: false },
        txVersion: TxVersion.V0,
        computeBudgetConfig: { units: 600_000, microLamports: 50_000 },
      });
      const ladderTx = await ladderRes.execute({ sendAndConfirm: true });
      const ladderNftMint = ladderRes.extInfo?.nftMint?.toBase58();
      console.log(`    opened: nft=${ladderNftMint}, tx=${ladderTx.txId}`);
      progress({
        stage: 'ladder_open_done',
        bandIndex: bi,
        nftMint: ladderNftMint,
        txId: ladderTx.txId,
      });

      ladderPositions.push({
        bandIndex: bi,
        tickLower,
        tickUpper,
        nftMint: ladderNftMint,
        // Phase 3 will flip this to true. Ladder positions never have
        // recipients — Fee Keys always sweep back with the launch
        // wallet. No transferredTo field; nothing in Phase 4 looks at
        // ladder positions.
        locked: false,
        txIds: {
          open: ladderTx.txId,
          lock: null,
        },
      });
    }
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
    ladderPositions,
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
      // Mode determines the tick range Phase 2 uses (narrow vs full-range)
      // and influences the otherAmountMax slippage cap sizing. Threaded
      // through unchanged from the orchestrator.
      bootstrapMode: bootstrapMode || 'minimal',
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
  // NOTE: lockPositions no longer accepted; locking happens in the
  // dedicated Phase 3 (lockAllPositions). See createSinglePool's note.
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
    bootstrapMode,
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

  // Tick range depends on mode. Minimal keeps the historical narrow band
  // around currentTick; custom uses the full MIN_TICK..MAX_TICK range so
  // the user-funded support liquidity backs the pool at every price level.
  const bsTicks = computeBootstrapTicks({
    currentTick,
    tickSpacing,
    mode: bootstrapMode,
  });
  console.log(
    `  bootstrap range [${bsTicks.tickLower}, ${bsTicks.tickUpper}] ` +
      `(mode=${bootstrapMode})`,
  );
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
  // For a position straddling the current tick (which all bootstraps
  // do, including the full-range custom variant), the quote-side need
  // is approximately equal in USD value to the launched-side. In raw
  // token terms that's `bootstrapBaseTokens × initialPrice` expressed
  // in the quote's decimals — exactly what equivOtherRaw computes.
  //
  // Old formula used a 200x multiplier as a "burst protection against
  // drift," then capped at 0.01 SOL absolute when quote was SOL. Both
  // pieces were defensive against a 1-whole-token bootstrap with a tiny
  // expected need. When the bootstrap is sized by the user in custom
  // mode (potentially many whole tokens), the 0.01 SOL cap clamps too
  // aggressively and a 200x multiplier produces absurd numbers that
  // serve no purpose. Replacing both with a flat 2x of the actual
  // expected need gives reasonable slippage tolerance at every scale
  // without scaling silliness in either direction.
  //
  // Note: for non-SOL quotes, an over-generous otherAmountMax was harmless
  // (SDK doesn't pre-fund; actual transfer bounded by math). For SOL with
  // useSOLBalance:true it could starve the wallet of lamports, so the
  // tightness change actually frees up SOL budget for the bootstrap's
  // own quote-side requirement.
  // Compute the expected quote-side requirement, then size otherAmountMax
  // at 2x of it. equivOtherRaw = (bootstrap whole-token amount) × initialPrice
  // × 10^quoteDecimals, where initialPrice is quote-per-launched-whole. This
  // is approximately what the SDK will actually transfer on the quote side
  // for any range straddling the current tick — narrow OR full.
  //
  // launchedDecimals is recovered from poolInfo since we don't carry it
  // explicitly in the bootstrap context: it's whatever the launched mint's
  // decimals are, which lives on the SDK's pool info.
  const launchedDecimals = launchedIsMintA
    ? poolInfo.mintA.decimals
    : poolInfo.mintB.decimals;
  const bootstrapWhole = new Decimal(bootstrapBaseRaw.toString())
    .div(new Decimal(10).pow(launchedDecimals));
  const equivOtherRaw = bootstrapWhole
    .mul(initialPrice)
    .mul(new Decimal(10).pow(quoteToken.decimals));

  // 2x of the expected need gives roughly 50% slippage tolerance — enough
  // to absorb tick drift between phases and intra-block price movement,
  // without over-sizing.
  const bsOtherMaxDecimal = equivOtherRaw.mul(2);

  // Floor at 1000 raw — handles extreme micro-price launches where the
  // computed value rounds to 0 (e.g. 1 token bootstrap at a $0.00000001
  // launch price against a high-decimal quote).
  const bsOtherMax = BN.max(new BN(bsOtherMaxDecimal.toFixed(0)), new BN(1000));
  const isQuoteSol = quoteToken.address === WSOL_MINT;
  console.log(
    `  bootstrap otherAmountMax: ${bsOtherMax.toString()} raw quote ` +
      `(actual need ~${equivOtherRaw.toFixed(0)} raw, ` +
      `bootstrapWhole=${bootstrapWhole.toFixed(6)}, ` +
      `isQuoteSol=${isQuoteSol})`,
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
  //
  // Bootstrap locking is now deferred to a dedicated phase (lockAllPositions),
  // matching the deferred-lock model for main positions. We return the open
  // result with locked: false; Phase 3 will mutate this entry in place.
  // Until Phase 3 runs, the bootstrap is openable+closable by the ephemeral
  // wallet — the same recoverable state main positions sit in between
  // Phase 1 and Phase 3.
  return {
    nftMint: bsNftMint,
    locked: false,
    txIds: { open: bsTx.txId, lock: null },
  };
}

// ---------------------------------------------------------------------------
// Phase 3: Lock every position across every pool.
//
// Runs after every position (main + bootstrap) is open across every pool.
// This is the irreversibility line: each successful lock burns the position
// NFT and mints a Fee Key NFT, committing the LP'd tokens for life.
//
// Fail-soft: failures collect into a `lockFailures` array and don't stop
// other locks from being attempted. Locks are independent transactions
// against the lock program — one failing doesn't affect another's chances.
//
// Iteration order is per-allocation (all of pool 1 first, then all of
// pool 2, etc.) so a partial-failure leaves whole pools either locked or
// not-locked rather than a scattered pattern across pools. Within a pool,
// main positions lock before the bootstrap; the bootstrap is the smallest
// and most reliable lock target, so locking mains first surfaces the more
// likely failure cases earlier.
//
// Mutates the results in place: each `mainPositions[i].locked` and
// `mainPositions[i].txIds.lock` get set, same for the bootstrap.
// ---------------------------------------------------------------------------
async function lockAllPositions({ raydium, results, onProgress }) {
  const progress = (event) => onProgress && onProgress(event);
  const lockFailures = [];

  console.log('\n=== Phase 3: Locking positions ===');
  progress({ stage: 'phase3_start' });

  for (let allocIdx = 0; allocIdx < results.length; allocIdx++) {
    const r = results[allocIdx];
    const symbol = r.quoteSymbol || '(?)';

    // 3a. Lock each main position in order.
    for (let i = 0; i < (r.mainPositions || []).length; i++) {
      const pos = r.mainPositions[i];
      if (pos.locked) {
        // Resume: already locked in a prior attempt; skip.
        console.log(`[${symbol}] main slice ${i + 1}: already locked (skip)`);
        continue;
      }
      if (!pos.nftMint) {
        // Defensive: should not happen if Phase 1 completed cleanly,
        // but if a result entry somehow lacks an nftMint, skip rather
        // than crash. The fail-soft collector picks this up as a
        // failure with a clear message.
        console.log(`[${symbol}] main slice ${i + 1}: no nftMint — skip`);
        lockFailures.push({
          allocationIndex: allocIdx,
          positionType: 'main',
          sliceIndex: i,
          nftMint: null,
          error: 'no nftMint on result entry',
        });
        continue;
      }
      console.log(`[${symbol}] locking main slice ${i + 1}/${r.mainPositions.length}: nft=${pos.nftMint}`);
      try {
        const lockRes = await raydium.clmm.lockPosition({
          ownerPosition: { nftMint: new PublicKey(pos.nftMint) },
          txVersion: TxVersion.V0,
        });
        const lockTx = await lockRes.execute({ sendAndConfirm: true });
        pos.locked = true;
        pos.txIds.lock = lockTx.txId;
        console.log(`  locked: tx=${lockTx.txId}`);
        progress({
          stage: 'main_lock_done',
          allocationIndex: allocIdx,
          sliceIndex: i,
          txId: lockTx.txId,
        });
      } catch (e) {
        console.error(`  lock FAILED: ${e.message}`);
        lockFailures.push({
          allocationIndex: allocIdx,
          positionType: 'main',
          sliceIndex: i,
          nftMint: pos.nftMint,
          error: e.message,
        });
        progress({
          stage: 'main_lock_failed',
          allocationIndex: allocIdx,
          sliceIndex: i,
          error: e.message,
        });
      }
    }

    // 3b. Lock each ladder band in order. Ladder bands are independent
    //     of main slices and bootstrap; they just need locking.
    for (let bi = 0; bi < (r.ladderPositions || []).length; bi++) {
      const lp = r.ladderPositions[bi];
      if (lp.locked) {
        console.log(`[${symbol}] ladder band ${bi + 1}: already locked (skip)`);
        continue;
      }
      if (!lp.nftMint) {
        console.log(`[${symbol}] ladder band ${bi + 1}: no nftMint — skip`);
        lockFailures.push({
          allocationIndex: allocIdx,
          positionType: 'ladder',
          sliceIndex: bi,
          nftMint: null,
          error: 'no nftMint on ladder result entry',
        });
        continue;
      }
      console.log(`[${symbol}] locking ladder band ${bi + 1}/${r.ladderPositions.length}: nft=${lp.nftMint}`);
      try {
        const lockRes = await raydium.clmm.lockPosition({
          ownerPosition: { nftMint: new PublicKey(lp.nftMint) },
          txVersion: TxVersion.V0,
        });
        const lockTx = await lockRes.execute({ sendAndConfirm: true });
        lp.locked = true;
        lp.txIds.lock = lockTx.txId;
        console.log(`  locked: tx=${lockTx.txId}`);
        progress({
          stage: 'ladder_lock_done',
          allocationIndex: allocIdx,
          bandIndex: bi,
          txId: lockTx.txId,
        });
      } catch (e) {
        console.error(`  lock FAILED: ${e.message}`);
        lockFailures.push({
          allocationIndex: allocIdx,
          positionType: 'ladder',
          sliceIndex: bi,
          nftMint: lp.nftMint,
          error: e.message,
        });
        progress({
          stage: 'ladder_lock_failed',
          allocationIndex: allocIdx,
          bandIndex: bi,
          error: e.message,
        });
      }
    }

    // 3c. Lock the bootstrap for this pool.
    const bs = r.bootstrap;
    if (bs && bs.nftMint && !bs.locked) {
      console.log(`[${symbol}] locking bootstrap: nft=${bs.nftMint}`);
      try {
        const lockRes = await raydium.clmm.lockPosition({
          ownerPosition: { nftMint: new PublicKey(bs.nftMint) },
          txVersion: TxVersion.V0,
        });
        const lockTx = await lockRes.execute({ sendAndConfirm: true });
        bs.locked = true;
        bs.txIds.lock = lockTx.txId;
        console.log(`  bootstrap locked: tx=${lockTx.txId}`);
        progress({
          stage: 'bootstrap_lock_done',
          allocationIndex: allocIdx,
          txId: lockTx.txId,
        });
      } catch (e) {
        console.error(`  bootstrap lock FAILED: ${e.message}`);
        lockFailures.push({
          allocationIndex: allocIdx,
          positionType: 'bootstrap',
          sliceIndex: null,
          nftMint: bs.nftMint,
          error: e.message,
        });
        progress({
          stage: 'bootstrap_lock_failed',
          allocationIndex: allocIdx,
          error: e.message,
        });
      }
    } else if (bs && bs.locked) {
      console.log(`[${symbol}] bootstrap: already locked (skip)`);
    } else if (!bs || !bs.nftMint) {
      // No bootstrap to lock — Phase 2 must have failed for this pool.
      // The bootstrap failure was already reported via bootstrapFailures;
      // nothing to add here.
      console.log(`[${symbol}] bootstrap: no nftMint to lock (Phase 2 failure expected)`);
    }
  }

  console.log(`=== Phase 3 done: ${lockFailures.length} failure(s) ===\n`);
  progress({ stage: 'phase3_done', failureCount: lockFailures.length });
  return { lockFailures };
}

// ---------------------------------------------------------------------------
// Phase 4: Transfer Fee Key NFTs to external recipients.
//
// Runs after Phase 3. Only LOCKED positions have Fee Key NFTs to transfer —
// the Fee Key is what the locker mints when it burns the position NFT, so
// an unlocked position has no Fee Key.
//
// Fail-soft like Phase 3. Failures collect into `transferFailures` and
// don't block other transfers. A transfer failure leaves the Fee Key NFT
// in the ephemeral wallet, where the final sweep step will pick it up
// and deliver it to the user's destination wallet — so a failed transfer
// at this phase isn't catastrophic, the user just ends up with the Fee
// Key in their primary wallet instead of the slice's recipient address.
//
// Mutates results in place: each transferring slice's `transferredTo`
// and `txIds.transfer` get populated.
// ---------------------------------------------------------------------------
async function transferFeeKeys({ raydium, ownerKeypair, results, onProgress }) {
  const progress = (event) => onProgress && onProgress(event);
  const connection = raydium.connection;
  const transferFailures = [];

  // Skip Phase 4 entirely if nothing has a recipient — cheap fast-path.
  const hasAnyRecipient = results.some((r) =>
    (r.mainPositions || []).some((p) => p.recipient && !p.transferredTo),
  );
  if (!hasAnyRecipient) {
    console.log('=== Phase 4: no Fee Key transfers needed (skip) ===\n');
    progress({ stage: 'phase4_skipped' });
    return { transferFailures };
  }

  console.log('\n=== Phase 4: Transferring Fee Key NFTs ===');
  progress({ stage: 'phase4_start' });

  for (let allocIdx = 0; allocIdx < results.length; allocIdx++) {
    const r = results[allocIdx];
    const symbol = r.quoteSymbol || '(?)';

    for (let i = 0; i < (r.mainPositions || []).length; i++) {
      const pos = r.mainPositions[i];
      if (!pos.recipient) continue;
      if (pos.transferredTo === pos.recipient) {
        // Resume: already transferred to this recipient; skip.
        console.log(`[${symbol}] main slice ${i + 1}: already transferred (skip)`);
        continue;
      }
      if (!pos.locked) {
        // No Fee Key to transfer — the position never locked. Push a
        // failure entry so the user knows the recipient didn't get
        // their NFT, and skip.
        console.log(`[${symbol}] main slice ${i + 1}: not locked, no Fee Key to transfer`);
        transferFailures.push({
          allocationIndex: allocIdx,
          sliceIndex: i,
          nftMint: pos.nftMint,
          recipient: pos.recipient,
          error: 'position not locked — no Fee Key NFT exists',
        });
        continue;
      }
      console.log(`[${symbol}] transferring Fee Key (slice ${i + 1}) to ${pos.recipient}...`);
      try {
        const txId = await transferNftToRecipient({
          connection,
          ownerKeypair,
          nftMint: pos.nftMint,
          recipient: pos.recipient,
        });
        pos.transferredTo = pos.recipient;
        pos.txIds.transfer = txId;
        console.log(`  transferred: tx=${txId}`);
        progress({
          stage: 'main_transfer_done',
          allocationIndex: allocIdx,
          sliceIndex: i,
          recipient: pos.recipient,
          txId,
        });
      } catch (e) {
        console.error(`  transfer FAILED: ${e.message}`);
        transferFailures.push({
          allocationIndex: allocIdx,
          sliceIndex: i,
          nftMint: pos.nftMint,
          recipient: pos.recipient,
          error: e.message,
        });
        progress({
          stage: 'main_transfer_failed',
          allocationIndex: allocIdx,
          sliceIndex: i,
          error: e.message,
        });
      }
    }
  }

  console.log(`=== Phase 4 done: ${transferFailures.length} failure(s) ===\n`);
  progress({ stage: 'phase4_done', failureCount: transferFailures.length });
  return { transferFailures };
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
  // 3.5. Validate per-allocation bootstrap configuration.
  //
  // Each allocation may carry an optional `bootstrap` block:
  //   bootstrap: { mode: 'minimal' | 'custom', supplyPercent?: number }
  //
  // When `bootstrap` is absent or `mode === 'minimal'`, the orchestrator
  // uses the historical defaults — a 1-whole-token reserve and the narrow
  // tickSpacing-based range around currentTick. When `mode === 'custom'`,
  // the user has opted into adding meaningful support liquidity: the
  // bootstrap launched-side carves out of the pool's main supplyPercent
  // (so the pool's total commitment doesn't grow), and the bootstrap range
  // becomes full-range so the support is visible across the entire price
  // curve.
  //
  // Constraint: 0 ≤ bootstrap.supplyPercent ≤ allocation.supplyPercent.
  // The lower bound rejects negative or zero custom-mode configs (zero is
  // indistinguishable from minimal — the caller should send mode='minimal'
  // explicitly rather than custom-with-zero). The upper bound prevents an
  // allocation from owing more supply to bootstrap than the pool actually
  // has; equality is allowed and produces a bootstrap-only pool with no
  // main positions (a constant-product-style starting liquidity profile).
  // -----------------------------------------------------------------------
  for (let i = 0; i < allocations.length; i++) {
    const a = allocations[i];
    const bs = a.bootstrap;
    if (!bs) continue; // absent → treated as minimal, no further checks
    if (bs.mode !== 'minimal' && bs.mode !== 'custom') {
      const err = new Error(
        `Allocation ${i + 1}: bootstrap.mode must be 'minimal' or 'custom' ` +
          `(got '${bs.mode}')`,
      );
      err.failedPhase = 'pre_flight';
      err.failedAllocationIndex = i;
      err.failedAllocation = a;
      err.partialResults = priorResults;
      throw err;
    }
    if (bs.mode !== 'custom') continue; // minimal — supplyPercent ignored
    const bsPct = Number(bs.supplyPercent);
    if (!Number.isFinite(bsPct) || bsPct <= 0) {
      const err = new Error(
        `Allocation ${i + 1}: custom-mode bootstrap requires a positive ` +
          `supplyPercent (got ${bs.supplyPercent})`,
      );
      err.failedPhase = 'pre_flight';
      err.failedAllocationIndex = i;
      err.failedAllocation = a;
      err.partialResults = priorResults;
      throw err;
    }
    if (bsPct > Number(a.supplyPercent)) {
      const err = new Error(
        `Allocation ${i + 1}: bootstrap supplyPercent (${bsPct}%) exceeds ` +
          `pool's main supplyPercent (${a.supplyPercent}%). The bootstrap ` +
          `carves out of the pool's allocation — either reduce the bootstrap ` +
          `support or increase this pool's allocation.`,
      );
      err.failedPhase = 'pre_flight';
      err.failedAllocationIndex = i;
      err.failedAllocation = a;
      err.partialResults = priorResults;
      throw err;
    }
  }

  // -----------------------------------------------------------------------
  // 3.6. Validate per-allocation ladder configuration.
  //
  // The ladder block carves the pool's main allocation (everything not
  // reserved by the bootstrap) into a stack of single-sided positions at
  // discrete, log-spaced price bands above launch price, with gaps in
  // between. Each band acts as both resistance going up (limit sells in
  // the launched token) and support coming back down (the band's quote
  // tokens accumulated during the upward move). The remainder of main
  // supply not consumed by the ladder stays in a single wide position
  // covering the full [P_launch, MAX_TICK] range — current behaviour
  // for the entire main allocation, just downsized.
  //
  // Shape:
  //   ladder: {
  //     mode: 'off' | 'simple',
  //     supplyPercent: 50,        // % of pool's MAIN supply that goes
  //                               // to the ladder (i.e., what's left
  //                               // after bootstrap carve-out)
  //     bandCount: 5,             // number of bands
  //     ceilingMultiplier: 1000,  // top of highest band, as multiple
  //                               // of launch price
  //   }
  //
  // When ladder is absent or mode === 'off', current behaviour: all of
  // main goes to the single wide position.
  // -----------------------------------------------------------------------
  for (let i = 0; i < allocations.length; i++) {
    const a = allocations[i];
    const ld = a.ladder;
    if (!ld) continue;
    if (ld.mode !== 'off' && ld.mode !== 'simple' && ld.mode !== 'manual') {
      const err = new Error(
        `Allocation ${i + 1}: ladder.mode must be 'off', 'simple', or 'manual' ` +
          `(got '${ld.mode}')`,
      );
      err.failedPhase = 'pre_flight';
      err.failedAllocationIndex = i;
      err.failedAllocation = a;
      err.partialResults = priorResults;
      throw err;
    }
    if (ld.mode === 'off') continue;

    if (ld.mode === 'simple') {
      const ldPct = Number(ld.supplyPercent);
      if (!Number.isFinite(ldPct) || ldPct <= 0 || ldPct > 100) {
        const err = new Error(
          `Allocation ${i + 1}: ladder.supplyPercent must be in (0, 100] ` +
            `(got ${ld.supplyPercent})`,
        );
        err.failedPhase = 'pre_flight';
        err.failedAllocationIndex = i;
        err.failedAllocation = a;
        err.partialResults = priorResults;
        throw err;
      }
      const bandCount = Number(ld.bandCount);
      if (!Number.isInteger(bandCount) || bandCount < 2 || bandCount > 20) {
        const err = new Error(
          `Allocation ${i + 1}: ladder.bandCount must be an integer in [2, 20] ` +
            `(got ${ld.bandCount})`,
        );
        err.failedPhase = 'pre_flight';
        err.failedAllocationIndex = i;
        err.failedAllocation = a;
        err.partialResults = priorResults;
        throw err;
      }
      const ceiling = Number(ld.ceilingMultiplier);
      if (!Number.isFinite(ceiling) || ceiling <= 1) {
        const err = new Error(
          `Allocation ${i + 1}: ladder.ceilingMultiplier must be > 1 ` +
            `(got ${ld.ceilingMultiplier})`,
        );
        err.failedPhase = 'pre_flight';
        err.failedAllocationIndex = i;
        err.failedAllocation = a;
        err.partialResults = priorResults;
        throw err;
      }
    } else if (ld.mode === 'manual') {
      // Manual mode: explicit list of bands, each with its own
      // supplyPercent and lower/upper multipliers relative to launch.
      // Bands can overlap or have gaps — that's intentional. The only
      // requirement is each band is internally valid and the total
      // supplyPercent across bands doesn't exceed 100%.
      if (!Array.isArray(ld.bands) || ld.bands.length === 0) {
        const err = new Error(
          `Allocation ${i + 1}: ladder.bands must be a non-empty array ` +
            `when ladder.mode is 'manual'`,
        );
        err.failedPhase = 'pre_flight';
        err.failedAllocationIndex = i;
        err.failedAllocation = a;
        err.partialResults = priorResults;
        throw err;
      }
      if (ld.bands.length > 20) {
        const err = new Error(
          `Allocation ${i + 1}: ladder.bands has ${ld.bands.length} entries; ` +
            `maximum is 20`,
        );
        err.failedPhase = 'pre_flight';
        err.failedAllocationIndex = i;
        err.failedAllocation = a;
        err.partialResults = priorResults;
        throw err;
      }
      let total = 0;
      for (let b = 0; b < ld.bands.length; b++) {
        const band = ld.bands[b];
        const sp = Number(band.supplyPercent);
        const lo = Number(band.lowerMultiplier);
        const hi = Number(band.upperMultiplier);
        if (!Number.isFinite(sp) || sp <= 0 || sp > 100) {
          const err = new Error(
            `Allocation ${i + 1}, band ${b + 1}: supplyPercent must be in ` +
              `(0, 100] (got ${band.supplyPercent})`,
          );
          err.failedPhase = 'pre_flight';
          err.failedAllocationIndex = i;
          err.failedAllocation = a;
          err.partialResults = priorResults;
          throw err;
        }
        if (!Number.isFinite(lo) || lo < 1) {
          const err = new Error(
            `Allocation ${i + 1}, band ${b + 1}: lowerMultiplier must be ` +
              `>= 1 (got ${band.lowerMultiplier})`,
          );
          err.failedPhase = 'pre_flight';
          err.failedAllocationIndex = i;
          err.failedAllocation = a;
          err.partialResults = priorResults;
          throw err;
        }
        if (!Number.isFinite(hi) || hi <= lo) {
          const err = new Error(
            `Allocation ${i + 1}, band ${b + 1}: upperMultiplier (${band.upperMultiplier}) ` +
              `must be greater than lowerMultiplier (${band.lowerMultiplier})`,
          );
          err.failedPhase = 'pre_flight';
          err.failedAllocationIndex = i;
          err.failedAllocation = a;
          err.partialResults = priorResults;
          throw err;
        }
        total += sp;
      }
      if (total > 100.001) {
        // tiny FP slack: 100% exactly is allowed; floating-point summing
        // of 5 × 20.0 entries can drift to 100.00000001 or similar.
        const err = new Error(
          `Allocation ${i + 1}: ladder bands sum to ${total.toFixed(2)}% — ` +
            `must be ≤ 100%`,
        );
        err.failedPhase = 'pre_flight';
        err.failedAllocationIndex = i;
        err.failedAllocation = a;
        err.partialResults = priorResults;
        throw err;
      }
    }
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

        // Mirror the bootstrap mode + size from the allocation we're resuming
        // against, not from the prior result. The allocation is what the user
        // is launching with right now; the prior result only carries main-
        // position info, not bootstrap config. If the user changed bootstrap
        // mode between attempts, the active resume uses the new mode.
        const bootstrapCfg = alloc.bootstrap || { mode: 'minimal' };
        const bootstrapMode = bootstrapCfg.mode === 'custom' ? 'custom' : 'minimal';
        const resumeBootstrapBaseRaw = bootstrapMode === 'custom'
          ? new BN(
              new Decimal(tokenTotalSupply)
                .mul(bootstrapCfg.supplyPercent)
                .div(100)
                .mul(new Decimal(10).pow(tokenDecimals))
                .toFixed(0),
            )
          : new BN(BOOTSTRAP_BASE_TOKENS_WHOLE).mul(
              new BN(10).pow(new BN(launchedToken.decimals)),
            );

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
            bootstrapBaseRaw: resumeBootstrapBaseRaw,
            bootstrapMode,
            initialPrice,
            quoteToken,
          },
          // Stash any prior bootstrap result so Phase 2 can skip if done.
          // (Bootstrap-only retries reach here with prior.bootstrap === null;
          // main-positions-only retries that succeeded fully reach here
          // with bootstrap populated.)
          existingBootstrap: prior.bootstrap || null,
        });
        // Pushing the prior result verbatim carries per-position state
        // (locked, transferredTo, txIds) into the current results array.
        // Phase 3 (locks) and Phase 4 (transfers) inspect each position's
        // state and skip those already done — so a resume that picked up
        // after a partial Phase 3 only attempts the still-unlocked
        // positions, and similarly Phase 4 only attempts the un-transferred
        // recipients. No special resume code needed for those phases.
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

      // 6c.5. Resolve bootstrap config. Defaults to minimal when the field
      //       is absent or explicitly set to mode='minimal'. The pre-flight
      //       check above has already validated supplyPercent bounds for
      //       custom-mode entries.
      const bootstrapCfg = alloc.bootstrap || { mode: 'minimal' };
      const bootstrapMode = bootstrapCfg.mode === 'custom' ? 'custom' : 'minimal';

      console.log(
        `\n[${quoteToken.symbol}] quote USD = $${quoteUsd.toString()}, ` +
          `allocation = ${alloc.supplyPercent}%, slices = ${distribution.length}, ` +
          `bootstrap = ${bootstrapMode}` +
          (bootstrapMode === 'custom'
            ? ` (${bootstrapCfg.supplyPercent}% of supply, full-range)`
            : ' (1 token, narrow range)'),
      );

      // 6d. Compute initial pool price = launched-in-terms-of-quote
      const initialPrice = launchedTokenUsd.div(quoteUsd);
      console.log(
        `  initialPrice (${quoteToken.symbol} per launched) = ${initialPrice.toString()}`,
      );

      // 6e. Compute the launched-token raw amounts: one for main positions,
      //     one reserved for the bootstrap. Both come out of the pool's
      //     allocation.supplyPercent (Option B "carve out" semantics):
      //
      //     - minimal mode: bootstrap = 1 whole token (current default);
      //       main gets the rest of the pool's allocation
      //     - custom mode:  bootstrap = bootstrap.supplyPercent of total supply;
      //       main gets (alloc.supplyPercent − bootstrap.supplyPercent)
      //
      //     For minimal mode, the 1-whole-token reserve carves out of the
      //     pool's allocation, same as the current behavior (the slicing
      //     loop in createSinglePool used to do this internally; we just
      //     hoisted it up). For custom mode, the bootstrap can be any
      //     fraction of the pool up to and including the entire pool —
      //     pre-flight already validated bootstrap.supplyPercent ≤
      //     alloc.supplyPercent.
      const oneTokenRaw = new BN(10).pow(new BN(tokenDecimals));
      const allocatedSupplyRaw = new BN(
        new Decimal(tokenTotalSupply)
          .mul(alloc.supplyPercent)
          .div(100)
          .mul(new Decimal(10).pow(tokenDecimals))
          .toFixed(0),
      );

      let bootstrapBaseRaw;
      let mainBaseRaw;
      if (bootstrapMode === 'custom') {
        bootstrapBaseRaw = new BN(
          new Decimal(tokenTotalSupply)
            .mul(bootstrapCfg.supplyPercent)
            .div(100)
            .mul(new Decimal(10).pow(tokenDecimals))
            .toFixed(0),
        );
        mainBaseRaw = allocatedSupplyRaw.sub(bootstrapBaseRaw);
      } else {
        // Minimal mode — match the historical 1-whole-token reserve.
        bootstrapBaseRaw = new BN(BOOTSTRAP_BASE_TOKENS_WHOLE).mul(oneTokenRaw);
        mainBaseRaw = allocatedSupplyRaw.sub(bootstrapBaseRaw);
      }

      // Split main supply between wide (covers full [launch, MAX_TICK])
      // and ladder bands (discrete bands within that range with gaps).
      // The wide always exists with the leftover supply; the ladder
      // exists only when ladder.mode is 'simple' or 'manual'.
      //
      // For 'simple' mode: ladder.supplyPercent is the total ladder share
      // of THIS pool's main allocation; equally split across bandCount
      // bands. Backwards-compatible with the original simple-mode wire
      // shape that ships from older clients.
      //
      // For 'manual' mode: each band carries its own supplyPercent and
      // its own price-multiplier range. This is what the customize-mode
      // UI produces, and is the canonical wire format from the trebuchet
      // frontend now.
      //
      // For 'off' (or no ladder field): wide gets the full mainBaseRaw,
      // no ladder positions opened — current behaviour for launches with
      // ladder disabled.
      const ladderCfg = alloc.ladder || { mode: 'off' };
      const ladderMode = ladderCfg.mode === 'simple' || ladderCfg.mode === 'manual'
        ? ladderCfg.mode
        : 'off';
      let ladderTotalBaseRaw = new BN(0);
      let wideBaseRaw = mainBaseRaw;
      // ladderBands is the per-band data the orchestrator passes to
      // createSinglePool. Each entry has the raw token amount for that
      // band, plus the tick range. For simple mode we compute uniform
      // bands here; for manual mode we use the band config directly
      // and compute per-band raw amounts from per-band supplyPercent.
      // createSinglePool consumes this uniformly regardless of how the
      // band list was constructed.
      let ladderBands = []; // [{ baseRaw, tickLower, tickUpper }] computed in createSinglePool

      if (ladderMode === 'simple') {
        const bandCount = Number(ladderCfg.bandCount);
        // ladderTotalBaseRaw = mainBaseRaw × ladder.supplyPercent / 100
        // Computed with BN arithmetic to avoid Number-precision loss
        // on large supplies.
        ladderTotalBaseRaw = mainBaseRaw
          .mul(new BN(Math.round(Number(ladderCfg.supplyPercent) * 100)))
          .div(new BN(10000));
        // Each band gets an equal slice. Any rounding remainder stays
        // in the wide position — a few tokens out of millions, dust.
        const perBandRaw = ladderTotalBaseRaw.div(new BN(bandCount));
        // Wide gets whatever's left after the ladder takes its share.
        // Using mul/div above rather than just multiplying by perBand
        // means rounding error accumulates in wide (not in any band),
        // keeping the bands exactly equal.
        wideBaseRaw = mainBaseRaw.sub(perBandRaw.mul(new BN(bandCount)));
        ladderBands = [];
        for (let bi = 0; bi < bandCount; bi++) {
          ladderBands.push({ baseRaw: perBandRaw });
        }
      } else if (ladderMode === 'manual') {
        // Each band's raw share = mainBaseRaw × band.supplyPercent / 100.
        // Same BN-arithmetic pattern as simple mode. We accumulate the
        // total separately so we can compute wide as the remainder.
        ladderBands = [];
        let totalLadderRaw = new BN(0);
        for (const b of ladderCfg.bands) {
          const bandRaw = mainBaseRaw
            .mul(new BN(Math.round(Number(b.supplyPercent) * 100)))
            .div(new BN(10000));
          ladderBands.push({
            baseRaw: bandRaw,
            // Pass multipliers through so createSinglePool can compute
            // ticks from them via computeLadderTicksManual.
            lowerMultiplier: Number(b.lowerMultiplier),
            upperMultiplier: Number(b.upperMultiplier),
          });
          totalLadderRaw = totalLadderRaw.add(bandRaw);
        }
        ladderTotalBaseRaw = totalLadderRaw;
        wideBaseRaw = mainBaseRaw.sub(totalLadderRaw);
      }

      console.log(
        `  raw split: total=${allocatedSupplyRaw.toString()}, ` +
          `wide=${wideBaseRaw.toString()}, ` +
          `bootstrap=${bootstrapBaseRaw.toString()}` +
          (ladderMode !== 'off'
            ? `, ladder=${ladderTotalBaseRaw.toString()} (${ladderBands.length} bands, ${ladderMode})`
            : ''),
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

      // 6g. Phase 1: create the pool, open the wide main position(s)
      //     according to distribution, and open the ladder bands if
      //     any. Bootstrap is deliberately skipped here — see the
      //     long comment in createSinglePool for why. We gather the
      //     per-pool context in `bootstrapQueue` so phase 2 can open
      //     all bootstraps at the end.
      const poolResult = await createSinglePool({
        raydium,
        ownerKeypair,
        ammConfig,
        launchedToken,
        quoteToken,
        initialPrice,
        // wideBaseRaw is what the existing distribution-sliced main
        // positions get. It's the original mainBaseRaw minus whatever
        // the ladder took.
        wideBaseRaw,
        bootstrapBaseRaw,
        bootstrapMode,
        distribution,
        // Ladder config:
        //   ladderMode: 'off' | 'simple' | 'manual'
        //   ladderBands: per-band [{baseRaw, lowerMultiplier?, upperMultiplier?}]
        //                — empty when off; simple-mode entries have only
        //                baseRaw, manual-mode entries also carry the
        //                multipliers. createSinglePool decides which
        //                tick-math function to call based on what's present.
        //   ladderCeiling: ceiling multiplier for simple mode (unused
        //                  for manual). Passed for backward-compat.
        ladderMode,
        ladderBands,
        ladderCeiling: ladderMode === 'simple' ? Number(ladderCfg.ceilingMultiplier) : 0,
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

      const resultEntry = {
        allocationIndex: allocIdx,
        quoteSymbol: quoteToken.symbol,
        quoteAddress: quoteToken.address,
        supplyPercent: alloc.supplyPercent,
        ...publicPoolResult,
        // Bootstrap fields populated in phase 2. Predeclared as null so the
        // result shape is consistent if a bootstrap fails partway through.
        bootstrap: null,
      };
      results.push(resultEntry);
      onProgress && onProgress({
        allocationIndex: allocIdx,
        stage: 'phase1_pool_done',
        result: resultEntry,
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
    //
    // We deliberately do NOT proceed to Phase 3 (locks) when bootstrap
    // failures are present. The user needs to resolve the bootstrap
    // failures first (retry or manually open), and only then should we
    // lock everything. Locking the partial state now would leave the
    // user with locked main positions in pools that aren't tradable.
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

  // -------------------------------------------------------------------------
  // 8. Phase 3: Lock every position across every pool.
  //
  // This is the irreversibility line. Every preceding phase produced state
  // that the ephemeral wallet can still walk back from (close positions,
  // sweep tokens). Locking burns the position NFT and mints a Fee Key NFT,
  // committing the LP'd tokens for life.
  //
  // We only reach here if Phase 1 and Phase 2 both succeeded — so every
  // pool has its main positions AND its bootstrap open. Locking everything
  // at once means a partial Phase 3 failure leaves some pools fully locked
  // and others not; the caller can retry locks via the resume flow.
  //
  // When lockPositions is false (test/manual launches), Phase 3 and Phase 4
  // are skipped — results retain locked: false on every position.
  // -------------------------------------------------------------------------
  let lockFailures = [];
  let transferFailures = [];

  if (lockPositions) {
    const lockResult = await lockAllPositions({
      raydium,
      results,
      onProgress,
    });
    lockFailures = lockResult.lockFailures;

    if (lockFailures.length > 0) {
      // Don't proceed to Phase 4. Fee Key transfers depend on locks
      // having succeeded — there's nothing to transfer for an unlocked
      // position. The user needs to resolve the lock failures (retry)
      // before transfers can run.
      const summary = lockFailures
        .map((f) => `${f.positionType}${f.sliceIndex != null ? ` slice ${f.sliceIndex + 1}` : ''} (${f.error})`)
        .join('; ');
      const err = new Error(
        `${lockFailures.length} position(s) failed to lock: ${summary}. ` +
          `Pools are open and tradable; retry to complete the locks.`,
      );
      err.partialResults = results;
      err.lockFailures = lockFailures;
      err.failedPhase = 'locks';
      throw err;
    }

    // -----------------------------------------------------------------------
    // 9. Phase 4: Transfer Fee Key NFTs to external recipients.
    //
    // Fee Key NFTs only exist for locked positions, so this phase strictly
    // follows Phase 3. Each transfer is an independent NFT-move tx; failures
    // are fail-soft. The final wallet sweep at the end of the launch flow
    // will pick up any Fee Keys still in the ephemeral wallet (whether
    // because the slice had no recipient, or because the transfer here
    // failed) and deliver them to the user's destination wallet.
    // -----------------------------------------------------------------------
    const transferResult = await transferFeeKeys({
      raydium,
      ownerKeypair,
      results,
      onProgress,
    });
    transferFailures = transferResult.transferFailures;

    if (transferFailures.length > 0) {
      // Transfer failures are non-blocking conceptually — the Fee Key
      // NFTs end up in the user's destination wallet via sweep instead
      // of in the recipient's wallet. But we still surface this clearly
      // so the user knows which recipients didn't get their NFTs and
      // can manually re-send them if they want.
      const summary = transferFailures
        .map((f) => `slice ${(f.sliceIndex ?? 0) + 1} → ${f.recipient} (${f.error})`)
        .join('; ');
      const err = new Error(
        `${transferFailures.length} Fee Key transfer(s) failed: ${summary}. ` +
          `Pools are fully created and locked; un-transferred Fee Keys remain ` +
          `in the launch wallet and will be swept to your destination wallet.`,
      );
      err.partialResults = results;
      err.transferFailures = transferFailures;
      err.failedPhase = 'transfers';
      throw err;
    }
  } else {
    console.log('\n=== Phase 3 + 4 skipped (lockPositions = false) ===');
  }

  console.log(`\n=== All ${results.length} pool(s) created, bootstrapped, locked, and transferred successfully ===`);
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

// For CUSTOM-MODE bootstraps, the acquire target and SOL-spend
// multipliers are dialed way back from the minimal-mode constants
// above. Why: the minimal-mode 2× target × 2× spend = 4× of actual
// need was sensible when "actual need" was $1 (a 50% slippage event
// on a $1 swap is realistic on thin pools, and over-budgeting by $3
// of SOL is trivial). For user-funded bootstraps measured in the
// hundreds or thousands of dollars, that same compound 4× becomes
// hundreds or thousands of dollars of over-budget — which the user
// has to hold in the launch wallet for the duration of the launch
// even though the bulk sweeps back at the end. That's a poor UX
// (asks the user to fund 4× what they're committing to LP).
//
// At larger swap sizes, real Raydium slippage on a healthy pair is
// fractions of a percent, not double-digit percents. 15% acquire
// oversize + 10% SOL spend overhead = ~27% combined buffer, which
// is generous for any swap in the $100+ range. For pathological
// thin-liquidity pairs the swap would fail anyway and fall through
// to the manual-prefund branch.
const AUTOSWAP_CUSTOM_TARGET_MULTIPLIER = 1.15;  // 15% oversize on acquire
const AUTOSWAP_CUSTOM_SIZING_MULTIPLIER = 1.10;  // 10% extra SOL on top

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
export async function estimateRequiredFunding({
  allocations,
  // Required when any allocation has bootstrap.mode === 'custom'. The
  // estimator uses it to compute that allocation's bootstrap quote-side
  // USD value (= bootstrap.supplyPercent × targetMarketCapUsd / 100).
  // When omitted, custom-mode allocations fall back to the minimal-mode
  // budget — which is wrong if the user actually opted in to custom, but
  // safe (under-budgets so the launch flow surfaces an error rather than
  // proceeding with a half-funded bootstrap).
  targetMarketCapUsd,
}) {
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

    // Bootstrap position (always one per pool — NFT mint + lock)
    addSol(
      `${poolLabel}: bootstrap position (NFT mint + lock)`,
      COST_POSITION_SOL + COST_LOCK_SOL,
    );

    // Ladder bands. Each band is its own position (NFT mint + lock,
    // no Fee Key transfer since ladder positions don't take recipients).
    // The launched-side supply for ladder bands comes out of the same
    // pool allocation as the wide main; it doesn't need any additional
    // funding from the user. Just the per-position SOL rent and lock fees.
    //
    // Both simple and manual modes contribute the same per-band cost.
    // Simple-mode count comes from ladderCfg.bandCount; manual-mode
    // count comes from the bands array length. Off contributes zero.
    const ladderCfg = a.ladder || { mode: 'off' };
    let ladderBandCount = 0;
    if (ladderCfg.mode === 'simple') {
      ladderBandCount = Number(ladderCfg.bandCount) || 0;
    } else if (ladderCfg.mode === 'manual') {
      ladderBandCount = Array.isArray(ladderCfg.bands) ? ladderCfg.bands.length : 0;
    }
    for (let b = 0; b < ladderBandCount; b++) {
      addSol(
        `${poolLabel}: ladder band ${b + 1}/${ladderBandCount} (NFT mint + lock)`,
        COST_POSITION_SOL + COST_LOCK_SOL,
      );
    }

    // Determine the bootstrap mode and USD budget for the quote-side.
    //
    // Minimal mode: budget is the historical $1 (manual prefund) / $2
    //   (auto-swap acquire target). These are constants; the per-allocation
    //   need is dust regardless of pool size.
    //
    // Custom mode: budget is bootstrap.supplyPercent × targetMarketCapUsd / 100,
    //   the launched-side USD value the user is committing as starting
    //   liquidity. The quote-side need is ≈ equal in USD (1:1 ratio at
    //   current tick), so this same USD value gets converted to SOL,
    //   quote tokens, or auto-swap target depending on the pool.
    //
    // targetMarketCapUsd may be missing if the caller forgot to supply it
    // when a custom-mode allocation exists. We fall back to the minimal
    // budget so the user sees an undersized estimate rather than a server
    // error — but the launch itself will fail at deposit time with a
    // clearer SDK error, which is the better surface for "you didn't
    // fund enough".
    const bsCfg = a.bootstrap || { mode: 'minimal' };
    const bsIsCustom = bsCfg.mode === 'custom';
    let bsActualUsd; // the actual USD value the bootstrap quote-side needs
    if (bsIsCustom && Number(targetMarketCapUsd) > 0 && Number(bsCfg.supplyPercent) > 0) {
      bsActualUsd = (Number(bsCfg.supplyPercent) * Number(targetMarketCapUsd)) / 100;
    } else {
      // Minimal mode (or custom mode with missing inputs — defensive fallback)
      bsActualUsd = BS_BOOTSTRAP_USD; // $1
    }

    // Bootstrap quote-side requirement: three branches.
    //   (1) SOL pool       → SOL deposited directly (auto-wrapped at deposit).
    //   (2) Trade API can route SOL→quoteMint (typical case)
    //                      → roll cost into SOL bucket; we'll swap during funding.
    //   (3) No route from Trade API
    //                      → fall back to manual pre-fund.
    //
    // In minimal mode the USD value is dust ($1); in custom mode it's the
    // user's chosen support amount. The branch logic is identical otherwise.
    if (isSol) {
      // (1) SOL pool — quote-side is just SOL.
      // For minimal mode we keep the historical dust constant (0.001 SOL,
      // which comfortably covers the 1-whole-token bootstrap's actual need).
      // For custom mode, we deposit the actual USD value worth of SOL.
      let solCost;
      let label;
      if (bsIsCustom) {
        solCost = bsActualUsd / Number(solUsd.toString());
        label = `${poolLabel}: bootstrap support (~$${bsActualUsd.toFixed(2)} as SOL)`;
      } else {
        solCost = COST_BS_QUOTE_SOL;
        label = `${poolLabel}: bootstrap quote-side (SOL, dust)`;
      }
      addSol(label, solCost);
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

      // Pick the acquire/prefund target USD. For minimal mode:
      //   auto-swap target = $2 (oversize the $1 actual need by 2x so a
      //                          partial fill still meets the need)
      //   manual prefund   = $1 (user can send the exact amount; no slippage)
      // For custom mode:
      //   auto-swap target = bsActualUsd × 1.15 (15% partial-fill buffer)
      //   manual prefund   = bsActualUsd × 1.0  (user can send exact)
      //
      // Custom-mode multipliers are dialed back from the minimal-mode
      // constants because the compound minimal-mode buffer (2× target ×
      // 2× SOL spend = 4× over need) was sized for $1 dust where $3
      // over-budget is irrelevant. For a user-funded $2000 bootstrap,
      // the same compound 4× becomes $8000 of SOL spend budgeted for
      // a swap that should land within a few percent of $2000 — that
      // asks the user to fund 4× what they're committing to LP, with
      // the bulk sweeping back at the end. See the multiplier-constant
      // comments above for the reasoning behind the chosen values.
      const isAutoSwap = !!(route && route.available);
      let targetUsd;
      if (bsIsCustom) {
        targetUsd = isAutoSwap
          ? bsActualUsd * AUTOSWAP_CUSTOM_TARGET_MULTIPLIER
          : bsActualUsd;
      } else {
        targetUsd = isAutoSwap ? AUTOSWAP_TARGET_USD : BS_BOOTSTRAP_USD;
      }

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
        // SOL spend scales with the acquire target × the sizing multiplier.
        // Minimal mode: $2 target × 2 = $4 spent for $2 acquired.
        // Custom mode: bsActualUsd × 1.15 target × 1.10 = ~27% over actual
        // need (compound 1.265× of bsActualUsd) spent for ~15% over need
        // acquired. Most of the buffer absorbs swap slippage; the small
        // acquire-side buffer absorbs partial fills.
        const spendMultiplier = bsIsCustom
          ? AUTOSWAP_CUSTOM_SIZING_MULTIPLIER
          : AUTOSWAP_SIZING_MULTIPLIER;
        const estSolSpend = new Decimal(targetUsd)
          .mul(spendMultiplier)
          .div(solUsd)
          .toNumber();
        const label = bsIsCustom
          ? `${poolLabel}: bootstrap support (auto-swap → ~$${bsActualUsd.toFixed(2)} ${quoteSymbol})`
          : `${poolLabel}: bootstrap quote-side (auto-swap → ~$${targetUsd} ${quoteSymbol})`;
        addSol(label, estSolSpend);
        // Compute the actual bootstrap need (vs the ambitious acquire
        // target) so the frontend can mark a row "met" once we have
        // ENOUGH for the bootstrap, even if the swap underperformed
        // (e.g. 50% partial fill of a $2 target still leaves $1 — the
        // actual on-chain need). Without this, partial fills would
        // leave the row blocked even though the launch would succeed.
        let minWhole;
        if (quoteUsd && quoteUsd.gt(0)) {
          minWhole = new Decimal(bsActualUsd).div(quoteUsd).toNumber();
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
          // sizingMultiplier and bootstrapMode propagate the estimator's
          // mode-aware budget choices down to the actual swap execution.
          // The swap function (swapService.js) has its own slippage
          // oversize math and a hard MAX_SPEND cap that was sized for
          // dust targets. Without these fields, a custom-mode bootstrap
          // would get budgeted correctly by the estimator but then have
          // its actual swap silently floored to ~0.05 SOL by the cap,
          // delivering almost no quote tokens and failing the bootstrap.
          // server.js threads these through to swapSolForQuote.
          sizingMultiplier: bsIsCustom
            ? AUTOSWAP_CUSTOM_SIZING_MULTIPLIER
            : AUTOSWAP_SIZING_MULTIPLIER,
          bootstrapMode: bsIsCustom ? 'custom' : 'minimal',
        });
      } else {
        // (3) Manual pre-fund branch.
        byQuote[quoteAddr] = (byQuote[quoteAddr] || 0) + rawAmt;
        const label = bsIsCustom
          ? `${poolLabel}: bootstrap support (~$${bsActualUsd.toFixed(2)})`
          : `${poolLabel}: bootstrap quote-side`;
        quoteBreakdown.push({
          label,
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
