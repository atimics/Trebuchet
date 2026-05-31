// lpConstants.js
//
// Cost and sizing constants shared between lpService.js (the Raydium CLMM
// orchestrator) and lpEstimate.js (the funding estimator). Extracted from
// lpService.js so each module stays focused and the constants can be tested
// in isolation.

// Per-account rent costs (in SOL). These are reasonably stable on-chain
// rents for the account types involved.
export const COST_POOL_RENT_SOL    = 0.062;
export const COST_TICK_ARRAY_SOL   = 0.072;
export const COST_POSITION_SOL     = 0.022;
export const COST_LOCK_SOL         = 0.005;
export const COST_TRANSFER_SOL     = 0.005;
export const COST_BS_QUOTE_SOL     = 0.001;
export const COST_TX_BUFFER_SOL    = 0.001;
export const COST_TOKEN_CREATE_SOL = 0.05;
export const SAFETY_BUFFER_PCT     = 0.20;

// Bootstrap budget: $1 worth of quote token (USD-denominated).
export const BS_BOOTSTRAP_USD = 1;

// Auto-swap acquire target (USD). Oversized 2x over actual need.
export const AUTOSWAP_TARGET_USD = 2;

// Fallback whole-unit amount when no USD price is available.
export const BS_FALLBACK_WHOLE = 0.01;

// SOL spend multiplier for auto-swap sizing.
export const AUTOSWAP_SIZING_MULTIPLIER = 2;

// Custom-mode multipliers — dialed back from minimal-mode defaults.
export const AUTOSWAP_CUSTOM_TARGET_MULTIPLIER = 1.15;
export const AUTOSWAP_CUSTOM_SIZING_MULTIPLIER = 1.10;

// Fallback SOL-USD price when oracle is unavailable.
export const FALLBACK_SOL_USD = 200;

// Well-known mint addresses.
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
