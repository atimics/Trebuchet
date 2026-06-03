// ===========================================================================
// Defensive listener helper
// ===========================================================================
//
// Wraps document.getElementById + addEventListener so a single missing
// element doesn't crash the entire script and prevent other listeners from
// attaching. Without this, one bad reference can stop the whole page from
// working.
function bind(id, event, handler) {
  const el = document.getElementById(id);
  if (el) {
    el.addEventListener(event, handler);
  } else {
    console.warn(`Element #${id} not found — listener for "${event}" not attached.`);
  }
}

// ===========================================================================
// Global state
// ===========================================================================

let tempWallet = null;
let createdTokenInfo = null;       // { mint, decimals, totalSupply, name, symbol }
let fundingWallet = null;
let balancePollHandle = null;
let lpResult = null;
let pools = [];
let fundingRequirement = { solLamports: 0, byQuote: {}, autoSwapPlan: [] };

// Demo mode flag. Set once on app load from /api/demo/status (see
// startup.js). When true, the demo banner and the "Pretend funding
// arrived" button are shown, and the server simulates all chain calls.
let demoModeActive = false;

// One-shot bypass for the beforeunload "launch in progress" guard. The demo
// toggle reloads the page to reset state, but it has ALREADY warned and
// confirmed with the user via the HTML confirm dialog. Without this flag the
// reload would also trip Electron's native "Launch in progress" dialog (a
// second, non-HTML prompt). setDemoMode sets this true just before reloading;
// the beforeunload handler checks it and lets the reload through silently.
let demoModeReloading = false;

// ---------------------------------------------------------------------------
// Flywheel presets
// ---------------------------------------------------------------------------
//
// The simple-config UI offers a flywheel pool alongside the SOL pool.
// Each entry below is one option in the flywheel dropdown. Edit this
// list to add/rename/disable flywheels — no other code needs to change
// since renderSimpleConfig() and rebuildPoolsFromSimple() drive purely
// off this object.
//
// Fields:
//   key          — internal identifier, used in simpleConfig.flywheelKey
//                  and never shown to the user
//   label        — short text shown in the dropdown
//   mint         — quote-token mint address; passed to addPool() exactly
//                  as the existing dropdown options do
//   description  — optional short tagline shown next to the dropdown
//   available    — when false, the option is shown grayed out as a hint
//                  that this flywheel exists but isn't launched yet
const FLYWHEELS = {
  reserve: {
    key: 'reserve',
    label: 'Reserve',
    mint: 'J1bZFRAFC8ALqAN7ktkcCpobgoeTGfP5Xh1BwCP1oqoj',
    description: 'wBTC + ETH reserve flywheel',
    available: true,
  },
  meme: {
    key: 'meme',
    label: 'Meme',
    mint: 'HipYKXiDh3Kjd1jb7ji6jCEsKQMSGWiFJMdtvH8yb5r',
    description: 'Meme-token flywheel',
    available: true,
  },
};

// Flywheel allocation bounds and default. The slider in the simple-config
// UI lets users dial this between MIN and MAX; default is the value the
// PRESETS_PLAN.md called for (90% SOL is the main trading venue, 10%
// flywheel siphons accumulation into the chosen reserve token). The 30%
// upper bound matches the design-decision guidance "users who want
// heavier flywheel exposure" — beyond that, customize-mode is the right
// place since they're really designing a different launch shape.
const DEFAULT_FLYWHEEL_PERCENT = 10;
const FLYWHEEL_MIN_PERCENT = 10;
const FLYWHEEL_MAX_PERCENT = 30;

// LP-split bounds for the "Split the LP" simple-config toggle. Each
// position in a pool's distribution mints its own Fee Key NFT, so
// splitCount = N means N transferable fee streams per pool. We cap at
// 10 to avoid runaway position counts (a flywheel-on launch already
// has 2 pools, so split=10 means 20 NFTs to track).
const SPLIT_MIN_COUNT = 1;
const SPLIT_MAX_COUNT = 10;

// Ladder bounds for the "Ladder positions" simple-config toggle. Sliders
// control how much supply goes to ladder bands (20-80% default 50%) and
// how many bands the supply is split across (3-10 default 5). The
// ceiling is hardcoded at 1000× launch price — wide enough that the
// last band doesn't act as an artificial cap for any realistic
// price trajectory but small enough to keep bands meaningfully sized.
const LADDER_DEFAULT_PERCENT = 50;
const LADDER_MIN_PERCENT = 20;
const LADDER_MAX_PERCENT = 80;
const LADDER_DEFAULT_BANDS = 5;
const LADDER_MIN_BANDS = 3;
const LADDER_MAX_BANDS = 10;
const LADDER_CEILING_MULTIPLIER = 1000;

// Hard upper bound on the whole-token total supply the user can enter.
//
// The on-chain ceiling at 9 decimals is actually ~18.4 billion — that's
// floor((2^64 - 1) / 10^9), the largest whole-token value whose raw u64
// representation fits in the SPL mint. We cap at 10 billion instead,
// well below that hard limit, for two reasons:
//
//   1. Operator policy. Launches with absurd supplies (1 trillion+) tend
//      to be users who haven't thought about per-token price implications
//      and will end up with a launch that fails downstream regardless —
//      either at the mint (over the u64 ceiling) or at the LP-creation
//      math, where extreme supplies push tick spacing and pool prices
//      into floating-point precision danger zones.
//   2. A round limit that's clearly below the hard ceiling makes the
//      error message actionable. "Max is 10,000,000,000" is something
//      a user can act on; "Max is 18,446,744,073" is a number that begs
//      questions about where it came from.
//
// If the decimals constant in tokenService.js ever changes from 9,
// the on-chain ceiling shifts accordingly but this policy cap stays
// where it is (it's user-experience policy, not a chain limit).
const MAX_TOKEN_SUPPLY = 10_000_000_000;

// Logo upload constraints.
//
// MAX_LOGO_BYTES mirrors the server-side multer cap (server.js: 100KB)
// so the client rejects oversized files immediately rather than the
// user clicking Create Token, waiting through the upload, and getting
// an opaque error. Keeping these two numbers in sync is a manual
// concern — if the server cap ever moves, this one needs to move too.
//
// MAX_LOGO_DIMENSION caps the resolution. The chain doesn't care, but:
//   - Token logo displays in wallets/explorers downsize aggressively;
//     anything over 1024 is wasted bytes that bloat the Arweave upload.
//   - A 4096×4096 PNG that compresses well can sneak under the byte
//     cap and still be a bad upload — pure size isn't sufficient.
//   - 1024 matches what Solscan, Jupiter, and Phantom recommend.
//
// MIN_LOGO_DIMENSION rejects accidentally-tiny pickups (favicons, etc.)
// that would look terrible on the launched token's listings. 64 is
// small enough to allow simple pixel-art logos while catching the
// common "I picked the wrong file" case.
const MAX_LOGO_BYTES = 100 * 1024;
const MAX_LOGO_DIMENSION = 1024;
const MIN_LOGO_DIMENSION = 64;

// State for the simple-config UI. `mode` is the master switch:
//   'default'   — show the simple toggle+dropdown UI; pool list hidden
//                 (rebuilt automatically on every config change)
//   'customize' — show the full pool list editor; simple controls hidden
//                 (user has manual control over pool composition)
//
// Switching from default → customize preserves the currently-rendered
// pools (so the user keeps whatever they were about to launch with).
// Switching back wipes pools and rebuilds defaults — confirmation
// prompt handles the "lose customizations" case.
//
// flywheelPercent is the slider value. Persists across toggle off→on
// cycles so users don't lose their chosen allocation by accidentally
// toggling.
//
// splitEnabled + splitCount control the "Split the LP" feature: when
// enabled with count > 1, each pool's distribution is N equal slices,
// producing N transferable Fee Key NFTs per pool. When disabled or at
// 1, each pool has a single 100% slice (the historical default).
//
// bootstrapMode + bootstrapSolValue control the bootstrap position
// thickness. Default mode 'minimal' preserves the historical 1-whole-
// token-and-narrow-band behavior; 'custom' deposits bootstrapSolValue
// SOL worth of total starting liquidity, split evenly across all pools
// and using full-range positions so the support is visible across every
// price level. The split is computed at submit time from the number of
// pools in the current configuration.
let simpleConfig = {
  mode: 'default',
  flywheelEnabled: true,
  // Default flywheel: meme. The marketing site documents that the meme
  // flywheel's pair set includes the reserve flywheel itself, so picking
  // meme by default gets users into BOTH networks at once — reserve-pair
  // arbitrage cascades reach meme-launched tokens automatically through
  // the meme↔reserve pool, while reserve-launched tokens only see the
  // reserve network. Users launching serious / utility tokens can still
  // pick Reserve manually; the in-app flywheel explainer modal still
  // documents both use cases.
  flywheelKey: 'meme',
  flywheelPercent: DEFAULT_FLYWHEEL_PERCENT,
  splitEnabled: false,
  splitCount: 1,
  bootstrapMode: 'minimal',
  bootstrapSolValue: 1, // total SOL to commit, when bootstrapMode === 'custom'
  // Ladder positions: when enabled, splits each pool's main allocation
  // into a wide remainder plus N single-sided bands at log-spaced price
  // ranges going from launch up to a 1000× ceiling. Distributes supply
  // more evenly across mcap levels and creates natural support/resistance
  // zones. Off by default for backward compatibility.
  ladderEnabled: false,
  ladderPercent: LADDER_DEFAULT_PERCENT,
  ladderBandCount: LADDER_DEFAULT_BANDS,
};

// Build a distribution array of N equal slices that sum to exactly 100%.
// We round each slice to 2 decimal places (10000/N / 100) and assign the
// rounding remainder to the last slice, so:
//   N=3  → 33.33, 33.33, 33.34   (sum 100.00)
//   N=7  → 14.28 × 6, 14.32      (sum 100.00)
//   N=10 → 10.00 × 10            (sum 100.00)
// Build N equal slices that sum to a target total (default 100). Used by:
//   - The simple-UI "Split the LP" toggle which produces N slices that
//     subdivide the wide portion of a pool.
//   - The customize-mode "Add slice" button which expands the slice count.
//
// totalPct is the sum these slices should add to. When the pool has no
// bootstrap or ladder, the wide gets the full 100% of pool and slices
// sum to 100. When bootstrap is custom (say 2% of pool) and ladder
// takes 50% of pool, wide gets 48%, so slices sum to 48 (not 100).
// Each slice gets totalPct / count, with rounding remainder absorbed
// into the last slice so the sum is exact.
//
// Stays within the backend's 0.01 tolerance and keeps every share > 0,
// which normalizeDistribution() requires.
//
// For count <= 1, returns a single slice at the full totalPct — same
// shape as the addPool default, so callers can use this unconditionally
// without special-casing.
function buildEqualSplitDistribution(count, totalPct = 100) {
  if (!Number.isFinite(totalPct) || totalPct < 0) totalPct = 100;
  if (!count || count <= 1) {
    return [{ sharePercent: totalPct, recipient: null, useExternalRecipient: false }];
  }
  const each = Math.floor((totalPct * 10000 / count)) / 10000;
  const slices = [];
  let assigned = 0;
  for (let i = 0; i < count - 1; i++) {
    slices.push({ sharePercent: each, recipient: null, useExternalRecipient: false });
    assigned += each;
  }
  // Last slice picks up any rounding remainder so total is exactly totalPct.
  slices.push({
    sharePercent: Number((totalPct - assigned).toFixed(4)),
    recipient: null,
    useExternalRecipient: false,
  });
  return slices;
}

// CLMM fee tiers populated at startup from /api/clmm-fee-tiers, which in
// turn pulls from Raydium's published config endpoint. The hardcoded list
// here is a fallback used while the fetch is in flight (so adding the
// first pool before the network call returns doesn't blow up) and as a
// last resort if the fetch fails entirely. Each entry is { index,
// tradeFeeRate, tickSpacing }; tradeFeeRate is in 1e-6 units, so 10000
// = 1%.
let feeTiers = [
  { index: 2, tradeFeeRate:   100, tickSpacing:   1 }, // 0.01%
  { index: 1, tradeFeeRate:   500, tickSpacing:  10 }, // 0.05%
  { index: 0, tradeFeeRate:  2500, tickSpacing:  60 }, // 0.25%
  { index: 3, tradeFeeRate: 10000, tickSpacing: 120 }, // 1%
];

// Run state — when an operation is in flight, disable cancel and step toggles
// to avoid sending a cancel sweep mid-transaction
let isRunningOperation = false;

// Current active step (1-6)
let currentStep = 1;

// Step titles for the sticky bar
const STEP_TITLES = {
  1: 'Generate Wallet',
  2: 'Token & Pool Configuration',
  3: 'Fund Wallet',
  4: 'Create Token',
  5: 'Create Pools',
  6: 'Transfer Assets',
};

