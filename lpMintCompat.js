// lpMintCompat.js
//
// Pure Token-2022 mint compatibility logic. Extracted from lpService.js so
// the extension allowlist, whitelist, and classification logic can be tested
// without RPC or @solana/spl-token imports.
//
// The RPC-dependent parts (getAccountInfo, unpackMint, getExtensionTypes)
// remain in lpService.js's getMintCompatibilityWithRaydiumClmm, which now
// delegates the pure classification step to classifyToken2022Extensions().

// Extensions that Raydium CLMM explicitly supports for Token-2022 mints.
// Must stay in sync with the on-chain is_supported_mint check.
export const RAYDIUM_CLMM_ALLOWED_TOKEN2022_EXTENSIONS = new Set([
  'TransferFeeConfig',
  'MetadataPointer',
  'TokenMetadata',
  'InterestBearingConfig',
  'ScaledUiAmountConfig',
  'ScaledUiAmount',
]);

// Raydium's hardcoded MINT_WHITELIST. These 6 specific mints are accepted
// even when they carry extensions that would otherwise fail the generic
// check — the protocol team specifically vetted them.
//
// Source-of-truth: raydium-clmm/programs/amm/src/util/token.rs
export const RAYDIUM_CLMM_MINT_WHITELIST = new Set([
  'HVbpJAQGNpkgBaYBZQBR1t7yFdvaYVp2vCQQfKKEN4tM',
  'Crn4x1Y2HUKko7ox2EZMT6N2t2ZyH7eKtwkBGVnhEq1g',
  'FrBfWJ4qE5sCzKm3k3JaAtqZcXUh4LvJygDeketsrsH4',
  '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo', // PYUSD
  'DAUcJBg4jSpVoEzASxYzdqHMUN8vuTpQyG2TvDcCHfZg',
  'AUSD1jCcCyPLybk1YnvPWsHQSrZ46dxwoMniN4N2UEB9', // AUSD
]);

// Friendly names for extension types. Keyed by string extension name
// (the human-readable form). Used to build disallowedNames in error surfaces.
export const EXTENSION_DISPLAY_NAMES = {
  TransferFeeAmount:        'TransferFeeAmount (account-side)',
  MintCloseAuthority:       'MintCloseAuthority',
  ConfidentialTransferMint: 'ConfidentialTransferMint',
  DefaultAccountState:      'DefaultAccountState (e.g. frozen-by-default)',
  ImmutableOwner:           'ImmutableOwner',
  MemoTransfer:             'MemoTransfer (memo required on transfer)',
  NonTransferable:          'NonTransferable (soulbound)',
  CpiGuard:                 'CpiGuard',
  PermanentDelegate:        'PermanentDelegate',
  TransferHook:             'TransferHook',
  ConfidentialTransferFeeConfig: 'ConfidentialTransferFeeConfig',
  ConfidentialTransferFeeAmount: 'ConfidentialTransferFeeAmount',
  GroupPointer:             'GroupPointer',
  TokenGroup:               'TokenGroup',
  GroupMemberPointer:       'GroupMemberPointer',
  TokenGroupMember:         'TokenGroupMember',
  PausableConfig:           'PausableConfig',
  PausableAccount:          'PausableAccount',
};

/**
 * Classify a Token-2022 mint's extension list and determine Raydium CLMM
 * compatibility — entirely pure, no RPC.
 *
 * @param {string[]} extensions - Array of string extension type names
 * @param {string} mintAddress - Base58 mint address (for whitelist check)
 * @returns {{
 *   compatible: boolean,
 *   whitelisted: boolean,
 *   whitelistedDespite: string[],
 *   disallowed: string[],
 *   disallowedNames: string[],
 * }}
 */
export function classifyToken2022Extensions(extensions, mintAddress) {
  const disallowed = extensions.filter(
    (e) => !RAYDIUM_CLMM_ALLOWED_TOKEN2022_EXTENSIONS.has(e),
  );
  const disallowedNames = disallowed.map(
    (e) => EXTENSION_DISPLAY_NAMES[e] || `extension:${e}`,
  );

  const isWhitelisted = RAYDIUM_CLMM_MINT_WHITELIST.has(mintAddress);
  if (isWhitelisted && disallowed.length > 0) {
    return {
      compatible: true,
      whitelisted: true,
      whitelistedDespite: disallowedNames,
      disallowed: [],
      disallowedNames: [],
    };
  }

  return {
    compatible: disallowed.length === 0,
    whitelisted: false,
    whitelistedDespite: [],
    disallowed,
    disallowedNames,
  };
}
