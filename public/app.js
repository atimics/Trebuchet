// app.js — frontend logic for Trebuchet
//
// Six-step launcher with collapsible step cards. Each step is in one of
// three states:
//
//   pending   — collapsed, dimmed, header non-clickable. Default for
//               all steps after the active one.
//   active    — expanded, full opacity. Exactly one step at a time.
//   completed — collapsed, full opacity, header clickable to re-expand
//               for review. Body is hidden but accessible.
//
// The sticky bar at the top of the page shows the current step number/
// title and a Cancel & Refund button. Cancel is available at any time
// after the wallet is generated, but is disabled while an in-flight
// operation (token creation, pool creation, etc.) is running. Cancel
// uses the same /api/transfer-assets endpoint as the normal final
// transfer — the difference is just the destination defaults to the
// detected funding wallet.

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
// Local API session header
// ===========================================================================
//
// The backend requires an x-trebuchet-session header on every /api request
// except /api/session. Same-origin code can read that token; cross-origin
// pages cannot read it because the server does not opt into CORS.
const originalFetch = window.fetch.bind(window);
let apiSessionTokenPromise = null;

function isLocalApiRequest(input) {
  const raw = typeof input === 'string' ? input : input?.url;
  if (!raw) return false;
  const url = new URL(raw, window.location.href);
  return (
    url.origin === window.location.origin &&
    url.pathname.startsWith('/api/') &&
    url.pathname !== '/api/session'
  );
}

async function getApiSessionToken() {
  if (!apiSessionTokenPromise) {
    apiSessionTokenPromise = originalFetch('/api/session', {
      credentials: 'same-origin',
    })
      .then((r) => {
        if (!r.ok) throw new Error(`API session failed: HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => {
        if (!data?.token) throw new Error('API session response missing token');
        return data.token;
      });
  }
  return apiSessionTokenPromise;
}

window.fetch = async (input, init = {}) => {
  if (!isLocalApiRequest(input)) return originalFetch(input, init);

  const headers = new Headers(
    init.headers || (input instanceof Request ? input.headers : undefined),
  );
  headers.set('x-trebuchet-session', await getApiSessionToken());
  return originalFetch(input, { ...init, headers });
};

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

// ===========================================================================
// Logging
// ===========================================================================
const activityLog = document.getElementById('activityLog');

// Maximum number of entries to keep in the activity log. The server-log
// streamer polls every 2s and appends any new server-side entries — over
// a long-running session (hours, especially with active RPC chatter
// during pool creation or auto-swap retries), the log can accumulate
// thousands of <div> nodes. Each entry stays in the DOM, participates in
// layout, and slows down scrolling, append, and the rest of the page as
// it grows. Symptoms include progressively laggy UI that "feels like a
// freeze" but is really just death-by-DOM-size.
//
// 1500 chosen as a balance: a typical clean launch generates 30-80
// entries, a launch with retries 100-200, and a long session with lots
// of server chatter might approach 1000 — so 1500 gives comfortable
// headroom while still capping the absolute worst case.
//
// trimActivityLog() drops oldest entries when over cap, called from
// both log() and appendServerLogEntry() after each append. Trim cost is
// O(1) per call in steady state (one removal at most once cap is hit).
const MAX_LOG_ENTRIES = 1500;
function trimActivityLog() {
  // Use childElementCount rather than .length on a stale childNodes
  // collection — children can include text nodes from whitespace and
  // we only want to count actual entry divs.
  while (activityLog.childElementCount > MAX_LOG_ENTRIES) {
    activityLog.removeChild(activityLog.firstElementChild);
  }
}

function log(message, type = 'info') {
  // Accept 'error' as a backwards-compatible alias for 'danger' — the CSS
  // class is .danger (Bulma convention), but a lot of older / muscle-
  // memory code calls log(msg, 'danger'). Without this normalization the
  // 'error'-labeled entries would render as default (green) text, hiding
  // real errors from the user.
  if (type === 'error') type = 'danger';

  // Escape HTML in the message — `message` is rendered via innerHTML
  // so that we can include the timestamp span, and callers do frequently
  // pass error messages that come from third-party indexers or RPC
  // responses (potentially attacker-controlled). Without escaping, a
  // crafted error string could inject script or break the layout.
  // Doing it here means every log site is safe by construction; we
  // don't have to audit every caller.
  const safe = String(message)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
  const entry = document.createElement('div');
  entry.className = `log-entry ${type}`;
  entry.innerHTML = `<span class="timestamp">[${ts}]</span><span>${safe}</span>`;
  activityLog.appendChild(entry);
  trimActivityLog();
  activityLog.scrollTop = activityLog.scrollHeight;
}

// ===========================================================================
// Server log streaming
// ===========================================================================
//
// The packaged Electron app hides server.js's console output — only the
// browser DevTools console and this activity log are visible to the user.
// To make backend activity visible (especially during the auto-swap flow),
// we continuously poll /api/server-logs and dump new entries here with a
// [server] prefix.
//
// State:
//   _lastSeenServerLogSeq — highest server log sequence number we've
//     already shown. Sent as `since` on each poll so the server only
//     returns new entries.
//   _serverLogStreamStarted — guard so the streamer is only started once.
//
// The streamer runs forever (no abort path) — it just keeps polling until
// the page is closed. Each poll is one cheap HTTP round-trip every 2s,
// and returns nothing when the server is idle, so it's not chatty.

let _lastSeenServerLogSeq = 0;
let _serverLogStreamStarted = false;

/**
 * Append a single server log entry to the activity log. Uses a [server]
 * prefix and dimmer styling (info -> grey color, warn -> warning, error
 * -> danger) so server logs are visually distinguishable from frontend
 * action logs.
 */
function appendServerLogEntry(entry) {
  // Map server log levels to the activity log's CSS types.
  let type;
  if (entry.level === 'error') type = 'danger';
  else if (entry.level === 'warn') type = 'warning';
  else type = 'info';
  // Use the entry's original server-side timestamp (not new Date()) so
  // entries that arrive in a single poll preserve their actual ordering
  // relative to one another, and the user can tell when a server event
  // really happened. Format as HH:MM:SS to match the rest of the log.
  const ts = new Date(entry.ts).toLocaleTimeString('en-US', { hour12: false });
  const el = document.createElement('div');
  el.className = `log-entry ${type} server-log`;
  // escapeHtml is defined later in this file; use a small inline escape
  // just in case the function isn't hoisted in some weird load order.
  const safe = String(entry.msg)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  el.innerHTML =
    `<span class="timestamp">[${ts}]</span>` +
    `<span><span class="has-text-grey">[server]</span> ${safe}</span>`;
  activityLog.appendChild(el);
  trimActivityLog();
  activityLog.scrollTop = activityLog.scrollHeight;
}

/**
 * Start a continuous polling loop that fetches new server logs every 2s
 * and appends them to the activity log. Idempotent — calling more than
 * once is a no-op.
 */
async function startServerLogStream() {
  if (_serverLogStreamStarted) return;
  _serverLogStreamStarted = true;

  // Initial seed: fetch the last 30 entries so the user sees recent
  // backend history immediately (boot logs, any prior activity). Capped
  // at 30 so we don't drown the activity log on first load if the
  // server has been running a while.
  try {
    const resp = await fetch('/api/server-logs?limit=30');
    if (resp.ok) {
      const data = await resp.json();
      for (const entry of data.entries || []) {
        appendServerLogEntry(entry);
        if (entry.seq > _lastSeenServerLogSeq) _lastSeenServerLogSeq = entry.seq;
      }
    }
  } catch (_) {
    // Network error on initial seed — just continue to the polling loop,
    // it'll catch up on next poll.
  }

  // Continuous poll. Every 2s, fetch entries with seq > our last seen.
  // No error escalation: a single failed poll is silent, and we just
  // try again on the next interval. The page-unload kills this loop.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const resp = await fetch(`/api/server-logs?since=${_lastSeenServerLogSeq}`);
      if (resp.ok) {
        const data = await resp.json();
        for (const entry of data.entries || []) {
          appendServerLogEntry(entry);
          if (entry.seq > _lastSeenServerLogSeq) _lastSeenServerLogSeq = entry.seq;
        }
      }
    } catch (_) {
      // Ignore — try again on next poll.
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

// Kick off the streamer at module load. It runs for the lifetime of
// the page, polling every 2s. No-op when the server has nothing new
// to report.
startServerLogStream();

function setLoading(btn, loading) {
  if (!btn) return;
  if (loading) {
    btn.classList.add('is-loading');
    btn.disabled = true;
  } else {
    btn.classList.remove('is-loading');
    btn.disabled = false;
  }
}

// Wrap an async operation in run-state handling. While `isRunningOperation`
// is true, the cancel button is disabled — don't sweep mid-transaction.
async function withRunState(fn) {
  isRunningOperation = true;
  updateCancelButtonState();
  try {
    return await fn();
  } finally {
    isRunningOperation = false;
    updateCancelButtonState();
  }
}

// ===========================================================================
// HTML confirm dialog
// ===========================================================================
//
// Drop-in replacement for window.confirm(). Returns a Promise<boolean>:
// resolves to true on OK, false on Cancel or Esc or background click.
//
// Why we have this: window.confirm() on Windows triggers a Chromium
// compositor hit-testing bug — after the dialog dismisses, text inputs
// in the app become un-clickable (single-clicks don't focus, double-
// clicks can still select) until the user switches windows away and
// back. HTML modals don't trigger the bug because they never leave
// Chromium's compositor — they're just DOM elements styled as a modal.
//
// The dialog uses Bulma's .modal classes the same way the existing
// cancelConfirmModal does. opts:
//   title         — header text (default: "Confirm")
//   body          — body content; can include <strong>, <p>, etc.
//   confirmLabel  — text on the OK button (default: "OK")
//   danger        — if true, OK button is styled red as is-danger
//                   instead of is-primary blue
async function confirmDialog(opts = {}) {
  const {
    title = 'Confirm',
    body = '',
    confirmLabel = 'OK',
    danger = false,
  } = opts;

  const modal     = document.getElementById('genericConfirmModal');
  const titleEl   = document.getElementById('genericConfirmTitle');
  const bodyEl    = document.getElementById('genericConfirmBody');
  const okBtn     = document.getElementById('genericConfirmOk');
  const cancelBtn = document.getElementById('genericConfirmCancel');
  const bgEl      = modal.querySelector('.modal-background');

  titleEl.textContent = title;
  // Use innerHTML so callers can pass <p>, <strong>, etc. Callers
  // are responsible for escaping any user-supplied data they
  // include — same trust model as the rest of the codebase.
  bodyEl.innerHTML = body;
  okBtn.textContent = confirmLabel;
  okBtn.classList.remove('is-primary', 'is-danger');
  okBtn.classList.add(danger ? 'is-danger' : 'is-primary');

  modal.classList.add('is-active');
  okBtn.focus();

  return new Promise((resolve) => {
    const cleanup = (result) => {
      modal.classList.remove('is-active');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      bgEl.removeEventListener('click', onCancel);
      document.removeEventListener('keydown', onKey);
      resolve(result);
    };
    const onOk     = () => cleanup(true);
    const onCancel = () => cleanup(false);
    const onKey    = (e) => {
      if (e.key === 'Escape') onCancel();
      else if (e.key === 'Enter') onOk();
    };

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    bgEl.addEventListener('click', onCancel);
    document.addEventListener('keydown', onKey);
  });
}

// ===========================================================================
// Step state machine
// ===========================================================================
//
// A step's state is reflected by a CSS class on its card (.is-pending,
// .is-active, .is-completed). The is-active card has its body visible;
// the others have it hidden via CSS. setStepState() handles all the
// class manipulation plus the sticky-bar update.

function setStepState(num, state, summaryText) {
  const card = document.getElementById(`step${num}-card`);
  if (!card) return;
  card.classList.remove('is-pending', 'is-active', 'is-completed');
  card.classList.add(`is-${state}`);
  // is-peeking is a sub-state of is-active managed only by the peek-mode
  // logic in bindStepHeaders. Any other caller of setStepState is making
  // a workflow-level state change (activateStep moving the user forward,
  // a cancel flow finalising on step 6, resetForNewLaunch handing control
  // back to step 2, etc.) and those callers should not inherit a stale
  // peek class from whatever the previous interaction left behind.
  //
  // Without this clear, the class survives every code path except the
  // bindStepHeaders collapse logic — so e.g. peek step 2 from step 3,
  // hit Cancel & Refund, then Start Over: activateStep(2) makes step 2
  // the active step but is-peeking is still set, and the CSS
  // pointer-events:none rule on .step-card.is-peeking input/button/etc.
  // locks every field. The user can't edit pool config, can't click
  // Continue to Funding, and the step header click bails out early
  // because step 2 is also the current step. No way out except a full
  // reload.
  //
  // The peek-open branch in bindStepHeaders adds is-peeking AFTER calling
  // setStepState, so it still ends up with the right combination
  // (is-active + is-peeking). The two explicit remove calls in the
  // collapse branches become redundant but are kept for clarity.
  card.classList.remove('is-peeking');
  // Also tear down the peek banner DOM element if one was injected.
  // Same rationale as the class clear above — any state change means
  // the banner doesn't belong to this card anymore. injectPeekBanner
  // adds it back when peek starts again.
  card.querySelectorAll('.peek-banner').forEach((el) => el.remove());

  const summaryEl = document.getElementById(`step${num}-summary`);
  if (summaryEl && summaryText !== undefined) {
    summaryEl.textContent = summaryText ? `  —  ${summaryText}` : '';
  }
}

// Build and insert the peek banner at the top of a step body. Called
// when entering peek mode. The banner explains the read-only state
// and — more importantly — contains an explicit "Done reviewing" button
// so the user has a discoverable way back out. Without it, the only
// way to exit peek was to click the same step header again, which is
// not obviously interactive once the body is already expanded.
//
// The banner element is plain DOM (not a CSS ::before pseudo) so it
// can contain a real clickable button. setStepState removes the banner
// alongside clearing the is-peeking class, so any state transition
// cleans it up automatically — no separate teardown required from the
// callers in bindStepHeaders.
function injectPeekBanner(card, stepNum) {
  const body = card.querySelector('.step-body');
  if (!body) return;
  // Defensive: drop any existing banner before adding a new one so we
  // can't accidentally end up with duplicates if this is somehow
  // called twice without an intervening teardown.
  body.querySelectorAll('.peek-banner').forEach((el) => el.remove());

  const banner = document.createElement('div');
  banner.className = 'peek-banner';

  const text = document.createElement('span');
  text.className = 'peek-banner-text';
  text.textContent = 'Reviewing completed step — fields are read-only.';
  banner.appendChild(text);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'peek-banner-close';
  closeBtn.textContent = 'Done reviewing';
  // Collapse the peek. setStepState handles all the cleanup —
  // removes is-peeking, removes this banner element, sets the
  // is-completed class — so we don't need to do anything else here.
  closeBtn.addEventListener('click', () => {
    setStepState(stepNum, 'completed');
  });
  banner.appendChild(closeBtn);

  // Insert at the very top of the body so it's the first thing the
  // user sees inside the expanded step.
  body.insertBefore(banner, body.firstChild);
}

// Activate a specific step. Marks all earlier steps as completed (preserving
// any summary set on them), the target step as active, and any later steps
// as pending. Scrolls the active step into view.
function activateStep(num) {
  currentStep = num;
  for (let i = 1; i <= 6; i++) {
    const card = document.getElementById(`step${i}-card`);
    if (!card) continue;
    if (i < num) {
      // Only set to completed if not already (preserves the summary)
      if (!card.classList.contains('is-completed')) {
        setStepState(i, 'completed');
      }
    } else if (i === num) {
      setStepState(i, 'active');
    } else {
      setStepState(i, 'pending');
    }
  }

  // Update sticky bar
  document.getElementById('stickyStepNum').textContent = String(num);
  document.getElementById('stickyStepTitle').textContent = STEP_TITLES[num];
  document.getElementById('stickyBar').classList.add('is-visible');

  // Scroll the active card into view (with a small delay to let CSS settle)
  setTimeout(() => {
    document.getElementById(`step${num}-card`)?.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
    });
  }, 50);

  // Sync the cost preview with the new step. Transitioning INTO step 2
  // schedules a fresh preview compute (after the 500ms debounce);
  // transitioning OUT of it hides the preview since the user is past
  // the config stage. requestCostPreviewUpdate handles both directions
  // based on the now-updated currentStep value, so a single call here
  // covers transitions in either direction.
  if (typeof requestCostPreviewUpdate === 'function') {
    requestCostPreviewUpdate();
  }
}

// Set a step's completion summary (one-line text shown next to the title
// when collapsed). Optional; helps the user see at a glance what was done.
function setStepSummary(num, text) {
  const summaryEl = document.getElementById(`step${num}-summary`);
  if (summaryEl) summaryEl.textContent = text ? `  —  ${text}` : '';
}

// Click on a completed step's header — re-expand it for review, or
// collapse if currently peeked. Pending and active-current steps are
// non-interactive via this handler (the early return below handles them).
function bindStepHeaders() {
  for (let i = 1; i <= 6; i++) {
    const header = document.querySelector(`#step${i}-card .step-header`);
    if (!header) continue;
    header.addEventListener('click', () => {
      const card = document.getElementById(`step${i}-card`);
      const isCurrentStep = i === currentStep;
      const isCompleted = card.classList.contains('is-completed');
      // A peeked step is one that has been temporarily expanded for
      // review via this handler. We detect this as "is-active but not
      // the actual current step" — setStepState() removes is-completed
      // when applying is-active, so we can't rely on is-completed alone
      // to identify peekable steps once they've been peeked once.
      const isPeeking = card.classList.contains('is-active') && !isCurrentStep;

      // Pending or active-current steps don't respond to header clicks —
      // they're navigated via the action buttons inside their body.
      if (!isCompleted && !isPeeking) return;

      if (isPeeking) {
        // Currently peeked → collapse back to completed.
        setStepState(i, 'completed');
        card.classList.remove('is-peeking');
        return;
      }

      // is-completed and not currently peeked → open for peek. First
      // collapse any OTHER peeked step so only one peek is visible at
      // a time (avoids visual confusion with multiple expanded cards).
      for (let j = 1; j <= 6; j++) {
        if (j === i) continue;
        if (j === currentStep) continue; // never collapse the active step
        const otherCard = document.getElementById(`step${j}-card`);
        if (otherCard && otherCard.classList.contains('is-active')) {
          setStepState(j, 'completed');
          otherCard.classList.remove('is-peeking');
        }
      }
      // Open this completed step for peek. Marker class `is-peeking`
      // additionally lets CSS disable form fields inside (see
      // peek-readonly fix below) so the user doesn't silently
      // invalidate downstream state by editing a completed step.
      setStepState(i, 'active');
      card.classList.add('is-peeking');
      // Inject the read-only banner with the Done button. Has to run
      // after setStepState because setStepState tears down any prior
      // banner as part of its general state-change cleanup.
      injectPeekBanner(card, i);
    });
  }
}

// ===========================================================================
// Cancel & refund
// ===========================================================================

function updateCancelButtonState() {
  const btn = document.getElementById('cancelBtn');
  if (!btn) return;
  // Disabled while an operation is in flight, or before wallet is generated,
  // or after the user is on step 6 (use the regular transfer button there)
  const shouldDisable = isRunningOperation || !tempWallet || currentStep === 6;
  btn.disabled = shouldDisable;
  btn.title = isRunningOperation
    ? 'Wait for the current operation to finish before cancelling'
    : (currentStep === 6 ? 'Use the Transfer Assets button at this stage' : 'Cancel and refund leftover funds');
}

// Tracks which mode the cancel modal is currently in. Set by
// openCancelConfirm() based on the on-chain wallet balance; consumed
// by the proceed-button handler so it knows whether to do a sweep or
// just close the launch UI.
//   'end_launch' — wallet is empty (no SOL, nothing to sweep). The
//                  proceed action just locks the UI and logs, no
//                  /api/transfer-assets call. The pending-wallets
//                  recovery cache entry stays alive in case a delayed
//                  deposit arrives later (user can claim via the
//                  recovery panel).
//   'refund'     — wallet has funds. Existing refund flow: require
//                  destination address, call transfer-assets, sweep.
let cancelMode = 'refund';

async function openCancelConfirm() {
  if (isRunningOperation) {
    log('Wait for the current operation to finish before cancelling', 'warning');
    return;
  }

  const titleEl = document.getElementById('cancelConfirmTitle');
  const intro = document.getElementById('cancelConfirmIntro');
  const destSection = document.getElementById('cancelDestSection');
  const destInput = document.getElementById('cancelDestInput');
  const destHelp = document.getElementById('cancelDestHelp');
  const finePrint = document.getElementById('cancelConfirmFinePrint');
  const proceedBtn = document.getElementById('cancelConfirmProceedBtn');
  const proceedLabel = document.getElementById('cancelConfirmProceedLabel');

  // Fetch the wallet's current SOL balance so we can decide whether
  // there's anything to refund. If the wallet has nothing, the whole
  // refund-destination flow is unnecessary and the user just wants to
  // end the launch and clean up the UI.
  //
  // Use the cached value from pollBalances if we have one; otherwise
  // hit the balance endpoint directly. Falls back to assuming "funded"
  // on RPC error — safer to show the refund flow than to silently let
  // the user end-launch a wallet that might actually have funds.
  let solBalance = 0;
  let balanceCheckFailed = false;
  if (tempWallet) {
    try {
      const resp = await fetch('/api/check-balance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ publicKey: tempWallet.publicKey }),
      });
      const data = await resp.json();
      if (data.success) {
        solBalance = Number(data.balance) || 0;
      } else {
        balanceCheckFailed = true;
      }
    } catch (e) {
      balanceCheckFailed = true;
    }
  }

  // Dust threshold: 0.0001 SOL. Below this is too little to cover even
  // a single transfer's fee (~5000 lamports), so there's effectively
  // nothing to sweep anyway. Treat as empty.
  const DUST_SOL = 0.0001;
  const isEmpty = !balanceCheckFailed && solBalance < DUST_SOL;

  if (isEmpty) {
    // ---------- End-launch mode ----------
    cancelMode = 'end_launch';
    titleEl.textContent = 'End launch?';
    let stepMsg;
    if (currentStep <= 3) {
      stepMsg =
        'The ephemeral wallet hasn\'t been funded yet. Nothing has been ' +
        'spent and there\'s nothing to refund — cancelling just ends the ' +
        'launch flow and resets the UI.';
    } else {
      stepMsg =
        'The ephemeral wallet is empty. Nothing to sweep. Anything created ' +
        'on-chain so far (token, pools) stays on-chain. Cancelling just ends ' +
        'the launch flow.';
    }
    intro.textContent = stepMsg;
    destSection.classList.add('hidden');
    finePrint.innerHTML =
      '<p>The wallet\'s secret key stays in the recovery panel above so you ' +
      'can claim any delayed deposits that may arrive later. To remove it ' +
      'permanently, use Discard in that panel.</p>';
    proceedLabel.textContent = 'End Launch';
    proceedBtn.disabled = false;
  } else {
    // ---------- Refund mode (existing flow) ----------
    cancelMode = 'refund';
    titleEl.textContent = 'Cancel and Refund?';
    destSection.classList.remove('hidden');
    finePrint.innerHTML =
      '<p>This will sweep everything currently in the ephemeral wallet to ' +
      'that destination, then end the launch. Anything created on-chain so ' +
      'far (e.g., the SPL token if step 4 completed, or any pools created ' +
      'in step 5) stays on-chain — only the wallet\'s contents move.</p>';
    proceedLabel.textContent = 'Cancel and Refund';

    // Tailor the lead message to the current step so the user knows
    // what's at stake. (Now that we only reach this branch when the
    // wallet actually has funds, "you have funded" is no longer a lie
    // at step 3.)
    let message;
    if (currentStep <= 2) {
      message = 'You have SOL in the ephemeral wallet. Cancelling will sweep it back to you.';
    } else if (currentStep === 3) {
      message = 'You have funded the ephemeral wallet but no on-chain operations have run yet. Cancelling will refund the SOL.';
    } else if (currentStep === 4) {
      message = 'The token may have been created already. Cancelling will refund SOL and any leftover token supply, but the token itself stays on-chain (you cannot un-mint).';
    } else if (currentStep === 5) {
      message = 'The token exists. Some pools may have been created. Cancelling will sweep everything currently in the wallet (tokens, SOL, any Fee Key NFTs from completed pools), but already-created pools stay on-chain.';
    } else {
      message = 'This will sweep everything in the ephemeral wallet to your destination.';
    }
    if (balanceCheckFailed) {
      message =
        'Couldn\'t verify the wallet balance — RPC may be down. ' +
        'Defaulting to the refund flow. ' + message;
    }
    intro.textContent = message;

    // Pre-fill destination with the detected funding wallet if available
    if (fundingWallet) {
      destInput.value = fundingWallet;
      destHelp.textContent = 'Pre-filled with the detected funding wallet. Verify before proceeding.';
      proceedBtn.disabled = false;
    } else {
      destInput.value = '';
      destHelp.textContent = 'No funding wallet detected — paste your destination address.';
      proceedBtn.disabled = true;
    }
  }

  document.getElementById('cancelConfirmModal').classList.add('is-active');
}

bind('cancelDestInput', 'input', (e) => {
  // Only relevant in refund mode (in end-launch mode the input is
  // hidden and the proceed button is enabled unconditionally).
  if (cancelMode !== 'refund') return;
  const v = e.target.value.trim();
  const looksValid = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v);
  document.getElementById('cancelConfirmProceedBtn').disabled = !looksValid;
});

bind('cancelConfirmDismissBtn', 'click', () => {
  document.getElementById('cancelConfirmModal').classList.remove('is-active');
});

// Show the step-6 cancelled panel and decide whether to offer the
// "Start over with the same wallet" affordance. We only offer start-
// over when nothing was created on-chain — i.e., the cancel happened
// before step 4 (token creation). For step-4+ cancels, the token (and
// possibly pools) exist on-chain; starting over would silently create
// a SECOND set, leaving the first one stranded. Better UX is to
// require the user to consciously launch a new instance for that case.
//
// `cancelStep` is the step the user was on when they hit cancel (not
// the post-cancel step, which is always 6). `panelBodyText` is the
// "what happened" message — varies by cancel mode (empty vs refunded).
function showCancelledPanel(cancelStep, panelBodyText) {
  document.getElementById('step6NormalBody').classList.add('hidden');
  document.getElementById('step6CancelledPanel').classList.remove('hidden');

  const bodyEl = document.getElementById('step6CancelledPanelBody');
  if (bodyEl) bodyEl.textContent = panelBodyText;

  // Only safe to start over if no on-chain ops have run yet. Steps 1-3
  // are pre-mint; step 4+ creates the token / pools.
  const canStartOver = cancelStep <= 3;
  const startOverWrap = document.getElementById('step6StartOverWrap');
  const closeHint = document.getElementById('step6CancelledCloseHint');
  if (canStartOver) {
    startOverWrap.classList.remove('hidden');
    // Hide the "close and reopen" hint — that's the fallback advice
    // for when start-over isn't available.
    closeHint.classList.add('hidden');
  } else {
    startOverWrap.classList.add('hidden');
    closeHint.classList.remove('hidden');
  }
}

bind('cancelConfirmProceedBtn', 'click', async () => {
  // ---------- End-launch path ----------
  // Wallet is empty — nothing to sweep, nothing to refund. Just stop
  // polling, lock the UI at step 6, and log it. The wallet's secret
  // key stays in the pending-wallets recovery cache server-side so
  // a delayed deposit (one the user sent right before clicking
  // cancel, say) can still be claimed via that panel later.
  if (cancelMode === 'end_launch') {
    document.getElementById('cancelConfirmModal').classList.remove('is-active');

    if (balancePollHandle) {
      clearInterval(balancePollHandle);
      balancePollHandle = null;
    }

    log('Launch ended. The ephemeral wallet was empty — no sweep needed.', 'info');
    // Mark the user's CURRENT step (before activateStep flips it) as
    // cancelled so its summary reflects that context. activateStep(6)
    // below will mark every step 1..5 as completed/preserved and make
    // step 6 the active terminal step.
    setStepSummary(currentStep, 'cancelled — wallet was empty');

    // Swap Step 6's body: hide the normal transfer form (destination
    // wallet input + Transfer Assets button), show the cancellation
    // notice instead. Without this, the user sees a form prompting
    // them for a destination address even though there's nothing in
    // the wallet to transfer — confusing and dead-ends them because
    // we also hide the Transfer Assets button (no submit affordance).
    // showCancelledPanel also decides whether to offer "Start over"
    // based on whether on-chain ops have run.
    showCancelledPanel(
      currentStep,
      'The ephemeral wallet was empty, so there was nothing to refund. ' +
      'Nothing was spent on-chain, and no token or pools were created.',
    );

    // Mark Step 6's summary too, so the collapsed/peek view of the
    // terminal step also makes the cancellation context obvious
    // (without this, the user could glance at Step 6 in the step
    // overview and not realize it was reached via cancel rather
    // than normal completion).
    setStepSummary(6, 'launch cancelled');

    activateStep(6);

    // Refresh the pending-wallets panel — server kept this wallet
    // in the recovery cache (we didn't dismiss), so the user can
    // see it there if they want to claim a delayed deposit later or
    // discard the entry permanently.
    loadPendingWallets();
    return;
  }

  // ---------- Refund path (existing flow) ----------
  const dest = document.getElementById('cancelDestInput').value.trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(dest)) {
    log('Invalid destination address', 'danger');
    return;
  }
  document.getElementById('cancelConfirmModal').classList.remove('is-active');

  // Stop balance polling so we don't fight with the sweep
  if (balancePollHandle) {
    clearInterval(balancePollHandle);
    balancePollHandle = null;
  }

  await withRunState(async () => {
    log(`Cancelling: sweeping wallet to ${dest}...`, 'warning');
    try {
      const resp = await fetch('/api/transfer-assets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tempWalletSecretKey: tempWallet.secretKey,
          destinationWallet: dest,
          tokenMint: createdTokenInfo ? createdTokenInfo.mint : '',
        }),
      });
      const data = await resp.json();
      if (!data.success) throw new Error(data.error);

      const swept = [
        data.tokensTransferred ? `${data.tokensTransferred} tokens` : null,
        data.solTransferred ? `${data.solTransferred} SOL` : null,
        data.nftSweep?.transferred?.length ? `${data.nftSweep.transferred.length} NFT(s)` : null,
      ].filter(Boolean).join(', ');

      // Surface partial-failure modes — same detection logic as runTransfer().
      // The cancel path uses the same /api/transfer-assets endpoint, so it
      // has identical sub-step failure modes (SOL sweep failure with
      // tokens already moved, individual token/NFT transfer errors).
      // Without these warnings the user might think the cancel completed
      // cleanly when SOL is actually stranded in the ephemeral wallet.
      const tokenErrors = data.tokenSweep?.errors || [];
      const nftErrors = data.nftSweep?.errors || [];
      const hasPartialFailure =
        data.solSweepError || tokenErrors.length > 0 || nftErrors.length > 0;

      if (data.solSweepError) {
        log(`Cancel: SOL sweep failed: ${data.solSweepError}`, 'warning');
        log(
          'Tokens and NFTs were moved, but SOL remained in the ephemeral wallet. ' +
          'Use the pending-wallets panel above to recover the SOL with the wallet\'s ' +
          'secret key.',
          'warning',
        );
      }
      for (const e of tokenErrors) {
        log(`Cancel: token sweep error (${e.mint?.slice(0, 8) || 'unknown'}…): ${e.error}`, 'warning');
      }
      for (const e of nftErrors) {
        log(`Cancel: NFT sweep error (${e.mint?.slice(0, 8) || 'unknown'}…): ${e.error}`, 'warning');
      }

      if (hasPartialFailure) {
        log(`Cancel partially complete. Swept: ${swept || 'nothing'} — see warnings`, 'warning');
        setStepSummary(currentStep, `cancelled — partial sweep, see warnings`);
      } else {
        log(`Cancel complete. Swept: ${swept || 'nothing'}`, 'success');
        setStepSummary(currentStep, `cancelled — funds returned`);
      }

      // Show the cancelled panel with the swept summary, and offer
      // start-over when no on-chain ops have run (cancel happened
      // before step 4). showCancelledPanel hides the normal transfer
      // body so the user doesn't see a stale form prompting for a
      // destination they've already used.
      const partialNote = hasPartialFailure
        ? ' Some sub-steps failed — see the activity log for details and use the pending-wallets panel to recover anything stranded.'
        : '';
      const sweptText = swept ? `Swept ${swept} back to ${dest}.` : 'Wallet was already empty.';
      showCancelledPanel(
        currentStep,
        `${sweptText}${partialNote}`,
      );
      setStepSummary(6, 'launch cancelled');
      activateStep(6);

      // Refresh pending-wallets panel — server retains a recovery
      // entry in case of partial-failure or delayed deposits.
      loadPendingWallets();
    } catch (e) {
      log(`Cancel failed: ${e.message}`, 'danger');
    }
  });
});

bind('cancelBtn', 'click', openCancelConfirm);

// ===========================================================================
// Activity log toggle
// ===========================================================================

bind('activityLogHeader', 'click', () => {
  const container = document.getElementById('activityLogContainer');
  const chevron = document.getElementById('activityLogChevron');
  container.classList.toggle('is-expanded');
  document.body.classList.toggle('log-expanded', container.classList.contains('is-expanded'));
  chevron.classList.toggle('fa-chevron-up');
  chevron.classList.toggle('fa-chevron-down');
});

// ===========================================================================
// CLMM fee tier list — fetched at startup and used to populate the per-pool
// Fee Tier dropdown in Step 2.
// ===========================================================================

// Fetch the canonical CLMM fee tier list from the server (which in turn
// pulls from Raydium's published config endpoint, with its own fallback).
// On success, replaces the hardcoded fallback in feeTiers with the live
// list. If pools are already rendered when the call returns, re-render
// them so the dropdown picks up newly-available tiers — this matters
// only on the rare path where the user manages to add a pool faster than
// the network call returns; usual case is the call completes first.
async function loadFeeTiers() {
  try {
    const resp = await fetch('/api/clmm-fee-tiers').then((r) => r.json());
    if (resp.success && Array.isArray(resp.tiers) && resp.tiers.length > 0) {
      feeTiers = resp.tiers;
      // If pools have already been rendered, the dropdowns were built
      // from the fallback list. Re-render to pick up the live list.
      if (pools.length > 0) renderPools();
    }
  } catch (e) {
    console.error('Failed to load CLMM fee tiers, using fallback:', e);
  }
}

// ===========================================================================
// RPC settings (top of page) — unchanged from previous version
// ===========================================================================

async function loadRpcConfig() {
  try {
    const resp = await fetch('/api/rpc-config').then((r) => r.json());
    if (resp.success) renderRpcConfig(resp.config);
  } catch (e) {
    console.error('Failed to load RPC config:', e);
  }
}

// Render an RPC URL safely for display. Keeps just the scheme and host
// — everything else (path, query string) is redacted, because that's
// where API keys typically live. Helius URLs look like
// https://mainnet.helius-rpc.com/?api-key=<secret>; QuickNode/Triton
// embed the key in the path. Showing the host only is enough for the
// user to recognise which RPC is active without exposing their key in
// screenshots, screen-shares, or tutorial videos.
//
// `host` mode returns just "https://mainnet.helius-rpc.com".
// `hostWithIndicator` mode appends "/…" if the original had a path or
// query, as a subtle hint that there's more in the URL the user just
// can't see. That's the default — it makes it obvious the display is
// truncated, not that the URL itself is bare.
function safeRpcUrl(url, mode = 'hostWithIndicator') {
  if (typeof url !== 'string' || url.length === 0) return '';
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    // Malformed input — return a generic placeholder rather than
    // leaking whatever raw text was passed in.
    return '(invalid url)';
  }
  const base = `${parsed.protocol}//${parsed.host}`;
  if (mode === 'host') return base;
  const hasMore = parsed.pathname !== '/' || parsed.search.length > 0;
  return hasMore ? `${base}/…` : base;
}

function renderRpcConfig(config) {
  const active = config.saved.find((r) => r.url === config.active);
  const display = active
    ? `${active.name} — ${safeRpcUrl(active.url)}`
    : safeRpcUrl(config.active);
  document.getElementById('rpcCurrentDisplay').textContent = display;

  // Toggle the public-RPC warning. Anything matching the well-known
  // public mainnet hosts is a launch hazard; dedicated RPCs (custom
  // URLs the user has added — Helius, QuickNode, etc., free tier or
  // otherwise) are fine. We match on hostname rather than exact URL
  // so query-string variants and minor formatting differences all
  // get caught.
  togglePublicRpcWarning(config.active);

  const list = document.getElementById('rpcSavedList');
  list.innerHTML = '';
  config.saved.forEach((rpc) => {
    const isActive = rpc.url === config.active;
    const row = document.createElement('div');
    row.className = 'rpc-row';
    const info = document.createElement('div');
    info.className = 'rpc-info';
    info.innerHTML = `
      <strong>${escapeHtml(rpc.name)}</strong>
      ${isActive ? '<span class="tag is-success is-light is-small">active</span>' : ''}
      <br>
      <span class="is-family-monospace is-size-7">${escapeHtml(safeRpcUrl(rpc.url))}</span>
    `;
    const actions = document.createElement('div');
    actions.className = 'rpc-actions';
    if (!isActive) {
      const useBtn = document.createElement('button');
      useBtn.className = 'button is-small is-primary';
      useBtn.textContent = 'Use';
      useBtn.addEventListener('click', () => selectRpc(rpc.url));
      actions.appendChild(useBtn);
    }
    if (config.saved.length > 1) {
      const rmBtn = document.createElement('button');
      rmBtn.className = 'button is-small is-danger is-light';
      rmBtn.innerHTML = '<span class="icon is-small"><i class="fas fa-times"></i></span>';
      rmBtn.title = 'Remove';
      rmBtn.addEventListener('click', () => removeRpc(rpc.url));
      actions.appendChild(rmBtn);
    }
    row.appendChild(info);
    row.appendChild(actions);
    list.appendChild(row);
  });
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Format a token amount in whole units for display in a balance row.
// Uses Math.floor to avoid the rounding hazard where displayed >
// actual — polling reads this text back as Number to compare against
// the wallet balance, so wallet >= displayed must imply wallet >=
// actual on-chain target. For small amounts (<10), keeps decimals so
// USDC-like rows still display "1" not "0".
function formatTokenDisplay(whole) {
  const n = Number(whole);
  if (!isFinite(n) || n <= 0) return '0';
  if (n >= 10) {
    // Big amounts: floor to integer for readability.
    return String(Math.floor(n));
  }
  // Small amounts: keep up to 4 sig figs, floored.
  // (toPrecision rounds — fine for display since the actual auto-swap
  // target is already buffered with the 2x sizing multiplier.)
  return Number(n.toPrecision(4)).toString();
}

// ---------------------------------------------------------------------------
// Numeric input formatting (thousands separators)
// ---------------------------------------------------------------------------
//
// We display large numbers in inputs with comma thousand-separators
// (e.g. "1,000,000,000") because long runs of zeros are hard to
// distinguish at a glance. The inputs themselves are <input type="text"
// inputmode="numeric"> — type="number" won't store commas and the native
// number stepper would conflict with our formatting.
//
// At submit time, every read site uses parseNumberInput() to strip
// the commas and produce a plain number. Server-side sees raw digits
// only.

// Format an input's current value as a comma-grouped integer string,
// preserving the user's cursor position. Called from the input
// element's `input` event so the value re-formats live as the user
// types — but without the cursor jumping to the end on every keystroke
// (which is what naive innerHTML rewrites would cause).
//
// Cursor preservation works by counting how many commas sit before
// the cursor in the OLD value, computing the same count after the
// reformat, and shifting the cursor by the difference. That handles
// every case I can think of: typing in the middle of a number, deleting
// a digit which removes a comma, pasting a long number, etc.
//
// Allows a leading minus sign and decimals — the integer portion gets
// commas, the decimal portion doesn't. Empty input stays empty (no
// leading "0"). Multiple decimals or non-digit junk gets stripped.
function formatNumberInput(input) {
  if (!input) return;
  const oldValue = input.value;
  const oldCursor = input.selectionStart ?? oldValue.length;

  // Count commas before the cursor in the old value — we'll use this
  // to compute where the cursor should sit after re-formatting.
  const oldCommasBeforeCursor = (oldValue.slice(0, oldCursor).match(/,/g) || []).length;

  // Strip everything except digits, the leading minus, and a single
  // decimal point. Order: minus first (if present), then digits, then
  // optional decimal + more digits.
  const cleaned = oldValue
    .replace(/[^\d.\-]/g, '')         // drop everything but digits, dot, minus
    .replace(/(?!^)-/g, '')           // minus only at start
    .replace(/(\..*)\./g, '$1');      // collapse multiple dots into one

  if (cleaned === '' || cleaned === '-' || cleaned === '.') {
    // Edge case: user is mid-typing something that isn't yet a number
    // (just typed "-" or "."). Keep the literal value, no commas yet.
    input.value = cleaned;
    return;
  }

  // Split integer and decimal portions; comma-format the integer only.
  const negative = cleaned.startsWith('-');
  const body = negative ? cleaned.slice(1) : cleaned;
  const dotIdx = body.indexOf('.');
  const intPart = dotIdx === -1 ? body : body.slice(0, dotIdx);
  const decPart = dotIdx === -1 ? '' : body.slice(dotIdx); // includes the dot

  // Strip leading zeros from the integer part (but keep a single zero
  // if the whole integer is zero, e.g. "0.5").
  const intStripped = intPart.replace(/^0+(?=\d)/, '') || '0';
  const intWithCommas = intStripped.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

  const newValue = (negative ? '-' : '') + intWithCommas + decPart;
  input.value = newValue;

  // Reposition cursor: walk from the start of the new value, counting
  // non-comma characters, and stop when we've walked past the same
  // count as came before the cursor in the old value. This handles
  // every case I tested: typing in the middle, deleting a digit that
  // collapses a comma, pasting a long number, etc.
  const oldNonCommasBeforeCursor = oldCursor - oldCommasBeforeCursor;
  let walked = 0;
  let cursor = 0;
  while (cursor < newValue.length && walked < oldNonCommasBeforeCursor) {
    if (newValue[cursor] !== ',') walked++;
    cursor++;
  }
  input.setSelectionRange(cursor, cursor);
}

// Read a numeric input's current value as a plain number, stripping
// any thousand-separator commas. Returns NaN for empty / unparseable
// inputs — same as Number() on a malformed string. Callers that need
// a non-NaN fallback should provide one explicitly (e.g. `?? 0`).
function parseNumberInput(input) {
  if (!input) return NaN;
  const raw = String(input.value).replace(/,/g, '');
  if (raw === '' || raw === '-' || raw === '.') return NaN;
  return Number(raw);
}

function getIntegerInputString(input) {
  if (!input) return '';
  return String(input.value).replace(/,/g, '').trim();
}

// Show a warning banner whenever the active RPC is one of the well-known
// public mainnet endpoints. The list is matched by hostname so all the
// quirky variants (with/without trailing slashes, query strings, etc.)
// still get caught. If a new public alias appears in the wild, just add
// its hostname here.
const PUBLIC_RPC_HOSTS = new Set([
  'api.mainnet-beta.solana.com',
  'solana-api.projectserum.com',
  'rpc.ankr.com',                    // free tier shows up here
  'solana.public-rpc.com',
]);

function togglePublicRpcWarning(activeUrl) {
  const banner = document.getElementById('publicRpcWarning');
  if (!banner) return;

  let isPublic = false;
  try {
    const host = new URL(activeUrl).hostname.toLowerCase();
    isPublic = PUBLIC_RPC_HOSTS.has(host);
  } catch {
    // Malformed URL — treat as not-public (the existing test/validate
    // flow will surface URL problems separately).
    isPublic = false;
  }

  banner.classList.toggle('hidden', !isPublic);
}

async function selectRpc(url) {
  try {
    const resp = await fetch('/api/rpc-config/select', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    }).then((r) => r.json());
    if (resp.success) {
      renderRpcConfig(resp.config);
      log(`Switched RPC to ${safeRpcUrl(url)}`, 'success');
    }
  } catch (e) {
    log(`Failed to switch RPC: ${e.message}`, 'danger');
  }
}

async function removeRpc(url) {
  // The confirm dialog should identify which RPC is being removed
  // without exposing the API key in the URL. Hostname is plenty for
  // the user to recognise. escapeHtml because the URL goes into
  // innerHTML; we don't trust user-supplied URL bytes.
  const ok = await confirmDialog({
    title: 'Remove RPC?',
    body: `<p>Remove this RPC from your saved list?</p>
           <p class="is-family-monospace is-size-7">${escapeHtml(safeRpcUrl(url))}</p>`,
    confirmLabel: 'Remove',
    danger: true,
  });
  if (!ok) return;
  try {
    const resp = await fetch('/api/rpc-config/remove', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    }).then((r) => r.json());
    if (resp.success) renderRpcConfig(resp.config);
  } catch (e) {
    log(`Failed to remove RPC: ${e.message}`, 'danger');
  }
}

bind('rpcSettingsToggle', 'click', () => {
  const panel = document.getElementById('rpcSettingsPanel');
  const chevron = document.getElementById('rpcSettingsChevron');
  panel.classList.toggle('hidden');
  chevron.classList.toggle('fa-chevron-down');
  chevron.classList.toggle('fa-chevron-up');
});

bind('testRpcBtn', 'click', async () => {
  const url = document.getElementById('newRpcUrl').value.trim();
  const result = document.getElementById('rpcTestResult');
  if (!url) {
    result.textContent = 'Enter a URL first';
    result.className = 'help is-warning';
    return;
  }
  result.textContent = 'Testing...';
  result.className = 'help';
  try {
    const resp = await fetch('/api/rpc-config/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    }).then((r) => r.json());
    if (resp.result.ok) {
      result.textContent = `OK — Solana ${resp.result.version}, ${resp.result.latencyMs}ms`;
      result.className = 'help is-success';
    } else {
      result.textContent = `Failed: ${resp.result.error}`;
      result.className = 'help is-danger';
    }
  } catch (e) {
    result.textContent = `Failed: ${e.message}`;
    result.className = 'help is-danger';
  }
});

bind('addRpcBtn', 'click', async () => {
  const name = document.getElementById('newRpcName').value.trim();
  const url = document.getElementById('newRpcUrl').value.trim();
  const result = document.getElementById('rpcTestResult');
  if (!name || !url) {
    result.textContent = 'Both name and URL are required';
    result.className = 'help is-warning';
    return;
  }
  try {
    const resp = await fetch('/api/rpc-config/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, url, setActive: true }),
    }).then((r) => r.json());
    if (resp.success) {
      document.getElementById('newRpcName').value = '';
      document.getElementById('newRpcUrl').value = '';
      result.textContent = '';
      renderRpcConfig(resp.config);
      log(`RPC added: ${name}`, 'success');
    } else {
      result.textContent = `Failed: ${resp.error}`;
      result.className = 'help is-danger';
    }
  } catch (e) {
    result.textContent = `Failed: ${e.message}`;
    result.className = 'help is-danger';
  }
});

// ===========================================================================
// STEP 1: Generate wallet
// ===========================================================================

bind('generateWalletBtn', 'click', async () => {
  const btn = document.getElementById('generateWalletBtn');
  // If a wallet already exists, this is a regenerate. Confirm to avoid
  // accidentally wiping a launch in progress. Tailor the warning to how
  // far along the user is — past step 3 they may have funded the wallet.
  if (tempWallet && currentStep > 1) {
    const pastFunding = currentStep > 3;
    const body = pastFunding
      ? '<p>You are mid-launch. Generating a new wallet will <strong>not</strong> ' +
        'recover any funds, tokens, or NFTs already in the current ephemeral ' +
        'wallet — those will be stranded unless you save the private key ' +
        '(currently visible above) <strong>first</strong>.</p>' +
        '<p>Cancel this dialog, click "Show Private Key", copy the key somewhere ' +
        'safe, <strong>then</strong> regenerate.</p>' +
        '<p>Proceed anyway?</p>'
      : '<p>You already have a wallet from this session. Generating a new one will ' +
        'discard it. If you sent any SOL to it, you will lose access unless you ' +
        'saved the private key first.</p>' +
        '<p>Proceed?</p>';
    const ok = await confirmDialog({
      title: 'Discard current wallet?',
      body,
      confirmLabel: 'Generate new wallet',
      danger: true,
    });
    if (!ok) return;
  }

  await withRunState(async () => {
    setLoading(btn, true);
    try {
      log('Generating temporary wallet...');
      if (balancePollHandle) {
        clearInterval(balancePollHandle);
        balancePollHandle = null;
      }
      const resp = await fetch('/api/generate-wallet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await resp.json();
      if (!data.success) throw new Error(data.error);

      // Reset all per-launch state so a regenerate starts truly fresh
      tempWallet = data.wallet;
      fundingWallet = null;
      fundingDetectionExhausted = false;
      lastSolBalance = 0;
      createdTokenInfo = null;
      lpResult = null;
      fundingRequirement = { solLamports: 0, byQuote: {}, autoSwapPlan: [] };

      // Reset UI panels that may carry stale info from a previous attempt
      document.getElementById('walletInfo').classList.remove('hidden');
      document.getElementById('qrCode').src = data.wallet.qrCode;
      document.getElementById('walletAddress').value = data.wallet.publicKey;
      document.getElementById('privateKeyContainer').classList.add('hidden');
      document.getElementById('tokenCreatedInfo').classList.add('hidden');
      document.getElementById('createTokenBtn').classList.remove('hidden');
      document.getElementById('createLpBtn').classList.remove('hidden');
      document.getElementById('transferAssetsBtn').classList.remove('hidden');
      document.getElementById('lpDoneInfo').classList.add('hidden');
      document.getElementById('lpFailInfo').classList.add('hidden');
      document.getElementById('lpProgress').classList.add('hidden');
      document.getElementById('lpProgressTree').innerHTML = '';
      document.getElementById('transferResult').classList.add('hidden');
      document.getElementById('fundingWalletInfo').classList.add('hidden');
      document.getElementById('destinationWallet').value = '';

      // Reset step summaries from any prior attempt
      for (let i = 2; i <= 6; i++) setStepSummary(i, '');

      document.body.classList.add('has-log');

      log(`Wallet generated: ${data.wallet.publicKey}`, 'success');

      if (pools.length === 0) {
        // Build pools from simpleConfig defaults — produces 90/10
        // SOL+XLRT (or whatever the user has selected in the simple
        // toggle) instead of the old single SOL pool. The simple-config
        // UI may have been rendered already (see init at the bottom of
        // this file); we re-apply the mode here to make sure the right
        // container is visible after step 2 activates.
        rebuildPoolsFromSimple();
      }
      applySimpleConfigMode();

      setStepSummary(1, `${data.wallet.publicKey.slice(0, 8)}…${data.wallet.publicKey.slice(-6)}`);
      activateStep(2);
      updateContinueToFundingState();
      updateCancelButtonState();
    } catch (e) {
      log(`Error: ${e.message}`, 'danger');
    } finally {
      setLoading(btn, false);
    }
  });
});

bind('showPrivateKeyBtn', 'click', () => {
  const cont = document.getElementById('privateKeyContainer');
  const target = document.getElementById('privateKey');
  if (!tempWallet) return;
  if (cont.classList.contains('hidden')) {
    // New wallets always have a mnemonic; the base58 fallback is only
    // here in case something upstream changes and we end up without one.
    if (tempWallet.mnemonic) {
      target.innerHTML = '';
      target.appendChild(buildMnemonicGrid(tempWallet.mnemonic));
    } else {
      target.className = 'secret-key-container';
      target.textContent = tempWallet.secretKeyB58 || '(secret unavailable)';
    }
    cont.classList.remove('hidden');
  } else {
    cont.classList.add('hidden');
  }
});

// Build a numbered 12-word grid for displaying a BIP39 mnemonic. Reads
// nicely on screen, easy to copy down accurately on paper.
function buildMnemonicGrid(mnemonic) {
  const wrap = document.createElement('div');
  wrap.className = 'mnemonic-grid';
  const words = mnemonic.trim().split(/\s+/);
  words.forEach((word, i) => {
    const cell = document.createElement('div');
    cell.innerHTML = `<span class="num">${i + 1}.</span>${word}`;
    wrap.appendChild(cell);
  });
  return wrap;
}

// ===========================================================================
// STEP 2: Token + Pool config
// ===========================================================================

// Validate a picked logo file against the size and dimension limits.
// Returns a Promise<string|null>: null on success, an error message on
// failure. Loads the file as an image to read its natural dimensions —
// we can't trust the file metadata or filename extension for this; the
// only reliable read is "actually decode the image and ask."
//
// The Image decode is wrapped in a same-document objectURL that we
// revoke immediately after, regardless of outcome, so this validation
// path doesn't leak object URLs even on rapid file changes.
async function validateLogoFile(file) {
  if (file.size > MAX_LOGO_BYTES) {
    const kb = (file.size / 1024).toFixed(1);
    const maxKb = (MAX_LOGO_BYTES / 1024).toFixed(0);
    return `Logo is ${kb}KB; max is ${maxKb}KB. ` +
      `Compress the image or pick a smaller file.`;
  }
  // accept attribute on the input already restricts the picker to
  // image/png and image/jpeg, but the browser's filter isn't a hard
  // gate (drag-and-drop, devtools, OS file dialogs that ignore filters
  // on some platforms). Re-check the MIME explicitly so we surface a
  // useful message instead of letting the image decode fail opaquely.
  if (file.type !== 'image/png' && file.type !== 'image/jpeg') {
    return 'Logo must be a PNG or JPG image.';
  }

  // Image-decode dimension check. We have to actually load the file as
  // an image — there's no synchronous way to get pixel dimensions from
  // a File object. createObjectURL + new Image() is the standard idiom.
  const url = URL.createObjectURL(file);
  try {
    const dims = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = () => reject(new Error('Could not decode image — file may be corrupt'));
      img.src = url;
    });
    if (dims.w > MAX_LOGO_DIMENSION || dims.h > MAX_LOGO_DIMENSION) {
      return `Logo is ${dims.w}×${dims.h}px; max is ` +
        `${MAX_LOGO_DIMENSION}×${MAX_LOGO_DIMENSION}px. Resize the image and try again.`;
    }
    if (dims.w < MIN_LOGO_DIMENSION || dims.h < MIN_LOGO_DIMENSION) {
      return `Logo is ${dims.w}×${dims.h}px; minimum is ` +
        `${MIN_LOGO_DIMENSION}×${MIN_LOGO_DIMENSION}px. Pick a larger image.`;
    }
    return null;
  } catch (e) {
    return e.message || 'Could not read the image.';
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Show or clear the inline logo error message under the file picker.
// Passing null hides the element; passing a string reveals it with the
// message. Encapsulates the .hidden toggle so the call sites read
// clearly as "set the error" vs "clear the error."
function setLogoError(message) {
  const el = document.getElementById('tokenLogoError');
  if (!el) return;
  if (message) {
    el.textContent = message;
    el.classList.remove('hidden');
  } else {
    el.textContent = '';
    el.classList.add('hidden');
  }
}

bind('tokenLogo', 'change', async (e) => {
  const f = e.target.files[0];
  const filenameEl = document.getElementById('logoFileName');
  // No file selected (user cancelled out of the picker, or cleared the
  // selection). Reset displayed state and any prior error.
  if (!f) {
    filenameEl.textContent = 'No file selected';
    setLogoError(null);
    return;
  }
  // Show the picked filename immediately so the UI feels responsive
  // even while we're decoding the image to check dimensions. We'll
  // overwrite this with "No file selected" if validation fails.
  filenameEl.textContent = f.name;
  setLogoError(null);

  const err = await validateLogoFile(f);
  if (err) {
    // Reject the file: clear the input so subsequent code paths
    // (renderTokenPreview, the create-token submit) see no logo at
    // all, rather than seeing a logo that's about to be rejected by
    // the server. Setting .value = '' is the cross-browser way to
    // programmatically clear a file input.
    e.target.value = '';
    filenameEl.textContent = 'No file selected';
    setLogoError(err);
    // Trigger a preview re-render so the thumbnail and live preview
    // card both drop back to their no-logo state.
    if (typeof renderTokenPreview === 'function') renderTokenPreview();
    return;
  }
  // Valid file — leave the filename as set above. The separate
  // change-handler binding (see bind('tokenLogo', 'change', renderTokenPreview)
  // below in this file) handles updating the preview thumbnail and
  // live card. We don't trigger it directly from here; the browser
  // fires `change` once and both listeners receive it.
});

const poolList = document.getElementById('poolList');

function addPool(initial = {}) {
  // Default supplyPercent to whatever's left of the 100% budget so we never
  // create a new pool that pushes the total over 100. Callers that pass an
  // explicit supplyPercent (wallet-generation passes 100, future presets
  // will pass their own) bypass this default unchanged. If the budget is
  // already full the new pool comes up at 0% and the validation surfaces a
  // "set an allocation" hint inline.
  const sumExisting = pools.reduce((s, p) => s + (Number(p.supplyPercent) || 0), 0);
  const defaultPct = Math.max(0, 100 - sumExisting);
  pools.push({
    quoteToken: initial.quoteToken || 'SOL',
    supplyPercent: initial.supplyPercent ?? defaultPct,
    ammConfigIndex: 3,
    quoteUsdOverride: null,
    quoteDecimalsOverride: null,
    quoteSymbolOverride: null,
    resolvedSymbol: null,
    resolvedDecimals: null,
    resolvedPriceUsd: null,
    resolvedMint: null,
    // Optional display-only fields populated by /api/quote-token-info.
    // Either may be null if no indexer (Gecko, DexScreener) had the
    // token — the UI just hides the logo or falls back to the symbol.
    resolvedName: null,
    resolvedImageUrl: null,
    // Raydium CLMM compatibility info, set by resolvePoolQuote():
    //   resolvedCompatible: true | false | null (null = couldn't check)
    //   resolvedIsToken2022: bool — true when the mint is owned by the
    //                        Token-2022 program (vs the classic SPL Token
    //                        program). Token-2022 mints with allowlisted
    //                        extensions are still compatible.
    //   resolvedDisallowedNames: [string] — friendly names of any Token-2022
    //                        extensions this mint has that Raydium CLMM
    //                        doesn't accept. Empty when compatible.
    //   resolvedCompatError: string | null — populated when the on-chain
    //                        check failed (RPC issue / mint missing).
    resolvedCompatible: null,
    resolvedIsToken2022: false,
    resolvedDisallowedNames: [],
    resolvedCompatError: null,
    // Initial distribution. Defaults to a single 100% slice (one
    // position, one Fee Key NFT). The simple-config "Split the LP"
    // toggle passes a multi-slice distribution here for users who
    // want N positions, each minting its own transferable NFT.
    distribution: initial.distribution || [
      { sharePercent: 100, recipient: null, useExternalRecipient: false },
    ],
    // Per-pool bootstrap configuration.
    //   { mode: 'minimal' } — 1-whole-token reserve, narrow tick range
    //   { mode: 'custom', solValue: N, supplyPercent: M } — user-funded
    //
    // Under "user thinks in SOL" semantics, solValue is the canonical
    // input — the absolute SOL value of starting liquidity the user
    // wants on this pool. supplyPercent is DERIVED from solValue,
    // pool.supplyPercent, the target market cap, and the SOL/USD price.
    // It's recomputed any time those inputs change (the user types SOL,
    // the target mcap input is edited, the SOL price resolves), and
    // the wide slices auto-rebalance to absorb the delta so positions
    // total stays at 100%.
    //
    // supplyPercent is stored alongside solValue (rather than recomputed
    // every read) so the positions-total indicator and the wire-format
    // conversion don't have to redo the derivation logic on every paint.
    // Whenever solValue or any input it depends on changes, we call
    // recomputePoolBootstrapAndRebalance() to refresh supplyPercent and
    // rebalance slices in one shot.
    bootstrapConfig: initial.bootstrapConfig || { mode: 'minimal' },
    // Per-pool ladder configuration.
    //   { mode: 'off' } — no ladder positions
    //   { mode: 'manual', bands: [...] } — explicit list of bands
    // Each band: { supplyPercent, lowerMultiplier, upperMultiplier }
    // where multipliers are relative to launch price (e.g., 1.5–2.5 =
    // a band spanning 1.5× to 2.5× of launch price). The simple-UI
    // ladder toggle populates manual-mode bands using the log-spaced
    // preset; customize mode lets the user edit, add, or remove
    // individual bands. The wire format the backend receives is
    // always 'off' or 'manual' from the trebuchet frontend; the
    // backend's older 'simple' mode is preserved for direct API
    // users (scripts) but unused here.
    ladderConfig: initial.ladderConfig || { mode: 'off', bands: [] },
    // UI-only: whether this pool's body is expanded in the editor. Set
    // by initialIsExpanded() at construction; the user can flip it via
    // the header click or via auto-expansion when the pool needs
    // attention. Buildmode/render code never reads this on a collapsed
    // pool, since collapsed pools only render the header strip.
    _isExpanded: initial._isExpanded ?? false,
  });
  renderPools();
  resolvePoolQuote(pools.length - 1);
}

function removePool(idx) {
  pools.splice(idx, 1);
  renderPools();
  updateContinueToFundingState();
}

// Add a slice to a pool's distribution. Splits the last existing slice
// in half so the total wide allocation doesn't change — the user is
// subdividing for ownership splitting, not reallocating supply. The
// new slice arrives with no recipient set; user can wire one up via
// "Send to a different wallet" checkbox in the row.
function addSlice(poolIdx) {
  const p = pools[poolIdx];
  // Adding a slice always splits the LAST existing slice in half.
  // This keeps the positions total invariant — the wide bucket's
  // size doesn't change, we just subdivide it further for ownership
  // splitting.
  //
  // If there are no existing slices (edge case — distribution was
  // emptied), seed with what's left of the wide bucket after bs +
  // bands. Should never happen in practice since addPool seeds one
  // slice, but we guard so a corrupt state can still recover.
  if (p.distribution.length === 0) {
    const bsPct = (p.bootstrapConfig?.mode === 'custom')
      ? Number(p.bootstrapConfig.supplyPercent) || 0 : 0;
    const bandsPct = (p.ladderConfig?.mode === 'manual' && Array.isArray(p.ladderConfig.bands))
      ? p.ladderConfig.bands.reduce((s, b) => s + (Number(b.supplyPercent) || 0), 0) : 0;
    const widePct = Math.max(0, 100 - bsPct - bandsPct);
    p.distribution.push({ sharePercent: widePct, recipient: null, useExternalRecipient: false });
  } else {
    const last = p.distribution[p.distribution.length - 1];
    const lastShare = Number(last.sharePercent) || 0;
    const half = Number((lastShare / 2).toFixed(4));
    last.sharePercent = half;
    p.distribution.push({ sharePercent: half, recipient: null, useExternalRecipient: false });
  }
  renderPools();
}

function removeSlice(poolIdx, sliceIdx) {
  const p = pools[poolIdx];
  if (p.distribution.length <= 1) return;
  // Absorb the removed slice's share into the last remaining slice so
  // the positions total stays at whatever it was. Without this, removing
  // a slice would silently shrink the wide bucket and the user would
  // see a confusing "now total is 75%" warning that they didn't trigger
  // intentionally. The remaining slice grows to take back the freed
  // share.
  const removedShare = Number(p.distribution[sliceIdx].sharePercent) || 0;
  p.distribution.splice(sliceIdx, 1);
  if (p.distribution.length > 0) {
    const last = p.distribution[p.distribution.length - 1];
    last.sharePercent = Number(
      ((Number(last.sharePercent) || 0) + removedShare).toFixed(4),
    );
  }
  renderPools();
}

// ---------------------------------------------------------------------------
// Simple-config rendering and pool rebuild
// ---------------------------------------------------------------------------

// Rebuild the pools array from the current simpleConfig state. Always
// produces either one pool (SOL at 100%) or two pools (SOL at 90% +
// flywheel at 10%). Wipes any existing pools — this function is the
// authority on what pools look like when in default mode.
//
// Pools come up collapsed by default (since they're at trivial defaults
// with no user customization). Resolution kicks off automatically per
// the existing addPool() behavior.
function rebuildPoolsFromSimple() {
  // Wipe the existing pool list. We assume the caller knows what they're
  // doing — switching from customize → default mode should confirm
  // before calling this.
  pools.length = 0;

  // Helper: compute the wide-bucket total for a pool given its bs + ladder
  // configs. With unified semantics, bs + sum(ladder) + sum(wide slices)
  // = 100% of pool. So wide total = 100 - bs - sum(bands). Slices then
  // split this wide total equally.
  function widePctForPool(bsCfg, ladderCfg) {
    const bsPct = bsCfg && bsCfg.mode === 'custom' ? Number(bsCfg.supplyPercent) : 0;
    const ladderTotal = ladderCfg && Array.isArray(ladderCfg.bands)
      ? ladderCfg.bands.reduce((s, b) => s + Number(b.supplyPercent || 0), 0)
      : 0;
    return Math.max(0, 100 - bsPct - ladderTotal);
  }

  if (simpleConfig.flywheelEnabled) {
    const fw = FLYWHEELS[simpleConfig.flywheelKey];
    if (fw && fw.available && fw.mint) {
      const flywheelPct = Math.max(
        FLYWHEEL_MIN_PERCENT,
        Math.min(FLYWHEEL_MAX_PERCENT, Number(simpleConfig.flywheelPercent) || DEFAULT_FLYWHEEL_PERCENT),
      );
      const solPercent = 100 - flywheelPct;

      // Compute bootstrap and ladder for each pool. Bootstrap is derived
      // per-pool (since the pool's supplyPercent matters for converting
      // dollar value to % of pool); ladder is the same shape on both.
      const solBs = deriveBootstrapConfigFromSimple(solPercent, 2);
      const solLadder = deriveLadderConfigFromSimple();
      const fwBs = deriveBootstrapConfigFromSimple(flywheelPct, 2);
      const fwLadder = deriveLadderConfigFromSimple();

      // Distribution slices share the wide bucket. Split-the-LP applies
      // only to the SOL pool in simple mode; flywheel pool always gets
      // one slice. Each slice's sharePercent is "% of pool" (new unified
      // semantics).
      const solSplitCount = simpleConfig.splitEnabled ? simpleConfig.splitCount : 1;
      const solDistribution = buildEqualSplitDistribution(
        solSplitCount, widePctForPool(solBs, solLadder),
      );
      const fwDistribution = buildEqualSplitDistribution(
        1, widePctForPool(fwBs, fwLadder),
      );
      addPool({
        quoteToken: 'SOL',
        supplyPercent: solPercent,
        distribution: solDistribution,
        bootstrapConfig: solBs,
        ladderConfig: solLadder,
      });
      addPool({
        quoteToken: fw.mint,
        supplyPercent: flywheelPct,
        distribution: fwDistribution,
        bootstrapConfig: fwBs,
        ladderConfig: fwLadder,
      });
      return;
    }
    // Selected flywheel is not available (e.g. user picked it before
    // it launches, or the entry got removed); fall through to single-
    // SOL-pool default. The dropdown should prevent this in normal use.
  }

  // Default / flywheel-disabled / unavailable-flywheel case. Only one
  // pool (SOL), so splitting that pool is the only kind of split that
  // makes sense here.
  const bsCfg = deriveBootstrapConfigFromSimple(100, 1);
  const ladderCfg = deriveLadderConfigFromSimple();
  const distribution = buildEqualSplitDistribution(
    simpleConfig.splitEnabled ? simpleConfig.splitCount : 1,
    widePctForPool(bsCfg, ladderCfg),
  );
  addPool({
    quoteToken: 'SOL',
    supplyPercent: 100,
    distribution,
    bootstrapConfig: bsCfg,
    ladderConfig: ladderCfg,
  });
}

// Translate the simple-UI bootstrap toggle into a per-pool bootstrapConfig.
//
// The canonical user-intent value is the SOL value of starting liquidity
// (simpleConfig.bootstrapSolValue) split evenly across pools. We return
// both the solValue (canonical) and the derived supplyPercent (% of
// this pool), so the customize-mode UI can display either and the
// wire-format conversion can use supplyPercent without recomputing.
//
// supplyPercent uses the live SOL price when available (read from the
// SOL pool's resolvedPriceUsd), falling back to $200 when no pool has
// resolved yet — same fallback the funding estimator uses. The post-
// resolution refresh in resolvePoolQuote re-runs this and updates each
// pool's supplyPercent + rebalances slices when the live price arrives.
//
// If any input is missing or invalid (no resolved SOL price yet, no
// target mcap set, custom mode but zero SOL value), we return minimal
// mode. Pre-flight will reject if a custom-mode pool ends up with a
// bad supplyPercent, but returning minimal here is the friendlier
// behavior because the user can still launch and then switch to
// customize to fix it.
function deriveBootstrapConfigFromSimple(poolSupplyPercent, poolCount) {
  if (simpleConfig.mode !== 'default') return { mode: 'minimal' };
  if (simpleConfig.bootstrapMode !== 'custom') return { mode: 'minimal' };
  const totalSol = Number(simpleConfig.bootstrapSolValue);
  if (!Number.isFinite(totalSol) || totalSol <= 0) return { mode: 'minimal' };
  if (!Number.isFinite(poolCount) || poolCount <= 0) return { mode: 'minimal' };
  if (!Number.isFinite(poolSupplyPercent) || poolSupplyPercent <= 0) return { mode: 'minimal' };

  // Each pool gets an equal share of the total bootstrap SOL.
  const perPoolSol = totalSol / poolCount;
  // Derive supplyPercent for initial display. The on-input handlers
  // and the targetMarketCap/resolvePoolQuote hooks all recompute this
  // via computeBootstrapSupplyPercent() which uses the same logic.
  const supplyPercent = computeBootstrapSupplyPercent(perPoolSol, poolSupplyPercent);
  if (supplyPercent == null) return { mode: 'minimal' };
  return { mode: 'custom', solValue: perPoolSol, supplyPercent };
}

// Compute the supplyPercent (% of pool) for a bootstrap given:
//   solValue        — absolute SOL of starting liquidity for THIS pool
//   poolSupplyPct   — pool's allocation as % of total token supply
//
// Reads targetMarketCap from the DOM and the SOL price from the SOL
// pool's resolvedPriceUsd (falls back to $200 if unresolved). Returns
// null if any input is missing/invalid; callers treat null as "leave
// the supplyPercent alone."
function computeBootstrapSupplyPercent(solValue, poolSupplyPct) {
  const sol = Number(solValue);
  if (!Number.isFinite(sol) || sol <= 0) return null;
  if (!Number.isFinite(poolSupplyPct) || poolSupplyPct <= 0) return null;
  const targetMc = parseNumberInput(document.getElementById('targetMarketCap'));
  if (!Number.isFinite(targetMc) || targetMc <= 0) return null;
  const solPool = pools.find((p) => (p.quoteToken || '').toUpperCase() === 'SOL');
  const solUsd = solPool && Number(solPool.resolvedPriceUsd) > 0
    ? Number(solPool.resolvedPriceUsd) : 200;
  const bsUsd = sol * solUsd;
  const poolUsd = targetMc * poolSupplyPct / 100;
  if (poolUsd <= 0) return null;
  const pct = (bsUsd / poolUsd) * 100;
  if (!Number.isFinite(pct) || pct <= 0) return null;
  return pct;
}

// Refresh one pool's bootstrap supplyPercent from its stored solValue,
// then absorb the delta into the wide slices so positions total stays
// at 100%. Called from any path that can change the derived supplyPercent
// without changing user intent: targetMarketCap input, SOL price
// resolution, and the SOL input in customize mode itself.
//
// No-op when bootstrap is in minimal mode (no solValue to recompute)
// or when the recompute fails (missing mcap/price). In both cases the
// supplyPercent stays at whatever it was, so the total may drift —
// the warning indicator surfaces that to the user.
function recomputePoolBootstrapAndRebalance(pool) {
  if (!pool || !pool.bootstrapConfig || pool.bootstrapConfig.mode !== 'custom') return;
  const oldPct = Number(pool.bootstrapConfig.supplyPercent) || 0;
  const newPct = computeBootstrapSupplyPercent(
    pool.bootstrapConfig.solValue,
    Number(pool.supplyPercent),
  );
  if (newPct == null) return;
  pool.bootstrapConfig.supplyPercent = newPct;
  rebalanceWideSlicesByDelta(pool, newPct - oldPct);
}

// Translate the simple-UI ladder toggle into a per-pool ladderConfig.
//
// When the toggle is off (or the user is in customize mode but
// rebuildPoolsFromSimple is somehow called), return { mode: 'off' }.
// When on, generate the log-spaced default bands the simple UI would
// have produced — same math as the original simple-mode auto-generated
// bands. From this point, the user can edit individual bands in
// customize mode and the per-pool ladderConfig becomes the source of
// truth.
//
// Each band has supplyPercent (equal share of the global ladder %),
// lowerMultiplier, upperMultiplier. Multipliers are computed from
// the log-spacing math: ln(ceiling) / (2N - 1) per "unit", N bands +
// (N-1) gaps. Band i covers [ratio^(2i), ratio^(2i+1)].
function deriveLadderConfigFromSimple() {
  if (simpleConfig.mode !== 'default') return { mode: 'off', bands: [] };
  if (!simpleConfig.ladderEnabled) return { mode: 'off', bands: [] };
  const supplyPercent = Math.max(
    LADDER_MIN_PERCENT,
    Math.min(LADDER_MAX_PERCENT, Number(simpleConfig.ladderPercent) || LADDER_DEFAULT_PERCENT),
  );
  const bandCount = Math.max(
    LADDER_MIN_BANDS,
    Math.min(LADDER_MAX_BANDS, Number(simpleConfig.ladderBandCount) || LADDER_DEFAULT_BANDS),
  );
  return {
    mode: 'manual',
    bands: generateLogSpacedBands({
      supplyPercent,
      bandCount,
      ceilingMultiplier: LADDER_CEILING_MULTIPLIER,
    }),
  };
}

// Generate N log-spaced ladder bands covering [1×, ceiling×] with equal
// gap widths between bands. Each band is given an equal share of the
// total ladder supply. This is the math the backend's 'simple' mode
// used to do server-side; we do it client-side now so the bands are
// editable as manual-mode bands.
//
// Math: total log span = ln(ceiling), per-unit log = total/(2N-1)
// (N bands + N-1 gaps). Band i (0-indexed) covers
// [e^(2i × perUnit), e^((2i+1) × perUnit)].
function generateLogSpacedBands({ supplyPercent, bandCount, ceilingMultiplier }) {
  const perBandPct = supplyPercent / bandCount;
  const totalLog = Math.log(ceilingMultiplier);
  const perUnitLog = totalLog / (2 * bandCount - 1);
  const bands = [];
  for (let i = 0; i < bandCount; i++) {
    const lowerMul = Math.exp(2 * i * perUnitLog);
    const upperMul = Math.exp((2 * i + 1) * perUnitLog);
    bands.push({
      // toFixed → Number to bound trailing precision (the slider step
      // is 0.01, so 4 decimals is plenty for our needs).
      supplyPercent: Number(perBandPct.toFixed(4)),
      lowerMultiplier: Number(lowerMul.toFixed(4)),
      upperMultiplier: Number(upperMul.toFixed(4)),
    });
  }
  return bands;
}

// Paint the simple-config UI into #simpleConfigBody. Called whenever
// simpleConfig changes or when switching mode. Uses textContent /
// dataset on the elements we listen to, but constructs them with
// innerHTML for terseness — none of the values are user-controlled
// strings, so injection isn't a concern.
function renderSimpleConfig() {
  const body = document.getElementById('simpleConfigBody');
  if (!body) return;

  // Defensive: if simpleConfig.flywheelKey points at an unavailable
  // flywheel (e.g. someone re-flagged 'reserve' as unavailable, or a
  // future session-restore path loaded a stale key), fall back to the
  // first available one. Without this, the dropdown would render with
  // a disabled option pre-selected, which is awkward and confusing.
  const currentFw = FLYWHEELS[simpleConfig.flywheelKey];
  if (!currentFw || !currentFw.available) {
    const firstAvailable = Object.values(FLYWHEELS).find((fw) => fw.available);
    if (firstAvailable) {
      simpleConfig.flywheelKey = firstAvailable.key;
    }
  }

  // Build the list of <option> entries from FLYWHEELS, marking
  // unavailable ones as disabled so users see them but can't pick them.
  const options = Object.values(FLYWHEELS).map((fw) => {
    const selected = fw.key === simpleConfig.flywheelKey ? 'selected' : '';
    const disabled = !fw.available ? 'disabled' : '';
    return `<option value="${escapeHtml(fw.key)}" ${selected} ${disabled}>${escapeHtml(fw.label)}</option>`;
  }).join('');

  const dropdownDisabled = !simpleConfig.flywheelEnabled ? 'disabled' : '';
  const checked = simpleConfig.flywheelEnabled ? 'checked' : '';
  // Slider value — clamp at render time too, in case anything pushed it
  // out of range. The defensive clamp in rebuildPoolsFromSimple is the
  // ultimate authority but it's nicer if the UI shows the right number.
  const sliderValue = Math.max(
    FLYWHEEL_MIN_PERCENT,
    Math.min(FLYWHEEL_MAX_PERCENT, Number(simpleConfig.flywheelPercent) || DEFAULT_FLYWHEEL_PERCENT),
  );

  // Split-LP state. Slider value clamped here too — same belt-and-
  // suspenders rationale as the flywheel slider above.
  const splitChecked = simpleConfig.splitEnabled ? 'checked' : '';
  const splitSliderDisabled = !simpleConfig.splitEnabled ? 'disabled' : '';
  const splitValue = Math.max(
    SPLIT_MIN_COUNT,
    Math.min(SPLIT_MAX_COUNT, Number(simpleConfig.splitCount) || 1),
  );
  const splitReadoutText = `${splitValue} ${splitValue === 1 ? 'position' : 'positions'}`;

  // Help text varies based on toggle state. When on, describe what the
  // flywheel does. When off, describe what the simple SOL launch does.
  const helpText = simpleConfig.flywheelEnabled
    ? 'A flywheel routes a portion of trade fees into a reserve token like XLRT, building accumulation pressure on it. Recommended for most launches.'
    : 'Your token will launch in a single SOL pool with all supply allocated. No flywheel mechanic — simple and standard.';

  // Bootstrap-mode state. Clamp the SOL value defensively to prevent
  // negative or absurd values from a corrupted state from rendering
  // weirdly. The funding estimator does its own validation server-side;
  // this is just for display.
  const bsCustomChecked = simpleConfig.bootstrapMode === 'custom' ? 'checked' : '';
  const bsInputDisabled = simpleConfig.bootstrapMode === 'custom' ? '' : 'disabled';
  const bsSolValue = Math.max(0, Number(simpleConfig.bootstrapSolValue) || 0);

  // Ladder state. Disabled sliders when toggle is off — keeps the visible
  // values but conveys "this isn't doing anything" to the user.
  const ladderChecked = simpleConfig.ladderEnabled ? 'checked' : '';
  const ladderSlidersDisabled = simpleConfig.ladderEnabled ? '' : 'disabled';
  const ladderPercent = Math.max(
    LADDER_MIN_PERCENT,
    Math.min(LADDER_MAX_PERCENT, Number(simpleConfig.ladderPercent) || LADDER_DEFAULT_PERCENT),
  );
  const ladderBandCount = Math.max(
    LADDER_MIN_BANDS,
    Math.min(LADDER_MAX_BANDS, Number(simpleConfig.ladderBandCount) || LADDER_DEFAULT_BANDS),
  );

  body.innerHTML = `
    <div class="simple-config-row">
      <label class="simple-config-toggle">
        <input type="checkbox" id="simpleFlywheelToggle" ${checked}>
        <strong>Use a flywheel</strong>
      </label>
      <a class="is-size-7 ml-2" id="simpleFlywheelLearnMore" href="#" role="button"
         aria-haspopup="dialog" aria-controls="flywheelInfoModal">Learn more</a>
      <div class="select is-small simple-config-dropdown" ${dropdownDisabled}>
        <select id="simpleFlywheelSelect" ${dropdownDisabled}>
          ${options}
        </select>
      </div>
      <div class="simple-config-slider" ${dropdownDisabled}>
        <input type="range" id="simpleFlywheelSlider"
               min="${FLYWHEEL_MIN_PERCENT}" max="${FLYWHEEL_MAX_PERCENT}" step="1"
               value="${sliderValue}" ${dropdownDisabled}>
        <span class="simple-config-slider-value" id="simpleFlywheelSliderValue">${sliderValue}%</span>
      </div>
    </div>
    <p class="simple-config-help-text">${escapeHtml(helpText)}</p>
    <div class="simple-config-row">
      <label class="simple-config-toggle">
        <input type="checkbox" id="simpleSplitToggle" ${splitChecked}>
        <strong>Split the LP</strong>
      </label>
      <div class="simple-config-slider" ${splitSliderDisabled}>
        <input type="range" id="simpleSplitSlider"
               min="${SPLIT_MIN_COUNT}" max="${SPLIT_MAX_COUNT}" step="1"
               value="${splitValue}" ${splitSliderDisabled}>
        <span class="simple-config-slider-value" id="simpleSplitSliderValue">${splitReadoutText}</span>
      </div>
    </div>
    <p class="simple-config-help-text">Splits the SOL pool into multiple positions, each minting its own transferable Fee Key NFT (when Lock liquidity is enabled below) — useful if you want to give away or sell partial fee streams. To split the flywheel pool too, use Customize.</p>
    <div class="simple-config-row">
      <label class="simple-config-toggle">
        <input type="checkbox" id="simpleBootstrapCustomToggle" ${bsCustomChecked}>
        <strong>Add starting liquidity</strong>
      </label>
      <div class="simple-config-slider">
        <input class="input is-small" type="number" min="0" step="0.1"
               id="simpleBootstrapSolInput"
               style="width: 7rem;"
               value="${bsSolValue}" ${bsInputDisabled}>
        <span class="simple-config-slider-value" id="simpleBootstrapSolUnit">SOL total</span>
      </div>
    </div>
    <p class="simple-config-help-text">By default the bootstrap is a tiny ~$1 position that just makes the pool tradable. Enable this to deposit real starting liquidity across all your pools — the SOL you commit gets split evenly across every pool (SOL pool plus any flywheel pools), and each pool's bootstrap uses a full-range position so the support shows up at every price level. Token-side liquidity carves out of each pool's allocation; you don't need extra tokens.</p>
    <div class="simple-config-row">
      <label class="simple-config-toggle">
        <input type="checkbox" id="simpleLadderToggle" ${ladderChecked}>
        <strong>Ladder positions</strong>
      </label>
      <div class="simple-config-slider" ${ladderSlidersDisabled}>
        <input type="range" id="simpleLadderPercentSlider"
               min="${LADDER_MIN_PERCENT}" max="${LADDER_MAX_PERCENT}" step="5"
               value="${ladderPercent}" ${ladderSlidersDisabled}>
        <span class="simple-config-slider-value" id="simpleLadderPercentValue">${ladderPercent}% supply</span>
      </div>
      <div class="simple-config-slider" ${ladderSlidersDisabled}>
        <input type="range" id="simpleLadderBandsSlider"
               min="${LADDER_MIN_BANDS}" max="${LADDER_MAX_BANDS}" step="1"
               value="${ladderBandCount}" ${ladderSlidersDisabled}>
        <span class="simple-config-slider-value" id="simpleLadderBandsValue">${ladderBandCount} bands</span>
      </div>
    </div>
    <p class="simple-config-help-text">Splits a portion of each pool's supply across discrete log-spaced price bands going up to 1000× launch (with gaps between bands for breakouts). Each band acts as resistance on the way up and support on the way back down. Smooths supply distribution so 90% isn't gobbled up by the time you hit 10× — leaves room for higher-mcap accumulation. The rest of the pool stays in a wide position covering all prices.</p>
    <div class="simple-config-customize-row">
      <button type="button" class="button is-link is-light" id="simpleCustomizeBtn">
        <span class="icon"><i class="fas fa-sliders-h"></i></span>
        <span>Customize pools manually</span>
      </button>
    </div>
  `;

  // Wire up listeners. These elements are recreated on every render,
  // so attaching directly is fine — they're discarded along with the
  // innerHTML on the next render.
  const toggle = body.querySelector('#simpleFlywheelToggle');
  const select = body.querySelector('#simpleFlywheelSelect');
  const slider = body.querySelector('#simpleFlywheelSlider');
  const sliderReadout = body.querySelector('#simpleFlywheelSliderValue');
  const learnMoreLink = body.querySelector('#simpleFlywheelLearnMore');
  const splitToggle = body.querySelector('#simpleSplitToggle');
  const splitSlider = body.querySelector('#simpleSplitSlider');
  const splitReadout = body.querySelector('#simpleSplitSliderValue');
  const bsCustomToggle = body.querySelector('#simpleBootstrapCustomToggle');
  const bsSolInput = body.querySelector('#simpleBootstrapSolInput');
  const ladderToggle = body.querySelector('#simpleLadderToggle');
  const ladderPctSlider = body.querySelector('#simpleLadderPercentSlider');
  const ladderPctReadout = body.querySelector('#simpleLadderPercentValue');
  const ladderBandsSlider = body.querySelector('#simpleLadderBandsSlider');
  const ladderBandsReadout = body.querySelector('#simpleLadderBandsValue');
  const customizeBtn = body.querySelector('#simpleCustomizeBtn');

  // Learn-more link — opens the static flywheel explainer modal. The link
  // sits next to the toggle so the user can discover what flywheels do
  // before deciding to enable one. preventDefault on the click so the
  // href="#" doesn't scroll the page or change the URL hash.
  if (learnMoreLink) {
    learnMoreLink.addEventListener('click', (e) => {
      e.preventDefault();
      openFlywheelInfoModal();
    });
  }

  toggle.addEventListener('change', (e) => {
    simpleConfig.flywheelEnabled = e.target.checked;
    rebuildPoolsFromSimple();
    renderSimpleConfig();
    // No explicit renderPools() — rebuildPoolsFromSimple invokes
    // addPool which already paints the pool list.
  });

  select.addEventListener('change', (e) => {
    simpleConfig.flywheelKey = e.target.value;
    rebuildPoolsFromSimple();
    renderSimpleConfig();
  });

  // Slider has two events:
  //   - `input` fires continuously as the user drags. We update the
  //     readout live so they see the value moving with the thumb, but
  //     don't rebuild pools on every pixel — that would fire a quote
  //     resolution per pixel.
  //   - `change` fires on mouseup / keyboard commit. We rebuild pools
  //     here, once per drag.
  slider.addEventListener('input', (e) => {
    sliderReadout.textContent = `${e.target.value}%`;
  });
  slider.addEventListener('change', (e) => {
    simpleConfig.flywheelPercent = Number(e.target.value);
    rebuildPoolsFromSimple();
    // Don't re-render the simple-config UI on slider change — that
    // would destroy the slider element mid-drag-cycle on some browsers
    // and feels jumpy. The readout is already in sync from the input
    // handler above; pool list (hidden in default mode anyway) is
    // refreshed by addPool calls inside rebuildPoolsFromSimple.
  });

  // Split-LP toggle: enable/disable splitting. State persists so the
  // slider value sticks across uncheck→check cycles. Any change here
  // requires re-rendering the simple-config UI to flip the slider's
  // disabled visual state.
  splitToggle.addEventListener('change', (e) => {
    simpleConfig.splitEnabled = e.target.checked;
    rebuildPoolsFromSimple();
    renderSimpleConfig();
  });

  // Split slider follows the same input/change split as the flywheel
  // slider — live readout on input, pool rebuild on commit.
  splitSlider.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    splitReadout.textContent = `${v} ${v === 1 ? 'position' : 'positions'}`;
  });
  splitSlider.addEventListener('change', (e) => {
    simpleConfig.splitCount = Number(e.target.value);
    rebuildPoolsFromSimple();
  });

  // Bootstrap mode toggle: switch between minimal and custom. State
  // persists across toggle off/on cycles (the SOL value is kept), so a
  // user who accidentally untoggles doesn't lose their entered amount.
  // Re-renders so the SOL input flips between enabled and disabled, and
  // re-runs rebuildPoolsFromSimple so per-pool bootstrapConfig stays in
  // sync (this is what makes the simple→customize transition show the
  // bootstrap state correctly).
  bsCustomToggle.addEventListener('change', (e) => {
    simpleConfig.bootstrapMode = e.target.checked ? 'custom' : 'minimal';
    rebuildPoolsFromSimple();
    renderSimpleConfig();
  });

  // SOL value input. We update on `input` (every keystroke) rather than
  // on `change` so the value is fresh when the user clicks Continue.
  // The estimator will be called against the latest value at submit
  // time — no live re-estimate per keystroke (those are expensive and
  // bursty typing would drown the server). We also re-derive the
  // per-pool bootstrapConfig so a customize-mode switch later sees the
  // current value.
  bsSolInput.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    simpleConfig.bootstrapSolValue = Number.isFinite(v) && v >= 0 ? v : 0;
    rebuildPoolsFromSimple();
  });

  // Ladder toggle: enable/disable the ladder feature. State persists
  // (percent + band count are kept), and the sliders flip between
  // enabled/disabled via re-render. rebuildPoolsFromSimple regenerates
  // each pool's ladderConfig so the bands are populated/cleared.
  ladderToggle.addEventListener('change', (e) => {
    simpleConfig.ladderEnabled = e.target.checked;
    rebuildPoolsFromSimple();
    renderSimpleConfig();
  });

  // Ladder slider handlers update state on each tick and refresh just
  // the readout text — no full re-render needed for the simple UI
  // (rest of it is invariant under these changes). We do rebuild pools
  // so each pool's ladderConfig gets fresh bands sized for the new
  // value, in case the user switches to customize.
  ladderPctSlider.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    simpleConfig.ladderPercent = Number.isFinite(v) ? v : LADDER_DEFAULT_PERCENT;
    ladderPctReadout.textContent = `${simpleConfig.ladderPercent}% supply`;
    rebuildPoolsFromSimple();
  });
  ladderBandsSlider.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    simpleConfig.ladderBandCount = Number.isInteger(v) ? v : LADDER_DEFAULT_BANDS;
    ladderBandsReadout.textContent = `${simpleConfig.ladderBandCount} bands`;
    rebuildPoolsFromSimple();
  });

  customizeBtn.addEventListener('click', () => {
    // Switch into customize mode. Pools stay as they are — user starts
    // tuning from the current state. The Customize button (now hidden)
    // is replaced by a "Use a preset instead" affordance in
    // the customize-mode container that switches back.
    simpleConfig.mode = 'customize';
    applySimpleConfigMode();
  });
}

// ===========================================================================
// Flywheel explainer modal
// ===========================================================================
//
// Static content — no per-instance data, just an explanation of what
// flywheels are and which one the user should pick. Triggered by the
// "Learn more" link next to the flywheel toggle in the simple-config
// block. Modal markup lives in index.html; this just toggles visibility
// and wires up the close handlers.
//
// The close handlers are attached lazily on first open rather than at
// module load. Reason: the <script src="app.js"> tag appears in
// index.html BEFORE the modal markup, so the modal's elements don't
// exist when the script first runs — a top-level attachment would
// silently no-op (document.getElementById returns null). Same pattern
// the token-info modal uses; the dataset.closeHandlersWired flag
// prevents duplicate listeners on repeat opens.

function openFlywheelInfoModal() {
  const modal = document.getElementById('flywheelInfoModal');
  if (!modal) return;

  // Wire up close affordances on first open. Three ways to dismiss:
  // the X in the header, the "Got it" button in the footer, and
  // clicking the background overlay. The dataset flag makes this
  // idempotent across reopens.
  if (!modal.dataset.closeHandlersWired) {
    const close = () => modal.classList.remove('is-active');
    ['flywheelInfoCloseBtn', 'flywheelInfoDismissBtn', 'flywheelInfoBackground']
      .forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('click', close);
      });
    modal.dataset.closeHandlersWired = '1';
  }

  modal.classList.add('is-active');
}

// Apply the current simpleConfig.mode to the page: hides one container,
// shows the other, and re-renders the appropriate side. Called once on
// page init and on every mode change. Uses the existing .hidden class
// so the visibility toggle is purely CSS, no display-juggling needed.
function applySimpleConfigMode() {
  const simpleC = document.getElementById('simpleConfigContainer');
  const customC = document.getElementById('customizeConfigContainer');
  if (!simpleC || !customC) return;

  if (simpleConfig.mode === 'default') {
    simpleC.classList.remove('hidden');
    customC.classList.add('hidden');
    renderSimpleConfig();
  } else {
    simpleC.classList.add('hidden');
    customC.classList.remove('hidden');
    renderPools();
  }
}

// ---------------------------------------------------------------------------
// Live token preview card
// ---------------------------------------------------------------------------
//
// Mirrors the per-pool resolved-info card shape. Updates on every input
// event from the token-details fields so the user sees their token
// take shape as they type.
//
// We hold a single object URL for the user-selected logo. Each new file
// selection revokes the previous URL before creating a new one — keeps
// memory tidy and avoids leaking blob handles. Revoking is also done
// when the file is cleared (length 0) and on logo-not-set fallback.
let _tokenPreviewLogoObjectUrl = null;

function renderTokenPreview() {
  const block = document.getElementById('tokenPreviewBlock');
  if (!block) return;

  // Read all the inputs. parseNumberInput strips commas from the
  // number-formatted ones; trim whitespace from text fields.
  const nameEl = document.getElementById('tokenName');
  const symbolEl = document.getElementById('tokenSymbol');
  const supplyEl = document.getElementById('tokenSupply');
  const mcEl = document.getElementById('targetMarketCap');
  const descEl = document.getElementById('tokenDescription');
  const logoEl = document.getElementById('tokenLogo');

  const name = nameEl ? nameEl.value.trim() : '';
  const symbol = symbolEl ? symbolEl.value.trim() : '';
  const supply = supplyEl ? parseNumberInput(supplyEl) : NaN;
  const mc = mcEl ? parseNumberInput(mcEl) : NaN;
  const description = descEl ? descEl.value.trim() : '';
  const logoFile = logoEl && logoEl.files && logoEl.files[0] ? logoEl.files[0] : null;

  // Manage the object URL lifecycle. Revoke any prior URL whenever we
  // replace or clear it. createObjectURL returns a new URL each call
  // so we must store the last one to know what to revoke.
  let logoUrl = null;
  if (logoFile) {
    if (_tokenPreviewLogoObjectUrl) URL.revokeObjectURL(_tokenPreviewLogoObjectUrl);
    logoUrl = URL.createObjectURL(logoFile);
    _tokenPreviewLogoObjectUrl = logoUrl;
  } else if (_tokenPreviewLogoObjectUrl) {
    URL.revokeObjectURL(_tokenPreviewLogoObjectUrl);
    _tokenPreviewLogoObjectUrl = null;
  }

  // Logo: image when uploaded, initial-letter circle as fallback.
  // The fallback letter is always rendered as the parent span's text;
  // the <img> sits on top via CSS (position:absolute + 100% size).
  // When the image loads successfully, it covers the letter. When it
  // fails to decode (corrupt file, mistitled extension), the img
  // takes zero rendered area and the underlying letter shows through.
  // This avoids the inline-onerror-with-user-data pattern entirely.
  const initial = (symbol.charAt(0) || name.charAt(0) || '?').toUpperCase();
  let logoHtml;
  if (logoUrl) {
    logoHtml =
      `<span class="token-preview-logo token-preview-logo-fallback">` +
      `${escapeHtml(initial)}` +
      `<img src="${escapeHtml(logoUrl)}" alt="">` +
      `</span>`;
  } else {
    logoHtml = `<span class="token-preview-logo token-preview-logo-fallback">${escapeHtml(initial)}</span>`;
  }

  // Symbol line. Placeholder italic-grey when empty; keeps the same
  // vertical space so the layout doesn't jump as the user fills in.
  const symbolLine = symbol
    ? `<div class="token-preview-symbol">${escapeHtml(symbol)}</div>`
    : `<div class="token-preview-symbol is-placeholder">Your token preview</div>`;

  // Name line. Only shown when distinct from symbol — same logic the
  // resolved-info card uses for resolved tokens. Empty string kept as
  // empty markup so spacing stays consistent (margin-top on the next
  // line handles separation regardless).
  const nameLine = (name && name !== symbol)
    ? `<div class="token-preview-name">${escapeHtml(name)}</div>`
    : '';

  // Tech line: supply and market cap. Both formatted with locale
  // commas. Hidden when both are missing/zero (avoids "0 supply ·
  // $0 mcap" looking authoritative when the user hasn't set values).
  let techLine = '';
  const supplyValid = Number.isFinite(supply) && supply > 0;
  const mcValid = Number.isFinite(mc) && mc > 0;
  if (supplyValid || mcValid) {
    const parts = [];
    if (supplyValid) parts.push(`${supply.toLocaleString()} supply`);
    if (mcValid) parts.push(`$${mc.toLocaleString()} mcap`);
    techLine = `<div class="token-preview-tech">${parts.join(' · ')}</div>`;
  }

  // Decimals + starting price line. Decimals is fixed at 9 (Solana
  // native default — the launcher's createMint always uses 9). Start
  // price is computed from mcap/supply when both are known; the
  // formatter handles the wide range of crypto launch prices, from
  // $-figure tokens down to nano-cent memecoins.
  let priceLine = '';
  if (supplyValid && mcValid) {
    const startPrice = mc / supply;
    const priceText = formatPreviewPrice(startPrice);
    if (priceText) {
      priceLine = `<div class="token-preview-tech">9 decimals · start ${priceText}</div>`;
    } else {
      priceLine = `<div class="token-preview-tech">9 decimals</div>`;
    }
  } else {
    // Even before the user sets supply/mcap, the decimal count is
    // worth showing — it's a real fact about the token they're
    // launching, not a derived value.
    priceLine = `<div class="token-preview-tech">9 decimals</div>`;
  }

  // Description line — only when present; truncated to 2 lines via CSS.
  const descLine = description
    ? `<div class="token-preview-desc">${escapeHtml(description)}</div>`
    : '';

  block.innerHTML =
    logoHtml +
    `<div class="token-preview-stack">` +
      symbolLine +
      nameLine +
      techLine +
      priceLine +
      descLine +
    `</div>`;

  // Also paint the small standalone logo thumbnail that sits next to
  // the file-picker. Same pattern as the preview card's logo: the
  // initial letter is the parent's text content, and the img — when
  // a file is selected — sits on top via CSS. Failure to decode the
  // image reveals the letter underneath. We always set both classes
  // so the grey fallback background is the baseline; with an image
  // loaded successfully, the img covers it.
  const thumb = document.getElementById('tokenLogoThumb');
  if (thumb) {
    if (logoUrl) {
      thumb.innerHTML =
        `${escapeHtml(initial)}` +
        `<img src="${escapeHtml(logoUrl)}" alt="">`;
    } else {
      thumb.innerHTML = escapeHtml(initial);
    }
  }
}

// Format a per-token USD price for the live preview. Crypto launches
// span a huge range (from $1+ "blue chip" launches to nano-cent
// memecoins) so a single fixed-decimals format doesn't cut it. We use
// a tiered approach plus parseFloat to strip any trailing zeros that
// toFixed leaves behind:
//   ≥ $1            → 2 decimals with locale commas ($1,234.56)
//   $0.01–$1        → up to 4 significant decimals ($0.5, $0.0123)
//   $0.000001–$0.01 → up to 8 significant decimals ($0.0001, $0.00012345)
//   anything tinier → scientific notation ($1.23e-10)
// Returns null for invalid/zero/negative inputs so the caller can fall
// back to a "decimals only" line.
function formatPreviewPrice(p) {
  if (!Number.isFinite(p) || p <= 0) return null;
  if (p >= 1) {
    return '$' + p.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
  if (p >= 0.01) {
    return '$' + parseFloat(p.toFixed(4)).toString();
  }
  if (p >= 0.000001) {
    return '$' + parseFloat(p.toFixed(8)).toString();
  }
  return '$' + p.toExponential(2);
}

function renderPools() {
  // Auto-expand any pool that needs attention before painting. Without
  // this, errors that develop mid-flow (resolution fails, allocation
  // gets bumped to 0%, slices stop summing to 100%) would be hidden
  // inside a collapsed card. The user can still manually re-collapse
  // a pool after fixing it; we only force-open here, never force-close.
  for (const pool of pools) {
    if (poolNeedsAttention(pool)) pool._isExpanded = true;
  }
  poolList.innerHTML = '';
  pools.forEach((pool, idx) => {
    poolList.appendChild(buildPoolNode(pool, idx));
  });
  updateAllocationSummary();
  updateContinueToFundingState();
}

// ---------------------------------------------------------------------------
// Pool-rendering helpers
// ---------------------------------------------------------------------------

// Build the inner HTML of a pool's title, e.g. "Pool 1 · SOL · 90% of supply".
//
// The title carries enough info to scan a stack of pools without opening
// any of them: quote-token symbol (resolved if available, falling back to
// the user's input or a truncated mint address), and the supply allocation.
//
// When the pool has a 0% allocation, the title surfaces that inline as a
// warning rather than just sitting on the validation reasons box at the
// bottom of the step. New pools added to a fully-allocated budget land
// here and must catch the user's eye.
// Render the pool's title text (no logo — that's a sibling element in
// the header, painted separately by updatePoolLogo). The title carries
// pool number, symbol, and allocation percent, with the "Pool N" prefix
// dropped when there's only one pool (noise, not signal).
function renderPoolTitle(pool, idx) {
  let label;
  if (pool.resolvedSymbol) {
    label = pool.resolvedSymbol;
  } else if (pool.quoteSymbolOverride) {
    label = pool.quoteSymbolOverride;
  } else if (pool.quoteToken) {
    // Truncate long mint addresses so the title doesn't wrap.
    const t = pool.quoteToken;
    label = t.length > 12 ? `${t.slice(0, 4)}…${t.slice(-4)}` : t;
  } else {
    label = '?';
  }
  const pct = Number(pool.supplyPercent);
  const pctNum = Number.isFinite(pct) ? pct : 0;
  const safeLabel = escapeHtml(String(label));

  // "Pool N" prefix is only useful when there are multiple pools — for
  // a single-pool launch (the most common case) it's noise, since
  // there's nothing to disambiguate against.
  const showPoolNum = pools.length > 1;
  const prefix = showPoolNum
    ? `<span class="has-text-weight-bold">Pool ${idx + 1}</span> &middot; `
    : '';

  if (pctNum === 0) {
    return prefix +
           `<span class="has-text-weight-bold">${safeLabel}</span>` +
           ` &middot; <span class="has-text-warning-dark">0% of supply — set an allocation</span>`;
  }
  return prefix +
         `<span class="has-text-weight-bold">${safeLabel}</span>` +
         ` &middot; <span class="has-text-grey">${pctNum}% of supply</span>`;
}

// Update the small logo element in a pool's header. Separate from
// renderPoolTitle so we can update logo and title independently and
// because the logo is a sibling element in the new header layout, not
// embedded in the title span. Falls back to a coloured initial-style
// circle when no image URL is available — keeps the visual rhythm
// stable rather than leaving an empty space.
function updatePoolLogo(node, pool) {
  const el = node.querySelector('[data-field="poolLogo"]');
  if (!el) return;
  const sym = pool.resolvedSymbol || pool.quoteSymbolOverride || '?';
  const initial = sym.charAt(0).toUpperCase() || '?';
  if (pool.resolvedImageUrl) {
    const safeUrl = escapeHtml(pool.resolvedImageUrl);
    el.innerHTML =
      `<img src="${safeUrl}" alt="" loading="lazy" data-action="pool-logo-fail">`;
    el.dataset.fallbackInitial = initial;
    el.classList.remove('pool-row-logo-fallback');
  } else {
    delete el.dataset.fallbackInitial;
    el.textContent = initial;
    el.classList.add('pool-row-logo-fallback');
  }
}

// Update the small "▸ configure" / "▾ collapse" / "needs attention"
// affordance on the right side of the pool header. Reflects whether
// the pool is currently expanded and whether it needs user attention.
// In the warning case, the affordance becomes a clickable hint so users
// can see at a glance what's pending without opening the pool.
function updatePoolAffordance(node, pool) {
  const el = node.querySelector('[data-field="poolAffordance"]');
  if (!el) return;
  const attention = poolNeedsAttention(pool);
  if (attention) {
    // Showing a warning takes priority — even if expanded, we want the
    // user to know there's something pending. The exact message is
    // already encoded in the pool title via renderPoolTitle()'s 0% case
    // and the resolved-info block's error states; this is just a
    // pointer to draw attention.
    el.className = 'pool-row-affordance pool-row-affordance-warn';
    el.textContent = '⚠ needs attention';
  } else if (pool._isExpanded) {
    el.className = 'pool-row-affordance';
    el.textContent = '▾ collapse';
  } else {
    el.className = 'pool-row-affordance';
    el.textContent = '▸ configure';
  }
}

// Single source of truth for "this pool needs the user to do something
// before they can launch." Used both by the new collapsed-header chrome
// (to show a warning state and label) and by the auto-expansion logic
// (to force a pool open when a collapsed view would hide the problem).
//
// Returns one of:
//   null              — pool is fine, can stay collapsed
//   'unresolved'      — resolution failed (no decimals); user must fix
//                       the address or fill in overrides
//   'price-missing'   — resolution succeeded but no USD price; user
//                       must enter one in overrides
//   'no-allocation'   — supplyPercent is 0; the pool would create with
//                       no liquidity allocation, almost always wrong
//   'slice-mismatch'  — legacy name; replaced by 'positions-mismatch'
//   'positions-mismatch' — bootstrap + slices + ladder bands don't sum
//                          to 100% of pool
//
// This intentionally doesn't account for "the user has opened the
// override section but not filled in all values" — that's a finer-
// grained validation handled by updateContinueToFundingState().
function poolNeedsAttention(pool) {
  if (!pool) return null;
  if (Number(pool.supplyPercent) === 0) return 'no-allocation';
  if (pool.resolvedSymbol && pool.resolvedDecimals == null) return 'unresolved';
  if (pool.resolvedSymbol &&
      pool.resolvedDecimals != null &&
      pool.resolvedPriceUsd == null &&
      pool.quoteUsdOverride == null) {
    return 'price-missing';
  }
  // Positions total check: under unified semantics, the sum of
  // bootstrap (if custom) + slice sharePercents + ladder band
  // supplyPercents must equal 100% of pool. If not, the pool is
  // misconfigured and we can't safely send it to the backend.
  if (Math.abs(computePoolPositionsTotal(pool) - 100) > 0.01) return 'positions-mismatch';
  return null;
}

// Compute the sum of all position percentages in a pool: bootstrap
// (if custom), all wide slices, and all ladder bands. Each is "% of
// pool" under unified semantics. The total should be 100%.
function computePoolPositionsTotal(pool) {
  const bsPct = (pool.bootstrapConfig && pool.bootstrapConfig.mode === 'custom')
    ? Number(pool.bootstrapConfig.supplyPercent) || 0
    : 0;
  const slicePct = Array.isArray(pool.distribution)
    ? pool.distribution.reduce((s, x) => s + (Number(x.sharePercent) || 0), 0)
    : 0;
  const bandPct = (pool.ladderConfig && pool.ladderConfig.mode === 'manual' && Array.isArray(pool.ladderConfig.bands))
    ? pool.ladderConfig.bands.reduce((s, b) => s + (Number(b.supplyPercent) || 0), 0)
    : 0;
  return bsPct + slicePct + bandPct;
}

// Absorb a delta into the wide-slices bucket to keep positions total
// at 100% after a structural toggle (bs on/off, ladder on/off). When
// delta > 0, slices need to shrink to make room. When delta < 0,
// slices need to grow to absorb. The adjustment lands on the LAST
// slice — simplest and most predictable for the user (they can see
// at a glance what changed). If absorbing fully would push the last
// slice below 0, it clamps at 0 and the user gets a positions-total
// warning to manually rebalance.
//
// Edge case: pool has no slices at all (distribution empty). Then we
// can't rebalance through slices; total just drifts and the warning
// fires. Should never happen in practice since addPool seeds one
// slice, but we guard anyway.
function rebalanceWideSlicesByDelta(pool, delta) {
  if (!Array.isArray(pool.distribution) || pool.distribution.length === 0) return;
  const lastIdx = pool.distribution.length - 1;
  const newVal = Number(pool.distribution[lastIdx].sharePercent || 0) - delta;
  pool.distribution[lastIdx].sharePercent = Math.max(0, Number(newVal.toFixed(4)));
}

// Update one pool's title in place.
//
// Called from every input/state change that affects the displayed title:
// supplyPercent typing, quote-dropdown change, custom-mint typing, and
// the async resolution callback. Touches only the title element so we
// don't lose focus on whatever input the user is currently in.
// Refresh a pool's header chrome in place: title, logo, and the
// affordance hint. All three depend on overlapping fields (symbol,
// allocation, resolution status, expanded state, attention status) so
// it's simpler to update them together than to track which-affects-what.
//
// Called from every input/state change that affects the displayed
// header: supplyPercent typing, quote-dropdown change, custom-mint
// typing, and the async resolution callback. Touches only header
// elements so we don't lose focus on whatever input the user is
// currently in.
//
// (Function still named updatePoolTitle for backward compatibility with
// existing call sites — its scope grew but the name stuck.)
function updatePoolTitle(poolIdx) {
  const pool = pools[poolIdx];
  if (!pool) return;
  const node = poolList.children[poolIdx];
  if (!node) return;
  const titleEl = node.querySelector('[data-field="poolTitle"]');
  if (titleEl) titleEl.innerHTML = renderPoolTitle(pool, poolIdx);
  updatePoolLogo(node, pool);
  updatePoolAffordance(node, pool);
}

// Apply visibility rules for the per-pool override section ("manual quote
// token info"). Auto-shown when:
//   - resolution came back but with missing fields (the user has to fill
//     them in to continue), or
//   - the user already has any override value typed in (so editing stays
//     accessible without forcing them to find a toggle), or
//   - the user has explicitly opened the section via the toggle link
//     (`_overrideForceOpen`).
//
// Otherwise the section is hidden behind a small "Override resolved
// values" link — the override path stays available for power users but
// doesn't clutter the default view when resolution succeeded.
function applyOverrideVisibility(node, pool) {
  const toggle = node.querySelector('[data-action="toggle-override"]');
  const section = node.querySelector('[data-field="overrideSection"]');
  if (!toggle || !section) return;

  const hasUserOverride =
    !!pool.quoteSymbolOverride ||
    pool.quoteDecimalsOverride != null ||
    pool.quoteUsdOverride != null;
  const resolutionIncomplete =
    !!pool.resolvedSymbol &&
    (pool.resolvedDecimals == null || pool.resolvedPriceUsd == null);
  // Resolution is "fully complete" when we have all three pieces of
  // info (symbol + decimals + price) from the indexer. In that state
  // there's nothing for the user to override, so the toggle button is
  // pure clutter — hide it entirely. The button comes back the moment
  // anything's missing, or the moment the user types an override.
  const resolutionComplete =
    !!pool.resolvedSymbol &&
    pool.resolvedDecimals != null &&
    pool.resolvedPriceUsd != null;

  const shouldShow = resolutionIncomplete || hasUserOverride || pool._overrideForceOpen === true;

  if (shouldShow) {
    section.classList.remove('hidden');
    toggle.classList.remove('hidden');
    toggle.textContent = '▾ Hide override fields';
  } else {
    section.classList.add('hidden');
    // Hide the toggle too when there's nothing to fix. Keeping it
    // visible was making the resolved-info card look cluttered with a
    // button for an action the user almost never needs to take.
    if (resolutionComplete && !hasUserOverride && !pool._overrideForceOpen) {
      toggle.classList.add('hidden');
    } else {
      toggle.classList.remove('hidden');
      toggle.textContent = 'Override resolved values';
    }
  }
}

// Render the resolved-info content as a multi-line block. Layout:
//
//   ┌──────────────────────────────────────────────────┐
//   │ [logo]   WETH                          ⓘ details │
//   │          Wrapped Ether (Wormhole)                │
//   │          8 decimals · $2,286.35                  │
//   └──────────────────────────────────────────────────┘
//
// Three render states match the original logic exactly:
//   - decimals missing: "Couldn't resolve" red message (hard stop, no
//     logo since there's nothing to show in the modal anyway).
//   - price missing: same layout but with a red "no USD price" line
//     in place of the price (recoverable via override fields).
//   - everything resolved: the full layout above.
//
// Used both from the initial buildPoolNode render and from the in-place
// updateQuoteResolvedDisplay() that runs after async resolution returns,
// to keep both rendering paths consistent.
function renderResolvedInfoHtml(pool) {
  // Resolution-failure case: show a clear error with a retry button.
  // This is distinct from "haven't resolved yet" (pool.resolvedSymbol
  // is null because the resolve call hasn't returned) and from "couldn't
  // read from chain" (pool.resolvedDecimals is null). pool.resolvedFailed
  // is the marker set by resolvePoolQuote when the fetch itself threw —
  // typically a network/server issue where a retry is appropriate.
  if (pool.resolvedFailed) {
    const err = escapeHtml(pool.resolvedFailedError || 'unknown error');
    return (
      `<div class="has-text-danger is-size-7">` +
      `<i class="fas fa-exclamation-circle"></i> ` +
      `Couldn't fetch quote-token info (${err}). ` +
      `<a data-action="retry-resolve" class="has-text-weight-bold">Retry</a>` +
      `</div>`
    );
  }
  if (!pool.resolvedSymbol) return '';

  const safeSym = escapeHtml(pool.resolvedSymbol);

  // Hard-stop case: on-chain read failed entirely. Single-line error,
  // no logo / name / icon. Returns flat text since the parent block
  // is a flex container — single-child works fine.
  if (pool.resolvedDecimals == null) {
    return `<div class="has-text-danger">Couldn't resolve ${safeSym} on-chain — check the address and your RPC.</div>`;
  }

  // Logo (36px circle, left column). Falls back to an initial-letter
  // circle when the image fails to load. Implemented with a structural
  // sibling fallback (the initial-letter is always in the DOM, hidden
  // behind the img) rather than an inline image-error handler with
  // interpolated content. The old approach worked but mixed HTML/JS
  // contexts in a way that's hard to audit for injection — better to
  // build it with regular HTML and CSS.
  const initial = escapeHtml((pool.resolvedSymbol.charAt(0) || '?').toUpperCase());
  let logoHtml;
  if (pool.resolvedImageUrl) {
    const safeUrl = escapeHtml(pool.resolvedImageUrl);
    // The img sits on top of the fallback span. If the img's load fails,
    // the data-action="logo-fail" listener (set up below) hides the img
    // and reveals the fallback. The initial-letter is already in the
    // markup, so the fallback content can't be injection-influenced.
    logoHtml =
      `<span class="resolved-logo resolved-logo-with-image">` +
      `<span class="resolved-logo-initial">${initial}</span>` +
      `<img src="${safeUrl}" alt="" loading="lazy" data-action="logo-fail">` +
      `</span>`;
  } else {
    logoHtml = `<span class="resolved-logo resolved-logo-fallback">${initial}</span>`;
  }

  // Name line — only shown when distinct from symbol. For a token like
  // SOL with name "Solana" we render both; for a token whose metadata
  // has identical name/symbol, we skip the line entirely.
  let nameLine = '';
  if (pool.resolvedName && pool.resolvedName !== pool.resolvedSymbol) {
    nameLine = `<div class="resolved-info-name">${escapeHtml(pool.resolvedName)}</div>`;
  }

  // Technicals line: decimals + price, OR decimals + the no-price hint.
  let techLine;
  if (pool.resolvedPriceUsd) {
    const priceTxt = `$${Number(pool.resolvedPriceUsd).toLocaleString(
      undefined,
      { maximumFractionDigits: 6 },
    )}`;
    techLine = `<div class="resolved-info-tech">${pool.resolvedDecimals} decimals · ${priceTxt}</div>`;
  } else {
    // Symbol+decimals came back from on-chain reads but neither
    // GeckoTerminal nor Jupiter could give us a USD price. Common for
    // very-low-volume tokens, including the flywheel tokens this app
    // is designed around. Tell the user clearly and point them at the
    // override fields below — applyOverrideVisibility() auto-shows
    // them when the price is missing, so the user doesn't need to
    // hunt for a toggle.
    techLine =
      `<div class="resolved-info-tech">${pool.resolvedDecimals} decimals · ` +
      `<span class="has-text-danger">no USD price — set one in the override fields below</span></div>`;
  }

  // Info icon — opens the token info modal on click. Wired via delegated
  // event handling on the pool node so this helper just emits HTML.
  const infoIcon =
    `<a class="resolved-info-icon" data-action="show-token-info" title="Token info">` +
    `<i class="fas fa-info-circle"></i> details</a>`;

  // Raydium CLMM compatibility line. We surface three states:
  //   - hard incompatible: red text, names the disallowed extensions.
  //     updateContinueToFundingState also blocks "Continue" in this case.
  //   - unknown (compatible === null): yellow note ("couldn't verify").
  //     Continue is not blocked; user can override via Advanced settings
  //     or fix RPC and retry.
  //   - compatible: nothing (silent), OR a small "Token-2022" pill when
  //     the user is dealing with a Token-2022 mint, so they know the
  //     pool will involve transfer fees / extension semantics.
  let compatLine = '';
  if (pool.resolvedCompatible === false) {
    const exts = (pool.resolvedDisallowedNames || []).join(', ');
    compatLine =
      `<div class="resolved-info-tech has-text-danger">` +
        `<i class="fas fa-exclamation-triangle"></i> ` +
        `Not compatible with Raydium CLMM — ` +
        `unsupported Token-2022 extension${exts.split(',').length === 1 ? '' : 's'}: ` +
        `${escapeHtml(exts)}` +
      `</div>`;
  } else if (pool.resolvedCompatible === null) {
    compatLine =
      `<div class="resolved-info-tech has-text-warning-dark">` +
        `<i class="fas fa-question-circle"></i> ` +
        `Couldn't verify Raydium compatibility ` +
        `(${escapeHtml(pool.resolvedCompatError || 'RPC error')})` +
      `</div>`;
  } else if (pool.resolvedIsToken2022) {
    // Compatible Token-2022. Quiet informational marker so the user
    // knows this isn't a vanilla SPL token — relevant for understanding
    // transfer fee behavior, metadata via on-chain extensions, etc.
    compatLine =
      `<div class="resolved-info-tech has-text-info">` +
        `<i class="fas fa-shield-alt"></i> ` +
        `Token-2022 (compatible)` +
      `</div>`;
  }

  return `${logoHtml}` +
         `<div class="resolved-info-stack">` +
         `<div class="resolved-info-top">` +
           `<span class="resolved-info-symbol">${safeSym}</span>` +
           infoIcon +
         `</div>` +
         nameLine +
         techLine +
         compatLine +
         `</div>`;
}

// Populate and show the token info modal for a given pool. The modal
// markup lives in index.html alongside the other modals; this just
// fills in its slots and flips the .is-active class to show it.
//
// Re-uses the same pattern as confirmDialog/cancelConfirmModal — no new
// modal infrastructure. External links are constructed from the resolved
// mint, which is the canonical address for any of the explorers.
function showTokenInfoModal(pool) {
  const modal = document.getElementById('tokenInfoModal');
  if (!modal) return;
  const body = document.getElementById('tokenInfoBody');
  if (!body) return;
  const mint = pool.resolvedMint || pool.quoteToken || '';
  const symbol = pool.resolvedSymbol || pool.quoteSymbolOverride || '?';
  const name = pool.resolvedName || symbol;
  const decimals = pool.resolvedDecimals ?? pool.quoteDecimalsOverride ?? '—';
  const priceUsd = pool.resolvedPriceUsd ?? pool.quoteUsdOverride;
  const priceTxt = priceUsd
    ? `$${Number(priceUsd).toLocaleString(undefined, { maximumFractionDigits: 8 })}`
    : '<span class="has-text-grey">unavailable</span>';

  const logoHtml = pool.resolvedImageUrl
    ? `<img src="${escapeHtml(pool.resolvedImageUrl)}" alt="" class="token-info-logo" data-action="token-info-logo-fail">`
    : '';

  const safeMint = escapeHtml(mint);
  // External explorer links. We just need the mint — every explorer
  // uses it as the canonical identifier in the URL path.
  const solscanUrl = `https://solscan.io/token/${encodeURIComponent(mint)}`;
  const geckoUrl = `https://www.geckoterminal.com/solana/tokens/${encodeURIComponent(mint)}`;
  const dexscreenerUrl = `https://dexscreener.com/solana/${encodeURIComponent(mint)}`;

  body.innerHTML = `
    <div class="token-info-header">
      ${logoHtml}
      <div class="token-info-titles">
        <div class="token-info-name">${escapeHtml(name)}</div>
        <div class="token-info-symbol">${escapeHtml(symbol)}</div>
      </div>
    </div>

    <table class="table is-narrow is-fullwidth is-size-7 mt-3 mb-3">
      <tbody>
        <tr>
          <td class="has-text-grey" style="width: 30%;">Mint</td>
          <td>
            <span class="is-family-monospace" style="word-break: break-all;">${safeMint}</span>
            <button class="button is-small is-light ml-2" data-action="copy-mint" title="Copy mint address">
              <span class="icon is-small"><i class="fas fa-copy"></i></span>
            </button>
          </td>
        </tr>
        <tr>
          <td class="has-text-grey">Decimals</td>
          <td>${escapeHtml(String(decimals))}</td>
        </tr>
        <tr>
          <td class="has-text-grey">USD price</td>
          <td>${priceTxt}</td>
        </tr>
      </tbody>
    </table>

    <p class="is-size-7 has-text-grey mb-2">View on:</p>
    <div class="buttons are-small">
      <a class="button is-light" href="${escapeHtml(solscanUrl)}" target="_blank" rel="noopener noreferrer">Solscan</a>
      <a class="button is-light" href="${escapeHtml(geckoUrl)}" target="_blank" rel="noopener noreferrer">GeckoTerminal</a>
      <a class="button is-light" href="${escapeHtml(dexscreenerUrl)}" target="_blank" rel="noopener noreferrer">DexScreener</a>
    </div>
  `;

  body.querySelectorAll('[data-action="token-info-logo-fail"]').forEach((img) => {
    img.addEventListener('error', () => {
      img.remove();
    }, { once: true });
  });

  // Wire up the copy-mint button. Clipboard write is async but we don't
  // need to await — just fire and forget, log on success.
  const copyBtn = body.querySelector('[data-action="copy-mint"]');
  if (copyBtn && mint) {
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(mint);
        log(`Mint address copied: ${mint.slice(0, 8)}…${mint.slice(-6)}`, 'info');
      } catch (e) {
        log(`Couldn't copy mint: ${e.message}`, 'warning');
      }
    });
  }

  // Wire up close handlers — close button, background click, and Esc.
  // We do this on first open rather than at init time because app.js
  // runs synchronously and is loaded before the modal markup later in
  // the body, so the elements don't exist yet when init runs. Guarded
  // with a dataset flag so we don't accumulate duplicate listeners on
  // repeat opens of the modal.
  if (!modal.dataset.closeHandlersWired) {
    const close = () => modal.classList.remove('is-active');
    const closeBtn = document.getElementById('tokenInfoCloseBtn');
    if (closeBtn) closeBtn.addEventListener('click', close);
    const bg = document.getElementById('tokenInfoBackground');
    if (bg) bg.addEventListener('click', close);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && modal.classList.contains('is-active')) close();
    });
    modal.dataset.closeHandlersWired = 'true';
  }

  modal.classList.add('is-active');
}

function buildPoolNode(pool, idx) {
  const node = document.createElement('div');
  node.className = 'pool-row';

  // Delegated click handler for the resolved-info row. Handles both the
  // info-modal icon and the retry-resolve link, since both live inside
  // the resolved-info block and may be re-rendered as state changes.
  // Using delegation on the pool node means we don't need to re-attach
  // these listeners each time the inner HTML rebuilds.
  node.addEventListener('click', (e) => {
    // Info icon → open the details modal.
    if (e.target.closest('[data-action="show-token-info"]')) {
      e.preventDefault();
      showTokenInfoModal(pool);
      return;
    }
    // Retry-resolve link (shown only when a prior resolve attempt failed)
    // → re-run resolvePoolQuote. Clears the failure marker so the UI
    // shows "resolving…" again, then the resolve call either succeeds
    // (clearing resolvedFailed in its success path) or fails again
    // (re-setting it in the catch).
    if (e.target.closest('[data-action="retry-resolve"]')) {
      e.preventDefault();
      // Provisionally clear the failure state so the UI re-paints to a
      // clean "resolving" state. If the retry fails too, resolvePoolQuote
      // re-sets resolvedFailed in its catch block.
      pool.resolvedFailed = false;
      pool.resolvedFailedError = null;
      updateQuoteResolvedDisplay(idx);
      resolvePoolQuote(idx);
      return;
    }
  });

  // Logo image error handler. Uses event capture (third argument true)
  // because the `error` event doesn't bubble through normal DOM
  // propagation — listeners attached to a parent see it only on the
  // capture phase. When the img fails to load (404, CORS, etc), we add
  // .resolved-logo-img-failed to the wrapping span, which CSS uses to
  // hide the img and reveal the initial-letter fallback that's already
  // sitting underneath it. Same delegation pattern as the click handler
  // above: works across renders without re-attaching.
  node.addEventListener('error', (e) => {
    const img = e.target;
    if (!img || img.tagName !== 'IMG') return;
    if (img.dataset.action === 'logo-fail') {
      const wrapper = img.closest('.resolved-logo-with-image');
      if (wrapper) wrapper.classList.add('resolved-logo-img-failed');
      return;
    }
    if (img.dataset.action === 'pool-logo-fail') {
      const wrapper = img.closest('[data-field="poolLogo"]');
      if (!wrapper) return;
      wrapper.textContent = wrapper.dataset.fallbackInitial || '?';
      delete wrapper.dataset.fallbackInitial;
      wrapper.classList.add('pool-row-logo-fallback');
    }
  }, true);

  const header = document.createElement('div');
  header.className = 'pool-row-header';
  // Header is interactive: clicking anywhere except the trash toggles
  // the body's collapsed/expanded state. We attach the toggle to the
  // entire header (not just the left zone) so the affordance hint on
  // the right side ("▸ configure" / "▾ collapse") is also clickable —
  // it looks like a button, so it should act like one. The trash
  // button stops propagation to avoid double-firing.
  header.innerHTML = `
    <div class="pool-row-header-left">
      <span class="pool-row-logo" data-field="poolLogo"></span>
      <span data-field="poolTitle">${renderPoolTitle(pool, idx)}</span>
    </div>
    <div class="pool-row-header-right">
      <span class="pool-row-affordance" data-field="poolAffordance"></span>
      <button class="button is-danger is-small is-light" data-action="remove-pool">
        <span class="icon"><i class="fas fa-trash"></i></span>
      </button>
    </div>
  `;
  header.querySelector('[data-action="remove-pool"]').addEventListener('click', (e) => {
    e.stopPropagation(); // don't also toggle expand
    removePool(idx);
  });
  header.addEventListener('click', () => {
    pool._isExpanded = !pool._isExpanded;
    renderPools();
  });
  node.appendChild(header);

  // Populate the header's logo and affordance text. These depend on
  // resolved data plus the expansion state, so we set them after the
  // header element is in place. Both code paths below (collapsed
  // early-return and the expanded body build) need this — without it,
  // the header's logo span stays empty and the user sees just a blank
  // white circle next to the pool title.
  updatePoolLogo(node, pool);
  updatePoolAffordance(node, pool);

  // Body wrapper. Holds the form grid, resolved-info block, override
  // section, and distribution section. When the pool is collapsed,
  // we simply skip building this entirely — everything inside it is
  // unnecessary DOM. The body is rebuilt fresh on each renderPools()
  // anyway, so there's no state lost by skipping it.
  if (!pool._isExpanded) {
    return node;
  }

  const body = document.createElement('div');
  body.className = 'pool-row-body';
  node.appendChild(body);

  const row1 = document.createElement('div');
  row1.className = 'columns is-mobile is-multiline pool-row-form';
  row1.innerHTML = `
    <div class="column is-half-mobile">
      <label class="label is-small">Quote Token</label>
      <div class="select is-small is-fullwidth">
        <select data-field="quoteSelect">
          <optgroup label="Native">
            <option value="SOL">SOL</option>
          </optgroup>
          <optgroup label="Flywheels">
            <option value="HipYKXiDh3Kjd1jb7ji6jCEsKQMSGWiFJMdtvH8yb5r">$seige (Meme flywheel — recommended)</option>
            <option value="J1bZFRAFC8ALqAN7ktkcCpobgoeTGfP5Xh1BwCP1oqoj">XLRT (Reserve flywheel)</option>
          </optgroup>
          <optgroup label="Majors">
            <option value="3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh">wBTC (Wormhole)</option>
            <option value="7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs">ETH (Wormhole)</option>
          </optgroup>
          <optgroup label="Stables">
            <option value="USDC">USDC</option>
            <option value="USDT">USDT</option>
            <option value="USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB">USD1 (World Liberty Financial)</option>
          </optgroup>
          <optgroup label="Other">
            <option value="__custom">Custom mint…</option>
          </optgroup>
        </select>
      </div>
      <input class="input is-small mt-1 hidden" type="text" data-field="quoteCustom" placeholder="SPL mint address">
    </div>
    <div class="column is-narrow pool-row-allocation">
      <label class="label is-small">Allocation</label>
      <div class="field has-addons">
        <div class="control">
          <input class="input is-small" type="number" min="0" max="100" step="0.01" data-field="supplyPercent" value="${pool.supplyPercent}">
        </div>
        <div class="control"><a class="button is-small is-static">%</a></div>
      </div>
    </div>
    <div class="column">
      <label class="label is-small">Fee Tier</label>
      <div class="select is-small is-fullwidth">
        <select data-field="ammConfig">
          ${feeTiers.map((t) => {
            const pct = (t.tradeFeeRate / 10000).toString();
            const isDefault = t.index === 3;
            const isSelected = pool.ammConfigIndex === t.index;
            return `<option value="${t.index}" ${isSelected ? 'selected' : ''}>${pct}% / spacing ${t.tickSpacing}${isDefault ? ' (default)' : ''}</option>`;
          }).join('')}
        </select>
      </div>
    </div>
  `;
  body.appendChild(row1);

  const quoteSelect = row1.querySelector('[data-field="quoteSelect"]');
  const quoteCustom = row1.querySelector('[data-field="quoteCustom"]');

  // The dropdown contains a mix of uppercase symbols (SOL/USDC/USDT — these
  // are the tokens the server knows about via KNOWN_QUOTES) and raw mint
  // addresses (the curated tokens in Flywheels/Majors/Stables — these go
  // through the GeckoTerminal lookup path on resolve, same as any custom
  // mint). To decide whether the saved pool.quoteToken matches a dropdown
  // option, we collect all option values from the live <select> rather
  // than maintaining a separate hardcoded list.
  const dropdownValues = new Set(
    Array.from(quoteSelect.querySelectorAll('option'))
      .map((o) => o.value)
      .filter((v) => v && v !== '__custom')
  );

  // Match symbols case-insensitively (SOL/USDC/USDT) and mint addresses
  // case-sensitively (base58 is case-sensitive on Solana).
  const isInDropdown = (() => {
    const t = pool.quoteToken || '';
    if (dropdownValues.has(t)) return true;
    const upper = t.toUpperCase();
    if (dropdownValues.has(upper)) return true;
    return false;
  })();

  if (isInDropdown) {
    // Snap to whichever case matches the option (symbols are uppercase in
    // the dropdown; mint addresses are stored as-is).
    quoteSelect.value = dropdownValues.has(pool.quoteToken)
      ? pool.quoteToken
      : pool.quoteToken.toUpperCase();
    quoteCustom.classList.add('hidden');
  } else {
    quoteSelect.value = '__custom';
    quoteCustom.classList.remove('hidden');
    quoteCustom.value = pool.quoteToken;
  }

  // Initial resolved-info content is populated when resolvedBlock is
  // constructed below (via renderResolvedInfoHtml). No need to set it
  // here.

  // Clear every resolved-state field on the pool. Called whenever the
  // quote-token identity changes (dropdown change OR custom-address
  // change) so stale info from the prior token doesn't bleed through
  // until the new resolution returns.
  //
  // The compat fields (resolvedCompatible, resolvedIsToken2022, etc) are
  // particularly important to reset: if the previous token was flagged
  // incompatible, the red warning would persist on the new token until
  // resolvePoolQuote() returned, AND updateContinueToFundingState() would
  // keep blocking the Continue button on the stale compatible=false. By
  // resetting to compatible=null (unknown), the UI cleanly transitions
  // through "unknown" → "compatible/incompatible" as resolution
  // completes, with no stale-state lockout.
  function clearResolvedFields() {
    pool.resolvedSymbol = null;
    pool.resolvedDecimals = null;
    pool.resolvedPriceUsd = null;
    pool.resolvedMint = null;
    pool.resolvedName = null;
    pool.resolvedImageUrl = null;
    pool.resolvedCompatible = null;
    pool.resolvedIsToken2022 = false;
    pool.resolvedDisallowedNames = [];
    pool.resolvedCompatError = null;
  }

  quoteSelect.addEventListener('change', () => {
    const v = quoteSelect.value;
    if (v === '__custom') {
      quoteCustom.classList.remove('hidden');
      pool.quoteToken = quoteCustom.value || '';
    } else {
      quoteCustom.classList.add('hidden');
      pool.quoteToken = v;
    }
    clearResolvedFields();
    // Refresh the resolved-info block (now empty) and header chrome.
    updateQuoteResolvedDisplay(idx);
    // Also refresh the continue-state immediately — the previous quote
    // may have been blocking via compatible=false; clearing it should
    // unblock the button right away (subject to other pool validations).
    updateContinueToFundingState();
    resolvePoolQuote(idx);
  });
  quoteCustom.addEventListener('change', () => {
    pool.quoteToken = quoteCustom.value;
    clearResolvedFields();
    updateQuoteResolvedDisplay(idx);
    updateContinueToFundingState();
    resolvePoolQuote(idx);
  });

  row1.querySelector('[data-field="supplyPercent"]').addEventListener('input', (e) => {
    pool.supplyPercent = Number(e.target.value);
    // Pool's allocation as % of total supply is one of the inputs to
    // the bootstrap's derived supplyPercent (bs_pct = bs_usd / pool_usd
    // × 100, and pool_usd = targetMc × pool.supplyPercent / 100). If we
    // don't recompute on a pool-size change, positions total drifts and
    // the bootstrap row's hint shows stale numbers.
    recomputePoolBootstrapAndRebalance(pool);
    refreshBootstrapHint(idx);
    refreshWideSliceInputs(idx);
    updateAllocationSummary();
    updatePoolTitle(idx);
    updatePoolPositionsTotal(idx);
    updateContinueToFundingState();
  });

  row1.querySelector('[data-field="ammConfig"]').addEventListener('change', (e) => {
    pool.ammConfigIndex = Number(e.target.value);
  });

  // Resolved-info block. Multi-line layout that gives token info room
  // to breathe instead of cramming logo, name, decimals, and price onto
  // a single overflowing line. Appended after the form grid so it sits
  // between the inputs and the tier-3 action buttons. Filled by
  // renderResolvedInfoHtml() — same renderer used by the in-place
  // updateQuoteResolvedDisplay() so initial paint and post-resolution
  // refresh look identical.
  const resolvedBlock = document.createElement('div');
  resolvedBlock.className = 'resolved-info-block';
  resolvedBlock.dataset.field = 'resolvedBlock';
  resolvedBlock.innerHTML = renderResolvedInfoHtml(pool);
  // Hide the block entirely until resolution returns something — empty
  // grey card looks like a layout bug otherwise.
  if (!pool.resolvedSymbol) resolvedBlock.classList.add('hidden');
  body.appendChild(resolvedBlock);

  // Override section (manual quote token info).
  //
  // Always rendered in the DOM but visibility is controlled by the .hidden
  // class via applyOverrideVisibility() — that lets the async resolution
  // callback toggle visibility without re-rendering anything (and without
  // losing focus on whatever input the user is in). The default is hidden
  // when resolution succeeded fully, auto-shown when something failed or
  // when the user has typed an override.
  //
  // The toggle is a real button now (was a text link); same applies to
  // the distribution-section split toggle below. Tier-3 actions shouldn't
  // look like article hyperlinks.
  const actionRow = document.createElement('div');
  actionRow.className = 'pool-row-actions';
  body.appendChild(actionRow);

  const advToggle = document.createElement('button');
  advToggle.type = 'button';
  advToggle.className = 'button is-small is-light';
  advToggle.dataset.action = 'toggle-override';
  // textContent is set by applyOverrideVisibility() below
  actionRow.appendChild(advToggle);

  const adv = document.createElement('div');
  adv.className = 'advanced-section';
  adv.dataset.field = 'overrideSection';
  adv.innerHTML = `
    <p class="help mb-2">Override the auto-detected info for this quote token. Decimals are read on-chain so they should always be present; symbol comes from Metaplex metadata if available; USD price tries GeckoTerminal then Jupiter. Set anything here to override what the app found, or fill in a price if neither indexer had one.</p>
    <div class="columns is-mobile is-multiline">
      <div class="column">
        <label class="label is-small">Symbol override</label>
        <input class="input is-small" type="text" data-field="symOverride" value="${escapeAttr(pool.quoteSymbolOverride || '')}">
      </div>
      <div class="column">
        <label class="label is-small">Decimals override</label>
        <input class="input is-small" type="number" min="0" max="18" data-field="decOverride" value="${pool.quoteDecimalsOverride ?? ''}">
      </div>
      <div class="column">
        <label class="label is-small">USD price override</label>
        <input class="input is-small" type="number" min="0" step="any" data-field="usdOverride" value="${pool.quoteUsdOverride ?? ''}">
      </div>
    </div>
  `;
  body.appendChild(adv);

  // Set initial visibility + toggle text based on current resolution state.
  applyOverrideVisibility(node, pool);

  advToggle.addEventListener('click', () => {
    // Manual user toggle. Only meaningful when the section would otherwise
    // be hidden (resolution succeeded, no overrides set) — but flipping the
    // flag is harmless when conditions auto-show the section anyway.
    pool._overrideForceOpen = !pool._overrideForceOpen;
    applyOverrideVisibility(node, pool);
  });
  adv.querySelector('[data-field="symOverride"]').addEventListener('change', (e) => {
    pool.quoteSymbolOverride = e.target.value.trim() || null;
    updatePoolTitle(idx);
  });
  adv.querySelector('[data-field="decOverride"]').addEventListener('change', (e) => {
    const v = e.target.value;
    pool.quoteDecimalsOverride = v === '' ? null : Number(v);
    // Override may resolve a "price-missing" attention state; refresh
    // the header's title + affordance accordingly.
    updatePoolTitle(idx);
    updateContinueToFundingState();
  });
  adv.querySelector('[data-field="usdOverride"]').addEventListener('change', (e) => {
    const v = e.target.value;
    pool.quoteUsdOverride = v === '' ? null : Number(v);
    // Same — typing a USD override clears the price-missing warning.
    updatePoolTitle(idx);
    updateContinueToFundingState();
  });

  // Distribution section. Under the unified-positions model, slices
  // are first-class wide LP positions sharing the pool's allocation
  // alongside bootstrap and ladder bands. We always show the slice
  // row(s) — even when there's just one — so the user can see how
  // much of the pool is going to the main LP. Hiding this behind a
  // collapsed "Split fee distribution" button was confusing because
  // the user had no way to see the main LP's % allocation without
  // first expanding.
  //
  // The single-slice case is the common one and that single row
  // serves as "the main LP position." If the user wants to split fee
  // ownership across multiple wallets, they click "Add slice" and
  // the existing slice splits in half. Multiple slices = multiple
  // positions at the same wide range, each with its own Fee Key NFT.
  const distSection = document.createElement('div');
  distSection.className = 'distribution-section';
  body.appendChild(distSection);

  // Header. Text is gentler in the single-slice case (where "slice"
  // doesn't really describe anything — it's just the main LP) vs the
  // multi-slice case (where the split-into-pieces framing is accurate).
  const isSingleSlice = pool.distribution.length <= 1;
  const expandedHeader = document.createElement('div');
  expandedHeader.className = 'distribution-expanded-header';
  expandedHeader.innerHTML = isSingleSlice
    ? `<label class="label is-small mb-0">Main LP position <span class="has-text-grey has-text-weight-normal is-size-7">— wide position above launch; "Add slice" splits fee ownership across recipients</span></label>`
    : `<label class="label is-small mb-0">Main LP positions <span class="has-text-grey has-text-weight-normal is-size-7">— each is a wide position above launch with its own Fee Key</span></label>`;
  distSection.appendChild(expandedHeader);

  const sliceContainer = document.createElement('div');
  sliceContainer.className = 'distribution-slices';
  distSection.appendChild(sliceContainer);

  pool.distribution.forEach((slice, sliceIdx) => {
    sliceContainer.appendChild(buildSliceNode(pool, idx, slice, sliceIdx));
  });

  const addSliceBtn = document.createElement('button');
  addSliceBtn.className = 'button is-light is-small mt-1';
  addSliceBtn.innerHTML = '<span class="icon"><i class="fas fa-plus"></i></span><span>Add slice</span>';
  addSliceBtn.addEventListener('click', () => addSlice(idx));
  distSection.appendChild(addSliceBtn);

  // Bootstrap section: lets the user opt this pool in to custom-mode
  // bootstrap (a meaningful starting-liquidity position at launch).
  // Rendered as a slice-style row matching the rest of the position UI.
  body.appendChild(buildBootstrapNode(pool, idx));

  // Ladder section: lets the user view, add, edit, or remove individual
  // ladder bands. Each band has supplyPercent (of pool), lowerMultiplier,
  // and upperMultiplier (relative to launch price). Bands are independent
  // — they can be overlapping or have gaps, and the order doesn't matter
  // to the backend math.
  body.appendChild(buildLadderNode(pool, idx));

  // Positions total indicator. Under unified semantics, bootstrap
  // (if custom) + sum(slice sharePercents) + sum(band supplyPercents)
  // must equal 100% of the pool's allocation. Rendered as a paragraph
  // at the bottom of the pool body with a stable data-attribute so
  // updatePoolPositionsTotal() can find and update it in place.
  const positionsTotal = document.createElement('p');
  positionsTotal.className = 'has-text-weight-semibold mt-3';
  positionsTotal.dataset.positionsTotal = '';
  body.appendChild(positionsTotal);

  // Paint the initial state.
  refreshPoolPositionsTotalNode(positionsTotal, pool);

  return node;
}

// Refresh a positions-total <p> in place with the latest sum and a
// pass/fail visual. Extracted out so both the initial render (above)
// and the in-place update from input handlers (updatePoolPositionsTotal
// below) share the same formatting logic.
function refreshPoolPositionsTotalNode(el, pool) {
  const total = computePoolPositionsTotal(pool);
  const ok = Math.abs(total - 100) <= 0.01;
  el.textContent = `Positions total: ${total.toFixed(2)}% of pool` + (ok ? ' ✓' : ' — must be 100%');
  el.classList.toggle('has-text-success', ok);
  el.classList.toggle('has-text-danger', !ok);
}

// In-place update of the positions-total indicator for one pool.
// Called from every input that changes a position's supply share:
// bootstrap supply input + SOL input, slice-share input, band supply
// input, plus add/remove operations on bands and slices.
//
// We rely on the pool's DOM node being the corresponding index'th
// child of poolList (renderPools paints them in order), and look up
// the indicator inside it via the stable data-attribute selector.
function updatePoolPositionsTotal(poolIdx) {
  const pool = pools[poolIdx];
  if (!pool) return;
  const poolNode = poolList.children[poolIdx];
  if (!poolNode) return;
  const el = poolNode.querySelector('[data-positions-total]');
  if (!el) return;
  refreshPoolPositionsTotalNode(el, pool);
  // The positions-total state also drives the pool's "needs attention"
  // affordance, so refresh that. updatePoolTitle paints the title
  // + affordance together.
  updatePoolTitle(poolIdx);
  updateContinueToFundingState();
}

// Update one pool's bootstrap-hint text in place. Reads the live
// targetMarketCap and the pool's current bs supplyPercent + pool size
// to render "≈ X% of pool · $Y of token supply". Safe to call when
// bootstrap is in minimal mode (clears the hint) or when target mcap
// is missing (clears the hint). Used by every input handler that can
// change inputs to the derivation (the bs SOL input, the pool's
// supplyPercent input) so we keep the hint accurate without a full
// renderPools() that would lose focus.
function refreshBootstrapHint(poolIdx) {
  const pool = pools[poolIdx];
  if (!pool) return;
  const node = poolList.children[poolIdx];
  if (!node) return;
  const hint = node.querySelector('[data-bs-hint]');
  if (!hint) return;
  const isCustom = pool.bootstrapConfig?.mode === 'custom';
  if (!isCustom) { hint.textContent = ''; return; }
  const pct = Number(pool.bootstrapConfig.supplyPercent) || 0;
  const targetMc = parseNumberInput(document.getElementById('targetMarketCap'));
  if (!Number.isFinite(targetMc) || targetMc <= 0 || pct <= 0) {
    hint.textContent = '';
    return;
  }
  const poolUsd = targetMc * (Number(pool.supplyPercent) / 100);
  const bsUsd = (pct / 100) * poolUsd;
  hint.textContent = `≈ ${pct.toFixed(3)}% of pool · $${formatUsdRoughly(bsUsd)} of token supply`;
}

// Refresh wide slice input values in place after a rebalance, without
// touching whichever input the user is currently typing in. Used by
// any handler that calls rebalanceWideSlicesByDelta without doing a
// full renderPools() (typically because the user is mid-keystroke in
// an input we'd destroy on re-render).
function refreshWideSliceInputs(poolIdx) {
  const pool = pools[poolIdx];
  if (!pool) return;
  const node = poolList.children[poolIdx];
  if (!node) return;
  const inputs = node.querySelectorAll('.distribution-slices .slice-share');
  inputs.forEach((inp, i) => {
    if (pool.distribution[i] && document.activeElement !== inp) {
      inp.value = pool.distribution[i].sharePercent;
    }
  });
}

function buildBootstrapNode(pool, poolIdx) {
  // Bootstrap is one of three position types (alongside wide slices
  // and ladder bands). Two states:
  //   minimal — 1-whole-token reserve, no user funds, no slot in 100%
  //   custom  — user-funded position, sized by an absolute SOL value
  //
  // The user thinks in terms of "how much starting liquidity do I want
  // to put down", not "what % of supply." So this row has a single SOL
  // input as the canonical control; the supplyPercent (% of pool) is
  // derived live and shown in the hint. Whenever solValue changes, or
  // target mcap changes, or SOL price resolves, supplyPercent is
  // recomputed and the wide slices auto-rebalance so positions total
  // stays at 100%.
  //
  // Storage: pool.bootstrapConfig = {
  //   mode: 'minimal' | 'custom',
  //   solValue: number   (custom only; user's input)
  //   supplyPercent: number   (custom only; derived from solValue)
  // }
  // The wire format conversion in buildAllocationsForApi uses
  // supplyPercent directly — solValue stays on the UI side.
  const node = document.createElement('div');
  node.className = 'pool-bootstrap-section';

  const cfg = pool.bootstrapConfig || { mode: 'minimal' };
  const isCustom = cfg.mode === 'custom';
  const solValue = Number(cfg.solValue) || 0;

  node.innerHTML = `
    <label class="label is-small mb-1 mt-3">
      <input type="checkbox" data-bs-toggle ${isCustom ? 'checked' : ''}>
      Bootstrap support liquidity
    </label>
    <p class="is-size-7 has-text-grey mb-1">
      Single full-range position centered on launch price.
      Off: a tiny ~$1 reserve that just makes the pool tradable.
      On: a meaningful starting-liquidity position. Token-side carves from this pool's allocation;
      quote-side is funded during the next step.
    </p>
    <div class="slice-row bootstrap-row" ${isCustom ? '' : 'style="opacity:0.5;pointer-events:none;"'}>
      <span class="slice-label">Bootstrap</span>
      <input class="input is-small" type="number" min="0" step="0.001"
             data-bs-sol-value value="${solValue}" ${isCustom ? '' : 'disabled'}
             style="width: 8rem;">
      <span style="line-height:30px;">SOL of starting liquidity</span>
      <span class="is-size-7 has-text-grey-dark" data-bs-hint style="margin-left:0.5rem;line-height:30px;flex:1;"></span>
    </div>
  `;

  const toggle = node.querySelector('[data-bs-toggle]');
  const solInput = node.querySelector('[data-bs-sol-value]');

  // Render the initial hint via the shared helper. Subsequent refreshes
  // also go through the helper so the rendering stays consistent.
  refreshBootstrapHint(poolIdx);

  // Toggle: flip between minimal and custom.
  //   custom default: 0.5 SOL of starting liquidity (matches simple-UI
  //   default). When flipping back to minimal, preserve solValue so
  //   re-toggling restores it without losing user input.
  // After flipping, the bs supplyPercent (derived) changes by the
  // full bs amount; rebalance wide slices accordingly so positions
  // total stays at 100%.
  toggle.addEventListener('change', (e) => {
    const oldPct = (pool.bootstrapConfig && pool.bootstrapConfig.mode === 'custom')
      ? Number(pool.bootstrapConfig.supplyPercent) || 0
      : 0;
    if (e.target.checked) {
      // Restore prior solValue if any; default to 0.5 SOL.
      const restoredSol = Number(pool.bootstrapConfig?.solValue) > 0
        ? Number(pool.bootstrapConfig.solValue) : 0.5;
      const newPct = computeBootstrapSupplyPercent(restoredSol, Number(pool.supplyPercent)) || 0;
      pool.bootstrapConfig = { mode: 'custom', solValue: restoredSol, supplyPercent: newPct };
    } else {
      // Preserve solValue on the object so re-toggle restores it. Wire
      // format ignores solValue/supplyPercent in minimal mode.
      pool.bootstrapConfig = {
        mode: 'minimal',
        solValue: Number(pool.bootstrapConfig?.solValue) || 0,
        supplyPercent: 0,
      };
    }
    const newPct = (pool.bootstrapConfig.mode === 'custom')
      ? Number(pool.bootstrapConfig.supplyPercent) || 0 : 0;
    rebalanceWideSlicesByDelta(pool, newPct - oldPct);
    renderPools();
  });

  // SOL input: canonical value. Compute new supplyPercent and rebalance
  // slices so positions total stays at 100%. We update only the hint
  // text and the positions-total indicator in place — full re-render
  // would lose focus on the input the user is typing in.
  solInput.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    if (!Number.isFinite(v) || v < 0) return;
    const oldPct = Number(pool.bootstrapConfig?.supplyPercent) || 0;
    const newPct = computeBootstrapSupplyPercent(v, Number(pool.supplyPercent)) || 0;
    pool.bootstrapConfig = { mode: 'custom', solValue: v, supplyPercent: newPct };
    rebalanceWideSlicesByDelta(pool, newPct - oldPct);
    refreshBootstrapHint(poolIdx);
    refreshWideSliceInputs(poolIdx);
    updatePoolPositionsTotal(poolIdx);
  });

  return node;
}

function buildLadderNode(pool, poolIdx) {
  // Ladder section. Shows the current bands (if any) and lets the user
  // toggle ladder on/off, add bands, edit individual bands, remove bands,
  // or load a 5-band log-spaced preset.
  const node = document.createElement('div');
  node.className = 'pool-ladder-section box has-background-light p-3 mt-3 mb-0';

  const cfg = pool.ladderConfig || { mode: 'off', bands: [] };
  const enabled = cfg.mode === 'manual';
  const checked = enabled ? 'checked' : '';

  node.innerHTML = `
    <label class="label is-small mb-1">
      <input type="checkbox" data-ladder-toggle ${checked}>
      Ladder positions
    </label>
    <p class="is-size-7 has-text-grey mb-2">
      Discrete single-sided positions at specific price ranges above launch.
      Each band carves out a slice of this pool's allocated supply and provides resistance
      going up / support coming back down. Bands can overlap or have gaps — both are valid.
    </p>
    <div class="ladder-bands-container" ${enabled ? '' : 'style="display:none;"'}>
      <div class="ladder-bands-list" data-ladder-bands></div>
      <div class="ladder-bands-actions" style="margin-top: 0.5rem;">
        <button type="button" class="button is-small is-light" data-ladder-add>
          <span class="icon"><i class="fas fa-plus"></i></span><span>Add band</span>
        </button>
        <button type="button" class="button is-small is-light" data-ladder-preset>
          <span class="icon"><i class="fas fa-magic"></i></span><span>Generate 5-band preset to 1000×</span>
        </button>
      </div>
      <p class="help is-danger mt-1 hidden" data-ladder-warning></p>
    </div>
  `;

  const toggle = node.querySelector('[data-ladder-toggle]');
  const container = node.querySelector('.ladder-bands-container');
  const bandsList = node.querySelector('[data-ladder-bands]');
  const addBtn = node.querySelector('[data-ladder-add]');
  const presetBtn = node.querySelector('[data-ladder-preset]');
  const warning = node.querySelector('[data-ladder-warning]');

  // Render the current band rows. Called from the toggle, the add/remove
  // band handlers, and the preset handler. Editing an individual band
  // updates state in place via the row's own event handlers without
  // re-rendering — same pattern as slice rows.
  function renderBands() {
    bandsList.innerHTML = '';
    const bands = Array.isArray(pool.ladderConfig?.bands) ? pool.ladderConfig.bands : [];
    bands.forEach((band, bandIdx) => {
      bandsList.appendChild(buildBandRow(pool, poolIdx, band, bandIdx, renderBands, updateWarning));
    });
    updateWarning();
  }

  // Validate the band list and surface a warning paragraph when the
  // total supplyPercent exceeds 100% or any band has bad geometry.
  // Backend pre-flight will catch the same conditions, but inline
  // feedback during editing is much friendlier.
  function updateWarning() {
    const bands = Array.isArray(pool.ladderConfig?.bands) ? pool.ladderConfig.bands : [];
    let msg = '';
    const totalPct = bands.reduce((s, b) => s + (Number(b.supplyPercent) || 0), 0);
    if (totalPct > 100) {
      msg = `Band supply totals ${totalPct.toFixed(2)}% — must be ≤ 100%.`;
    } else {
      for (let i = 0; i < bands.length; i++) {
        const b = bands[i];
        const lo = Number(b.lowerMultiplier);
        const hi = Number(b.upperMultiplier);
        if (!(lo >= 1)) {
          msg = `Band ${i + 1}: lower multiplier must be ≥ 1× launch price.`;
          break;
        }
        if (!(hi > lo)) {
          msg = `Band ${i + 1}: upper multiplier must be greater than lower.`;
          break;
        }
        if (!(b.supplyPercent > 0)) {
          msg = `Band ${i + 1}: supply % must be greater than 0.`;
          break;
        }
      }
    }
    if (msg) {
      warning.textContent = msg;
      warning.classList.remove('hidden');
    } else {
      warning.classList.add('hidden');
    }
  }

  toggle.addEventListener('change', (e) => {
    // Compute the ladder total before and after the toggle so we can
    // absorb the delta into the wide slices and keep positions total
    // at 100%. Same rationale as the bootstrap toggle.
    const oldLadderTotal = (pool.ladderConfig && pool.ladderConfig.mode === 'manual' && Array.isArray(pool.ladderConfig.bands))
      ? pool.ladderConfig.bands.reduce((s, b) => s + (Number(b.supplyPercent) || 0), 0)
      : 0;
    if (e.target.checked) {
      // Turning ladder on with no existing bands → seed with the preset.
      // If the user had bands from a previous toggle-on, preserve them.
      const existing = Array.isArray(pool.ladderConfig?.bands)
        ? pool.ladderConfig.bands
        : [];
      pool.ladderConfig = {
        mode: 'manual',
        bands: existing.length > 0 ? existing : generateLogSpacedBands({
          supplyPercent: LADDER_DEFAULT_PERCENT,
          bandCount: LADDER_DEFAULT_BANDS,
          ceilingMultiplier: LADDER_CEILING_MULTIPLIER,
        }),
      };
      container.style.display = '';
    } else {
      // Off: keep the bands on the object for restoration on re-toggle.
      pool.ladderConfig = {
        mode: 'off',
        bands: Array.isArray(pool.ladderConfig?.bands) ? pool.ladderConfig.bands : [],
      };
      container.style.display = 'none';
    }
    const newLadderTotal = (pool.ladderConfig.mode === 'manual' && Array.isArray(pool.ladderConfig.bands))
      ? pool.ladderConfig.bands.reduce((s, b) => s + (Number(b.supplyPercent) || 0), 0)
      : 0;
    rebalanceWideSlicesByDelta(pool, newLadderTotal - oldLadderTotal);
    // Full re-render: the wide slice values changed, the band list
    // toggled visibility, the positions-total needs refresh, and the
    // pool affordance may have flipped between attention/normal.
    renderPools();
  });

  addBtn.addEventListener('click', () => {
    if (!Array.isArray(pool.ladderConfig?.bands)) {
      pool.ladderConfig = { mode: 'manual', bands: [] };
    }
    // New band gets sensible defaults: 5% supply, 1.5× to 2× range.
    // User can edit immediately. The 5% is taken from the wide bucket
    // via rebalance so positions total stays at 100% — without this,
    // adding a band would silently overshoot 100% and the user would
    // see a confusing warning they didn't trigger intentionally.
    const newBand = { supplyPercent: 5, lowerMultiplier: 1.5, upperMultiplier: 2.0 };
    pool.ladderConfig.bands.push(newBand);
    rebalanceWideSlicesByDelta(pool, newBand.supplyPercent);
    renderPools();
  });

  presetBtn.addEventListener('click', () => {
    // Replace current bands with the 5-band log-spaced preset. This is
    // a destructive action but the user explicitly asked for it; a
    // confirmation prompt would be overkill since they can just edit
    // bands afterward if they liked the prior state.
    //
    // Compute the band-total delta and rebalance wide slices so the
    // pool's positions total stays at 100%. The preset is always
    // LADDER_DEFAULT_PERCENT (50%) so most likely the wide bucket
    // shrinks to absorb the increase — unless the user had a heavier
    // ladder configured manually, in which case wide grows.
    const oldTotal = (pool.ladderConfig?.mode === 'manual' && Array.isArray(pool.ladderConfig.bands))
      ? pool.ladderConfig.bands.reduce((s, b) => s + (Number(b.supplyPercent) || 0), 0)
      : 0;
    pool.ladderConfig = {
      mode: 'manual',
      bands: generateLogSpacedBands({
        supplyPercent: LADDER_DEFAULT_PERCENT,
        bandCount: LADDER_DEFAULT_BANDS,
        ceilingMultiplier: LADDER_CEILING_MULTIPLIER,
      }),
    };
    const newTotal = pool.ladderConfig.bands.reduce((s, b) => s + (Number(b.supplyPercent) || 0), 0);
    rebalanceWideSlicesByDelta(pool, newTotal - oldTotal);
    renderPools();
  });

  // Initial paint.
  renderBands();

  return node;
}

// Build a single band-row editor. Each band has three numeric inputs
// (supplyPercent of pool, lowerMultiplier, upperMultiplier) plus a
// remove button. The mcap hint below shows the dollar-value range
// based on the current target market cap input.
//
// Uses the same slice-row CSS class as wide slices and the bootstrap
// row so all positions in the pool look visually consistent.
function buildBandRow(pool, poolIdx, band, bandIdx, rerenderBands, updateWarning) {
  const row = document.createElement('div');
  row.className = 'slice-row band-row';

  row.innerHTML = `
    <span class="slice-label">Band ${bandIdx + 1}</span>
    <input class="input is-small slice-share" type="number" min="0" max="100" step="0.01"
           data-field="supplyPercent" value="${Number(band.supplyPercent)}">
    <span style="line-height:30px;">% of pool</span>
    <span class="is-size-7 has-text-grey" style="line-height:30px;">Range:</span>
    <input class="input is-small" type="number" min="1" step="0.01"
           data-field="lowerMultiplier" value="${Number(band.lowerMultiplier)}" style="width: 5rem;">
    <span class="is-size-7" style="line-height:30px;">× to</span>
    <input class="input is-small" type="number" min="1" step="0.01"
           data-field="upperMultiplier" value="${Number(band.upperMultiplier)}" style="width: 5rem;">
    <span class="is-size-7" style="line-height:30px;">× launch</span>
    <span class="is-size-7 has-text-grey-dark" data-mcap-hint style="line-height:30px;margin-left:0.4rem;flex:1;"></span>
    <button class="button is-danger is-small is-light" data-action="remove-band" title="Remove band">
      <span class="icon is-small"><i class="fas fa-times"></i></span>
    </button>
  `;

  const hint = row.querySelector('[data-mcap-hint]');

  // Refresh the mcap hint based on current targetMarketCap input. Called
  // on initial render and whenever the lower/upper multipliers change.
  function updateMcapHint() {
    const targetMc = parseNumberInput(document.getElementById('targetMarketCap'));
    const lo = Number(band.lowerMultiplier);
    const hi = Number(band.upperMultiplier);
    if (Number.isFinite(targetMc) && targetMc > 0 && lo > 0 && hi > 0) {
      hint.textContent = `≈ $${formatUsdRoughly(lo * targetMc)} – $${formatUsdRoughly(hi * targetMc)} mcap`;
    } else {
      hint.textContent = '';
    }
  }

  // Wire the three numeric inputs. Each updates the band object in
  // place and re-runs the cross-band validation that lights up the
  // warning paragraph below the row list. Also re-runs the pool-level
  // positions-total recompute, since changing a band's % of pool
  // changes what's left for the wide bucket.
  row.querySelector('[data-field="supplyPercent"]').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    if (Number.isFinite(v) && v >= 0) {
      band.supplyPercent = v;
      updateWarning();
      updatePoolPositionsTotal(poolIdx);
    }
  });
  row.querySelector('[data-field="lowerMultiplier"]').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    if (Number.isFinite(v) && v >= 1) {
      band.lowerMultiplier = v;
      updateMcapHint();
      updateWarning();
    }
  });
  row.querySelector('[data-field="upperMultiplier"]').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    if (Number.isFinite(v) && v >= 1) {
      band.upperMultiplier = v;
      updateMcapHint();
      updateWarning();
    }
  });

  row.querySelector('[data-action="remove-band"]').addEventListener('click', () => {
    // Removing a band frees up its share back to the wide bucket so
    // positions total stays at 100%. Same pattern as remove-slice and
    // the bs/ladder toggles.
    const removedShare = Number(pool.ladderConfig.bands[bandIdx].supplyPercent) || 0;
    pool.ladderConfig.bands.splice(bandIdx, 1);
    rebalanceWideSlicesByDelta(pool, -removedShare);
    renderPools();
  });

  // Initial mcap hint.
  updateMcapHint();

  return row;
}

// Format a USD number for compact display: $1.2k, $35k, $1.2M, etc.
// Used by the ladder + bootstrap dollar hints next to multiplier-based
// inputs, so user can see the absolute mcap each input maps to.
function formatUsdRoughly(value) {
  if (!Number.isFinite(value) || value <= 0) return '0';
  if (value < 1000) return value.toFixed(0);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10000 ? 1 : 0)}k`;
  if (value < 1_000_000_000) return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)}M`;
  return `${(value / 1_000_000_000).toFixed(1)}B`;
}

function buildSliceNode(pool, poolIdx, slice, sliceIdx) {
  const node = document.createElement('div');
  node.className = 'slice-row';
  // Hide the remove button when this is the only slice — removeSlice
  // short-circuits in that case anyway, and a non-functional X button
  // is more confusing than just not showing it.
  const isOnlySlice = pool.distribution.length === 1;
  // Label is "Slice N/M" only when there's more than one; for a single
  // slice the "Main LP position" header above already provides context
  // and "Slice 1/1" reads oddly.
  const labelText = isOnlySlice ? 'Slice' : `Slice ${sliceIdx + 1}/${pool.distribution.length}`;
  node.innerHTML = `
    <span class="slice-label">${labelText}</span>
    <input class="input is-small slice-share" type="number" min="0" max="100" step="0.01" value="${slice.sharePercent}">
    <span style="line-height:30px;">% of pool</span>
    <label class="checkbox is-small" style="line-height:30px;">
      <input type="checkbox" data-field="useExternal" ${slice.useExternalRecipient ? 'checked' : ''}>
      &nbsp;Send to a different wallet
    </label>
    <input class="input is-small ${slice.useExternalRecipient ? '' : 'hidden'}" type="text" data-field="recipient" placeholder="Recipient address" value="${slice.recipient || ''}" style="flex: 1; min-width: 200px;">
    ${isOnlySlice ? '' : `<button class="button is-danger is-small is-light" data-action="remove-slice"><span class="icon is-small"><i class="fas fa-times"></i></span></button>`}
  `;

  const shareInput = node.querySelector('.slice-share');
  shareInput.addEventListener('input', (e) => {
    slice.sharePercent = Number(e.target.value);
    // Targeted update only — we used to call renderPools() here, which
    // destroyed and recreated *every* input element in *every* pool on
    // every keystroke. The browser would lose focus on the input you were
    // typing in, the cursor would reset, and typing felt broken.
    //
    // Under unified semantics, slice sharePercent is "% of pool" and
    // the constraint is at the pool level (bs + slices + bands = 100%).
    // updatePoolPositionsTotal refreshes the pool-level indicator, the
    // title affordance, and the continue button state in one shot.
    updatePoolPositionsTotal(poolIdx);
  });

  const useExt = node.querySelector('[data-field="useExternal"]');
  const recipientInput = node.querySelector('[data-field="recipient"]');

  useExt.addEventListener('change', (e) => {
    slice.useExternalRecipient = e.target.checked;
    if (e.target.checked) {
      recipientInput.classList.remove('hidden');
    } else {
      recipientInput.classList.add('hidden');
      slice.recipient = null;
      recipientInput.value = '';
    }
    updateContinueToFundingState();
  });
  recipientInput.addEventListener('change', (e) => {
    slice.recipient = e.target.value.trim() || null;
    updateContinueToFundingState();
  });

  // Remove button only rendered when there's more than one slice;
  // guard the lookup so single-slice rows don't throw.
  const removeBtn = node.querySelector('[data-action="remove-slice"]');
  if (removeBtn) {
    removeBtn.addEventListener('click', () => {
      removeSlice(poolIdx, sliceIdx);
    });
  }

  return node;
}

async function resolvePoolQuote(idx) {
  const pool = pools[idx];
  if (!pool.quoteToken) return;
  try {
    const resp = await fetch('/api/quote-token-info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quoteToken: pool.quoteToken }),
    });
    const data = await resp.json();
    if (data.success) {
      pool.resolvedSymbol = data.info.symbol;
      pool.resolvedDecimals = data.info.decimals ?? null;
      pool.resolvedPriceUsd = data.info.priceUsd;
      // Save the resolved on-chain mint too. We need it at token-creation
      // time to seed the keypair search that ensures the launched token
      // sorts as mintA in every pool (which puts the launched token in
      // the *denominator* of the displayed Raydium price, matching user
      // expectations of "launch price up to infinity").
      pool.resolvedMint = data.info.address;
      // Display-only fields. Either may be null if no indexer had the
      // token; the UI handles that by hiding the logo and falling back
      // on the symbol where the name would have appeared.
      pool.resolvedName = data.info.name ?? null;
      pool.resolvedImageUrl = data.info.imageUrl ?? null;
      // Raydium CLMM compatibility info. Server-side we check whether the
      // quote token's mint program + Token-2022 extensions are allowed by
      // Raydium's on-chain `is_supported_mint` rules. The values here:
      //   compatible === true    → safe to use (either classic SPL, or
      //                            Token-2022 with allowlisted extensions,
      //                            or Token-2022 in Raydium's hardcoded
      //                            mint whitelist like PYUSD/AUSD)
      //   compatible === false   → pool creation WILL fail; we warn loudly
      //                            and disable the Continue button
      //   compatible === null    → couldn't check (mint missing on chain,
      //                            RPC down). Treat as unknown — surface
      //                            a note, don't block.
      pool.resolvedCompatible = data.info.compatible;
      pool.resolvedIsToken2022 = !!data.info.isToken2022;
      pool.resolvedDisallowedNames = data.info.disallowedNames || [];
      pool.resolvedCompatError = data.info.compatError || null;
      // Mark resolution as succeeded so the retry hint goes away.
      pool.resolvedFailed = false;
      pool.resolvedFailedError = null;

      // Post-resolution refresh of derived values that depend on the
      // live SOL price. Bootstrap supplyPercent is derived from
      // solValue × solUsd / poolUsd, so a SOL price update changes
      // the % each pool's bootstrap takes — without this refresh,
      // the positions total would drift away from 100% (the classic
      // "99.94% on initial load with default settings" bug). The
      // rebalance helper absorbs the delta into the wide slices.
      //
      // Runs in both simple AND customize mode because in both, the
      // user's intent is the SOL value they typed; the % is derived.
      // The only path we skip is when bootstrap is in minimal mode
      // (no solValue to recompute) — handled inside the helper.
      for (const p of pools) {
        recomputePoolBootstrapAndRebalance(p);
      }
      // Full pool re-render to surface the refreshed values in the
      // bootstrap row hint (%, $ amount). Use renderPools() rather
      // than the per-pool helper because the rebalance may have
      // touched any pool's slice values too.
      renderPools();

      // Targeted update only — we used to call renderPools() here, which
      // would destroy whatever input the user was typing in if the lookup
      // completed mid-keystroke (typically 100–500ms after they changed
      // the quote token). Now we update only the elements that actually
      // depend on resolved info: the per-pool resolved-display paragraph
      // and the continue-button validation state.
      updateQuoteResolvedDisplay(idx);
      updateContinueToFundingState();
    }
  } catch (e) {
    // Resolution failed (network blip, RPC error, server error). Surface
    // this in the resolved-info block with a retry affordance, instead
    // of just logging silently. Without this, the user sees an empty
    // resolved-info area and has no obvious recovery — they'd have to
    // edit the address field and tab away to re-trigger resolution.
    pool.resolvedFailed = true;
    pool.resolvedFailedError = e.message || 'unknown error';
    log(`Couldn't resolve quote info for ${pool.quoteToken}: ${e.message}`, 'warning');
    updateQuoteResolvedDisplay(idx);
    updateContinueToFundingState();
  }
}

function updateAllocationSummary() {
  const total = pools.reduce((s, p) => s + p.supplyPercent, 0);
  document.getElementById('totalAllocPct').textContent = total.toFixed(2);
  document.getElementById('unallocatedPct').textContent = Math.max(0, 100 - total).toFixed(2);
  const note = document.getElementById('allocationSummary');
  note.classList.toggle('is-danger', total > 100);
  note.classList.toggle('is-info', total <= 100);
}

// Update one pool's resolved-quote-info display in place.
//
// Used after resolvePoolQuote() finishes its async lookup and we've
// updated pool.resolvedSymbol / decimals / priceUsd / name / imageUrl.
// Touches only the resolved-info block below the form grid, the pool
// header (which carries logo + title + affordance), and the
// override-section visibility (which depends on whether resolution
// came back complete). Everything else in the pool's DOM (including
// any input the user might be typing in) stays untouched.
//
// Also handles the empty-state case: when no resolution data is
// present (typical right after the user changes the quote-token
// dropdown), the block is hidden entirely so we don't render an
// empty grey card that looks like a layout glitch.
function updateQuoteResolvedDisplay(poolIdx) {
  const pool = pools[poolIdx];
  if (!pool) return;
  const node = poolList.children[poolIdx];
  if (!node) return;
  const block = node.querySelector('[data-field="resolvedBlock"]');
  if (block) {
    if (pool.resolvedSymbol) {
      block.innerHTML = renderResolvedInfoHtml(pool);
      block.classList.remove('hidden');
    } else {
      block.innerHTML = '';
      block.classList.add('hidden');
    }
  }
  // Refresh the title (now shows the resolved symbol and logo) and the
  // override section visibility (auto-shown when resolution came back
  // incomplete). updatePoolTitle covers logo + affordance too.
  updatePoolTitle(poolIdx);
  applyOverrideVisibility(node, pool);
}

function updateContinueToFundingState() {
  const btn = document.getElementById('continueToFundingBtn');
  if (!btn) return;
  const reasons = [];

  if (pools.length === 0) reasons.push('No pools configured');
  const totalAlloc = pools.reduce((s, p) => s + p.supplyPercent, 0);
  if (totalAlloc > 100) reasons.push('Allocations exceed 100%');

  for (const [i, p] of pools.entries()) {
    if (!p.quoteToken) reasons.push(`Pool ${i + 1}: no quote token`);
    if (p.supplyPercent <= 0) reasons.push(`Pool ${i + 1}: 0% allocation`);
    if ((p.quoteToken || '').toUpperCase() === 'SOL' && p.supplyPercent < 1) {
      reasons.push(`Pool ${i + 1}: SOL allocation must be ≥ 1%`);
    }
    // Decimals must be resolved before we can do any launch math. If the
    // mint isn't on-chain or the user's RPC failed, p.resolvedDecimals is
    // null and the Advanced override is the only escape hatch — but if
    // they haven't supplied an override either, we can't continue.
    const hasDecimals = p.resolvedDecimals != null || p.quoteDecimalsOverride != null;
    if (!hasDecimals) {
      reasons.push(`Pool ${i + 1}: couldn't resolve decimals for ${p.resolvedSymbol || p.quoteToken}`);
    }
    const hasPrice = p.resolvedPriceUsd != null || p.quoteUsdOverride != null;
    if (!hasPrice) {
      reasons.push(`Pool ${i + 1}: no USD price for ${p.resolvedSymbol || p.quoteToken}`);
    }
    // Hard-block on known Raydium-CLMM incompatibility. We do NOT block on
    // resolvedCompatible === null (couldn't verify) — that's a soft warning,
    // user might be on a flaky RPC or the mint is new. Only resolvedCompatible
    // === false (we positively read the mint and found unsupported extensions)
    // gets blocked here. The pre-flight on the server side is a belt-and-
    // suspenders catch if this somehow gets bypassed.
    if (p.resolvedCompatible === false) {
      const exts = (p.resolvedDisallowedNames || []).join(', ');
      reasons.push(
        `Pool ${i + 1}: ${p.resolvedSymbol || p.quoteToken} is not Raydium-CLMM ` +
          `compatible (Token-2022 extensions: ${exts})`,
      );
    }
    // Pool-level positions total. Under the unified model, bootstrap
    // (if custom) + sum(slice sharePercents) + sum(band supplyPercents)
    // must equal 100% of pool. Failing this means the user has either
    // over- or under-allocated and the launch can't proceed.
    const positionsTotal = computePoolPositionsTotal(p);
    if (Math.abs(positionsTotal - 100) > 0.01) {
      reasons.push(
        `Pool ${i + 1}: positions total ${positionsTotal.toFixed(2)}% — ` +
          `bootstrap + slices + ladder must sum to 100%`,
      );
    }
    // Per-slice checks. We no longer flag a 0% slice as an error because
    // buildAllocationsForApi filters those out automatically (they
    // contribute nothing to the pool's allocation). A slice with an
    // external recipient configured but no address is still a real
    // mistake — flag it.
    for (const [si, slice] of p.distribution.entries()) {
      if (slice.useExternalRecipient && !slice.recipient) {
        reasons.push(`Pool ${i + 1} slice ${si + 1}: recipient address required`);
      }
    }
  }

  const name = document.getElementById('tokenName')?.value.trim();
  const symbol = document.getElementById('tokenSymbol')?.value.trim();
  const supply = parseNumberInput(document.getElementById('tokenSupply'));
  const mc = parseNumberInput(document.getElementById('targetMarketCap'));
  if (!name) reasons.push('Token name required');
  if (!symbol) reasons.push('Token symbol required');
  if (!supply || supply <= 0) {
    reasons.push('Token supply must be > 0');
  } else if (supply > MAX_TOKEN_SUPPLY) {
    // Sanity cap below the on-chain u64 ceiling — see MAX_TOKEN_SUPPLY
    // definition for rationale. Surface the actual cap in the message so
    // the user can adjust without guessing what an acceptable value is.
    reasons.push(`Token supply must not exceed ${MAX_TOKEN_SUPPLY.toLocaleString()}`);
  }
  if (!mc || mc <= 0) reasons.push('Target market cap must be > 0');

  btn.disabled = reasons.length > 0;
  btn.title = reasons.join('; ');

  // Also surface reasons inline. The empty-state takes the user further than
  // a tooltip-only hint they may not even hover over.
  const reasonBox = document.getElementById('continueReasons');
  if (reasonBox) {
    if (reasons.length === 0) {
      reasonBox.classList.add('hidden');
      reasonBox.innerHTML = '';
    } else {
      reasonBox.classList.remove('hidden');
      // If we're in simple mode and any of the reasons reference a pool,
      // append a hint pointing the user to Customize — that's where the
      // controls to fix pool-level issues (override price, etc.) live.
      // Without this hint, simple-mode users see "Pool 2: no USD price"
      // and have no idea where Pool 2 even is.
      const hasPoolReason = reasons.some((r) => /^Pool \d/.test(r));
      const hint = (simpleConfig.mode === 'default' && hasPoolReason)
        ? '<p class="is-size-7 mt-2 mb-0"><em>Click <strong>Customize pools manually</strong> to access pool-level controls.</em></p>'
        : '';
      reasonBox.innerHTML =
        '<strong>Cannot continue yet:</strong><ul style="margin-top: 0.25rem; margin-bottom: 0;">' +
        reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join('') +
        '</ul>' + hint;
    }
  }

  // Rolling cost preview. Piggybacking on this function's existing role as
  // the central "config changed, recheck" chokepoint means we automatically
  // pick up every config-mutation site without having to thread cost-update
  // calls through 17 separate handlers. The debounce inside
  // requestCostPreviewUpdate() handles per-keystroke firing.
  requestCostPreviewUpdate();
}

// ---------------------------------------------------------------------------
// Step 2 cost preview
// ---------------------------------------------------------------------------
//
// Shows an approximate SOL cost in step 2 so users see the price impact of
// their pool/config choices BEFORE they commit to step 3 funding. Addresses
// the "sticker shock at the funding stage" complaint: users who configured
// without any cost feedback would land at step 3 surprised by how much SOL
// they needed to send.
//
// Approach: call the same /api/estimate-lp-funding endpoint that step 3
// uses, but only display the total SOL (not the full breakdown — that's
// reserved for step 3 to avoid duplicating UI). Debounced 500ms so rapid
// keystrokes don't hammer the endpoint, with a sequence number so an
// in-flight stale response can't overwrite a newer one.
//
// Hidden on steps other than 2 — step 3+ already shows the real estimate,
// and showing the preview would just add confusion.

let _costPreviewDebounceHandle = null;
let _costPreviewRequestSeq = 0;

function setCostPreviewState(state, value) {
  const card = document.getElementById('costPreview');
  if (!card) return;
  const valueEl = document.getElementById('costPreviewValue');
  const labelEl = document.getElementById('costPreviewLabel');
  const hintEl = document.getElementById('costPreviewHint');
  if (!valueEl || !labelEl || !hintEl) return;

  if (state === 'hidden') {
    card.classList.add('hidden');
    return;
  }
  card.classList.remove('hidden');
  if (state === 'loading') {
    labelEl.textContent = 'Estimating cost: ';
    valueEl.textContent = '…';
    hintEl.textContent = '(computing)';
    return;
  }
  if (state === 'ready') {
    labelEl.textContent = 'Estimated cost: ';
    // 3 decimals matches the breakdown in step 3. Use ≈ rather than = so
    // the user reads it as "approximate" — the actual number can shift
    // slightly between this preview and step 3's estimate because the
    // server may pick up fresher SOL/quote-token prices in the interim.
    valueEl.textContent = `≈ ${Number(value).toFixed(3)} SOL`;
    hintEl.textContent = '(approximate; full breakdown shows on next step)';
    return;
  }
  if (state === 'error') {
    labelEl.textContent = '';
    valueEl.textContent = "Couldn't compute preview";
    hintEl.textContent = '(full estimate will run when you click Continue)';
    return;
  }
}

// Decide whether the preview should run at all. We only want it on step 2
// (config stage), and only when pools are configured to a state the
// estimator can actually handle. Trying to estimate an incomplete config
// would either fail server-side (noisy) or return a misleading number
// (worse — gives the user a wrong sense of cost).
function shouldShowCostPreview() {
  if (typeof currentStep === 'number' && currentStep !== 2) return false;
  if (!Array.isArray(pools) || pools.length === 0) return false;
  // Allocations should sum to ~100% — under-allocated pools would
  // estimate a cost for missing liquidity, over-allocated would
  // double-count. A small tolerance handles floating-point fuzz from
  // slider math.
  const total = pools.reduce((s, p) => s + (Number(p.supplyPercent) || 0), 0);
  if (Math.abs(total - 100) > 0.5) return false;
  // Bail if any pool's quote isn't resolved yet. The estimator's
  // bootstrap-cost math needs the quote token's USD price, and an
  // unresolved quote produces a worst-case estimate that scares users
  // unnecessarily.
  for (const p of pools) {
    if (p.resolvedPriceUsd == null && p.quoteUsdOverride == null) {
      const sym = (p.quoteToken || '').toUpperCase();
      const isSol = sym === 'SOL';
      if (!isSol) return false;
    }
  }
  return true;
}

async function runCostPreview() {
  if (!shouldShowCostPreview()) {
    setCostPreviewState('hidden');
    return;
  }
  const seq = ++_costPreviewRequestSeq;
  setCostPreviewState('loading');
  try {
    const allocations = buildAllocationsForApi();
    const targetMc = parseNumberInput(document.getElementById('targetMarketCap'));
    const resp = await fetch('/api/estimate-lp-funding', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ allocations, targetMarketCapUsd: targetMc }),
    });
    // If a newer request started while this one was in flight, drop
    // our result. Without this guard, an out-of-order response could
    // overwrite a fresher one and the user sees the wrong number.
    if (seq !== _costPreviewRequestSeq) return;
    const data = await resp.json();
    if (!data.success || !data.estimate) {
      setCostPreviewState('error');
      return;
    }
    setCostPreviewState('ready', data.estimate.totalSol);
  } catch (e) {
    if (seq !== _costPreviewRequestSeq) return;
    // Don't surface the error message — the user will see a real one
    // when they click Continue. This preview is best-effort.
    setCostPreviewState('error');
  }
}

function requestCostPreviewUpdate() {
  // Hidden on non-step-2 contexts. Cancel any pending fetch and stop
  // here so a freshly-arrived step-2 view sees a clean state.
  if (!shouldShowCostPreview()) {
    if (_costPreviewDebounceHandle) {
      clearTimeout(_costPreviewDebounceHandle);
      _costPreviewDebounceHandle = null;
    }
    setCostPreviewState('hidden');
    return;
  }
  if (_costPreviewDebounceHandle) clearTimeout(_costPreviewDebounceHandle);
  _costPreviewDebounceHandle = setTimeout(runCostPreview, 500);
}

['tokenName', 'tokenSymbol', 'tokenSupply', 'targetMarketCap'].forEach((id) => {
  bind(id, 'input', updateContinueToFundingState);
});

// targetMarketCap also drives the bootstrap supplyPercent math (the
// derived % depends on the pool's USD allocation, which is target mcap
// × pool's supplyPercent). When the user changes it on step 2, recompute
// each pool's bootstrap supplyPercent from its solValue, and rebalance
// the wide slices to absorb the delta so positions total stays at 100%.
//
// Runs in both simple AND customize mode — customize-mode users still
// have solValue as canonical, and a mcap change updates the derived %
// just like for simple-mode users. The recompute helper is a no-op when
// bootstrap is in minimal mode (no solValue to recompute).
bind('targetMarketCap', 'input', () => {
  let anyChange = false;
  for (const p of pools) {
    if (p.bootstrapConfig && p.bootstrapConfig.mode === 'custom') {
      recomputePoolBootstrapAndRebalance(p);
      anyChange = true;
    }
  }
  if (anyChange) {
    // The bootstrap dollar hint, the band mcap hints, and the positions-
    // total indicator all depend on mcap; re-render to refresh them.
    renderPools();
  }
});

// Live token-preview card. The same five fields that drive the
// continue-button state (above) plus description and logo all feed
// renderTokenPreview() so the card on the right updates as the user
// types/selects. Logo uses `change` since file inputs don't fire
// `input`. Multiple listeners on tokenLogo coexist with the existing
// filename-display handler bound earlier.
['tokenName', 'tokenSymbol', 'tokenSupply', 'targetMarketCap', 'tokenDescription'].forEach((id) => {
  bind(id, 'input', renderTokenPreview);
});
bind('tokenLogo', 'change', renderTokenPreview);

// Format the two numeric inputs with thousand-separator commas as the
// user types. The format on every input event preserves the user's
// cursor position. Read sites use parseNumberInput() to strip commas
// before passing the value to Number() or the server.
['tokenSupply', 'targetMarketCap'].forEach((id) => {
  const el = document.getElementById(id);
  if (el) {
    el.addEventListener('input', () => formatNumberInput(el));
    // The HTML default values are pre-formatted, but if a user has
    // browser autofill or any other source pushes a raw number into
    // the input, run the formatter once on focus too. Cheap insurance.
    el.addEventListener('focus', () => formatNumberInput(el));
  }
});

bind('addPoolBtn', 'click', () => {
  // Suggest a useful default quote for the second/third pool: USDC if a
  // SOL pool already exists, otherwise SOL. The supplyPercent default is
  // now computed inside addPool() from the remaining budget. Open
  // expanded since the user is explicitly configuring something.
  const hasSol = pools.some((p) => (p.quoteToken || '').toUpperCase() === 'SOL');
  addPool({ quoteToken: hasSol ? 'USDC' : 'SOL', _isExpanded: true });
});

// Return-to-simple-mode button: switches from customize mode back to
// the simple toggle+dropdown UI. Wipes any pool customizations and
// rebuilds defaults from simpleConfig — but only after confirming
// with the user, since they could lose meaningful customization.
//
// Uses the HTML confirmDialog rather than window.confirm because the
// rest of the codebase does — see the Chromium-on-Windows note in
// the genericConfirmModal markup. Native confirm leaves inputs in
// the page un-clickable until the next focus cycle on some Windows
// builds.
bind('returnToSimpleBtn', 'click', async () => {
  // Detect "meaningful customization" — anything beyond the defaults
  // simpleConfig would produce. If the current pools already match
  // what rebuildPoolsFromSimple would produce, skip the confirm.
  const currentMatchesSimple = poolsMatchSimpleDefaults();
  if (!currentMatchesSimple) {
    const ok = await confirmDialog({
      title: 'Discard custom pool configuration?',
      body: '<p>This will replace your custom pool setup with a preset. Any allocations, fee tier choices, slice splits, or override values you set will be discarded.</p>',
      confirmLabel: 'Use preset',
      danger: true,
    });
    if (!ok) return;
  }
  simpleConfig.mode = 'default';
  rebuildPoolsFromSimple();
  applySimpleConfigMode();
});

// Compare the current pools[] to what rebuildPoolsFromSimple() would
// produce given the current simpleConfig. Used to skip the confirm
// dialog when switching back to simple mode wouldn't actually lose
// anything (e.g. user clicked Customize but didn't change anything).
//
// Compares the things that matter for the lossiness check: pool count,
// quote tokens, allocations, fee tiers, and slice configuration.
// Resolved-info fields and underscored UI-state fields are ignored.
function poolsMatchSimpleDefaults() {
  // Build what the defaults *would* look like by simulating in a
  // throwaway array. We can't just call rebuildPoolsFromSimple()
  // because that has the side effect of mutating pools[].
  //
  // The expected distribution is per-pool: the SOL pool gets the split
  // (when split is enabled) but the flywheel pool always gets a single
  // 100% slice — matching rebuildPoolsFromSimple's behavior. Splitting
  // the flywheel side requires customize mode.
  const splitDist = buildEqualSplitDistribution(
    simpleConfig.splitEnabled ? simpleConfig.splitCount : 1,
  );
  const singleDist = buildEqualSplitDistribution(1);

  let expected;
  if (simpleConfig.flywheelEnabled) {
    const fw = FLYWHEELS[simpleConfig.flywheelKey];
    if (fw && fw.available && fw.mint) {
      // Match rebuildPoolsFromSimple's clamp so the comparison uses the
      // same effective value the rebuild would produce.
      const flywheelPct = Math.max(
        FLYWHEEL_MIN_PERCENT,
        Math.min(FLYWHEEL_MAX_PERCENT, Number(simpleConfig.flywheelPercent) || DEFAULT_FLYWHEEL_PERCENT),
      );
      expected = [
        { quoteToken: 'SOL', supplyPercent: 100 - flywheelPct, distribution: splitDist },
        { quoteToken: fw.mint, supplyPercent: flywheelPct, distribution: singleDist },
      ];
    } else {
      expected = [{ quoteToken: 'SOL', supplyPercent: 100, distribution: splitDist }];
    }
  } else {
    expected = [{ quoteToken: 'SOL', supplyPercent: 100, distribution: splitDist }];
  }

  if (pools.length !== expected.length) return false;
  for (let i = 0; i < pools.length; i++) {
    const p = pools[i];
    const e = expected[i];
    if (p.quoteToken !== e.quoteToken) return false;
    if (Number(p.supplyPercent) !== e.supplyPercent) return false;
    if (p.ammConfigIndex !== 3) return false; // 1% is the simple default
    // Distribution shape match. Compare slice count and each slice's
    // sharePercent within a small tolerance to absorb floating-point
    // drift. recipient/useExternalRecipient must be at defaults too —
    // any user-set recipient is meaningful customization that we don't
    // want to silently lose.
    if (p.distribution.length !== e.distribution.length) return false;
    for (let j = 0; j < p.distribution.length; j++) {
      const ps = p.distribution[j];
      const es = e.distribution[j];
      if (Math.abs(Number(ps.sharePercent) - es.sharePercent) > 0.01) return false;
      if (ps.useExternalRecipient) return false;
      if (ps.recipient) return false;
    }
    // User-typed overrides count as "meaningful customization" — losing
    // a price override the user manually entered (because resolution
    // failed for their token) would be a real regression. Trigger the
    // confirm if any override is set.
    if (p.quoteSymbolOverride) return false;
    if (p.quoteDecimalsOverride != null) return false;
    if (p.quoteUsdOverride != null) return false;

    // Bootstrap and ladder customizations: compare each pool's current
    // config against what deriveBootstrapConfigFromSimple and
    // deriveLadderConfigFromSimple would produce from the current
    // simpleConfig. Any drift means the user changed something in
    // customize mode and would lose it if we silently rebuilt.
    //
    // Both helpers are pure functions of simpleConfig + pool count, so
    // calling them here is safe — no side effects, no state mutation.
    const expectedBs = deriveBootstrapConfigFromSimple(Number(p.supplyPercent), pools.length);
    const actualBs = p.bootstrapConfig || { mode: 'minimal' };
    if (actualBs.mode !== expectedBs.mode) return false;
    if (actualBs.mode === 'custom') {
      // Compare solValue (canonical user intent) rather than supplyPercent
      // (which is derived from solValue + live SOL price + mcap). A
      // supplyPercent mismatch can happen when the user hasn't touched
      // anything but the SOL price refreshed — we don't want that to
      // count as a customization.
      if (Math.abs(Number(actualBs.solValue) - Number(expectedBs.solValue)) > 0.0001) {
        return false;
      }
    }

    const expectedLd = deriveLadderConfigFromSimple();
    const actualLd = p.ladderConfig || { mode: 'off', bands: [] };
    if (actualLd.mode !== expectedLd.mode) return false;
    if (actualLd.mode === 'manual') {
      const actualBands = Array.isArray(actualLd.bands) ? actualLd.bands : [];
      const expectedBands = Array.isArray(expectedLd.bands) ? expectedLd.bands : [];
      if (actualBands.length !== expectedBands.length) return false;
      for (let bi = 0; bi < actualBands.length; bi++) {
        const ab = actualBands[bi];
        const eb = expectedBands[bi];
        if (Math.abs(Number(ab.supplyPercent) - Number(eb.supplyPercent)) > 0.01) return false;
        if (Math.abs(Number(ab.lowerMultiplier) - Number(eb.lowerMultiplier)) > 0.001) return false;
        if (Math.abs(Number(ab.upperMultiplier) - Number(eb.upperMultiplier)) > 0.001) return false;
      }
    }
  }
  return true;
}

bind('continueToFundingBtn', 'click', async () => {
  await withRunState(async () => {
    try {
      const allocations = buildAllocationsForApi();
      const targetMc = parseNumberInput(document.getElementById('targetMarketCap'));
      const resp = await fetch('/api/estimate-lp-funding', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // targetMarketCapUsd is only used by the estimator when a custom-
        // mode bootstrap is present, but we send it unconditionally so the
        // server has it available regardless. All-minimal launches ignore it.
        body: JSON.stringify({ allocations, targetMarketCapUsd: targetMc }),
      });
      const data = await resp.json();
      if (!data.success) throw new Error(data.error);

      fundingRequirement = data.estimate;
      // Track how much of the SOL requirement has been "consumed" by
      // completed auto-swaps. The original solLamports requirement
      // includes budgeted SOL for all auto-swaps; once a swap finishes,
      // that portion is already spent, so we need to subtract its
      // estSolSpend from the effective requirement. Without this, the
      // SOL row stays red after auto-swaps complete (because the wallet
      // balance has gone down by ~$4 per swap) even though the launch
      // can proceed. See decrementSolRequirementForSwap() below.
      fundingRequirement.solCreditedForCompletedSwaps = 0;
      const manualCount = Object.keys(fundingRequirement.byQuote).length;
      const autoCount = (fundingRequirement.autoSwapPlan || []).length;
      const extras = [];
      if (autoCount) extras.push(`${autoCount} auto-swap`);
      if (manualCount) extras.push(`${manualCount} manual`);
      log(
        `Funding estimate: ${fundingRequirement.totalSol.toFixed(3)} SOL` +
        (extras.length ? ` + ${extras.join(', ')} token row${(autoCount + manualCount) === 1 ? '' : 's'}` : ''),
        'info',
      );

      const symbol = document.getElementById('tokenSymbol').value.trim() || 'token';
      const poolCount = pools.length;
      setStepSummary(2, `${symbol}, ${poolCount} pool${poolCount === 1 ? '' : 's'}`);

      renderFundingRequirements();
      activateStep(3);
      startBalancePolling();
    } catch (e) {
      log(`Funding estimation failed: ${e.message}`, 'danger');
    }
  });
});

// Back-to-configuration button on step 3 (Funding). The user has seen the
// SOL requirement and wants to adjust pool config / target mcap / etc.
// before committing funds. We just stop polling and reactivate step 2 —
// all token form values and pool state are still in memory, so the user
// picks up exactly where they left off. When they click Continue to
// Funding again, the estimate is recomputed (with their changes) and
// step 3 re-enters fresh.
//
// Funding deposits that may have already arrived in the wallet are NOT
// touched here — they're refundable through Cancel & Refund if the user
// decides to abandon the launch entirely. For a normal "re-estimate after
// edit" flow, leaving them in place is fine; they count toward the new
// estimate when the user comes back to step 3.
bind('backToConfigBtn', 'click', () => {
  // Don't allow navigation while an operation is running (e.g., an
  // auto-swap is mid-flight). The cancel button has the same guard via
  // updateCancelButtonState; mirror that here so the user can't yank
  // the rug out from under a running operation. Reuses the activity log
  // for user-facing feedback rather than a modal — operations are
  // typically short and the user will get a chance again soon.
  if (isRunningOperation) {
    log('Wait for the running operation to finish before editing the configuration.', 'warning');
    return;
  }
  if (balancePollHandle) {
    clearInterval(balancePollHandle);
    balancePollHandle = null;
  }
  // Clear step 3's summary so it doesn't read "ready" or similar when the
  // user collapses it to look at step 2.
  setStepSummary(3, '');
  // Also clear step 2's summary — the user is about to re-edit, and the
  // old "TOKEN, N pools" line would be misleading mid-edit. activateStep
  // will reset visual states; the summary needs an explicit clear.
  setStepSummary(2, '');
  log('Returned to configuration. Edit and click Continue to Funding when ready.', 'info');
  activateStep(2);
});

// Reset all token/pool state to defaults so the user can start a fresh
// launch. The wallet (tempWallet) is intentionally preserved — that's the
// whole point of "start over with the same wallet." Everything else gets
// wiped: form values, pool config, simpleConfig, created-token info,
// funding state, step summaries, the cancelled-panel itself, and all the
// downstream-step DOM panels that may carry stale display data.
//
// Called by the Start Over affordance on the step-6 cancelled panel.
// Safe to call from a clean cancelled state (wallet empty / refunded);
// not intended for use mid-launch.
//
// Mirrors the per-launch state reset that happens in the generate-wallet
// handler — we want "Start Over with same wallet" to leave the UI in
// the same state as "Generate Wallet" minus the wallet itself.
function resetForNewLaunch() {
  // 1. Defensive: stop any background polling that might still be alive.
  //    The cancel paths normally clear this before showing the cancelled
  //    panel, but a future code path could land here without going
  //    through cancel; better to be idempotent.
  if (balancePollHandle) {
    clearInterval(balancePollHandle);
    balancePollHandle = null;
  }

  // 2. Wipe in-memory launch state.
  createdTokenInfo = null;
  lpResult = null;
  fundingRequirement = { solLamports: 0, byQuote: {}, autoSwapPlan: [] };
  fundingWallet = null;
  lastSolBalance = 0;
  consecutivePollFailures = 0;
  fundingDetectionExhausted = false;
  // Auto-swap interlock — defensive reset. Cancel completion runs under
  // withRunState which would have failed if an auto-swap was mid-flight,
  // so reaching here with this flag set shouldn't be possible. Resetting
  // unconditionally keeps the state machine clean if a future code path
  // arrives here through a different route.
  isAcquireFlowRunning = false;

  // 3. Reset simpleConfig to its initial defaults so the simple-UI shows
  //    the "fresh launch" state. Mirror of the let-initializer at file top.
  simpleConfig = {
    mode: 'default',
    flywheelEnabled: true,
    flywheelKey: 'meme',
    flywheelPercent: DEFAULT_FLYWHEEL_PERCENT,
    splitEnabled: false,
    splitCount: 1,
    bootstrapMode: 'minimal',
    bootstrapSolValue: 1,
    ladderEnabled: false,
    ladderPercent: LADDER_DEFAULT_PERCENT,
    ladderBandCount: LADDER_DEFAULT_BANDS,
  };

  // 4. Reset token form inputs back to their HTML defaults. These hold
  //    whatever the user typed last time; leaving them prefilled with
  //    that data would imply "we'll use this again" when in fact the
  //    user explicitly chose to start over.
  //
  //    We read each input's `defaultValue` rather than hardcoding the
  //    values here. defaultValue is the string from the HTML `value="..."`
  //    attribute — empty for inputs that don't declare one (tokenName,
  //    tokenSymbol, tokenDescription), and the displayed default for the
  //    two that do (tokenSupply = "1,000,000,000", targetMarketCap =
  //    "100,000"). This keeps the reset behaviour in sync with the HTML
  //    automatically: if those defaults are ever changed in index.html,
  //    the reset still does the right thing without needing to update
  //    this list.
  //
  //    Prior version blindly cleared targetMarketCap to '' alongside the
  //    text fields, which produced an empty market-cap field after Start
  //    Over even though a fresh app open shows "100,000" — the bug Moose
  //    flagged. The supply fix is a related tidy-up: prior code set it
  //    to '1000000000' (no commas), which display-mismatches the HTML
  //    default of '1,000,000,000'; the numeric value is identical after
  //    parseNumberInput strips commas, but visually they differ.
  const formIds = [
    'tokenName',
    'tokenSymbol',
    'tokenSupply',
    'targetMarketCap',
    'tokenDescription',
  ];
  for (const id of formIds) {
    const el = document.getElementById(id);
    if (el) el.value = el.defaultValue;
  }
  // Logo: clear both the file input and any preview thumbnail.
  // File inputs always have an empty defaultValue, so we set value=''
  // explicitly to make the intent obvious at the call site rather than
  // relying on the defaultValue happening to be empty.
  const logoEl = document.getElementById('tokenLogo');
  if (logoEl) logoEl.value = '';
  if (_tokenPreviewLogoObjectUrl) {
    URL.revokeObjectURL(_tokenPreviewLogoObjectUrl);
    _tokenPreviewLogoObjectUrl = null;
  }
  const logoThumb = document.getElementById('tokenLogoThumb');
  if (logoThumb) logoThumb.classList.add('hidden');
  // Clear any stale logo validation error from a previous launch. The
  // setLogoError helper handles the hidden-class toggle so the help
  // text doesn't reserve vertical space when there's no message.
  setLogoError(null);

  // 5. Wipe pools and rebuild from the (now reset) simpleConfig defaults.
  //    rebuildPoolsFromSimple wipes pools.length=0 and re-adds the default
  //    SOL+flywheel pool split.
  pools.length = 0;
  rebuildPoolsFromSimple();
  // applySimpleConfigMode flips the visible config panel (simple vs
  // customize) based on simpleConfig.mode and re-runs the appropriate
  // renderer. We need this in case the user was in customize mode before
  // — without it the customize panel would still be visible while
  // simpleConfig says we're in default mode.
  applySimpleConfigMode();

  // 6. Reset step-2-through-6 DOM panels that may carry display state from
  //    the previous attempt. Mirror what the generate-wallet handler does
  //    so Start Over leaves the UI in the same shape as Generate Wallet.
  document.getElementById('tokenCreatedInfo')?.classList.add('hidden');
  document.getElementById('createTokenBtn')?.classList.remove('hidden');
  document.getElementById('createLpBtn')?.classList.remove('hidden');
  document.getElementById('transferAssetsBtn')?.classList.remove('hidden');
  document.getElementById('lpDoneInfo')?.classList.add('hidden');
  document.getElementById('lpFailInfo')?.classList.add('hidden');
  document.getElementById('lpProgress')?.classList.add('hidden');
  const lpTree = document.getElementById('lpProgressTree');
  if (lpTree) lpTree.innerHTML = '';
  document.getElementById('transferResult')?.classList.add('hidden');
  document.getElementById('fundingWalletInfo')?.classList.add('hidden');
  const destWalletEl = document.getElementById('destinationWallet');
  if (destWalletEl) destWalletEl.value = '';
  // Step 6 cancelled panel: restore normal body, hide cancelled.
  document.getElementById('step6NormalBody')?.classList.remove('hidden');
  document.getElementById('step6CancelledPanel')?.classList.add('hidden');

  // 7. Clear step summaries for steps 2-6. Step 1 stays — its summary
  //    shows the wallet abbreviation, which is still accurate.
  for (let i = 2; i <= 6; i++) setStepSummary(i, '');

  // 8. Re-render the live token preview card (now empty since form is
  //    cleared) and recompute the continue-button enabled state.
  renderTokenPreview();
  updateContinueToFundingState();
  updateCancelButtonState();

  // 9. Hand control back to step 2 and log a clear separator so the
  //    activity log makes the boundary obvious.
  log('— Started over. Configure your token and pools, then continue. —', 'info');
  activateStep(2);
}

bind('startOverBtn', 'click', resetForNewLaunch);

// ===========================================================================
// Tokenomics Preview Modal
// ===========================================================================
//
// Opened from "Visualize tokenomics" on step 2. Renders a donut chart of the
// planned token-supply distribution across pools + positions, plus a textual
// breakdown. Reads live pool state (so it reflects whatever the user has
// currently configured, including unsaved customize-mode edits) — no
// snapshot/copy of state is taken; close-and-reopen always shows current.

// Color palette for pool-level grouping. Each pool gets a base hue, and
// position types within that pool are shaded variants (bootstrap = darker,
// slices = base, ladder bands = progressively lighter). Wraps around if
// there are >5 pools (unusual but possible).
const POOL_COLOR_BASES = [
  { name: 'blue',   h: 217, s: 75 },
  { name: 'orange', h: 25,  s: 80 },
  { name: 'green',  h: 145, s: 60 },
  { name: 'purple', h: 280, s: 60 },
  { name: 'teal',   h: 175, s: 60 },
];

// Position-type shades within a pool's hue. Returns an HSL string.
// `kind` is 'bootstrap', 'slice', or 'band'. `variant` is the per-kind
// index (e.g., band 0, band 1, ...) used to vary band brightness so the
// arcs are distinguishable from each other.
function poolPositionColor(poolIdx, kind, variant) {
  const base = POOL_COLOR_BASES[poolIdx % POOL_COLOR_BASES.length];
  let l; // lightness
  if (kind === 'bootstrap') {
    // Dark variant — bootstrap is the conceptual "anchor" of the pool.
    l = 32;
  } else if (kind === 'slice') {
    // Mid variant — the wide main LP.
    l = 50;
  } else {
    // band — progressively lighter for each subsequent band so adjacent
    // arcs read as distinct. Cap at 75 lightness so the colors don't
    // become unreadably pale.
    l = Math.min(75, 58 + (variant || 0) * 4);
  }
  return `hsl(${base.h}, ${base.s}%, ${l}%)`;
}

// Build the flat list of arcs from the live pool state. Each arc has:
//   poolIdx, kind ('bootstrap' | 'slice' | 'band'), variant, label,
//   share (fraction of total token supply, 0..1), color
//
// Iteration order matters: arcs in the same pool stay adjacent in the
// donut, with bootstrap first, slices next, bands last. That ordering
// makes the chart read left-to-right within each pool: anchor →
// distribution → ladder.
function buildTokenomicsArcs() {
  const arcs = [];
  pools.forEach((pool, poolIdx) => {
    const poolFraction = Number(pool.supplyPercent) / 100; // 0..1 of total
    // Bootstrap (% of pool → % of total)
    const bsCfg = pool.bootstrapConfig;
    if (bsCfg && bsCfg.mode === 'custom') {
      const bsPctOfPool = Number(bsCfg.supplyPercent) || 0;
      if (bsPctOfPool > 0) {
        arcs.push({
          poolIdx,
          kind: 'bootstrap',
          variant: 0,
          label: 'Bootstrap',
          share: (bsPctOfPool / 100) * poolFraction,
          color: poolPositionColor(poolIdx, 'bootstrap', 0),
        });
      }
    }
    // Wide slices (% of pool → % of total)
    (pool.distribution || []).forEach((s, i) => {
      const slicePctOfPool = Number(s.sharePercent) || 0;
      if (slicePctOfPool > 0) {
        arcs.push({
          poolIdx,
          kind: 'slice',
          variant: i,
          label: pool.distribution.length === 1
            ? 'Main LP'
            : `Slice ${i + 1}/${pool.distribution.length}`,
          share: (slicePctOfPool / 100) * poolFraction,
          color: poolPositionColor(poolIdx, 'slice', i),
        });
      }
    });
    // Ladder bands (% of pool → % of total)
    const ladder = pool.ladderConfig;
    if (ladder && ladder.mode === 'manual' && Array.isArray(ladder.bands)) {
      ladder.bands.forEach((b, i) => {
        const bandPctOfPool = Number(b.supplyPercent) || 0;
        if (bandPctOfPool > 0) {
          arcs.push({
            poolIdx,
            kind: 'band',
            variant: i,
            label: `Band ${i + 1} (${Number(b.lowerMultiplier).toFixed(2)}×–${Number(b.upperMultiplier).toFixed(2)}×)`,
            share: (bandPctOfPool / 100) * poolFraction,
            color: poolPositionColor(poolIdx, 'band', i),
          });
        }
      });
    }
  });
  return arcs;
}

// Compute the SVG path string for a donut-segment arc spanning [startA, endA]
// radians, with the given outer and inner radii, centered at (cx, cy).
// Handles the angle-wrap and large-arc flag correctly for any arc <2π.
function donutArcPath(cx, cy, rOuter, rInner, startA, endA) {
  // Avoid 0-width arcs producing degenerate paths.
  if (Math.abs(endA - startA) < 1e-6) return '';
  // Use the "large arc" flag when the arc spans more than half a circle.
  const large = (endA - startA) > Math.PI ? 1 : 0;
  // Cartesian conversion. SVG y axis is flipped — but our trig is
  // standard (anti-clockwise from +x), so we negate the sin term to
  // make the chart read clockwise as users expect.
  const x1 = cx + rOuter * Math.cos(startA);
  const y1 = cy + rOuter * Math.sin(startA);
  const x2 = cx + rOuter * Math.cos(endA);
  const y2 = cy + rOuter * Math.sin(endA);
  const x3 = cx + rInner * Math.cos(endA);
  const y3 = cy + rInner * Math.sin(endA);
  const x4 = cx + rInner * Math.cos(startA);
  const y4 = cy + rInner * Math.sin(startA);
  return [
    `M ${x1} ${y1}`,
    `A ${rOuter} ${rOuter} 0 ${large} 1 ${x2} ${y2}`,
    `L ${x3} ${y3}`,
    `A ${rInner} ${rInner} 0 ${large} 0 ${x4} ${y4}`,
    'Z',
  ].join(' ');
}

// Render the donut chart as SVG markup. Arcs share a starting angle of
// -π/2 (12 o'clock) and go clockwise. Returns an SVG string ready to
// drop into innerHTML.
function renderTokenomicsDonutSvg(arcs, { size = 360, logoDataUrl = null } = {}) {
  const cx = size / 2;
  const cy = size / 2;
  const rOuter = size * 0.45;
  const rInner = size * 0.28;

  // Total share covered. Should be ~1 if positions sum to 100% per pool
  // and pool supplyPercents sum to 100% of total supply. Defensive
  // normalization avoids gaps/overshoot if the math drifts.
  const total = arcs.reduce((s, a) => s + a.share, 0);
  if (total <= 0) {
    return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
      <text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="middle"
            fill="#888" font-size="13">No positions configured</text>
    </svg>`;
  }

  let startA = -Math.PI / 2;
  let segments = '';
  for (const arc of arcs) {
    const sweep = (arc.share / total) * (2 * Math.PI);
    const endA = startA + sweep;
    const path = donutArcPath(cx, cy, rOuter, rInner, startA, endA);
    // title element gives hover tooltips in the browser (Electron's
    // Chromium supports them natively).
    const titleText = `${arc.label}: ${(arc.share * 100).toFixed(2)}% of total supply`;
    segments += `<path d="${path}" fill="${arc.color}" stroke="white" stroke-width="1">
      <title>${escapeHtml(titleText)}</title>
    </path>`;
    startA = endA;
  }

  // Center fill: if a logo data URL is available, embed it as a circular
  // image filling the donut hole. Otherwise fall back to the pool-count
  // summary text. This makes the chart strongly identity-anchored when a
  // logo exists — the chart reads as "the supply breakdown of THIS
  // specific token" rather than as a generic distribution diagram.
  //
  // Implementation: we draw a white circle behind the image as a clean
  // backdrop, clip the image to a circle via SVG <clipPath>, and inset
  // the image slightly from the inner radius so there's a small ring of
  // white between the logo edge and the innermost arc — that ring keeps
  // the logo from visually merging into the arcs at the boundary.
  let centerContent;
  if (logoDataUrl) {
    // Inset by 6% of inner radius to leave a clean ring of backdrop.
    // Cap the inset at a sensible minimum so very small charts don't
    // produce zero-pixel inset.
    const inset = Math.max(2, rInner * 0.06);
    const logoR = rInner - inset;
    const logoX = cx - logoR;
    const logoY = cy - logoR;
    const logoSize = logoR * 2;
    // clipPath ID is suffixed with the chart size so multiple charts on
    // one page (the modal AND the report-preview, if ever rendered side
    // by side) don't share a clip definition.
    const clipId = `donut-logo-clip-${size}`;
    centerContent = `
      <defs>
        <clipPath id="${clipId}">
          <circle cx="${cx}" cy="${cy}" r="${logoR}"/>
        </clipPath>
      </defs>
      <circle cx="${cx}" cy="${cy}" r="${rInner}" fill="white"/>
      <image href="${escapeAttr(logoDataUrl)}" x="${logoX}" y="${logoY}"
             width="${logoSize}" height="${logoSize}"
             preserveAspectRatio="xMidYMid slice"
             clip-path="url(#${clipId})"/>`;
  } else {
    const poolCount = pools.length;
    const positionCount = arcs.length;
    const centerLine1 = `${poolCount} pool${poolCount === 1 ? '' : 's'}`;
    const centerLine2 = `${positionCount} position${positionCount === 1 ? '' : 's'}`;
    centerContent = `
      <circle cx="${cx}" cy="${cy}" r="${rInner}" fill="white"/>
      <text x="${cx}" y="${cy - 8}" text-anchor="middle" dominant-baseline="middle"
            fill="#333" font-size="15" font-weight="600">${centerLine1}</text>
      <text x="${cx}" y="${cy + 12}" text-anchor="middle" dominant-baseline="middle"
            fill="#666" font-size="12">${centerLine2}</text>`;
  }

  return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" style="display:block;margin:0 auto;">
    ${segments}
    ${centerContent}
  </svg>`;
}

// Render the textual breakdown panel next to the chart. Groups arcs by
// pool and lists each position with its supplyPercent and (for bands)
// the multiplier range. Uses small colored swatches that match the
// chart's arc colors so the user can correlate visual ↔ text.
function renderTokenomicsBreakdownHtml(arcs) {
  const name = document.getElementById('tokenName')?.value.trim() || '(unnamed)';
  const symbol = document.getElementById('tokenSymbol')?.value.trim() || '?';
  const supply = parseNumberInput(document.getElementById('tokenSupply'));
  const targetMc = parseNumberInput(document.getElementById('targetMarketCap'));
  const supplyStr = Number.isFinite(supply) && supply > 0
    ? supply.toLocaleString() : '—';
  const mcStr = Number.isFinite(targetMc) && targetMc > 0
    ? `$${targetMc.toLocaleString()}` : '—';

  let html = `
    <p class="is-size-6 mb-2"><strong>${escapeHtml(name)}</strong> · ${escapeHtml(symbol)}</p>
    <p class="is-size-7 has-text-grey mb-3">
      Supply: ${supplyStr} &nbsp;·&nbsp; Target market cap: ${mcStr}
    </p>
  `;

  pools.forEach((pool, poolIdx) => {
    const poolArcs = arcs.filter((a) => a.poolIdx === poolIdx);
    if (poolArcs.length === 0) return; // pool has no real positions
    const poolPct = Number(pool.supplyPercent).toFixed(2);
    const sym = pool.resolvedSymbol || pool.quoteSymbolOverride
      || (pool.quoteToken === 'SOL' ? 'SOL' : pool.quoteToken?.slice(0, 6) + '…');
    const sliceCount = (pool.distribution || []).filter((s) => Number(s.sharePercent) > 0).length;
    const bandCount = (pool.ladderConfig?.mode === 'manual'
      ? (pool.ladderConfig.bands || []).filter((b) => Number(b.supplyPercent) > 0).length
      : 0);
    const bsActive = pool.bootstrapConfig?.mode === 'custom'
      && Number(pool.bootstrapConfig.supplyPercent) > 0;
    const bsSol = bsActive ? Number(pool.bootstrapConfig.solValue) : 0;

    // Per-pool summary line.
    html += `
      <div class="mb-3">
        <p class="is-size-7 mb-1">
          <strong>${escapeHtml(sym)} pool</strong> &nbsp;·&nbsp; ${poolPct}% of supply
          &nbsp;·&nbsp;
          ${bsActive ? `${bsSol} SOL bootstrap, ` : 'no bootstrap, '}${sliceCount} LP slice${sliceCount === 1 ? '' : 's'}${bandCount > 0 ? `, ${bandCount} ladder band${bandCount === 1 ? '' : 's'}` : ''}
        </p>
        <div style="margin-left:1rem;">
    `;
    poolArcs.forEach((arc) => {
      html += `
        <div class="is-size-7" style="display:flex;align-items:center;gap:0.4rem;margin:0.15rem 0;">
          <span style="display:inline-block;width:10px;height:10px;background:${arc.color};border-radius:2px;flex-shrink:0;"></span>
          <span style="flex:1;">${escapeHtml(arc.label)}</span>
          <span class="has-text-grey">${(arc.share * 100).toFixed(2)}% of supply</span>
        </div>
      `;
    });
    html += '</div></div>';
  });

  // Totals footer.
  const totalShare = arcs.reduce((s, a) => s + a.share, 0);
  const totalPct = (totalShare * 100).toFixed(2);
  const allocated = totalPct === '100.00';
  html += `
    <p class="is-size-7 mt-3 ${allocated ? 'has-text-success' : 'has-text-warning'}">
      <strong>${allocated ? '✓' : '⚠'}</strong>
      &nbsp;${totalPct}% of supply allocated across all positions${allocated ? '' : ' — should be 100%'}
    </p>
  `;
  return html;
}

// Open the tokenomics modal. Called from the "Visualize tokenomics" button
// on step 2. Rebuilds the body content from live state on every open so
// the user always sees their current configuration.
//
// If the user has selected a token logo, we embed it in the donut's
// center as a strong identity anchor. The logo is read async via
// FileReader; to keep the modal opening feel instant we render the
// "text fallback" chart first, then swap in the logo-centered version
// as soon as the file is ready. On a fast disk this swap is invisible
// (the modal animates open during the read); on a slow disk the user
// sees the count-text chart briefly before it morphs.
function showTokenomicsModal() {
  const modal = document.getElementById('tokenomicsModal');
  if (!modal) return;

  // Wire close handlers on first open. Can't do this at module load via
  // bind() because the modal markup lives later in the HTML body and
  // app.js runs synchronously before the DOM finishes parsing — bind()
  // would silently fail (the "Element not found" console.warn case).
  // The dataset flag guards against duplicate listeners on repeat opens.
  // Same pattern showTokenInfoModal() uses for the same reason.
  if (!modal.dataset.closeHandlersWired) {
    const close = () => modal.classList.remove('is-active');
    const closeBtn = document.getElementById('tokenomicsModalCloseBtn');
    if (closeBtn) closeBtn.addEventListener('click', close);
    const bg = document.getElementById('tokenomicsModalBackground');
    if (bg) bg.addEventListener('click', close);
    // Escape key closes too, but only when this modal is the one open.
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && modal.classList.contains('is-active')) close();
    });
    modal.dataset.closeHandlersWired = 'true';
  }

  const arcs = buildTokenomicsArcs();
  const breakdownHtml = renderTokenomicsBreakdownHtml(arcs);
  const body = document.getElementById('tokenomicsModalBody');

  // First paint: render the count-text chart and show the modal so it
  // opens instantly. The chart goes into a slot div we can re-render in
  // place once the logo loads.
  const initialSvg = renderTokenomicsDonutSvg(arcs);
  body.innerHTML = `
    <div class="columns is-vcentered">
      <div class="column is-narrow" id="tokenomicsChartSlot">${initialSvg}</div>
      <div class="column">${breakdownHtml}</div>
    </div>
  `;
  modal.classList.add('is-active');

  // Second paint (async): if a logo is selected, swap the chart for a
  // logo-centered version. Fire-and-forget — failures fall back to the
  // initial chart already on screen. We also re-check the modal is still
  // open so a quick close-then-reopen doesn't overwrite the second open's
  // chart with stale data from the first.
  readLogoAsDataUrl().then((logoDataUrl) => {
    if (!logoDataUrl) return;
    if (!modal.classList.contains('is-active')) return;
    const slot = document.getElementById('tokenomicsChartSlot');
    if (!slot) return;
    slot.innerHTML = renderTokenomicsDonutSvg(arcs, { logoDataUrl });
  }).catch(() => { /* ignore — fallback chart is already visible */ });
}

bind('visualizeTokenomicsBtn', 'click', showTokenomicsModal);

// ===========================================================================
// Launch Report Download
// ===========================================================================
//
// Generates a markdown report covering the just-completed launch:
// addresses for the token mint, pools, and every position; lock-status
// transactions; transfer txs for any Fee Keys sent to external recipients;
// and a tokenomics summary mirroring the visualization modal's content.
//
// Triggered from step 5 (after all pools created) or step 6 (after
// transfer). Both bindings call the same generator; the report content
// doesn't change between those two stages because all on-chain ops
// commit by step 5 — step 6 just sweeps the ephemeral wallet.

// Build an explorer URL for an address or transaction signature. Solscan
// is the de facto standard; users can change cluster via the UI if they
// need devnet/testnet view. Leaving cluster off defaults to mainnet,
// which matches what Trebuchet always launches on.
function solscanAddrUrl(addr) {
  return `https://solscan.io/account/${encodeURIComponent(addr)}`;
}
function solscanTxUrl(sig) {
  return `https://solscan.io/tx/${encodeURIComponent(sig)}`;
}

// Format an ISO timestamp as a human-readable local date+time string.
// Used for the report header so the user has a record of when this
// launch happened.
function formatReportTimestamp(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// Generate the HTML report — a self-contained .html document the team
// can open offline, share, or print to PDF. Includes:
//   - Token name/symbol/mint/decimals/supply/target mcap
//   - Embedded SVG donut chart (same chart the preview modal shows)
//   - Per-pool sections with bootstrap/main/ladder positions
//   - Per-row copy buttons for every address and TX signature
//   - Solscan links for everything
//   - Lock-status summary roll-up at the top
//
// Reads from createdTokenInfo, lpResult, pools (user's UI config — used
// for fee tiers, supply percentages, and ladder band ranges), tempWallet,
// and the token form fields. Defensive on every field: a partial-failure
// resume path may produce results where individual positions don't have
// a `txIds.lock` or `transferredTo`. Missing fields render as "—".

// Escape a value for safe inclusion in an HTML attribute. Used for the
// data attributes that drive the copy buttons. Same set as escapeHtml
// but called out separately so the intent reads clearly at call sites.
function escapeAttr(s) {
  return escapeHtml(String(s));
}

// Render one "address row": label, monospace value, copy button, optional
// explorer link. Used throughout the report for any address or tx sig.
// `kind` is 'addr' or 'tx' — only affects the explorer URL builder.
function renderAddressRow(label, value, kind = 'addr') {
  if (!value) {
    return `<div class="addr-row">
      <span class="addr-label">${escapeHtml(label)}</span>
      <span class="addr-value addr-missing">—</span>
    </div>`;
  }
  const url = kind === 'tx' ? solscanTxUrl(value) : solscanAddrUrl(value);
  return `<div class="addr-row">
    <span class="addr-label">${escapeHtml(label)}</span>
    <code class="addr-value">${escapeHtml(value)}</code>
    <button class="copy-btn" data-copy="${escapeAttr(value)}" title="Copy to clipboard">Copy</button>
    <a class="explorer-link" href="${escapeAttr(url)}" target="_blank" rel="noopener" title="Open on Solscan">↗</a>
  </div>`;
}

// Render a fact-line: "Label: value" with no copy button. For non-address
// fields like fee tier, decimals, range multipliers.
function renderFactRow(label, value) {
  return `<div class="fact-row">
    <span class="fact-label">${escapeHtml(label)}</span>
    <span class="fact-value">${escapeHtml(String(value))}</span>
  </div>`;
}

// Render a lock badge — green pill for locked, gray pill for not.
function renderLockBadge(locked) {
  return locked
    ? `<span class="badge badge-locked">🔒 Locked</span>`
    : `<span class="badge badge-unlocked">Not locked</span>`;
}

// Compute the lock-status roll-up across every position in every pool.
// Returns { total, locked, transferred, totalRecipient, allLocked }.
function computeLockSummary(results) {
  let total = 0, locked = 0, transferred = 0, totalRecipient = 0;
  for (const r of results) {
    const mains = Array.isArray(r.mainPositions) ? r.mainPositions : [];
    const ladder = Array.isArray(r.ladderPositions) ? r.ladderPositions : [];
    const all = [...mains, ...ladder, ...(r.bootstrap ? [r.bootstrap] : [])];
    for (const p of all) {
      total++;
      if (p.locked) locked++;
    }
    for (const p of mains) {
      if (p.recipient) {
        totalRecipient++;
        if (p.transferredTo) transferred++;
      }
    }
  }
  return { total, locked, transferred, totalRecipient, allLocked: total > 0 && locked === total };
}

// Build the entire HTML report as a string. Self-contained — inlines
// CSS and JS, includes the SVG chart directly, and embeds the token
// logo as a base64 data URL so the file works offline and survives
// email forwarding without breaking image refs.
//
// Visual theme matches the makesometokens.com marketing site:
// parchment background (#efe5cd theme color), Trebuchet MS body font
// (deliberately on-brand — the typeface is literally named after a
// trebuchet), engineering-manuscript flourishes (FIG. NN callouts,
// bracketed enumerators, "STEP NN · LABEL" headers, blueprint-style
// border treatments).
//
// Optional `logoDataUrl` parameter: if provided, embedded as the report's
// hero image. The downloadLaunchReport caller reads the user's selected
// logo file and converts it to a data URL before calling this.
function buildLaunchReportHtml({ logoDataUrl = null } = {}) {
  const now = new Date();
  const tokenInfo = createdTokenInfo || {};
  const results = (lpResult && Array.isArray(lpResult.results)) ? lpResult.results : [];
  const tokenName = document.getElementById('tokenName')?.value.trim() || tokenInfo.name || '(unnamed)';
  const tokenSymbol = document.getElementById('tokenSymbol')?.value.trim() || tokenInfo.symbol || '?';
  const tokenDescription = document.getElementById('tokenDescription')?.value.trim() || '';
  const supply = parseNumberInput(document.getElementById('tokenSupply'));
  const targetMc = parseNumberInput(document.getElementById('targetMarketCap'));
  const summary = computeLockSummary(results);

  // Reuse the same chart and breakdown the preview modal uses, so the
  // report's tokenomics view matches what the user saw at launch time.
  // Slightly smaller in the report so the chart and breakdown fit
  // side-by-side comfortably at the parchment-page width. If the user
  // provided a logo we pass it through so the chart center shows the
  // logo — same treatment as the hero block at the top of the report.
  const arcs = buildTokenomicsArcs();
  const chartSvg = renderTokenomicsDonutSvg(arcs, { size: 300, logoDataUrl });

  // ---- Per-pool sections ----
  let poolSections = '';
  results.forEach((r, idx) => {
    const userPool = pools[r.allocationIndex ?? idx] || pools[idx] || {};
    const sym = r.quoteSymbol || userPool.resolvedSymbol || '?';
    const supplyPct = Number(userPool.supplyPercent ?? 0).toFixed(2);
    const feeTierIdx = userPool.ammConfigIndex;
    const feeTier = feeTiers.find((t) => t.index === feeTierIdx);
    const feeTierLabel = feeTier
      ? `${(feeTier.tradeFeeRate / 10000).toFixed(2)}% / spacing ${feeTier.tickSpacing}`
      : (feeTierIdx != null ? `index ${feeTierIdx}` : '—');

    // Pool's own colour from the chart palette — used for the section
    // accent so the report visually ties pools to their arcs.
    const poolHue = POOL_COLOR_BASES[idx % POOL_COLOR_BASES.length].h;
    const poolSat = POOL_COLOR_BASES[idx % POOL_COLOR_BASES.length].s;

    let positionsHtml = '';

    // Bootstrap position (if present)
    if (r.bootstrap) {
      positionsHtml += `
        <div class="position-card">
          <div class="position-header">
            <span class="position-kind">Bootstrap position</span>
            ${renderLockBadge(r.bootstrap.locked)}
          </div>
          ${renderAddressRow('Position NFT', r.bootstrap.nftMint)}
          ${renderAddressRow('Open TX', r.bootstrap.txIds?.open, 'tx')}
          ${renderAddressRow('Lock TX', r.bootstrap.txIds?.lock, 'tx')}
        </div>`;
    }

    // Main LP positions / slices
    const mains = Array.isArray(r.mainPositions) ? r.mainPositions : [];
    mains.forEach((pos, si) => {
      const sliceLabel = mains.length === 1
        ? 'Main LP position'
        : `Main LP slice ${si + 1}/${mains.length}`;
      const shareText = pos.sharePercent != null
        ? `${Number(pos.sharePercent).toFixed(2)}% of wide bucket`
        : null;

      let recipientBlock = '';
      if (pos.recipient) {
        recipientBlock = `
          ${renderAddressRow('Fee Key recipient', pos.recipient)}
          <div class="fact-row">
            <span class="fact-label">Transferred to recipient</span>
            <span class="fact-value">${pos.transferredTo ? 'Yes' : 'No (Fee Key NFT stayed with launch wallet)'}</span>
          </div>
          ${pos.txIds?.transfer ? renderAddressRow('Fee Key transfer TX', pos.txIds.transfer, 'tx') : ''}`;
      }

      positionsHtml += `
        <div class="position-card">
          <div class="position-header">
            <span class="position-kind">${escapeHtml(sliceLabel)}</span>
            ${renderLockBadge(pos.locked)}
          </div>
          ${shareText ? renderFactRow('Share', shareText) : ''}
          ${renderAddressRow('Position NFT', pos.nftMint)}
          ${renderAddressRow('Open TX', pos.txIds?.open, 'tx')}
          ${renderAddressRow('Lock TX', pos.txIds?.lock, 'tx')}
          ${recipientBlock}
        </div>`;
    });

    // Ladder bands
    const ladder = Array.isArray(r.ladderPositions) ? r.ladderPositions : [];
    ladder.forEach((pos, bi) => {
      const userBand = userPool.ladderConfig?.bands?.[bi];
      const rangeLabel = userBand
        ? `${Number(userBand.lowerMultiplier).toFixed(2)}× – ${Number(userBand.upperMultiplier).toFixed(2)}× launch price`
        : `tick ${pos.tickLower} → ${pos.tickUpper}`;
      const supplyText = userBand
        ? `${Number(userBand.supplyPercent).toFixed(2)}% of pool`
        : null;

      positionsHtml += `
        <div class="position-card">
          <div class="position-header">
            <span class="position-kind">Ladder band ${bi + 1}/${ladder.length}</span>
            ${renderLockBadge(pos.locked)}
          </div>
          ${renderFactRow('Range', rangeLabel)}
          ${supplyText ? renderFactRow('Token-supply share', supplyText) : ''}
          ${renderAddressRow('Position NFT', pos.nftMint)}
          ${renderAddressRow('Open TX', pos.txIds?.open, 'tx')}
          ${renderAddressRow('Lock TX', pos.txIds?.lock, 'tx')}
        </div>`;
    });

    const poolEnum = String(idx + 1).padStart(2, '0');
    poolSections += `
      <section class="pool-section">
        <div class="pool-section-header">
          <div class="enum-badge">POOL · ${poolEnum}</div>
          <h2 class="pool-title">
            <span class="pool-swatch" style="background: hsl(${poolHue}, ${poolSat}%, 45%);"></span>
            ${escapeHtml(sym)} pool
          </h2>
          <div class="pool-meta">${supplyPct}% of token supply &nbsp;·&nbsp; Fee tier ${escapeHtml(feeTierLabel)}</div>
        </div>
        <div class="pool-addresses">
          ${renderAddressRow('Pool ID', r.poolId)}
          ${userPool.quoteToken && userPool.quoteToken !== 'SOL' ? renderAddressRow('Quote token mint', userPool.quoteToken) : ''}
          ${renderAddressRow('Create-pool TX', r.txIds?.createPool, 'tx')}
        </div>
        <div class="positions-grid">${positionsHtml}</div>
      </section>`;
  });

  // ---- Status banner (top of report) ----
  // Status banner. Two information dimensions: position locks (everything
  // locked? partial?) and Fee Key transfers (any external recipients
  // configured? did they all receive their NFTs?). The lock dimension is
  // always shown; the transfer dimension only when relevant.
  let statusBanner;
  if (results.length === 0) {
    statusBanner = `<div class="banner banner-warn">
      <strong>No pool results captured.</strong>
      This may indicate the launch did not reach the create-pool phase.
    </div>`;
  } else if (summary.allLocked) {
    // Lock all good. Surface transfer status only when external recipients
    // existed AND some failed — otherwise that line would be either "0/0"
    // (uninformative) or "all delivered" (already implicit in the green
    // banner). Failed transfers are the case the user genuinely needs to
    // know about, because the Fee Key NFTs sweep to the destination wallet
    // on transfer and the user has to forward them manually.
    const transferIssue = summary.totalRecipient > 0
      && summary.transferred < summary.totalRecipient;
    statusBanner = `<div class="banner banner-${transferIssue ? 'warn' : 'ok'}">
      <strong>All ${summary.total} positions locked.</strong>
      The liquidity is permanently committed via Burn &amp; Earn. Fees accrue to the Fee Key NFT holders.
      ${transferIssue ? `<br><strong>${summary.transferred} / ${summary.totalRecipient} Fee Key NFTs reached their external recipients</strong> — the remaining ones swept back to the launch wallet and were transferred to the destination wallet on step 6. Forward them manually to complete delivery.` : ''}
    </div>`;
  } else {
    statusBanner = `<div class="banner banner-warn">
      <strong>${summary.locked} / ${summary.total} positions locked.</strong>
      Any unlocked position is still controlled by the ephemeral launch wallet. If you ran the transfer step, those NFTs were swept to your destination wallet — you can re-lock them via Raydium's Burn &amp; Earn UI.
      ${summary.totalRecipient > 0 && summary.transferred < summary.totalRecipient ? `<br><strong>${summary.transferred} / ${summary.totalRecipient} Fee Key NFTs reached their external recipients.</strong>` : ''}
    </div>`;
  }

  // ---- Tokenomics breakdown (textual, matches the chart) ----
  let breakdownHtml = '';
  pools.forEach((pool, poolIdx) => {
    const poolArcs = arcs.filter((a) => a.poolIdx === poolIdx);
    if (poolArcs.length === 0) return;
    const sym = pool.resolvedSymbol || (pool.quoteToken === 'SOL' ? 'SOL' : pool.quoteToken?.slice(0, 6) + '…');
    breakdownHtml += `<div class="breakdown-pool"><div class="breakdown-pool-name">${escapeHtml(sym)} pool — ${Number(pool.supplyPercent).toFixed(2)}%</div>`;
    poolArcs.forEach((arc) => {
      breakdownHtml += `<div class="breakdown-arc">
        <span class="breakdown-swatch" style="background:${arc.color};"></span>
        <span class="breakdown-arc-label">${escapeHtml(arc.label)}</span>
        <span class="breakdown-arc-share">${(arc.share * 100).toFixed(2)}%</span>
      </div>`;
    });
    breakdownHtml += '</div>';
  });

  // ---- Logo hero block ----
  // Embedded as a data URL so the report is fully portable. The user
  // didn't have to provide one — we render a placeholder block with
  // the token symbol instead so the layout reads consistently.
  const logoBlock = logoDataUrl
    ? `<img class="hero-logo" src="${escapeHtml(logoDataUrl)}" alt="${escapeHtml(tokenName)} logo">`
    : `<div class="hero-logo hero-logo-placeholder">${escapeHtml((tokenSymbol || '?').slice(0, 3).toUpperCase())}</div>`;

  // ---- Final HTML document ----
  // Inline CSS so the file works offline and survives email forwarding.
  // Inline JS for the clipboard behavior. The aesthetic mirrors the
  // makesometokens.com marketing site — parchment background, ink
  // typography, engineering-manuscript flourishes.
  const safeName = escapeHtml(tokenName);
  const safeSymbol = escapeHtml(tokenSymbol);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${safeName} (${safeSymbol}) — Launch Dossier</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#efe5cd">
  <style>
    /* ============================================================
       Theme — matches makesometokens.com
       Parchment background, ink typography, engineering-manuscript
       flourishes. Trebuchet MS body font (literally on-brand —
       the typeface is named after a trebuchet).
       ============================================================ */
    :root {
      --parchment: #efe5cd;
      --parchment-deep: #e6dab9;
      --parchment-edge: #d6c8a3;
      --ink: #1a1a1a;
      --ink-soft: #3d3a32;
      --ink-muted: #6b6657;
      --rule: #1a1a1a;
      --rule-soft: #b8ad8a;
      --accent: #8a3a1a;        /* sienna red — matches the manuscript ink-stamp feel */
      --ok: #2d5016;
      --ok-bg: #d9e6c8;
      --ok-edge: #8aa466;
      --warn: #7a3a0a;
      --warn-bg: #eed9b0;
      --warn-edge: #c89860;
      --mono: "Courier New", Courier, ui-monospace, monospace;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body {
      font-family: "Trebuchet MS", "Lucida Sans Unicode", "Lucida Grande", Tahoma, sans-serif;
      background: var(--parchment);
      color: var(--ink);
      line-height: 1.55;
      font-size: 14.5px;
      /* Subtle paper texture — radial gradient gives a hint of vignette
         without requiring an external image. */
      background-image:
        radial-gradient(ellipse at center, transparent 0%, transparent 70%, rgba(110, 90, 50, 0.08) 100%),
        repeating-linear-gradient(0deg, transparent 0 28px, rgba(110, 90, 50, 0.012) 28px 29px);
      background-attachment: fixed;
    }
    .wrap {
      max-width: 1100px;
      margin: 0 auto;
      padding: 36px 32px 80px;
    }
    a { color: var(--accent); text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 2px; }
    a:hover { text-decoration-thickness: 2px; }
    code { font-family: var(--mono); font-size: 0.92em; }

    /* ---------- Top masthead ---------- */
    .masthead {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
      padding-bottom: 12px;
      margin-bottom: 8px;
      border-bottom: 2px solid var(--rule);
      font-family: var(--mono);
      font-size: 11px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--ink-soft);
    }
    .masthead-left { display: flex; align-items: center; gap: 18px; }
    .masthead-brand { font-weight: 700; letter-spacing: 0.35em; color: var(--ink); }
    .masthead-right { text-align: right; }

    /* ---------- Document title block ---------- */
    .title-block {
      display: grid;
      grid-template-columns: 120px 1fr;
      gap: 32px;
      align-items: center;
      margin: 32px 0 24px;
      padding-bottom: 24px;
      border-bottom: 1px solid var(--rule-soft);
    }
    @media (max-width: 600px) {
      .title-block { grid-template-columns: 1fr; text-align: center; }
    }
    .hero-logo {
      width: 120px;
      height: 120px;
      object-fit: contain;
      border-radius: 50%;
      background: var(--parchment-deep);
      border: 2px solid var(--rule);
      box-shadow: 0 2px 0 var(--rule-soft);
    }
    .hero-logo-placeholder {
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: var(--mono);
      font-size: 34px;
      font-weight: 700;
      color: var(--ink-soft);
      letter-spacing: 0.1em;
    }
    .doc-fig {
      font-family: var(--mono);
      font-size: 11px;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: var(--ink-muted);
      margin: 0 0 8px;
    }
    .doc-title {
      margin: 0;
      font-size: 44px;
      font-weight: 700;
      line-height: 1.05;
      letter-spacing: -0.01em;
    }
    .doc-title .doc-symbol {
      color: var(--ink-muted);
      font-weight: 500;
      font-size: 0.6em;
      letter-spacing: 0.02em;
      margin-left: 0.4em;
    }
    .doc-subtitle {
      margin: 10px 0 0;
      color: var(--ink-soft);
      font-size: 15px;
      font-style: italic;
      max-width: 60ch;
    }

    /* ---------- Section enumeration / headers ---------- */
    .enum-badge {
      display: inline-block;
      font-family: var(--mono);
      font-size: 10.5px;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: var(--ink-muted);
      padding: 3px 10px;
      border: 1px solid var(--rule-soft);
      background: var(--parchment-deep);
      margin-bottom: 12px;
    }
    .section-rule {
      margin: 36px 0 24px;
      border: 0;
      border-top: 2px solid var(--rule);
      position: relative;
    }
    .section-rule::after {
      content: "";
      position: absolute;
      top: 4px;
      left: 0;
      right: 0;
      border-top: 1px solid var(--rule);
    }
    h2.section-title {
      margin: 0 0 18px;
      font-size: 22px;
      font-weight: 700;
      letter-spacing: -0.005em;
    }
    h3.subsection {
      margin: 18px 0 8px;
      font-family: var(--mono);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.15em;
      color: var(--ink-muted);
      font-weight: 600;
    }

    /* ---------- Banner ---------- */
    .banner {
      padding: 12px 16px;
      margin: 20px 0 28px;
      font-size: 13.5px;
      border: 1px solid;
      background: var(--parchment-deep);
      position: relative;
    }
    .banner::before {
      content: "";
      position: absolute;
      left: 0; top: 0; bottom: 0;
      width: 4px;
    }
    .banner strong { display: inline-block; margin-right: 6px; }
    .banner-ok { border-color: var(--ok-edge); color: var(--ok); background: var(--ok-bg); }
    .banner-ok::before { background: var(--ok); }
    .banner-warn { border-color: var(--warn-edge); color: var(--warn); background: var(--warn-bg); }
    .banner-warn::before { background: var(--warn); }

    /* ---------- Token summary stat-grid ---------- */
    .token-summary-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
      gap: 0;
      border: 1px solid var(--rule);
      background: var(--parchment-deep);
    }
    .token-stat {
      padding: 14px 18px;
      border-right: 1px solid var(--rule-soft);
    }
    .token-stat:last-child { border-right: none; }
    .token-stat-label {
      font-family: var(--mono);
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.15em;
      color: var(--ink-muted);
      margin-bottom: 6px;
    }
    .token-stat-value {
      font-size: 18px;
      font-weight: 700;
      letter-spacing: -0.01em;
    }

    /* ---------- Tokenomics block ---------- */
    .tokenomics {
      display: grid;
      grid-template-columns: 320px 1fr;
      gap: 36px;
      align-items: start;
      margin-top: 16px;
    }
    @media (max-width: 720px) {
      .tokenomics { grid-template-columns: 1fr; }
    }
    .tokenomics svg { display: block; margin: 0 auto; }
    .chart-caption {
      font-family: var(--mono);
      font-size: 10px;
      letter-spacing: 0.15em;
      text-transform: uppercase;
      text-align: center;
      color: var(--ink-muted);
      margin-top: 4px;
    }
    .breakdown-pool { margin-bottom: 18px; }
    .breakdown-pool:last-child { margin-bottom: 0; }
    .breakdown-pool-name {
      font-weight: 700;
      font-size: 13px;
      margin-bottom: 8px;
      padding-bottom: 4px;
      border-bottom: 1px dashed var(--rule-soft);
      font-family: var(--mono);
      letter-spacing: 0.05em;
      text-transform: uppercase;
      color: var(--ink-soft);
    }
    .breakdown-arc {
      display: grid;
      grid-template-columns: 14px 1fr auto;
      gap: 10px;
      align-items: center;
      font-size: 13px;
      padding: 3px 0;
    }
    .breakdown-swatch {
      width: 12px; height: 12px; border-radius: 2px;
      border: 1px solid rgba(0,0,0,0.15);
    }
    .breakdown-arc-share {
      color: var(--ink-soft);
      font-variant-numeric: tabular-nums;
      font-family: var(--mono);
      font-size: 12px;
    }

    /* ---------- Pool section ---------- */
    .pool-section {
      margin: 28px 0;
      padding-top: 6px;
      border-top: 2px solid var(--rule);
    }
    .pool-section-header {
      margin-bottom: 18px;
    }
    .pool-title {
      margin: 0 0 4px;
      font-size: 24px;
      font-weight: 700;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .pool-swatch {
      display: inline-block;
      width: 16px; height: 16px;
      border-radius: 2px;
      border: 1px solid var(--rule);
    }
    .pool-meta {
      font-family: var(--mono);
      font-size: 11px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--ink-muted);
    }
    .pool-addresses {
      margin-bottom: 20px;
      padding: 14px 16px;
      background: var(--parchment-deep);
      border: 1px solid var(--rule-soft);
    }

    /* ---------- Position cards ---------- */
    .positions-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(440px, 1fr));
      gap: 14px;
    }
    .position-card {
      background: var(--parchment-deep);
      border: 1px solid var(--rule-soft);
      padding: 14px 16px;
      position: relative;
    }
    /* Top-left corner notch — engineering-drawing accent */
    .position-card::before {
      content: "";
      position: absolute;
      top: 0; left: 0;
      width: 8px; height: 8px;
      border-top: 2px solid var(--rule);
      border-left: 2px solid var(--rule);
    }
    .position-card::after {
      content: "";
      position: absolute;
      bottom: 0; right: 0;
      width: 8px; height: 8px;
      border-bottom: 2px solid var(--rule);
      border-right: 2px solid var(--rule);
    }
    .position-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 10px;
      padding-bottom: 8px;
      border-bottom: 1px dashed var(--rule-soft);
    }
    .position-kind {
      font-weight: 700;
      font-size: 13.5px;
      letter-spacing: 0.01em;
    }

    /* ---------- Address rows ---------- */
    .addr-row {
      display: grid;
      grid-template-columns: 140px 1fr auto auto;
      gap: 8px;
      align-items: center;
      padding: 5px 0;
      font-size: 12.5px;
    }
    .addr-label {
      font-family: var(--mono);
      color: var(--ink-muted);
      font-size: 10.5px;
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }
    .addr-value {
      font-family: var(--mono);
      font-size: 11.5px;
      background: var(--parchment);
      padding: 4px 8px;
      border: 1px solid var(--rule-soft);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .addr-missing {
      background: transparent;
      border: none;
      color: var(--ink-muted);
      font-style: italic;
      padding-left: 0;
    }
    .copy-btn {
      font: inherit;
      font-family: var(--mono);
      font-size: 10px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      padding: 4px 10px;
      background: var(--parchment);
      border: 1px solid var(--rule);
      cursor: pointer;
      color: var(--ink);
      transition: all 120ms ease;
    }
    .copy-btn:hover {
      background: var(--ink);
      color: var(--parchment);
    }
    .copy-btn.copied {
      background: var(--ok);
      border-color: var(--ok);
      color: var(--parchment);
    }
    .explorer-link {
      color: var(--ink-soft);
      font-size: 14px;
      text-decoration: none;
      padding: 2px 6px;
      border: 1px solid var(--rule-soft);
      background: var(--parchment);
      font-family: var(--mono);
    }
    .explorer-link:hover {
      background: var(--ink);
      color: var(--parchment);
      border-color: var(--ink);
      text-decoration: none;
    }

    /* ---------- Fact rows ---------- */
    .fact-row {
      display: grid;
      grid-template-columns: 140px 1fr;
      gap: 8px;
      padding: 4px 0;
      font-size: 12.5px;
    }
    .fact-label {
      font-family: var(--mono);
      color: var(--ink-muted);
      font-size: 10.5px;
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }
    .fact-value { color: var(--ink); }

    /* ---------- Badges ---------- */
    .badge {
      display: inline-block;
      padding: 3px 10px;
      font-family: var(--mono);
      font-size: 10px;
      letter-spacing: 0.15em;
      text-transform: uppercase;
      font-weight: 700;
      border: 1px solid;
    }
    .badge-locked {
      background: var(--ok-bg);
      color: var(--ok);
      border-color: var(--ok-edge);
    }
    .badge-unlocked {
      background: var(--warn-bg);
      color: var(--warn);
      border-color: var(--warn-edge);
    }

    /* ---------- Footer ---------- */
    .doc-footer {
      margin-top: 48px;
      padding-top: 24px;
      border-top: 2px solid var(--rule);
      font-family: var(--mono);
      font-size: 11px;
      letter-spacing: 0.08em;
      color: var(--ink-muted);
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
      flex-wrap: wrap;
    }
    .doc-footer a {
      color: var(--ink);
      text-decoration: none;
      font-weight: 700;
      letter-spacing: 0.12em;
      text-transform: uppercase;
    }
    .doc-footer a:hover { color: var(--accent); }

    /* ---------- Toast (copied confirmation) ---------- */
    .toast {
      position: fixed;
      bottom: 32px;
      left: 50%;
      transform: translateX(-50%) translateY(20px);
      background: var(--ink);
      color: var(--parchment);
      padding: 10px 22px;
      font-family: var(--mono);
      font-size: 12px;
      letter-spacing: 0.15em;
      text-transform: uppercase;
      border: 2px solid var(--ink);
      opacity: 0;
      pointer-events: none;
      transition: opacity 180ms ease, transform 180ms ease;
      z-index: 1000;
    }
    .toast.show {
      opacity: 1;
      transform: translateX(-50%) translateY(0);
    }

    /* ---------- Print ---------- */
    @media print {
      body {
        background: white;
        background-image: none;
        font-size: 11px;
      }
      .wrap { padding: 0; max-width: none; }
      .copy-btn { display: none; }
      .positions-grid { grid-template-columns: 1fr; }
      a { color: inherit; text-decoration: none; }
      .pool-section { page-break-inside: avoid; }
      .position-card { page-break-inside: avoid; }
      .doc-footer { page-break-inside: avoid; }
    }
  </style>
</head>
<body>
<div class="wrap">

  <!--
    Masthead — manuscript-style figure callout at the top of the page.
    Mirrors the makesometokens.com header strip pattern ("FIG. 1 · Solana
    Token Launcher · v1.0") so a team that's seen the marketing site
    immediately recognizes the document as part of the same family.
  -->
  <div class="masthead">
    <div class="masthead-left">
      <span class="masthead-brand">T R E B U C H E T</span>
      <span>FIG. 01 · Launch Dossier</span>
    </div>
    <div class="masthead-right">
      ${formatReportTimestamp(now)}
    </div>
  </div>

  <header class="title-block">
    ${logoBlock}
    <div>
      <p class="doc-fig">Token launch report · permanent record</p>
      <h1 class="doc-title">${safeName} <span class="doc-symbol">· ${safeSymbol}</span></h1>
      ${tokenDescription ? `<p class="doc-subtitle">${escapeHtml(tokenDescription)}</p>` : ''}
    </div>
  </header>

  ${statusBanner}

  <hr class="section-rule">
  <div class="enum-badge">[ 01 ] &nbsp; Token</div>
  <h2 class="section-title">Token specification</h2>

  <div class="token-summary-grid">
    <div class="token-stat">
      <div class="token-stat-label">Total supply</div>
      <div class="token-stat-value">${Number.isFinite(supply) && supply > 0 ? supply.toLocaleString() : '—'}</div>
    </div>
    <div class="token-stat">
      <div class="token-stat-label">Decimals</div>
      <div class="token-stat-value">${Number.isFinite(tokenInfo.decimals) ? tokenInfo.decimals : '—'}</div>
    </div>
    <div class="token-stat">
      <div class="token-stat-label">Launch market cap</div>
      <div class="token-stat-value">${Number.isFinite(targetMc) && targetMc > 0 ? '$' + targetMc.toLocaleString() : '—'}</div>
    </div>
    <div class="token-stat">
      <div class="token-stat-label">Pools</div>
      <div class="token-stat-value">${results.length}</div>
    </div>
  </div>

  <h3 class="subsection">Mint &amp; launch wallet</h3>
  ${renderAddressRow('Token mint', tokenInfo.mint)}
  ${tempWallet?.publicKey ? renderAddressRow('Launch wallet', tempWallet.publicKey) : ''}

  <hr class="section-rule">
  <div class="enum-badge">[ 02 ] &nbsp; Tokenomics</div>
  <h2 class="section-title">Supply distribution</h2>

  <div class="tokenomics">
    <div>
      ${chartSvg}
      <div class="chart-caption">FIG. 02 · Token supply across pools &amp; positions</div>
    </div>
    <div>${breakdownHtml || '<p style="color:var(--ink-muted);">No positions configured.</p>'}</div>
  </div>

  <hr class="section-rule">
  <div class="enum-badge">[ 03 ] &nbsp; Pools &amp; Positions</div>
  <h2 class="section-title">Liquidity pool breakdown</h2>

  ${poolSections}

  <footer class="doc-footer">
    <div>
      <div>Trebuchet — launch Solana tokens, no middleman.</div>
      <div style="margin-top: 4px; text-transform: none; letter-spacing: 0.04em; font-size: 10px;">
        Solscan links use mainnet-beta. Tap any address or transaction signature to copy.
      </div>
    </div>
    <div>
      <a href="https://makesometokens.com/" target="_blank" rel="noopener">makesometokens.com</a>
    </div>
  </footer>

</div>

<div id="toast" class="toast" role="status" aria-live="polite">Copied</div>

<script>
  // Copy-button behavior. Single delegated listener on the body — simpler
  // than attaching one per button and survives any future re-renders
  // (though this is a static report, so re-renders don't happen).
  document.body.addEventListener('click', (e) => {
    const btn = e.target.closest('.copy-btn');
    if (!btn) return;
    const value = btn.dataset.copy;
    if (!value) return;

    const showCopied = () => {
      btn.classList.add('copied');
      const original = btn.textContent;
      btn.textContent = 'Copied';
      const toast = document.getElementById('toast');
      toast.classList.add('show');
      setTimeout(() => {
        btn.classList.remove('copied');
        btn.textContent = original;
        toast.classList.remove('show');
      }, 1400);
    };

    // Modern Clipboard API first; fall back to execCommand for older
    // browsers and odd security contexts (some local-file openings
    // disable the modern API).
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(value).then(showCopied).catch(() => {
        legacyCopy(value, showCopied);
      });
    } else {
      legacyCopy(value, showCopied);
    }
  });

  function legacyCopy(value, onSuccess) {
    const ta = document.createElement('textarea');
    ta.value = value;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      onSuccess();
    } catch (e) {
      console.error('Copy failed:', e);
    }
    document.body.removeChild(ta);
  }
</script>
</body>
</html>`;
}

// Read the user-selected token logo file as a data URL (base64-encoded
// with the correct MIME prefix). Used to embed the logo directly into
// the downloadable HTML report so the report is self-contained — the
// team can open it offline or forward it without breaking image refs.
// Returns null if no logo is selected or the read fails; the report
// gracefully falls back to a text-only header in that case.
async function readLogoAsDataUrl() {
  const logoEl = document.getElementById('tokenLogo');
  const file = logoEl?.files?.[0];
  if (!file) return null;
  return await new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
    reader.onerror = () => {
      // Don't surface this as an error log — the rest of the report is
      // perfectly usable without the logo. Quietly fall back.
      console.warn('Failed to read logo file for report embedding', reader.error);
      resolve(null);
    };
    reader.readAsDataURL(file);
  });
}

// Trigger a download of the HTML report. Filename includes the token
// symbol (sanitized) and a date stamp so multiple reports from the
// same machine don't collide. Reads the logo file first so we can
// embed it; falls back to text-only header on failure.
async function downloadLaunchReport() {
  if (!createdTokenInfo && (!lpResult || !lpResult.results || lpResult.results.length === 0)) {
    log('No launch results available yet — try again after pools are created.', 'warning');
    return;
  }
  try {
    const logoDataUrl = await readLogoAsDataUrl();
    const html = buildLaunchReportHtml({ logoDataUrl });
    const symbol = (document.getElementById('tokenSymbol')?.value.trim() || createdTokenInfo?.symbol || 'token')
      .replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 24) || 'token';
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const datePart = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
    const filename = `trebuchet-launch-${symbol}-${datePart}.html`;

    // Use a Blob + anchor click for the download. Works in Electron's
    // Chromium without main-process file-system plumbing.
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 100);
    log(`Launch report saved: ${filename}`, 'success');
  } catch (err) {
    // Catch-all: a thrown error from any step in the report-build/download
    // pipeline shouldn't leave the user with no feedback. Surface via the
    // activity log and console; the launch itself is unaffected since this
    // is post-launch reporting.
    console.error('Launch report generation failed:', err);
    log(`Failed to generate launch report: ${err.message || err}`, 'danger');
  }
}

bind('downloadReportBtnStep5', 'click', downloadLaunchReport);
bind('downloadReportBtnStep6', 'click', downloadLaunchReport);

function buildAllocationsForApi() {
  return pools.map((p) => {
    // Pass the price the UI already resolved through to the server as
    // quoteUsdOverride, unless the user explicitly typed an override
    // (which always wins). This means the launch flow doesn't re-fetch
    // a price the UI just looked up — fewer external API calls, and the
    // price the user saw in the UI is the price the launch math uses.
    const effectiveUsdOverride =
      p.quoteUsdOverride != null
        ? p.quoteUsdOverride
        : (p.resolvedPriceUsd != null ? Number(p.resolvedPriceUsd) : null);
    const effectiveSymbolOverride =
      p.quoteSymbolOverride != null && p.quoteSymbolOverride !== ''
        ? p.quoteSymbolOverride
        : (p.resolvedSymbol || null);
    const effectiveDecimalsOverride =
      p.quoteDecimalsOverride != null
        ? p.quoteDecimalsOverride
        : (p.resolvedDecimals != null ? Number(p.resolvedDecimals) : null);

    // Unified "% of pool" semantics in the UI: bootstrap.supplyPercent,
    // ladder band.supplyPercent, and slice.sharePercent all express
    // each position's fraction of THIS pool's allocation. They sum to
    // 100% (validated). Backend wire format uses different denominators
    // (bootstrap = % of total; ladder band = % of main; slice = % of
    // wide), so we convert here.
    const uiBsPct = (p.bootstrapConfig && p.bootstrapConfig.mode === 'custom')
      ? Number(p.bootstrapConfig.supplyPercent) || 0
      : 0;
    const ldCfg = p.ladderConfig || { mode: 'off', bands: [] };
    const uiBandPcts = (ldCfg.mode === 'manual' && Array.isArray(ldCfg.bands))
      ? ldCfg.bands.map((b) => Number(b.supplyPercent) || 0)
      : [];

    // Wire bootstrap.supplyPercent is % of TOTAL token supply. With
    // pool at X% of total and bs at Y% of pool, bs of total = X × Y / 100.
    const bootstrap = uiBsPct > 0
      ? { mode: 'custom', supplyPercent: uiBsPct * Number(p.supplyPercent) / 100 }
      : { mode: 'minimal' };

    // Wire ladder band.supplyPercent is % of MAIN (pool − bootstrap).
    // Main fraction of pool = (1 − bs/100). So wire_band_pct = ui /
    // (1 − bs/100). Clamp the divisor to avoid divide-by-zero when bs
    // is 100% (edge case: user gave the entire pool to bootstrap).
    let ladder;
    if (uiBandPcts.length > 0) {
      const mainFraction = Math.max(0.0001, 1 - uiBsPct / 100);
      ladder = {
        mode: 'manual',
        bands: ldCfg.bands.map((b) => ({
          supplyPercent: Number(b.supplyPercent) / mainFraction,
          lowerMultiplier: Number(b.lowerMultiplier),
          upperMultiplier: Number(b.upperMultiplier),
        })),
      };
    } else {
      ladder = { mode: 'off' };
    }

    // Wire distribution[].sharePercent is share of WIDE (slices among
    // themselves sum to 100). UI slice sharePercent is % of pool;
    // normalize within the slices array.
    //
    // Filter out 0% slices first — they contribute nothing to the wide
    // bucket, would normalize to 0 on the wire, and the backend's
    // normalizeDistribution() rejects sharePercent <= 0. Dropping them
    // is a no-op since they don't represent any liquidity allocation.
    // If filtering leaves the array empty (everything is in bs + bands,
    // wide is 0), we send a single placeholder 100% slice; the backend's
    // wide loop is skipped when wideBaseRaw = 0, so the value is unused.
    const nonZeroSlices = p.distribution.filter((s) => (Number(s.sharePercent) || 0) > 0);
    const totalSliceUi = nonZeroSlices.reduce((s, x) => s + (Number(x.sharePercent) || 0), 0);
    let distribution;
    if (totalSliceUi > 0) {
      distribution = nonZeroSlices.map((s) => ({
        sharePercent: (Number(s.sharePercent) || 0) / totalSliceUi * 100,
        recipient: s.useExternalRecipient ? s.recipient : null,
      }));
    } else {
      distribution = [{ sharePercent: 100, recipient: null }];
    }

    return {
      quoteToken: p.quoteToken,
      supplyPercent: p.supplyPercent,
      ammConfigIndex: p.ammConfigIndex,
      quoteUsdOverride: effectiveUsdOverride,
      quoteDecimalsOverride: effectiveDecimalsOverride,
      quoteSymbolOverride: effectiveSymbolOverride,
      distribution,
      bootstrap,
      ladder,
    };
  });
}

// ===========================================================================
// STEP 3: Funding
// ===========================================================================

/**
 * Find the pool config object for a given quote mint, so we can pull
 * resolved metadata (symbol, logo, decimals) for the funding-step rows.
 * The KNOWN_QUOTES (USDC/USDT/SOL) need explicit handling because their
 * pool entries store the symbol ('USDC') in quoteToken rather than the
 * mint address.
 */
function findPoolByMint(mint) {
  return pools.find((p) => {
    const upper = (p.quoteToken || '').toUpperCase();
    if (upper === 'SOL') return false;
    if (upper === 'USDC' && mint === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') return true;
    if (upper === 'USDT' && mint === 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB') return true;
    return p.quoteToken === mint;
  });
}

/**
 * Build the inline-logo HTML for a pool's resolved image. Falls back
 * to a neutral placeholder when no image is available so the row
 * layout stays consistent.
 *
 * Broken URLs are handled by attachRowLogoFallbacks(), which swaps
 * failed images for placeholders without inline event handlers.
 */
function rowLogoHtml(pool) {
  if (pool && pool.resolvedImageUrl) {
    return `<img src="${escapeHtml(pool.resolvedImageUrl)}" alt="" class="row-logo" data-action="row-logo-fail">`;
  }
  return '<span class="row-logo-placeholder"></span>';
}

function replaceRowLogoWithPlaceholder(img) {
  if (!img || !img.parentNode) return;
  const placeholder = document.createElement('span');
  placeholder.className = 'row-logo-placeholder';
  img.parentNode.replaceChild(placeholder, img);
}

function attachRowLogoFallbacks(root) {
  root.querySelectorAll('[data-action="row-logo-fail"]').forEach((img) => {
    img.addEventListener('error', () => {
      replaceRowLogoWithPlaceholder(img);
    }, { once: true });
  });
}

function renderFundingRequirements() {
  document.getElementById('step3WalletAddr').textContent = tempWallet.publicKey;
  // The QR data URL was generated server-side when the wallet was created
  // and stashed on tempWallet alongside publicKey/secretKey. Reuse it here
  // so users on mobile can scan rather than copy-paste the address.
  const step3Qr = document.getElementById('step3QrCode');
  if (step3Qr && tempWallet.qrCode) step3Qr.src = tempWallet.qrCode;

  // ---- Section 1: things the user must send themselves ------------------
  // SOL is always present. Manual-prefund tokens (no auto-swap route, or
  // an auto-swap row that converted after a terminal failure) live here
  // alongside SOL so the user has a single "what do I need to send?" list.
  const sendContainer = document.getElementById('balanceRows');
  sendContainer.innerHTML = '';

  // Initial "needed" display shows the RECOMMENDED total (subtotal +
  // safety buffer). This is what users should aim for when funding —
  // landing exactly on the bare minimum leaves no margin for cost
  // variance, so we encourage depositing the full recommended amount.
  //
  // pollBalances handles the green/red transition: it uses the bare
  // minimum (subtotal - credits) as the "can proceed" threshold, so the
  // row will go green once wallet >= subtotal even if below recommended.
  // When that happens, a small grey/yellow note appears next to the
  // numbers indicating the buffer is below recommended but the launch
  // can still proceed.
  const solReqSol = fundingRequirement.totalSol
    || fundingRequirement.solLamports / 1e9;
  const solRow = document.createElement('div');
  solRow.className = 'balance-row';
  solRow.dataset.kind = 'sol';
  solRow.innerHTML = `
    <span><span class="status-dot"></span><strong>SOL</strong></span>
    <span>
      <span data-field="actual">0</span> /
      <span data-field="needed">${solReqSol.toFixed(3)}</span>
      <span data-field="buffer-note" class="is-size-7 has-text-grey ml-2"></span>
    </span>
  `;
  sendContainer.appendChild(solRow);

  Object.entries(fundingRequirement.byQuote).forEach(([mint, rawAmt]) => {
    const pool = findPoolByMint(mint);
    const decimals = pool?.resolvedDecimals ?? pool?.quoteDecimalsOverride ?? 6;
    const symbol = pool?.resolvedSymbol ?? pool?.quoteSymbolOverride ?? mint.slice(0, 6);
    // neededWhole is the precise target (what the bootstrap actually
    // needs on-chain). displayNeeded is the user-facing rounded form;
    // displayed value may have lost precision via toPrecision/floor in
    // formatTokenDisplay. Polling MUST compare against the precise
    // value (stashed on dataset) — comparing against the rounded text
    // would produce false "met" states for small fractional targets.
    const neededWhole = rawAmt / Math.pow(10, decimals);
    const displayNeeded = formatTokenDisplay(neededWhole);

    const row = document.createElement('div');
    row.className = 'balance-row';
    row.dataset.kind = 'token';
    row.dataset.mint = mint;
    row.dataset.decimals = decimals;
    row.dataset.target = String(neededWhole);
    row.innerHTML = `
      <span><span class="status-dot"></span>${rowLogoHtml(pool)}<strong>${escapeHtml(symbol)}</strong></span>
      <span><span data-field="actual">0</span> / <span data-field="needed">${displayNeeded}</span></span>
    `;
    sendContainer.appendChild(row);
  });

  // ---- Section 2: things the system will acquire on the user's behalf ----
  // Each row shows the target amount and a status indicator. No "0 / X"
  // ratio here — it'd read as "you need to send X" which is the opposite
  // of what auto-swap means. The status text walks: Pending → Swapping…
  // → Acquired ✓ → (or, on terminal failure, the row gets converted to
  // a Section-1 manual row by convertAutoSwapRowToManual).
  const autoContainer = document.getElementById('autoSwapRows');
  const autoSection = document.getElementById('autoSwapSection');
  autoContainer.innerHTML = '';
  const autoPlan = fundingRequirement.autoSwapPlan || [];
  if (autoPlan.length > 0) {
    autoSection.style.display = '';
    for (const item of autoPlan) {
      const pool = findPoolByMint(item.quoteMint);
      // Two different "target" concepts for an auto-swap row:
      //   - acquireWhole: what the swap aims for (oversize, $2). This is
      //     what we DISPLAY ("≈ 1000") so the user sees how much we're
      //     trying to obtain.
      //   - minWhole: the actual bootstrap on-chain need ($1). This is
      //     what we use for the "met" check — a 50% partial fill of the
      //     acquire target still meets minWhole, so the row marks green
      //     and the user can proceed.
      const acquireWhole = Number(item.targetRaw) / Math.pow(10, item.quoteDecimals);
      const minWhole = Number(item.minRaw || item.targetRaw) / Math.pow(10, item.quoteDecimals);
      const displayTarget = formatTokenDisplay(acquireWhole);

      const row = document.createElement('div');
      row.className = 'balance-row';
      row.dataset.kind = 'token-autoswap';
      row.dataset.mint = item.quoteMint;
      row.dataset.decimals = item.quoteDecimals;
      // data-target is what polling compares wallet balance against
      // for the "met" state — use the actual bootstrap need.
      row.dataset.target = String(minWhole);
      row.dataset.allocationIndex = item.allocationIndex;
      // Initial status: 'pending' (waiting for SOL + Acquire click). The
      // poll loop and Acquire handler update this as the row progresses.
      // The retry button stays hidden via CSS (.row-retry-btn) until the
      // row enters a retryable failed state — then setRowStatus reveals
      // it. Clicking it re-runs Acquire for just this one row.
      row.innerHTML = `
        <span><span class="status-dot"></span>${rowLogoHtml(pool)}<strong>${escapeHtml(item.quoteSymbol)}</strong>
          <span class="is-size-7 has-text-grey ml-2">≈ ${displayTarget}</span></span>
        <span class="row-status-cell">
          <span data-field="status" class="is-size-7 has-text-grey">Pending</span>
          <button class="row-retry-btn" type="button" title="Retry this swap" aria-label="Retry">
            <i class="fas fa-redo"></i>
          </button>
        </span>
      `;
      autoContainer.appendChild(row);
    }
  } else {
    autoSection.style.display = 'none';
  }

  // Show the Acquire-quote-tokens button only if there's anything to swap.
  const acquireWrap = document.getElementById('acquireQuoteTokensWrap');
  if (acquireWrap) {
    acquireWrap.style.display = autoPlan.length > 0 ? '' : 'none';
  }

  attachRowLogoFallbacks(document.getElementById('step3') || document);
  renderFundingBreakdown();
}

function renderFundingBreakdown() {
  const container = document.getElementById('fundingBreakdown');
  if (!container) return;
  if (!fundingRequirement.solBreakdown && !fundingRequirement.quoteBreakdown) {
    container.innerHTML = '';
    return;
  }

  let html = '<table class="table is-narrow is-fullwidth is-size-7"><tbody>';
  for (const item of fundingRequirement.solBreakdown || []) {
    const isBuffer = /safety buffer/i.test(item.label);
    html += `<tr${isBuffer ? ' class="has-text-grey"' : ''}>
      <td>${escapeHtml(item.label)}</td>
      <td class="has-text-right is-family-monospace">${item.sol.toFixed(4)} SOL</td>
    </tr>`;
  }
  for (const item of fundingRequirement.quoteBreakdown || []) {
    html += `<tr>
      <td>${escapeHtml(item.label)}</td>
      <td class="has-text-right is-family-monospace">${item.amount} ${escapeHtml(item.symbol)}</td>
    </tr>`;
  }
  html += `<tr class="has-text-weight-bold">
    <td>Total SOL</td>
    <td class="has-text-right is-family-monospace">${fundingRequirement.totalSol.toFixed(4)} SOL</td>
  </tr>`;
  html += '</tbody></table>';
  container.innerHTML = html;
}

function startBalancePolling() {
  if (balancePollHandle) clearInterval(balancePollHandle);
  pollBalances();
  balancePollHandle = setInterval(pollBalances, 5000);
}

async function pollBalances() {
  if (!tempWallet) return;
  try {
    const resp = await fetch('/api/check-balance-detailed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ publicKey: tempWallet.publicKey }),
    });
    const data = await resp.json();
    if (!data.success) return;

    const { sol, tokens } = data.balance;
    // -------------------------------------------------------------------
    // SOL requirement: two-threshold model.
    //
    // The funding estimate exposes three numbers:
    //   - subtotalSol: the sum of actual costs (pool creation, positions,
    //                  Arweave, token mint, plus budgeted auto-swap spend).
    //                  This is the BARE MINIMUM needed to complete the
    //                  launch successfully if every step costs exactly
    //                  what we expected.
    //   - bufferSol:   a 20% safety margin layered on top of subtotal,
    //                  to absorb variance (priority-fee spikes, slippage
    //                  overshoots on auto-swaps, etc).
    //   - totalSol:    subtotal + buffer. The "recommended" deposit
    //                  amount, shown in the cost breakdown.
    //
    // Earlier we used totalSol as a hard floor for the "met" check,
    // meaning if you'd eaten into the buffer (even by a tiny amount) the
    // launch was blocked. That's wrong — the buffer is SAFETY MARGIN,
    // not a fixed required reserve. As long as you still have enough for
    // the actual costs, you can proceed; the buffer just gives you
    // breathing room for unexpected variance.
    //
    // Now:
    //   - solMet (can proceed):    wallet >= subtotal - swapCreditApplied
    //   - solHasFullBuffer:        wallet >= total - swapCreditApplied
    //
    // The "needed" display shows the bare minimum (subtotal-credit). If
    // we're between minimum and full-recommended, a small "buffer below
    // recommended — launch may fail on cost overruns" hint shows beside
    // the row but does NOT block proceeding.
    //
    // swapCreditApplied accumulates each completed auto-swap's
    // estSolSpend (the SOL we budgeted to acquire that quote token). Once
    // a swap has actually happened, that SOL is gone from the wallet and
    // doesn't need to be reserved anymore — the credit subtracts the
    // budget from both thresholds so the user sees the requirement
    // shrink as the work completes.
    const subtotalSol = fundingRequirement.subtotalSol || 0;
    const totalSol = fundingRequirement.totalSol || (fundingRequirement.solLamports / 1e9);
    const solCredit = fundingRequirement.solCreditedForCompletedSwaps || 0;
    const solMinNeeded = Math.max(0, subtotalSol - solCredit);
    const solRecommended = Math.max(0, totalSol - solCredit);
    const solMet = sol >= solMinNeeded;
    const solHasFullBuffer = sol >= solRecommended;
    // The displayed "needed" is the bare minimum — the threshold that
    // actually gates proceeding. The recommended figure is shown to the
    // side when the user is below it but above the minimum.
    const solNeeded = solMinNeeded;

    let allMet = true;
    let anyAutoSwapPending = false;

    // ---- Section 1 (Send to wallet): SOL + manual-prefund tokens. -----
    // Each row needs to be 'met' for the launch to proceed.
    document.querySelectorAll('#balanceRows .balance-row').forEach((row) => {
      const kind = row.dataset.kind;

      if (kind === 'sol') {
        row.querySelector('[data-field="actual"]').textContent = sol.toFixed(4);
        // "Needed" shows the RECOMMENDED total (with buffer), even after
        // swap credits are applied. This is what the user should aim for
        // when funding — landing exactly at the bare minimum would mean
        // any unexpected cost variance fails the launch.
        //
        // The row turns green when wallet >= bare minimum (subtotal - credit)
        // so the user can still proceed if they've slightly eaten into the
        // buffer post-funding (e.g. swaps cost a touch more than budgeted).
        // The buffer-note span surfaces the situation when this happens.
        row.querySelector('[data-field="needed"]').textContent = solRecommended.toFixed(3);
        const bufferNote = row.querySelector('[data-field="buffer-note"]');
        if (bufferNote) {
          if (!solMet) {
            // Below bare minimum — can't proceed. Show how much more SOL
            // is actually needed for the launch to be viable (not the
            // buffered amount, just enough to complete the work). This
            // gives the user a clear "send me at least X more SOL" number.
            const short = (solMinNeeded - sol).toFixed(4);
            bufferNote.textContent = `(at least ${short} more SOL needed)`;
            bufferNote.className = 'is-size-7 has-text-danger ml-2';
          } else if (!solHasFullBuffer) {
            // Above minimum, below recommended-with-buffer. Soft hint —
            // launch will work but variance has eaten into the safety
            // margin. Inform the user how much they're short of the
            // recommended buffer so they can top up if they want full safety.
            const short = (solRecommended - sol).toFixed(4);
            bufferNote.textContent = `(below recommended +${short} SOL buffer — can proceed but launch may fail on cost overruns)`;
            bufferNote.className = 'is-size-7 has-text-warning ml-2';
          } else {
            // Above recommended — full buffer intact. No annotation.
            bufferNote.textContent = '';
            bufferNote.className = 'is-size-7 has-text-grey ml-2';
          }
        }
        row.classList.toggle('met', solMet);
        if (!solMet) allMet = false;
        return;
      }

      // Manual-prefund token row: balance goes up only when the user
      // sends tokens themselves. Compares against data-target (precise)
      // not the displayed text (may be rounded by formatTokenDisplay).
      const mint = row.dataset.mint;
      const have = tokens[mint] ? tokens[mint].amountUi : 0;
      const neededWhole = Number(row.dataset.target);
      row.querySelector('[data-field="actual"]').textContent = formatTokenDisplay(have);
      const met = have >= neededWhole;
      row.classList.toggle('met', met);
      if (!met) allMet = false;
    });

    // ---- Section 2 (We'll acquire for you): auto-swap tokens. -----
    // Status text drives the visible state. Possible states:
    //   Pending          → waiting for SOL funding (or click Acquire)
    //   Ready to acquire → SOL is funded, click Acquire button
    //   Swapping…        → set by the Acquire handler during the call
    //   Acquired ✓       → balance >= target
    //   needs more SOL   → set by the Acquire handler on INSUFFICIENT_SOL
    //   failed           → set by the Acquire handler on transient errors
    //
    // Polling only updates status when the row hasn't been explicitly
    // set to a non-default state by the Acquire handler. We detect that
    // by checking for a 'sticky' marker the handler sets — anything
    // marked sticky is left alone here so we don't clobber a user-
    // facing message with a generic 'Pending'.
    document.querySelectorAll('#autoSwapRows .balance-row').forEach((row) => {
      const mint = row.dataset.mint;
      const target = Number(row.dataset.target);
      const have = tokens[mint] ? tokens[mint].amountUi : 0;
      const met = have >= target;
      row.classList.toggle('met', met);
      const status = row.querySelector('[data-field="status"]');
      const sticky = row.dataset.statusSticky === '1';

      if (met) {
        // Acquired — overrides any sticky state since we're done.
        // Also clear the retry button (the row was acquired, no need
        // to retry).
        status.textContent = 'Acquired ✓';
        status.className = 'is-size-7 has-text-success';
        row.dataset.statusSticky = '';
        row.classList.remove('row-can-retry');
        // Belt-and-suspenders SOL credit: if the row is met but its
        // plan item's credit hasn't been applied yet (e.g. swap landed
        // before our polling caught the result, or page state somehow
        // missed the onResult call), apply it here. Idempotent via the
        // _solCredited flag on the plan item.
        const planItem = (fundingRequirement.autoSwapPlan || [])
          .find((p) => p.quoteMint === mint);
        if (planItem && !planItem._solCredited && planItem.estSolSpend) {
          fundingRequirement.solCreditedForCompletedSwaps =
            (fundingRequirement.solCreditedForCompletedSwaps || 0) + planItem.estSolSpend;
          planItem._solCredited = true;
        }
      } else {
        anyAutoSwapPending = true;
        allMet = false;
        if (!sticky) {
          // Row isn't in a user-set state (failure message etc.) — write
          // the default status. Also clear retry button since these are
          // non-failure states.
          row.classList.remove('row-can-retry');
          if (solMet) {
            status.textContent = 'Ready to acquire';
            status.className = 'is-size-7 has-text-info';
          } else {
            status.textContent = 'Pending';
            status.className = 'is-size-7 has-text-grey';
          }
        }
      }
    });

    document.getElementById('continueToTokenBtn').disabled = !allMet;

    // Acquire-quote-tokens button: enabled when SOL is funded AND
    // there are still pending auto-swaps. Disabled-but-visible when
    // SOL is short so the user sees the button is there waiting.
    const acquireBtn = document.getElementById('acquireQuoteTokensBtn');
    if (acquireBtn) {
      acquireBtn.disabled = !solMet || !anyAutoSwapPending;
    }

    // Funder detection: re-attempt whenever SOL goes up (new deposit
    // arrived since last check) AND we don't already have a funder.
    // Previously this used a one-shot exhausted flag that, once set,
    // never tried again — so a transient RPC failure on the first
    // attempt could permanently disable detection. Now we reset the
    // flag on any balance increase, which is the only condition under
    // which a new funder could appear anyway.
    if (sol > lastSolBalance) {
      fundingDetectionExhausted = false;
    }
    if (!fundingWallet && sol > 0 && !fundingDetectionExhausted) {
      detectFundingWallet();
    }
    lastSolBalance = sol;

    // Reset the consecutive-failure counter on any successful poll.
    // (See catch block below.)
    consecutivePollFailures = 0;
  } catch (e) {
    // Polling errors mean we don't have fresh balance data. We don't
    // want to spam the log with every failed poll, but staying silent
    // forever is worse — if the user's RPC is down or the server has
    // crashed, they'd see frozen balances with no indication of why.
    // Compromise: log once at the 3rd consecutive failure (about 15s in)
    // and stay quiet after that.
    consecutivePollFailures++;
    if (consecutivePollFailures === 3) {
      log(
        'Balance polling is failing — RPC or server may be unreachable. ' +
        'Balances shown may be stale.',
        'warning',
      );
    }
  }
}

// Module-scope counter so failure logs throttle across polls.
// Reset in pollBalances() on any successful round-trip.
let consecutivePollFailures = 0;

// Tracks the SOL balance reading from the previous pollBalances cycle.
// Used to detect deposits — when sol > lastSolBalance, a new deposit
// landed and we should re-attempt funder detection (in case the first
// attempt failed with no funder and got marked exhausted).
let lastSolBalance = 0;

// Per-attempt guard so we don't keep firing detection RPC every 5s
// while the user is funding gradually. Reset when:
//   - the wallet is regenerated (entirely new session)
//   - the SOL balance goes up (new deposit, possibly from a new funder)
// Set when:
//   - detection returned no funder (the answer isn't going to change
//     without a new deposit)
let fundingDetectionExhausted = false;

async function detectFundingWallet() {
  try {
    const resp = await fetch('/api/find-funder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ publicKey: tempWallet.publicKey }),
    });
    const data = await resp.json();
    if (data.success && data.result && data.result.funder) {
      fundingWallet = data.result.funder;
      document.getElementById('fundingWalletInfo').classList.remove('hidden');
      document.getElementById('detectedFundingWallet').textContent = fundingWallet;
      log(`Funding wallet identified: ${fundingWallet} (${data.result.amount} SOL)`, 'info');
    } else {
      // No funder found — stop retrying. The detection looks at recent
      // inbound transfers; if there isn't a clear single funder, we
      // shouldn't keep asking. The user can paste their destination
      // address manually in Step 6 anyway.
      fundingDetectionExhausted = true;
    }
  } catch (e) {
    // Network/RPC failure — let the next pollBalances cycle try again
    // (don't set fundingDetectionExhausted). One failure shouldn't
    // permanently disable detection.
  }
}

bind('refreshBalanceBtn', 'click', pollBalances);

// Acquire-quote-tokens button: triggers SOL → quote-token swaps for
// every allocation the funding-estimate flagged as auto-swappable.
//
// Failure handling:
//   - The backend retries internally (multiple pools × retry ladder).
//     We don't retry from here; we just present results.
//   - SUCCESS  → row goes green, user proceeds.
//   - INSUFFICIENT_SOL → row stays auto-swap, message asks user to fund
//     more SOL. (Once they do, click Acquire again — idempotent.)
//   - NO_USABLE_POOL / ALL_ATTEMPTS_FAILED → row CONVERTS to manual-
//     prefund. The user sees the same wallet address + required amount
//     they would have seen if the estimate had routed manual upfront.
//     This is the "no friction" guarantee: even if the auto path
//     completely fails, the user has a working path forward without
//     restarting.
//   - Any other error → treated as transient, row shows retry hint.
// Set a row's status text/color/title and (optionally) mark it sticky
// so the 5s balance-poll doesn't overwrite the message. `canRetry`
// toggles the .row-can-retry class which reveals the per-row retry
// button via CSS; pass true for failure states that the user can
// recover from with another click.
//
// Module-scope (not closure-scoped to the Acquire handler) because the
// per-row retry button needs to call it too.
function setAutoSwapRowStatus(mint, text, color, { sticky = false, title = '', canRetry = false } = {}) {
  const row = document.querySelector(
    `#autoSwapRows .balance-row[data-kind="token-autoswap"][data-mint="${CSS.escape(mint)}"]`,
  );
  const status = row?.querySelector('[data-field="status"]');
  if (!row || !status) return;
  status.textContent = text;
  status.className = `is-size-7 has-text-${color}`;
  status.title = title;
  row.dataset.statusSticky = sticky ? '1' : '';
  row.classList.toggle('row-can-retry', !!canRetry);
}

// Guards against concurrent calls to runAcquireFlow. Both the bulk
// Acquire button and per-row retry buttons consult this — running two
// in parallel against the same wallet causes SOL-balance races (one
// run depletes the funded SOL faster than the other can read it).
// Backend would classify the loser as INSUFFICIENT_SOL, which is
// recoverable but noisy. Avoiding the race entirely is cleaner.
let isAcquireFlowRunning = false;

/**
 * Run the acquire-quote-tokens flow for a given subset of the plan.
 * Used by both the global Acquire button (passing all pending rows)
 * and the per-row retry button (passing just one row's plan item).
 *
 * Drives the UI state machine: Queued → Swapping → Acquired/Failed,
 * updates the top-line progress label, and emits log lines.
 *
 * Returns nothing — failures are surfaced via row states and the log,
 * not via thrown exceptions, so a single bad swap doesn't break the
 * batch. If another acquire flow is already in flight, this returns
 * immediately without doing anything (caller is expected to gate
 * its UI affordance before calling, but we double-check here).
 */
async function runAcquireFlow(planSubset, btn) {
  if (!planSubset.length) return;
  if (isAcquireFlowRunning) {
    log('Another acquire is in progress; please wait for it to finish.', 'warning');
    return;
  }
  // Set the global guard and button-loading state INSIDE try so the
  // finally block can reliably clean them up even if something between
  // here and the network call throws. Without this wrapper, an
  // unexpected exception in setLoading() or row-status-setup code
  // would leave isAcquireFlowRunning permanently true and lock out
  // future acquire attempts.
  isAcquireFlowRunning = true;
  if (btn) setLoading(btn, true);

  const counts = { success: 0, solShort: 0, converted: 0, retryable: 0 };
  let completed = 0;
  const totalPlanned = planSubset.length;

  const updateProgressLabel = () => {
    const label = document.getElementById('autoSwapProgressLabel');
    if (!label) return;
    if (completed >= totalPlanned) {
      label.textContent = `${completed} of ${totalPlanned} processed.`;
    } else {
      label.textContent = `Acquiring — ${completed} of ${totalPlanned} complete…`;
    }
  };

  // Track which rows received a `result` event from the backend. Any
  // rows still missing one after the stream closes are stragglers —
  // either the swap was still running when the connection dropped, or
  // it never got scheduled, or the response stream truncated. Either
  // way we mark them as failed-retryable so the user can recover.
  const resultsReceived = new Set();

  // Mark every selected row as "Queued" so the user sees something
  // happen immediately, even though only 4 workers are running at a
  // time on the backend. Clears any previous retry button.
  for (const item of planSubset) {
    setAutoSwapRowStatus(item.quoteMint, 'Queued', 'grey', { sticky: true });
  }
  updateProgressLabel();

  log(
    `Acquiring ${totalPlanned} quote token${totalPlanned === 1 ? '' : 's'} via Raydium swap…`,
  );

  // Per-event handlers, defined here so they close over counts/progress.
  // (We used to also have an onAttempt handler that flipped a row to
  // "Swapping…" — now done inline in the polling loop based on the
  // server's inProgressMints list, which is more accurate.)
  const onResult = (r) => {
    completed++;
    resultsReceived.add(r.quoteMint);
    if (r.success) {
      counts.success++;
      // Credit this swap's budgeted SOL against the requirement. The
      // original solLamports estimate reserved ~$4 of SOL per auto-swap;
      // now that the swap has completed (the SOL is gone), we subtract
      // that reserve so the SOL row's "needed" reflects only what's
      // still ahead (pool creation, positions, Arweave, headroom).
      //
      // We use estSolSpend from the plan item, not the swap's actual
      // SOL consumption (which we don't have a precise measurement of).
      // Slight over- or under-shoot from the actual cost is absorbed by
      // the original estimate's safety buffer.
      //
      // Guard: only credit ONCE per row. The polling loop replays the
      // full results array on every poll, so onResult might be called
      // for the same mint multiple times across retries; resultsReceived
      // catches that upstream (early-return at the top), but it's worth
      // making the credit explicitly idempotent via the plan item's
      // own flag.
      const planItem = (fundingRequirement.autoSwapPlan || [])
        .find((p) => p.quoteMint === r.quoteMint);
      if (planItem && !planItem._solCredited && planItem.estSolSpend) {
        fundingRequirement.solCreditedForCompletedSwaps =
          (fundingRequirement.solCreditedForCompletedSwaps || 0) + planItem.estSolSpend;
        planItem._solCredited = true;
      }
      setAutoSwapRowStatus(r.quoteMint, 'Acquired ✓', 'success', {
        sticky: false,
        title: r.txId ? `tx: ${r.txId}` : '',
      });
      log(
        `Acquired ${r.quoteSymbol}` +
          (r.txId ? ` (tx ${r.txId.slice(0, 8)}…)` : ' (already had enough)'),
        'success',
      );
      updateProgressLabel();
      return;
    }
    const err = String(r.error || '');
    if (err.startsWith('INSUFFICIENT_SOL')) {
      counts.solShort++;
      setAutoSwapRowStatus(r.quoteMint, 'Needs more SOL — top up & retry', 'warning', {
        sticky: true,
        title: err,
        canRetry: true,
      });
      log(`${r.quoteSymbol}: ${err}`, 'warning');
    } else if (err.startsWith('NO_USABLE_POOL') || err.startsWith('ALL_ATTEMPTS_FAILED')) {
      counts.converted++;
      convertAutoSwapRowToManual(r.quoteMint, r.quoteSymbol);
      log(
        `${r.quoteSymbol}: auto-swap unavailable, switched to manual ` +
          `(send ${r.quoteSymbol} to the wallet address above). Reason: ${err}`,
        'warning',
      );
    } else {
      counts.retryable++;
      setAutoSwapRowStatus(r.quoteMint, 'Failed — click retry', 'danger', {
        sticky: true,
        title: err,
        canRetry: true,
      });
      log(`${r.quoteSymbol}: ${err}`, 'danger');
    }
    updateProgressLabel();
  };

  // Now safe to enter the network phase — guard and loading state are
  // both set, finally will clean them up.
  try {
    // 1. POST to kick off the job. Returns immediately with { jobId }.
    //    The actual swap work runs in the background on the server.
    const resp = await fetch('/api/acquire-quote-tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tempWalletSecretKey: tempWallet.secretKey,
        autoSwapPlan: planSubset,
      }),
    });
    if (!resp.ok) {
      log(`Acquire failed: HTTP ${resp.status}`, 'danger');
      return;
    }
    const { jobId } = await resp.json();
    if (!jobId) {
      log('Acquire failed: no jobId returned', 'danger');
      return;
    }

    // 2. Poll the job until it's done. Each poll is a fresh HTTP round-
    //    trip, naturally robust against network blips: a failed poll
    //    just retries on the next interval. Replaces our old SSE setup
    //    which was unreliable in Electron's fetch+ReadableStream layer.
    //
    //    Update strategy: on each poll, we compute the diff between the
    //    server's reported results and our local resultsReceived set,
    //    and call onResult for each newly-finished swap. Rows shown as
    //    "in progress" by the server get the "Swapping…" status, rows
    //    listed as pending stay "Queued". On a 404 (job expired), we
    //    fall back to polling on-chain balances and flagging stragglers.
    const POLL_INTERVAL_MS = 2000;
    const POLL_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes, matches server-side JOB_EXPIRY_MS
    const pollStartedAt = Date.now();
    let consecutivePollFailures = 0;
    const MAX_POLL_FAILURES = 5; // ~10 seconds of failures before giving up

    while (true) {
      // Bail out if we've been polling forever — defensive guard
      // against a runaway loop if the server gets into an odd state.
      if (Date.now() - pollStartedAt > POLL_TIMEOUT_MS) {
        log('Acquire polling timed out after 10 minutes', 'warning');
        break;
      }

      let pollResp;
      try {
        pollResp = await fetch(`/api/acquire-quote-tokens/${jobId}`);
      } catch (netErr) {
        // Network blip — retry on next interval. Only give up after
        // MAX_POLL_FAILURES consecutive failures.
        consecutivePollFailures++;
        if (consecutivePollFailures >= MAX_POLL_FAILURES) {
          log(
            `Acquire polling failed ${consecutivePollFailures} times in a row — giving up`,
            'warning',
          );
          break;
        }
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        continue;
      }

      if (pollResp.status === 404) {
        // Job is gone (expired or invalid). Could happen if the user
        // hit Acquire again, getting a new jobId, while a previous
        // poll loop is still running with the old one. Just exit
        // cleanly — the finally block will sync row states from
        // on-chain balances.
        log('Acquire job no longer tracked by server', 'info');
        break;
      }
      if (!pollResp.ok) {
        consecutivePollFailures++;
        if (consecutivePollFailures >= MAX_POLL_FAILURES) {
          log(`Acquire polling HTTP ${pollResp.status} — giving up`, 'warning');
          break;
        }
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        continue;
      }

      consecutivePollFailures = 0;
      const job = await pollResp.json();

      // Apply new results that we haven't already processed. The job's
      // results array is append-only on the server, so any entry we
      // haven't seen yet is new since our last poll.
      for (const r of job.results) {
        if (resultsReceived.has(r.quoteMint)) continue;
        // r might be the same shape as the old SSE result events —
        // onResult handles success/failure/conversion routing.
        onResult(r);
      }

      // Update in-progress rows to "Swapping…". Server reports
      // inProgressMints as an array; loop through and set status on
      // any row that isn't already met or already processed.
      //
      // The check for the `met` class is important: wallet-balance
      // polling runs on a separate ~5s interval and may have already
      // marked a row green because its on-chain balance reflects the
      // new tokens. We don't want to flip such a row back to
      // "Swapping…" — that's confusing and triggers a visible flicker.
      // The race is real because swapSolForQuote waits POST_SWAP_SETTLE_MS
      // after the tx confirms before returning, so for ~2 seconds the
      // mint is still in inProgressMints even though the on-chain
      // balance shows it's done.
      const inProgress = new Set(job.inProgressMints || []);
      for (const mint of inProgress) {
        if (resultsReceived.has(mint)) continue;
        const row = document.querySelector(
          `#autoSwapRows .balance-row[data-kind="token-autoswap"][data-mint="${CSS.escape(mint)}"]`,
        );
        if (!row || row.classList.contains('met')) continue;
        setAutoSwapRowStatus(mint, 'Swapping…', 'info', { sticky: true });
      }

      if (job.status === 'done') {
        if (job.error) {
          log(`Acquire job error: ${job.error}`, 'danger');
        }
        // Optimistically clean up the job server-side. Fire-and-forget;
        // if it fails, the server's auto-expiry will catch it in 10 min.
        fetch(`/api/acquire-quote-tokens/${jobId}`, { method: 'DELETE' })
          .catch(() => { /* ignore */ });
        break;
      }

      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }

    // Polling finished. The finally block runs the post-flow cleanup
    // pass (poll balances, flag any leftover stragglers, log summary).
  } catch (e) {
    log(`Acquire error: ${e.message}`, 'danger');
  } finally {
    // Cleanup pass. Runs in finally so it executes regardless of how
    // the try block exited (normal completion, polling timeout, network
    // error, or thrown exception). The three things we need to do
    // unconditionally on exit:
    //
    //   1. Re-poll on-chain balances first. The job's result list might
    //      have missed a swap that landed at the last moment (between
    //      the swap's confirmation and the job-state read). On-chain
    //      balance is the source of truth — polling will mark such rows
    //      Acquired ✓ via the met-class override.
    //
    //   2. Flag any leftover unresolved rows — anything in planSubset
    //      that didn't produce a result AND isn't met on-chain. These
    //      are rare with the polling architecture (only happens if the
    //      polling loop bailed early via timeout or connection failure)
    //      but we still need to give the user a recovery path.
    //
    //   3. Reset button state. setLoading(false) re-enables the button
    //      and removes the spinner. isAcquireFlowRunning=false unlocks
    //      the global guard so the user can click Acquire again.
    try {
      await pollBalances();
      let unresolvedCount = 0;
      for (const item of planSubset) {
        if (resultsReceived.has(item.quoteMint)) continue;
        const row = document.querySelector(
          `#autoSwapRows .balance-row[data-kind="token-autoswap"][data-mint="${CSS.escape(item.quoteMint)}"]`,
        );
        if (!row || row.classList.contains('met')) continue;
        unresolvedCount++;
        setAutoSwapRowStatus(item.quoteMint, 'Unresolved — click retry', 'danger', {
          sticky: true,
          title: 'No final status was received for this swap. Click retry to try again, or click "Acquire quote tokens" to retry all unresolved swaps at once.',
          canRetry: true,
        });
      }
      if (unresolvedCount > 1) {
        // Helpful hint: bulk retry is faster than clicking each row.
        log(
          `${unresolvedCount} swap${unresolvedCount === 1 ? '' : 's'} didn't complete cleanly — ` +
            `click "Acquire quote tokens" to retry all at once, or use the per-row retry buttons.`,
          'warning',
        );
      }

      const parts = [];
      if (counts.success) parts.push(`${counts.success} acquired`);
      if (counts.solShort) parts.push(`${counts.solShort} need more SOL`);
      if (counts.converted) parts.push(`${counts.converted} switched to manual`);
      if (counts.retryable) parts.push(`${counts.retryable} retryable`);
      if (unresolvedCount) parts.push(`${unresolvedCount} unresolved`);
      if (parts.length > 0) {
        log(
          `Done — ${parts.join(', ')}.`,
          counts.retryable || counts.solShort || unresolvedCount ? 'warning' : 'success',
        );
      }
    } catch (cleanupErr) {
      // Cleanup itself failed. Log but don't re-throw — we still want
      // to reset button state below so the user isn't stuck.
      console.error('Acquire flow cleanup failed:', cleanupErr);
    }

    if (btn) setLoading(btn, false);
    isAcquireFlowRunning = false;
  }
}

bind('acquireQuoteTokensBtn', 'click', async () => {
  const btn = document.getElementById('acquireQuoteTokensBtn');
  const plan = fundingRequirement.autoSwapPlan || [];
  if (plan.length === 0) return;

  // Filter to rows that aren't already satisfied. The backend handles
  // idempotency too, but skipping here saves work and avoids blinking
  // through "Queued" for rows that don't need anything.
  const pendingMints = new Set();
  document.querySelectorAll('#autoSwapRows .balance-row[data-kind="token-autoswap"]')
    .forEach((row) => {
      if (!row.classList.contains('met')) {
        pendingMints.add(row.dataset.mint);
      }
    });
  const pendingPlan = plan.filter((p) => pendingMints.has(p.quoteMint));
  if (pendingPlan.length === 0) {
    log('All auto-swap rows already satisfied — nothing to do.', 'info');
    return;
  }

  await withRunState(async () => {
    await runAcquireFlowWithAutoRetry(pendingPlan, btn);
  });
});

/**
 * Run the acquire flow, then if any stragglers remain (rows whose
 * result events never arrived even though the stream closed),
 * automatically re-run for just those rows ONCE before giving up.
 *
 * Rationale: the stream-disconnect bug we see in practice tends to be
 * transient — a second pass through the same rows usually completes
 * cleanly because the wallet's balance has stabilized (no more parallel
 * RPC contention) and the SSE stream is starting fresh. Auto-retrying
 * once handles 90%+ of these cases without making the user click anything.
 *
 * If auto-retry still leaves stragglers, the per-row retry buttons
 * and the bulk Acquire button are the remaining recovery paths.
 */
async function runAcquireFlowWithAutoRetry(planSubset, btn) {
  await runAcquireFlow(planSubset, btn);

  // Find stragglers: rows in the original plan that didn't make it
  // through. We have to look at the DOM here because runAcquireFlow
  // returns void — the row state IS the source of truth.
  const stragglers = [];
  for (const item of planSubset) {
    const row = document.querySelector(
      `#autoSwapRows .balance-row[data-kind="token-autoswap"][data-mint="${CSS.escape(item.quoteMint)}"]`,
    );
    // Skip rows that:
    //   - Don't exist anymore (converted to manual by a NO_USABLE_POOL error)
    //   - Are already met (acquired successfully)
    //   - Are in a non-retryable failure state (INSUFFICIENT_SOL, etc.)
    //     We detect this via the "Needs more SOL" status text — retrying
    //     won't help if the wallet is still short.
    if (!row) continue;
    if (row.classList.contains('met')) continue;
    const statusText = row.querySelector('[data-field="status"]')?.textContent || '';
    if (statusText.includes('Needs more SOL')) continue;
    stragglers.push(item);
  }

  if (stragglers.length === 0) return; // Clean run, nothing to retry.

  log(
    `Auto-retrying ${stragglers.length} unresolved swap${stragglers.length === 1 ? '' : 's'}…`,
    'info',
  );
  // Brief pause so the user notices the state change and so any
  // in-flight RPC operations have a moment to settle.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await runAcquireFlow(stragglers, btn);
}

// Per-row retry: delegated click handler on the auto-swap section.
// Lives at module scope so it survives row re-renders and works on
// rows added after page load. Looks up the row's mint, finds the
// corresponding plan item, and calls runAcquireFlow with just that one.
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('.row-retry-btn');
  if (!btn) return;
  const row = btn.closest('.balance-row[data-kind="token-autoswap"]');
  if (!row) return;
  const mint = row.dataset.mint;
  const planItem = (fundingRequirement.autoSwapPlan || [])
    .find((p) => p.quoteMint === mint);
  if (!planItem) {
    log('Retry: could not find plan item for this row', 'danger');
    return;
  }

  // If another acquire is already running, give the user clear visual
  // feedback rather than silently ignoring the click. Without this, the
  // user can click multiple retry buttons in a row and have no idea why
  // nothing's happening — the guard kicks in inside runAcquireFlow but
  // the rejection message only goes to the log (which most users don't
  // watch). Flash the row's status and shake the button briefly.
  if (isAcquireFlowRunning) {
    const status = row.querySelector('[data-field="status"]');
    if (status) {
      const original = { text: status.textContent, className: status.className };
      status.textContent = 'Wait — another swap is running…';
      status.className = 'is-size-7 has-text-warning';
      setTimeout(() => {
        // Only restore if nothing else has touched it (e.g. the running
        // flow finished and polling overwrote the status to Acquired ✓).
        if (status.textContent === 'Wait — another swap is running…') {
          status.textContent = original.text;
          status.className = original.className;
        }
      }, 2500);
    }
    return;
  }

  // Disable the row's button while running so the user can't fire
  // multiple parallel retries on the same row. setLoading would dim
  // the whole row visually; a simple disabled flag is less intrusive.
  btn.disabled = true;
  try {
    await withRunState(async () => {
      await runAcquireFlow([planItem], null);
    });
  } finally {
    btn.disabled = false;
  }
});

/**
 * Convert an auto-swap row to a manual-prefund row. Used when the
 * backend reports a terminal failure (no Raydium route available, or
 * all swap attempts exhausted). We move the requirement from the
 * "We'll acquire for you" section to the "Send to wallet" section so
 * the user sees exactly what they need to send themselves, with the
 * same address shown above. Polling picks up the new manual row by
 * its data-kind on the next cycle.
 *
 * After conversion:
 *   - The auto-swap section's row is removed entirely (not modified in
 *     place — fresh element created in #balanceRows).
 *   - autoSwapPlan and byQuote are updated to match the new layout.
 *   - The Acquire button hides itself if no auto rows remain.
 *   - The "send manually" tag distinguishes converted rows from the
 *     manual rows the user saw from the start (visual cue that this
 *     wasn't part of the original plan).
 */
function convertAutoSwapRowToManual(quoteMint, quoteSymbol) {
  const oldRow = document.querySelector(
    `#autoSwapRows .balance-row[data-kind="token-autoswap"][data-mint="${quoteMint}"]`,
  );
  if (!oldRow) return;
  const decimals = Number(oldRow.dataset.decimals);
  // data-target is already the actual bootstrap need (minWhole, not the
  // ambitious acquire target). The auto-swap row was DISPLAYING a higher
  // ≈ amount, but the underlying need is what we ask the user to send.
  const manualTarget = Number(oldRow.dataset.target);

  // Remove from the auto-swap section. If the section becomes empty,
  // hide it entirely so the user doesn't see a stranded header.
  oldRow.remove();
  const autoSection = document.getElementById('autoSwapSection');
  if (autoSection && document.querySelectorAll('#autoSwapRows .balance-row').length === 0) {
    autoSection.style.display = 'none';
  }

  // Build the equivalent manual-prefund row in the send section. Same
  // shape as a row created by renderFundingRequirements' Section 1
  // loop, so polling treats it identically. data-target carries the
  // precise value; the displayed text is formatted for readability.
  const pool = findPoolByMint(quoteMint);
  const displayTarget = formatTokenDisplay(manualTarget);
  const newRow = document.createElement('div');
  newRow.className = 'balance-row';
  newRow.dataset.kind = 'token';
  newRow.dataset.mint = quoteMint;
  newRow.dataset.decimals = decimals;
  newRow.dataset.target = String(manualTarget);
  newRow.innerHTML = `
    <span><span class="status-dot"></span>${rowLogoHtml(pool)}<strong>${escapeHtml(quoteSymbol)}</strong>
      <span class="tag is-warning is-light is-small ml-2">send manually</span></span>
    <span><span data-field="actual">0</span> / <span data-field="needed">${displayTarget}</span></span>
  `;
  document.getElementById('balanceRows').appendChild(newRow);
  attachRowLogoFallbacks(newRow);

  // Update fundingRequirement state to match the new layout. Also
  // credit this row's budgeted SOL back: it was reserved for the
  // auto-swap, but the swap isn't happening anymore (the user will
  // manually send the token instead). Without this, the SOL row
  // would falsely report we need extra ~$4 of SOL we no longer do.
  const removedPlanItem = (fundingRequirement.autoSwapPlan || [])
    .find((p) => p.quoteMint === quoteMint);
  if (removedPlanItem && !removedPlanItem._solCredited && removedPlanItem.estSolSpend) {
    fundingRequirement.solCreditedForCompletedSwaps =
      (fundingRequirement.solCreditedForCompletedSwaps || 0) + removedPlanItem.estSolSpend;
    // No need to mark _solCredited on a plan item we're about to drop
    // from the array, but it's cheap consistency.
    removedPlanItem._solCredited = true;
  }
  fundingRequirement.autoSwapPlan = (fundingRequirement.autoSwapPlan || [])
    .filter((p) => p.quoteMint !== quoteMint);
  if (!fundingRequirement.byQuote) fundingRequirement.byQuote = {};
  fundingRequirement.byQuote[quoteMint] = Math.ceil(manualTarget * Math.pow(10, decimals));

  // Hide the Acquire button if no auto rows remain.
  const acquireWrap = document.getElementById('acquireQuoteTokensWrap');
  if (acquireWrap && fundingRequirement.autoSwapPlan.length === 0) {
    acquireWrap.style.display = 'none';
  }
}

bind('continueToTokenBtn', 'click', () => {
  if (balancePollHandle) {
    clearInterval(balancePollHandle);
    balancePollHandle = null;
  }
  setStepSummary(3, `funded`);
  activateStep(4);
});

// ===========================================================================
// STEP 4: Create token
// ===========================================================================

bind('createTokenBtn', 'click', async () => {
  const btn = document.getElementById('createTokenBtn');
  await withRunState(async () => {
    setLoading(btn, true);
    try {
      log('Creating token...');
      const formData = new FormData();
      formData.append('tempWalletSecretKey', JSON.stringify(tempWallet.secretKey));
      formData.append('name', document.getElementById('tokenName').value.trim());
      formData.append('symbol', document.getElementById('tokenSymbol').value.trim());
      formData.append('description', document.getElementById('tokenDescription').value.trim());
      // Strip thousand-separator commas before sending. Keep this as a
      // string so large but valid SPL supplies do not lose integer precision
      // in JavaScript before the server converts to BigInt.
      const totalSupplyRaw = getIntegerInputString(document.getElementById('tokenSupply'));
      formData.append('totalSupply', totalSupplyRaw);
      // Quote mints from every configured pool. The server uses these to
      // search for a launched-token keypair that sorts smaller than all
      // of them, so the launched token is mintA in every pool. Filter out
      // pools whose mint hasn't resolved yet (e.g. user is mid-typing) —
      // the server will validate and either succeed with whatever's
      // present or fail loud.
      const quoteMints = pools
        .map((p) => p.resolvedMint)
        .filter((m) => typeof m === 'string' && m.length > 0);
      formData.append('quoteMints', JSON.stringify(quoteMints));
      const logoFile = document.getElementById('tokenLogo').files[0];
      if (logoFile) formData.append('logo', logoFile);

      const resp = await fetch('/api/create-token', { method: 'POST', body: formData });
      const data = await resp.json();
      if (!data.success) throw new Error(data.error);

      createdTokenInfo = {
        mint: data.tokenMint,
        decimals: data.decimals || 9,
        totalSupply: totalSupplyRaw,
        name: data.name || document.getElementById('tokenName').value.trim(),
        symbol: data.symbol || document.getElementById('tokenSymbol').value.trim(),
      };

      document.getElementById('tokenMintAddress').textContent = data.tokenMint;
      document.getElementById('tokenSolscanLink').href =
        `https://solscan.io/token/${data.tokenMint}`;
      document.getElementById('tokenCreatedInfo').classList.remove('hidden');
      // Hide the Create button after success — clicking it again would mint
      // a second token and overwrite createdTokenInfo, abandoning the first.
      document.getElementById('createTokenBtn').classList.add('hidden');
      log(`Token created: ${data.tokenMint}`, 'success');
    } catch (e) {
      log(`Token creation failed: ${e.message}`, 'danger');
    } finally {
      setLoading(btn, false);
    }
  });
});

bind('continueToLpBtn', 'click', () => {
  setStepSummary(4, `${createdTokenInfo.symbol} — ${createdTokenInfo.mint.slice(0, 8)}…`);
  renderLpSummary();
  activateStep(5);
});

// ===========================================================================
// STEP 5: Create LP
// ===========================================================================

function renderLpSummary() {
  const summary = document.getElementById('lpSummary');
  const targetMc = parseNumberInput(document.getElementById('targetMarketCap'));
  // Guard against zero / NaN total supply — the form field should never
  // accept that, but if something upstream produced a degenerate value
  // we surface a clear error instead of rendering "Infinity" or "NaN"
  // and proceeding into a broken launch.
  const totalSupply = Number(createdTokenInfo.totalSupply);
  if (!isFinite(totalSupply) || totalSupply <= 0) {
    summary.innerHTML =
      '<p class="has-text-danger"><strong>Invalid token supply.</strong> ' +
      'Please go back to Step 4, fix the total supply, and recreate the token.</p>';
    return;
  }
  const launchedTokenUsd = targetMc / totalSupply;

  // Escape every interpolation that includes user-provided or indexer-
  // sourced text. Token symbols, names, and quote symbols can contain
  // anything (the symbol field is free-form user input; resolvedSymbol
  // comes from on-chain metadata or third-party indexers and is not
  // sanitized at the source).
  const symSafe = escapeHtml(createdTokenInfo.symbol || '');

  let html = `
    <p>Ready to create <strong>${pools.length}</strong> pool${pools.length === 1 ? '' : 's'}
    for <strong>${symSafe}</strong> at <strong>$${launchedTokenUsd.toFixed(8)}</strong>
    per token (${targetMc.toLocaleString()} USD market cap).</p>
    <ul>
  `;
  for (const p of pools) {
    const quoteSafe = escapeHtml(p.resolvedSymbol || p.quoteToken || '');
    const sliceCount = p.distribution.length;
    const externalCount = p.distribution.filter((s) => s.useExternalRecipient && s.recipient).length;
    html += `<li><strong>${quoteSafe}</strong> pool — ${p.supplyPercent}% of supply, `;
    html += `${sliceCount} slice${sliceCount === 1 ? '' : 's'}`;
    if (externalCount > 0) html += ` (${externalCount} to external wallet${externalCount === 1 ? '' : 's'})`;
    html += `</li>`;
  }
  html += `</ul>`;
  html += `<p>Lock liquidity (Burn &amp; Earn): <strong>${document.getElementById('lockPositions').checked ? 'Yes' : 'No'}</strong></p>`;
  summary.innerHTML = html;
}

bind('createLpBtn', 'click', async () => {
  const btn = document.getElementById('createLpBtn');
  await withRunState(async () => {
    setLoading(btn, true);
    try {
      document.getElementById('lpProgress').classList.remove('hidden');
      document.getElementById('lpProgressTree').innerHTML = '';
      // Hide any stale failure banner from a prior attempt. This matters
      // for the pre-flight-retry case: if the previous attempt failed in
      // pre-flight and the user fixed their allocation, the failure
      // notification needs to go away when they re-click Create Pools so
      // they don't see "Validation failed..." next to a now-running launch.
      document.getElementById('lpFailInfo').classList.add('hidden');

      const allocations = buildAllocationsForApi();
      const targetMc = parseNumberInput(document.getElementById('targetMarketCap'));
      const lockPositions = document.getElementById('lockPositions').checked;

      log(`Starting pool creation for ${pools.length} pool(s)...`);
      addProgressIntro();
      buildPhaseProgressTree(pools, lockPositions);

      const resp = await fetch('/api/create-lp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tempWalletSecretKey: tempWallet.secretKey,
          tokenMint: createdTokenInfo.mint,
          tokenDecimals: createdTokenInfo.decimals,
          tokenTotalSupply: createdTokenInfo.totalSupply,
          targetMarketCapUsd: targetMc,
          allocations,
          lockPositions,
        }),
      });
      // The /api/create-lp endpoint returns JSON for both success (200)
      // and structured failure (500 with body). A non-JSON 5xx response
      // means something upstream of the route handler died (express
      // crashed, proxy returned an error page, etc) and the user
      // shouldn't see the cryptic "Unexpected token < in JSON" they'd
      // get from a blind resp.json().
      let data;
      try {
        data = await resp.json();
      } catch (parseErr) {
        if (!resp.ok) {
          throw new Error(
            `Server returned HTTP ${resp.status} with non-JSON body. ` +
            `This usually means the server crashed or a proxy intervened. ` +
            `Check the server console for details.`,
          );
        }
        throw new Error(`Unexpected response: ${parseErr.message}`);
      }

      if (data.success) {
        lpResult = data;
        data.results.forEach((r, i) => markPoolDone(i, r));
        markAllBootstrapsDone();
        log(`All ${data.results.length} pool(s) created and bootstrapped`, 'success');
        document.getElementById('lpDoneInfo').classList.remove('hidden');
        document.getElementById('lpDoneSummary').innerHTML = buildLpDoneSummary(data.results);
        // Hide the Create Pools button — re-clicking would attempt to create
        // duplicate pools for the same token, which is wasteful and confusing.
        document.getElementById('createLpBtn').classList.add('hidden');
      } else {
        // Phase-aware partial-failure rendering. The orchestrator returns
        // failedPhase = 'pre_flight', 'main_positions', 'bootstrap', 'locks',
        // or 'transfers' so we can mark the right rows as failed without
        // misrepresenting what completed.
        //
        // Under the deferred-lock model:
        //   - 'main_positions': pool may have been created, slice opens failed
        //   - 'bootstrap': mains opened in every pool, some bootstraps failed
        //   - 'locks': all opens succeeded across all pools, some locks failed
        //   - 'transfers': all opens + locks succeeded, some Fee Key transfers
        //     failed (non-blocking — leftover NFTs sweep back to user)
        lpResult = { results: data.partialResults || [] };
        const failedPhase = data.failedPhase || 'main_positions';

        if (failedPhase === 'pre_flight') {
          // Validation failed BEFORE any pool was created — nothing is on
          // chain yet. Mark only the offending allocation as failed; the
          // others stay as "pending" since they were never attempted.
          // The lpFailInfo notification surfaces the reason (typically a
          // Token-2022 mint with extensions Raydium doesn't support).
          if (data.failedAllocationIndex != null) {
            markPoolFailed(data.failedAllocationIndex, data.error);
          }
        } else if (failedPhase === 'main_positions') {
          // Pools whose main positions completed successfully; the failed
          // pool's main row gets the failure marker. No bootstraps ran yet.
          (data.partialResults || []).forEach((r) => {
            markPoolDone(r.allocationIndex, r);
          });
          if (data.failedAllocationIndex != null) {
            markPoolFailed(data.failedAllocationIndex, data.error);
          }
        } else if (failedPhase === 'bootstrap') {
          // All main positions completed; bootstrapping failed partway.
          // Mark every pool's main rows as done, then mark each bootstrap
          // row done if its result entry has a populated bootstrap field,
          // and mark every failed pool's bootstrap as failed.
          (data.partialResults || []).forEach((r) => {
            markPoolDone(r.allocationIndex, r);
            if (r.bootstrap) markBootstrapDoneForPool(r.allocationIndex, r.bootstrap);
          });
          // bootstrapFailures is an array of { allocationIndex, quoteSymbol, error }
          // for each bootstrap that failed. Falls back to failedAllocationIndex
          // for backward compatibility with older error shapes that didn't carry
          // the array.
          const failures = data.bootstrapFailures
            || (data.failedAllocationIndex != null
              ? [{ allocationIndex: data.failedAllocationIndex, error: data.error }]
              : []);
          for (const f of failures) {
            markBootstrapFailedForPool(f.allocationIndex, f.error);
          }
        } else if (failedPhase === 'locks' || failedPhase === 'transfers') {
          // All pools, mains, and bootstraps are open on-chain. The failure
          // is in the post-open lock or transfer phase. Mark every pool's
          // main and bootstrap rows as done (they did open successfully),
          // but leave the per-position lock/transfer markers in their
          // current state — the partialResults entries carry per-position
          // `locked` and `transferredTo` flags that the progress tree could
          // be enhanced to read from later. For now the user sees a clear
          // recovery message via lpFailInfo below.
          (data.partialResults || []).forEach((r) => {
            markPoolDone(r.allocationIndex, r);
            if (r.bootstrap) markBootstrapDoneForPool(r.allocationIndex, r.bootstrap);
          });
        }

        log(`Pool creation failed (phase: ${failedPhase}): ${data.error}`, 'danger');
        document.getElementById('lpFailInfo').classList.remove('hidden');

        // Friendlier error summary. The raw on-chain error message is often
        // an opaque JSON blob ("InstructionError: [2, {Custom: 2022}]"); if
        // we recognize a known pattern, translate it into something a human
        // can act on. Otherwise pass through the original.
        const rawErr = String(data.error || 'unknown error');
        let friendly = rawErr;
        if (failedPhase === 'pre_flight') {
          // Pre-flight errors are already human-readable (we wrote them).
          // Pass through verbatim — they typically explain exactly which
          // unsupported Token-2022 extensions were detected.
          friendly = rawErr;
        } else if (/Custom["':]\s*2022/.test(rawErr)) {
          friendly =
            'Anchor constraint violation (code 2022, ConstraintMintTokenProgram) — ' +
            'this means a Token-2022 mint was passed where the SPL Token program was ' +
            'expected. This commonly happens with pump.fun tokens and other Token-2022 ' +
            'mints. The latest build should detect these automatically; if you\'re ' +
            'still seeing this, the quote token may have an unusual extension that\'s ' +
            'not yet supported.';
        } else if (/insufficient.*lamports|0x1.*lamports/i.test(rawErr)) {
          friendly =
            'The ephemeral wallet ran out of SOL partway through. Cost variance ' +
            'on this launch exceeded the safety buffer.';
        }
        document.getElementById('lpFailSummary').textContent = friendly;

        // Show counts so the user knows what state things are in. These are
        // useful for understanding what they're recovering vs what they've
        // permanently put on-chain.
        const successCount = (data.partialResults || []).length;
        const totalCount = pools.length;
        const failedAlloc = data.failedAllocation;
        const failedSymbol = failedAlloc?.quoteSymbol
          || failedAlloc?.quoteToken
          || `allocation ${data.failedAllocationIndex}`;

        if (failedPhase === 'pre_flight') {
          // Nothing was attempted on chain. Tell the user this is a clean
          // abort — no SOL spent, no on-chain artifacts to clean up. The
          // "Skip to Transfer Assets" path is still available (they may
          // want to abandon and try over) but the primary recovery is
          // just to fix the allocation and re-click Create Pools.
          document.getElementById('lpFailHeading').textContent =
            'Validation failed before pool creation started.';
          document.getElementById('lpFailSucceededCount').innerHTML =
            `Nothing has been created on-chain yet — the failure is in ` +
            `the pre-launch validation of <strong>${escapeHtml(failedSymbol)}</strong>. ` +
            `Fix or remove this allocation and click Create Pools again; no SOL was spent.`;
          document.getElementById('lpFailReassurance').innerHTML =
            `<strong>No on-chain side effects.</strong> The ephemeral wallet still holds ` +
            `everything it did before you clicked Create Pools (SOL, any auto-swapped ` +
            `quote tokens). You can either fix the failing allocation above and retry, ` +
            `or sweep everything back to your destination wallet.`;
          document.getElementById('continueToTransferAfterFailBtnLabel').textContent =
            'Or sweep wallet to destination';
        } else {
          // Mid-launch failure — at least one pool was created and the
          // on-chain state can't be rolled back. Distinguish by phase:
          //   - 'bootstrap':  pools created, missing bootstraps. Recoverable
          //                   in place via Retry bootstraps.
          //   - 'locks':      all opens done across every pool, some locks
          //                   failed. Resume retries just the unlocked.
          //   - 'transfers':  all locks done, some Fee Key transfers failed.
          //                   Non-blocking — leftover NFTs sweep back to user.
          //   - 'main_positions' (default fallback): a slice open failed.
          //                   Not recoverable in place; must sweep and start
          //                   over (mid-Phase-1 partial recovery is a wider
          //                   refactor not done yet).
          let heading;
          if (failedPhase === 'bootstrap') {
            heading = 'Some pools couldn\'t be bootstrapped.';
          } else if (failedPhase === 'locks') {
            heading = 'Some positions couldn\'t be locked.';
          } else if (failedPhase === 'transfers') {
            heading = 'Some Fee Key transfers couldn\'t be delivered.';
          } else {
            heading = 'Pool creation failed partway through.';
          }
          document.getElementById('lpFailHeading').textContent = heading;
          document.getElementById('lpFailSucceededCount').innerHTML =
            `<strong>${successCount} of ${totalCount}</strong> pool${successCount === 1 ? '' : 's'} ` +
            `created successfully before the failure on <strong>${escapeHtml(failedSymbol)}</strong>. ` +
            `The created pools are permanent on-chain; their LP NFTs are in your ephemeral wallet.`;
          if (failedPhase === 'bootstrap') {
            // Bootstrap-only failures: pools and main positions are all
            // good, just the bootstrap leg is missing on some. Retrying
            // is safe and the typical fix.
            document.getElementById('lpFailReassurance').innerHTML =
              `<strong>Main positions are in place for every pool.</strong> Only the bootstrap ` +
              `leg failed for the pools listed above — these pools won't be tradable at the ` +
              `intended price until their bootstraps land. Click <strong>Retry bootstraps</strong> ` +
              `to try again (most bootstrap failures are transient RPC issues). If retrying ` +
              `keeps failing, sweep the wallet to your destination and manually add bootstrap ` +
              `liquidity in the Raydium UI later.`;
          } else if (failedPhase === 'locks') {
            // Lock-phase failures: every pool's main and bootstrap positions
            // are open on-chain (and the bootstraps make the pools tradable).
            // The positions just haven't been locked yet, which means the
            // ephemeral wallet can still close them — assets are recoverable
            // either by completing the locks or by sweeping the wallet back
            // (which would also close the open positions).
            document.getElementById('lpFailReassurance').innerHTML =
              `<strong>Every pool is open and tradable.</strong> The missing step is the lock — ` +
              `until locks finish, the LP'd tokens are still recoverable by the launch wallet. ` +
              `Click <strong>Resume launch</strong> to try the remaining locks again (most lock ` +
              `failures are transient RPC issues). If locks keep failing and you'd rather walk ` +
              `away, sweep the wallet to your destination — the open positions get closed and ` +
              `their LP tokens come back with the sweep.`;
          } else if (failedPhase === 'transfers') {
            // Transfer-phase failures are non-blocking conceptually: every
            // pool is locked successfully, only the courtesy of delivering
            // Fee Key NFTs to recipient addresses didn't complete. The
            // un-transferred NFTs are in the launch wallet and will sweep
            // to the user's destination wallet.
            document.getElementById('lpFailReassurance').innerHTML =
              `<strong>The launch itself succeeded.</strong> Every pool is created, tradable, and ` +
              `locked. The only thing that didn't finish was the delivery of Fee Key NFTs to ` +
              `recipient addresses you specified. Those NFTs are in your launch wallet and will ` +
              `come along with the final sweep to your destination wallet, so nothing is lost. ` +
              `You can manually send them to the intended recipients afterward, or click ` +
              `<strong>Resume launch</strong> to try the deliveries again.`;
          } else {
            // Main-positions failure: at least one pool was created but
            // its main positions couldn't be opened (or the next pool
            // couldn't be created). The resume endpoint can pick up
            // from where the failure happened — completed pools are
            // skipped, only the missing work is retried.
            document.getElementById('lpFailReassurance').innerHTML =
              `<strong>Your assets are safe</strong> — they're still in the ephemeral wallet ` +
              `(SOL, any auto-swapped quote tokens, and the LP NFTs from pools that did succeed). ` +
              `Click <strong>Resume launch</strong> to retry just the missing pools — already-` +
              `created pools will be skipped. If retrying keeps failing, you can sweep the wallet ` +
              `back to your destination as a last resort; the pools that succeeded above are ` +
              `permanent on-chain.`;
          }
          // Continue/sweep button label. For 'bootstrap' and 'locks',
          // the user has unfinished work that retry can fix in place,
          // so the sweep alternative reads as a secondary "give up"
          // option ("Or sweep to destination instead"). For 'transfers'
          // and the default main_positions case, the alternative IS
          // the primary recovery path (sweep collects everything),
          // so it reads as "Skip to Transfer Assets".
          document.getElementById('continueToTransferAfterFailBtnLabel').textContent =
            (failedPhase === 'bootstrap' || failedPhase === 'locks')
              ? 'Or sweep to destination instead'
              : 'Skip to Transfer Assets';
        }

        // Resume button visibility: meaningful for any post-pre-flight
        // failure (main_positions, bootstrap, locks, transfers). The
        // button calls a unified /api/resume-launch endpoint that
        // inspects per-position state in priorResults and skips any
        // operation already done. Pre-flight failures don't need the
        // button — the user fixes the config and re-clicks Create Pools.
        const retryBtn = document.getElementById('retryBootstrapsBtn');
        const retryLabel = retryBtn.querySelector('span:last-child');
        if (failedPhase !== 'pre_flight') {
          retryBtn.classList.remove('hidden');
          // Phase-specific label. Bootstrap gets its own verb ("Retry
          // bootstraps") because that's the established muscle memory
          // for that case; everything else uses the generic "Resume launch"
          // since the resume endpoint will figure out what to do.
          if (retryLabel) {
            retryLabel.textContent = failedPhase === 'bootstrap'
              ? 'Retry bootstraps'
              : 'Resume launch';
          }
          // Stash the data the retry endpoint needs. We pull it back out
          // in the click handler instead of closing over it — the click
          // handler is registered once at module load and shouldn't
          // capture stale state from a specific failure.
          retryBtn.dataset.lockPositions = String(lockPositions);
        } else {
          retryBtn.classList.add('hidden');
        }

        // For mid-launch failures, hide the Create Pools button — pools
        // that were created already are immutable, and re-clicking would
        // attempt to create duplicate pools for the same token (wasteful
        // and confusing). Recovery is via "Skip to Transfer Assets".
        //
        // For pre-flight failures, KEEP the button visible — nothing was
        // attempted on chain. The user just needs to fix their allocation
        // (remove the incompatible quote, swap to a different mint, or
        // fix RPC settings) and click Create Pools again. Hiding the
        // button here would force them into "Skip to Transfer Assets",
        // wasting the SOL they already spent on token creation.
        if (failedPhase !== 'pre_flight') {
          document.getElementById('createLpBtn').classList.add('hidden');
        }
      }
    } catch (e) {
      log(`LP creation failed: ${e.message}`, 'danger');
    } finally {
      setLoading(btn, false);
    }
  });
});

// Build the entire progress tree as four phase blocks, matching the
// orchestrator's execution order:
//
//   Phase 1 — Create pools and open main positions
//   Phase 2 — Open bootstrap positions
//   Phase 3 — Lock positions (only when lockPositions=true)
//   Phase 4 — Transfer Fee Keys to recipients (only when at least one
//             slice has an external recipient AND lockPositions=true,
//             since Fee Keys only exist for locked positions)
//
// Within each phase, rows are listed pool-by-pool (Pool 1 things, then
// Pool 2 things, etc.). This is the structure that matches what the
// orchestrator actually does and produces a coherent narrative when the
// user reads top-to-bottom after a launch completes.
//
// Rows are uniquely identified by data-pool-idx + data-stage attributes
// rather than per-pool container IDs, so marker functions can query each
// row independently regardless of which phase block it lives in.
function buildPhaseProgressTree(pools, lockPositions) {
  const tree = document.getElementById('lpProgressTree');

  // Ladder context — same for every pool in the simple-UI flow (ladder
  // is currently a global toggle, not per-pool). Read from simpleConfig
  // rather than threading it through from the caller; the tree is built
  // at click time when the config is current. In customize mode the
  // ladder is always off (no per-pool ladder UI yet).
  const ladderEnabled =
    simpleConfig.mode === 'default' && simpleConfig.ladderEnabled;
  const ladderBandCount = ladderEnabled
    ? Number(simpleConfig.ladderBandCount) || LADDER_DEFAULT_BANDS
    : 0;

  // --- Phase 1: pool creates + main opens + ladder opens
  const phase1 = document.createElement('div');
  phase1.className = 'progress-pool';
  phase1.id = 'pp-phase1';
  let phase1Rows = '';
  pools.forEach((p, i) => {
    const label = `Pool ${i + 1} (${p.resolvedSymbol || p.quoteToken})`;
    const sliceCount = p.distribution.length;
    phase1Rows += `<div class="progress-step pending" data-pool-idx="${i}" data-stage="pool"><span class="icon">◯</span>${label} — Create pool</div>`;
    for (let s = 0; s < sliceCount; s++) {
      phase1Rows += `<div class="progress-step pending" data-pool-idx="${i}" data-stage="slice-${s}"><span class="icon">◯</span>${label} — Open slice ${s + 1} of ${sliceCount}</div>`;
    }
    // Ladder bands per pool, ordered low-to-high (band 1 = closest to launch)
    for (let b = 0; b < ladderBandCount; b++) {
      phase1Rows += `<div class="progress-step pending" data-pool-idx="${i}" data-stage="ladder-${b}"><span class="icon">◯</span>${label} — Open ladder band ${b + 1} of ${ladderBandCount}</div>`;
    }
  });
  phase1.innerHTML = `
    <p class="has-text-weight-bold">Phase 1 — Open main positions</p>
    <p class="is-size-7 has-text-grey mb-1">Pools are created and main positions opened (single-sided in your token). Positions are recoverable by the launch wallet until Phase 3 locks them.</p>
    ${phase1Rows}
  `;
  tree.appendChild(phase1);

  // --- Phase 2: bootstrap opens
  const phase2 = document.createElement('div');
  phase2.className = 'progress-pool';
  phase2.id = 'pp-phase2';
  let phase2Rows = '';
  pools.forEach((p, i) => {
    const label = `Pool ${i + 1} (${p.resolvedSymbol || p.quoteToken})`;
    phase2Rows += `<div class="progress-step pending" data-pool-idx="${i}" data-stage="bs-open"><span class="icon">◯</span>${label} — Open bootstrap</div>`;
  });
  phase2.innerHTML = `
    <p class="has-text-weight-bold mt-3">Phase 2 — Open bootstrap positions</p>
    <p class="is-size-7 has-text-grey mb-1">Each pool becomes tradable as its bootstrap lands. Runs after every pool's main positions are in place so all pools cross the tradability line together.</p>
    ${phase2Rows}
  `;
  tree.appendChild(phase2);

  // --- Phase 3: locks (mains, then ladder bands, then bootstrap — per pool)
  // Skipped entirely when lockPositions=false — there will be no locked
  // positions and so no Phase 3 work; rendering the rows would mislead
  // the user into thinking Phase 3 runs when the orchestrator actually
  // bypasses it.
  if (lockPositions) {
    const phase3 = document.createElement('div');
    phase3.className = 'progress-pool';
    phase3.id = 'pp-phase3';
    let phase3Rows = '';
    pools.forEach((p, i) => {
      const label = `Pool ${i + 1} (${p.resolvedSymbol || p.quoteToken})`;
      const sliceCount = p.distribution.length;
      for (let s = 0; s < sliceCount; s++) {
        phase3Rows += `<div class="progress-step pending" data-pool-idx="${i}" data-stage="lock-${s}"><span class="icon">◯</span>${label} — Lock slice ${s + 1}</div>`;
      }
      for (let b = 0; b < ladderBandCount; b++) {
        phase3Rows += `<div class="progress-step pending" data-pool-idx="${i}" data-stage="ladder-lock-${b}"><span class="icon">◯</span>${label} — Lock ladder band ${b + 1}</div>`;
      }
      phase3Rows += `<div class="progress-step pending" data-pool-idx="${i}" data-stage="bs-lock"><span class="icon">◯</span>${label} — Lock bootstrap</div>`;
    });
    phase3.innerHTML = `
      <p class="has-text-weight-bold mt-3">Phase 3 — Lock positions</p>
      <p class="is-size-7 has-text-grey mb-1">Locks burn the position NFTs and mint Fee Key NFTs. After this, the LP'd tokens are committed for life and only fees can be claimed. Failures are retryable in place.</p>
      ${phase3Rows}
    `;
    tree.appendChild(phase3);

    // --- Phase 4: transfers — only render if at least one slice has a recipient
    const anyRecipient = pools.some((p) =>
      p.distribution.some((d) => d.useExternalRecipient && d.recipient),
    );
    if (anyRecipient) {
      const phase4 = document.createElement('div');
      phase4.className = 'progress-pool';
      phase4.id = 'pp-phase4';
      let phase4Rows = '';
      pools.forEach((p, i) => {
        const label = `Pool ${i + 1} (${p.resolvedSymbol || p.quoteToken})`;
        const sliceCount = p.distribution.length;
        for (let s = 0; s < sliceCount; s++) {
          if (p.distribution[s].useExternalRecipient && p.distribution[s].recipient) {
            phase4Rows += `<div class="progress-step pending" data-pool-idx="${i}" data-stage="xfer-${s}"><span class="icon">◯</span>${label} — Transfer slice ${s + 1} Fee Key to recipient</div>`;
          }
        }
      });
      phase4.innerHTML = `
        <p class="has-text-weight-bold mt-3">Phase 4 — Transfer Fee Keys to recipients</p>
        <p class="is-size-7 has-text-grey mb-1">Sends the Fee Key NFTs for slices with external recipients to those recipient addresses. Transfer failures are non-blocking — any undelivered Fee Keys sweep back to your destination wallet at the end.</p>
        ${phase4Rows}
      `;
      tree.appendChild(phase4);
    }
  }
}

// One-time note added to the progress tree at the start of LP creation, to
// prevent the user from worrying that nothing is happening. Per-step progress
// tracking would require server-side streaming (SSE/WS) — for now the user
// just sees pending → done at the end. Server console shows the live progress.
function addProgressIntro() {
  const tree = document.getElementById('lpProgressTree');
  const note = document.createElement('div');
  note.className = 'notification is-info is-light is-size-7 py-2 px-3 mb-3';
  note.innerHTML =
    '<i class="fas fa-info-circle"></i>&nbsp;Creating pools and positions can take several minutes. ' +
    'Each step submits a transaction and waits for confirmation. ' +
    'Live progress is logged to the server console. ' +
    'The checkmarks below will populate when the operation completes.';
  tree.appendChild(note);
}

// Mark progress rows for a pool based on what actually completed.
//
// Under the phase-organized tree, each pool's rows are distributed
// across the four phase blocks (pp-phase1..pp-phase4). We find each
// row by its data-pool-idx + data-stage attribute combination, and
// inspect the corresponding piece of state on poolResult to decide
// whether to mark the row done.
//
// Per-position state we look at:
//   - poolResult.poolId               → "Create pool" row
//   - mainPositions[i].nftMint        → "Open slice i" row
//   - mainPositions[i].locked         → "Lock slice i" row
//   - mainPositions[i].transferredTo  → "Transfer slice i to recipient" row
//
// Bootstrap rows for this pool live in pp-phase2 (bs-open) and
// pp-phase3 (bs-lock); markBootstrapDoneForPool handles those.
//
// For full-success results (every state field populated), every row
// for the pool ends up green — matching what the user expects.
// For partial-failure results, rows whose underlying operation didn't
// finish stay in their pending/failed state. The user sees an honest
// picture of what's done vs. what isn't.
function markPoolDone(idx, poolResult) {
  // Pool creation row.
  if (poolResult && poolResult.poolId) {
    const poolRow = document.querySelector(
      `#lpProgressTree [data-pool-idx="${idx}"][data-stage="pool"]`,
    );
    if (poolRow) markRowDone(poolRow);
  }

  // Per-slice rows.
  const mp = Array.isArray(poolResult && poolResult.mainPositions)
    ? poolResult.mainPositions
    : [];
  for (let i = 0; i < mp.length; i++) {
    const pos = mp[i];
    if (pos && pos.nftMint) {
      const openRow = document.querySelector(
        `#lpProgressTree [data-pool-idx="${idx}"][data-stage="slice-${i}"]`,
      );
      if (openRow) markRowDone(openRow);
    }
    if (pos && pos.locked) {
      const lockRow = document.querySelector(
        `#lpProgressTree [data-pool-idx="${idx}"][data-stage="lock-${i}"]`,
      );
      if (lockRow) markRowDone(lockRow);
    }
    if (pos && pos.transferredTo) {
      const xferRow = document.querySelector(
        `#lpProgressTree [data-pool-idx="${idx}"][data-stage="xfer-${i}"]`,
      );
      if (xferRow) markRowDone(xferRow);
    }
  }

  // Per-ladder-band rows. Ladder bands have open and lock rows; no
  // transfer rows because ladder Fee Keys always sweep with the launch
  // wallet, never to external recipients.
  const lp = Array.isArray(poolResult && poolResult.ladderPositions)
    ? poolResult.ladderPositions
    : [];
  for (let b = 0; b < lp.length; b++) {
    const pos = lp[b];
    if (pos && pos.nftMint) {
      const openRow = document.querySelector(
        `#lpProgressTree [data-pool-idx="${idx}"][data-stage="ladder-${b}"]`,
      );
      if (openRow) markRowDone(openRow);
    }
    if (pos && pos.locked) {
      const lockRow = document.querySelector(
        `#lpProgressTree [data-pool-idx="${idx}"][data-stage="ladder-lock-${b}"]`,
      );
      if (lockRow) markRowDone(lockRow);
    }
  }
}

// Helper: flip a single row from pending/running to done.
function markRowDone(row) {
  row.classList.remove('pending', 'running');
  row.classList.add('done');
  const icon = row.querySelector('.icon');
  if (icon) icon.textContent = '✓';
}

function markPoolFailed(idx, err) {
  // Find the first pending row for this pool. Under the phase-organized
  // tree, that's the first row anywhere in lpProgressTree with the
  // matching data-pool-idx that hasn't transitioned to done yet. The
  // first such row is by definition the operation that failed (the
  // orchestrator's sequential execution means failures stop progress
  // at that point).
  const pending = document.querySelector(
    `#lpProgressTree [data-pool-idx="${idx}"].pending`,
  );
  if (pending) {
    pending.classList.remove('pending');
    pending.classList.add('failed');
    const icon = pending.querySelector('.icon');
    if (icon) icon.textContent = '✗';
    pending.title = err;
  }
}

// Mark all bootstrap rows as done. Called after the orchestrator returns
// full success — phase 2 (bs-open) and phase 3 (bs-lock) are both
// completed by definition, so every bootstrap row transitions to ✓.
//
// Under the phase-organized tree, bootstrap rows live in pp-phase2 (for
// bs-open) and pp-phase3 (for bs-lock). We select by stage attribute so
// the lookup is independent of which phase block hosts the rows.
function markAllBootstrapsDone() {
  document.querySelectorAll(
    '#lpProgressTree [data-stage="bs-open"], #lpProgressTree [data-stage="bs-lock"]',
  ).forEach((row) => markRowDone(row));
}

// Mark a specific pool's bootstrap rows based on actual state. Each pool
// has up to TWO bootstrap rows (bs-open in phase 2, bs-lock in phase 3);
// under the deferred-lock model, the open happens in Phase 2 and the lock
// in Phase 3, so a pool's bootstrap can be open-but-not-locked between
// those phases.
//
// Callers may pass a bootstrap result object via the second arg; if
// omitted, we default to "everything done" (the historical behavior used
// from the success path). Partial-failure callers should pass the actual
// bootstrap result to get accurate per-row marking.
function markBootstrapDoneForPool(allocationIndex, bootstrapResult) {
  const rows = document.querySelectorAll(
    `#lpProgressTree [data-pool-idx="${allocationIndex}"][data-stage^="bs-"]`,
  );
  rows.forEach((row) => {
    const stage = row.dataset.stage;
    if (!bootstrapResult) {
      markRowDone(row);
      return;
    }
    if (stage === 'bs-open' && bootstrapResult.nftMint) {
      markRowDone(row);
    } else if (stage === 'bs-lock' && bootstrapResult.locked) {
      markRowDone(row);
    }
  });
}

// Mark a specific pool's bootstrap rows as failed. Each pool has up to
// TWO bootstrap rows; we mark every pending one as failed because the
// bootstrap step is atomic from the user's perspective. If we only
// marked the first match, the bs-lock row would stay pending even
// though the work is unreachable until the open succeeds.
function markBootstrapFailedForPool(allocationIndex, err) {
  const rows = document.querySelectorAll(
    `#lpProgressTree [data-pool-idx="${allocationIndex}"][data-stage^="bs-"].pending`,
  );
  rows.forEach((row) => {
    row.classList.remove('pending');
    row.classList.add('failed');
    const icon = row.querySelector('.icon');
    if (icon) icon.textContent = '✗';
    row.title = err;
  });
}

function buildLpDoneSummary(results) {
  // Build the success summary shown after all pools land. Note we escape
  // quoteSymbol — for known quotes (SOL/USDC/etc) it's hard-coded safe,
  // but for user-supplied custom mints the symbol may have been read from
  // on-chain metadata or an indexer, which could contain anything. Better
  // to be paranoid than to allow a malicious token symbol to inject
  // markup into our success banner.
  //
  // Defensive on every field: mainPositions should always be populated
  // on the success path (orchestrator guarantees it), but if the result
  // shape ever changes or a partial result somehow lands here, we
  // shouldn't throw inside an HTML-building function and leave the
  // summary blank. A missing field renders as "0 main slices" — visibly
  // odd but doesn't break the page.
  let s = '';
  for (const r of results) {
    const sym = escapeHtml(r.quoteSymbol || '');
    const idShort = escapeHtml(r.poolId?.slice(0, 8) || '');
    const slices = Array.isArray(r.mainPositions) ? r.mainPositions : [];
    const ladder = Array.isArray(r.ladderPositions) ? r.ladderPositions : [];
    s += `<strong>${sym}</strong> pool: ${idShort}…, `;
    s += `${slices.length} main slice${slices.length === 1 ? '' : 's'}`;
    if (ladder.length > 0) {
      s += `, ${ladder.length} ladder band${ladder.length === 1 ? '' : 's'}`;
    }
    const ext = slices.filter((p) => p.transferredTo).length;
    if (ext > 0) s += ` (${ext} sent to external wallets)`;
    s += '<br>';
  }
  return s;
}

bind('continueToTransferBtn', 'click', () => {
  setStepSummary(5, `${lpResult.results.length} pool${lpResult.results.length === 1 ? '' : 's'} created`);
  prefillDestinationFromFunder();
  activateStep(6);
});

bind('continueToTransferAfterFailBtn', 'click', () => {
  setStepSummary(5, `partial — proceed to refund`);
  prefillDestinationFromFunder();
  activateStep(6);
});

bind('retryBootstrapsBtn', 'click', async () => {
  const btn = document.getElementById('retryBootstrapsBtn');
  const lockPositions = btn.dataset.lockPositions === 'true';
  const priorResults = lpResult?.results || [];

  if (!createdTokenInfo) {
    log('Token info missing — cannot resume launch.', 'danger');
    return;
  }

  await withRunState(async () => {
    setLoading(btn, true);
    try {
      log(`Resuming launch (${priorResults.length} pool${priorResults.length === 1 ? '' : 's'} carried over)…`);
      // Hide the fail banner while the resume runs so the user sees a
      // clean "in progress" state rather than the stale failure copy.
      document.getElementById('lpFailInfo').classList.add('hidden');

      // Reset any failed rows back to pending so progress is reflected.
      // We don't know exactly which rows will run this attempt (depends
      // on what got done last time), so we reset everything that's
      // currently marked failed.
      document.querySelectorAll('#lpProgressTree .progress-step.failed')
        .forEach((row) => {
          row.classList.remove('failed');
          row.classList.add('pending');
          const icon = row.querySelector('.icon');
          if (icon) icon.textContent = '◯';
          row.title = '';
        });

      const allocations = buildAllocationsForApi();
      const targetMc = parseNumberInput(document.getElementById('targetMarketCap'));
      const resp = await fetch('/api/resume-launch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tempWalletSecretKey: tempWallet.secretKey,
          tokenMint: createdTokenInfo.mint,
          tokenDecimals: createdTokenInfo.decimals,
          tokenTotalSupply: createdTokenInfo.totalSupply,
          targetMarketCapUsd: targetMc,
          allocations,
          lockPositions,
          priorResults,
        }),
      });
      let data;
      try {
        data = await resp.json();
      } catch (parseErr) {
        if (!resp.ok) {
          throw new Error(
            `Server returned HTTP ${resp.status} with non-JSON body. ` +
            `Check the server console for details.`,
          );
        }
        throw new Error(`Unexpected response: ${parseErr.message}`);
      }

      if (data.success) {
        // Full success — every pool now has main positions + bootstrap.
        // Replace lpResult with the canonical full result so downstream
        // flows (transfer) see the up-to-date state.
        lpResult = data;
        data.results.forEach((r) => {
          markPoolDone(r.allocationIndex, r);
          markBootstrapDoneForPool(r.allocationIndex, r.bootstrap);
        });
        log(`All ${data.results.length} pool(s) created and bootstrapped`, 'success');
        document.getElementById('lpDoneInfo').classList.remove('hidden');
        document.getElementById('lpDoneSummary').innerHTML = buildLpDoneSummary(data.results);
        return;
      }

      // Partial: at least one allocation still couldn't be completed.
      // The data has the same shape as a fresh create-lp failure:
      // partialResults, failedAllocationIndex, failedPhase, bootstrapFailures.
      // Update our lpResult so the next retry sees the latest state.
      lpResult = { results: data.partialResults || [] };
      const newPhase = data.failedPhase || 'main_positions';
      log(
        `Resume: ${(data.partialResults || []).length} pool(s) done, ` +
        `still failing (phase: ${newPhase}): ${data.error}`,
        'warning',
      );

      // Repaint progress tree to reflect new state. Mark every entry in
      // partialResults as done (both main and bootstrap rows depending
      // on what's populated), and mark the still-failing ones.
      (data.partialResults || []).forEach((r) => {
        markPoolDone(r.allocationIndex, r);
        if (r.bootstrap) markBootstrapDoneForPool(r.allocationIndex, r.bootstrap);
      });
      if (newPhase === 'bootstrap') {
        const failures = data.bootstrapFailures
          || (data.failedAllocationIndex != null
            ? [{ allocationIndex: data.failedAllocationIndex, error: data.error }]
            : []);
        for (const f of failures) {
          markBootstrapFailedForPool(f.allocationIndex, f.error);
        }
      } else if (newPhase === 'locks' || newPhase === 'transfers') {
        // Lock/transfer phase failures don't map to a single failing
        // allocation row — the failures are per-position and don't
        // belong on the pool-level progress markers. We've already
        // marked pools and bootstraps as done above; the per-position
        // detail lives in data.lockFailures / data.transferFailures
        // and gets surfaced via the lpFailInfo banner below.
      } else if (data.failedAllocationIndex != null) {
        markPoolFailed(data.failedAllocationIndex, data.error);
      }

      // Re-show the fail banner with updated counts so the user can
      // either retry again or give up via sweep. Heading + reassurance
      // copy mirrors the initial-failure branches so the UX stays
      // consistent whether the user is on attempt 1 or attempt N.
      document.getElementById('lpFailInfo').classList.remove('hidden');
      let resumeHeading;
      if (newPhase === 'bootstrap') {
        resumeHeading = 'Bootstraps still failing.';
      } else if (newPhase === 'locks') {
        resumeHeading = 'Some position locks still failing.';
      } else if (newPhase === 'transfers') {
        resumeHeading = 'Some Fee Key transfers still failing.';
      } else {
        resumeHeading = 'Pool creation still failing.';
      }
      document.getElementById('lpFailHeading').textContent = resumeHeading;
      document.getElementById('lpFailSummary').textContent = data.error;
      const successCount = (data.partialResults || []).length;
      const totalCount = allocations.length;
      document.getElementById('lpFailSucceededCount').innerHTML =
        `<strong>${successCount}</strong> of ${totalCount} pool${totalCount === 1 ? '' : 's'} ` +
        `completed; the rest are still failing. Click <strong>${newPhase === 'bootstrap' ? 'Retry bootstraps' : 'Resume launch'}</strong> ` +
        `to try again, or sweep the wallet to start over.`;
      // Resume button stays visible for another attempt. Update its
      // label too — a retry can shift phases (e.g. main-positions
      // failure resolves but uncovers a bootstrap-only failure), and
      // the button label should reflect that. For locks/transfers we
      // keep the generic "Resume launch" label since those don't have
      // a dedicated retry verb.
      const retryLabel = btn.querySelector('span:last-child');
      if (retryLabel) {
        retryLabel.textContent = newPhase === 'bootstrap'
          ? 'Retry bootstraps'
          : 'Resume launch';
      }
      // Phase-specific reassurance copy (mirrors the initial-failure
      // path's branches so retry messaging stays consistent).
      if (newPhase === 'bootstrap') {
        document.getElementById('lpFailReassurance').innerHTML =
          `<strong>Main positions are in place for every pool.</strong> Only the bootstrap ` +
          `leg failed for the pools listed above — these pools won't be tradable at the ` +
          `intended price until their bootstraps land. Click <strong>Retry bootstraps</strong> ` +
          `to try again (most bootstrap failures are transient RPC issues). If retrying ` +
          `keeps failing, sweep the wallet to your destination and manually add bootstrap ` +
          `liquidity in the Raydium UI later.`;
        document.getElementById('continueToTransferAfterFailBtnLabel').textContent =
          'Or sweep to destination instead';
      } else if (newPhase === 'locks') {
        document.getElementById('lpFailReassurance').innerHTML =
          `<strong>Every pool is open and tradable.</strong> The missing step is the lock — ` +
          `until locks finish, the LP'd tokens are still recoverable by the launch wallet. ` +
          `Click <strong>Resume launch</strong> to try the remaining locks again. If locks ` +
          `keep failing and you'd rather walk away, sweep the wallet to your destination — ` +
          `the open positions get closed and their LP tokens come back with the sweep.`;
        document.getElementById('continueToTransferAfterFailBtnLabel').textContent =
          'Or sweep to destination instead';
      } else if (newPhase === 'transfers') {
        document.getElementById('lpFailReassurance').innerHTML =
          `<strong>The launch itself succeeded.</strong> Every pool is created, tradable, and ` +
          `locked. The only thing that didn't finish was the delivery of Fee Key NFTs to ` +
          `recipient addresses. Those NFTs are in your launch wallet and will sweep to your ` +
          `destination wallet, so nothing is lost. You can manually send them to the intended ` +
          `recipients afterward, or click <strong>Resume launch</strong> to try the deliveries ` +
          `again.`;
        document.getElementById('continueToTransferAfterFailBtnLabel').textContent =
          'Skip to Transfer Assets';
      } else {
        document.getElementById('lpFailReassurance').innerHTML =
          `<strong>Your assets are safe</strong> — they're still in the ephemeral wallet ` +
          `(SOL, any auto-swapped quote tokens, and the LP NFTs from pools that did succeed). ` +
          `Click <strong>Resume launch</strong> to retry just the missing pools — already-` +
          `created pools will be skipped. If retrying keeps failing, you can sweep the wallet ` +
          `back to your destination as a last resort; the pools that succeeded above are ` +
          `permanent on-chain.`;
        document.getElementById('continueToTransferAfterFailBtnLabel').textContent =
          'Skip to Transfer Assets';
      }
    } catch (e) {
      log(`Resume failed: ${e.message}`, 'danger');
      // Show the fail banner again so the user can see what to do next.
      document.getElementById('lpFailInfo').classList.remove('hidden');
    } finally {
      setLoading(btn, false);
    }
  });
});

// Pre-fill the Step 6 destination input with the detected funding wallet,
// IF the user hasn't already typed something there. This is a convenience —
// the user still has to click through the confirmation modal that displays
// the full address before any transfer actually runs.
function prefillDestinationFromFunder() {
  const dest = document.getElementById('destinationWallet');
  if (!dest) return;
  if (!dest.value && fundingWallet) {
    dest.value = fundingWallet;
    log(`Pre-filled destination with detected funder. Verify before transferring.`, 'warning');
  }
}

// ===========================================================================
// STEP 6: Transfer assets
// ===========================================================================

bind('transferAssetsBtn', 'click', () => {
  const dest = document.getElementById('destinationWallet').value.trim();
  if (!dest) {
    log('Destination wallet required', 'warning');
    return;
  }
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(dest)) {
    log("Destination address doesn't look like a valid Solana address", 'danger');
    return;
  }
  showTransferConfirmModal(dest);
});

function showTransferConfirmModal(dest) {
  const modal = document.getElementById('transferConfirmModal');
  const chunked = dest.match(/.{1,8}/g).join(' ');
  document.getElementById('transferConfirmAddress').textContent = chunked;

  const confirmCheckbox = document.getElementById('transferConfirmCheckbox');
  const confirmBtn = document.getElementById('transferConfirmBtn');
  confirmCheckbox.checked = false;
  confirmBtn.disabled = true;

  modal.classList.add('is-active');
}

bind('transferConfirmCheckbox', 'change', (e) => {
  document.getElementById('transferConfirmBtn').disabled = !e.target.checked;
});

bind('transferConfirmCancelBtn', 'click', () => {
  document.getElementById('transferConfirmModal').classList.remove('is-active');
});

bind('transferConfirmBtn', 'click', async () => {
  document.getElementById('transferConfirmModal').classList.remove('is-active');
  await runTransfer();
});

async function runTransfer() {
  const btn = document.getElementById('transferAssetsBtn');
  const dest = document.getElementById('destinationWallet').value.trim();
  await withRunState(async () => {
    setLoading(btn, true);
    try {
      log(`Transferring assets to ${dest}...`);
      const resp = await fetch('/api/transfer-assets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tempWalletSecretKey: tempWallet.secretKey,
          destinationWallet: dest,
          tokenMint: createdTokenInfo ? createdTokenInfo.mint : '',
        }),
      });
      const data = await resp.json();
      if (!data.success) throw new Error(data.error);

      document.getElementById('transferResult').classList.remove('hidden');
      document.getElementById('tokensTransferred').textContent = data.tokensTransferred ?? '—';
      document.getElementById('solTransferred').textContent = data.solTransferred ?? '—';
      document.getElementById('nftsTransferred').textContent =
        data.nftSweep?.transferred?.length ?? '0';

      // Detect partial-failure modes. The server's transfer endpoint can
      // succeed at the top level (tokens + NFTs moved) but still have
      // individual sub-steps fail. Without surfacing these the user thinks
      // the transfer completed cleanly and may not realize funds were
      // left behind in the ephemeral wallet:
      //
      //   solSweepError       — SOL sweep failed; tokens/NFTs succeeded.
      //                         Most common cause: ephemeral wallet didn't
      //                         have enough SOL left for the tx fee after
      //                         the earlier transfers ate into it.
      //   tokenSweep.errors[] — per-token transfer failures (e.g. an ATA
      //                         creation that ran out of lamports).
      //   nftSweep.errors[]   — per-NFT failures (e.g. a locked LP NFT
      //                         that the lock contract rejected releasing).
      //
      // Each gets a warning log line so the user can investigate. The
      // wallet's pending-recovery entry is also preserved server-side
      // when the post-sweep balance check finds anything left, so the
      // user can come back later with the secret key and try again.
      const tokenErrors = data.tokenSweep?.errors || [];
      const nftErrors = data.nftSweep?.errors || [];
      const hasPartialFailure =
        data.solSweepError || tokenErrors.length > 0 || nftErrors.length > 0;

      if (data.solSweepError) {
        log(`SOL sweep failed: ${data.solSweepError}`, 'warning');
        log(
          'Tokens and NFTs were transferred successfully, but SOL stayed in the ' +
          'ephemeral wallet. Use the pending-wallets panel above to recover the ' +
          'remaining SOL with the wallet\'s secret key.',
          'warning',
        );
      }
      for (const e of tokenErrors) {
        log(`Token sweep error (${e.mint?.slice(0, 8) || 'unknown'}…): ${e.error}`, 'warning');
      }
      for (const e of nftErrors) {
        log(`NFT sweep error (${e.mint?.slice(0, 8) || 'unknown'}…): ${e.error}`, 'warning');
      }

      // Hide the Transfer button — flow is complete. Re-clicking would attempt
      // to transfer from an empty wallet, which would error confusingly.
      // EXCEPTION: when there was a partial failure (some assets stuck), leave
      // the button visible so the user can retry. The server-side post-sweep
      // verification keeps the recovery cache entry alive in this case, so a
      // retry won't lose the wallet's secret key.
      if (!hasPartialFailure) {
        document.getElementById('transferAssetsBtn').classList.add('hidden');
        log('Transfer complete', 'success');
        setStepSummary(6, 'transferred');
      } else {
        log('Transfer partially complete — see warnings above', 'warning');
        setStepSummary(6, 'partial — see warnings');
      }
      // The server has already removed this wallet from the recovery
      // cache (provided the on-chain balance check confirmed it's empty).
      // Refresh the panel so it reflects the new state.
      loadLaunchJournals();
      loadPendingWallets();
    } catch (e) {
      log(`Transfer failed: ${e.message}`, 'danger');
    } finally {
      setLoading(btn, false);
    }
  });
}

// ===========================================================================
// Launch-journal recovery panel
// ---------------------------------------------------------------------------
// Launch journals are non-secret records of previous sessions: wallet public
// key, token mint, pool IDs, tx IDs, failed phase, and transfer outcome.
// They complement pending wallets, which hold the secret material needed for
// manual recovery.
// ===========================================================================

let launchJournalStartupIds = null;

async function loadLaunchJournals() {
  const panel = document.getElementById('launchJournalsPanel');
  const list = document.getElementById('launchJournalsList');
  if (!panel || !list) return;

  try {
    const resp = await fetch('/api/launch-journals').then((r) => r.json());
    let journals = (resp && resp.journals) || [];

    if (launchJournalStartupIds === null) {
      launchJournalStartupIds = new Set(journals.map((j) => j.id));
    }

    journals = journals.filter((j) => launchJournalStartupIds.has(j.id));

    if (journals.length === 0) {
      panel.classList.add('hidden');
      list.innerHTML = '';
      return;
    }

    list.innerHTML = '';
    for (const journal of journals) {
      list.appendChild(buildLaunchJournalRow(journal));
    }
    panel.classList.remove('hidden');
  } catch (e) {
    console.warn('Failed to load launch journals:', e);
    panel.classList.add('hidden');
  }
}

function shortAddress(value, prefix = 6, suffix = 6) {
  if (!value || typeof value !== 'string') return 'unknown';
  if (value.length <= prefix + suffix + 1) return value;
  return `${value.slice(0, prefix)}...${value.slice(-suffix)}`;
}

function launchJournalStageLabel(journal) {
  const stage = journal.stage || 'unknown';
  const labels = {
    wallet_generated: 'Wallet generated',
    token_create_started: 'Token creation started',
    logo_uploaded: 'Logo uploaded',
    metadata_uploaded: 'Metadata uploaded',
    mint_created: 'Mint created',
    metadata_account_created: 'Metadata account created',
    supply_minted: 'Supply minted',
    mint_authority_revoked: 'Mint authority revoked',
    metadata_update_authority_revoked: 'Metadata authority revoked',
    token_safety_verified: 'Token safety verified',
    token_created: 'Token created',
    token_create_failed: 'Token creation failed',
    lp_create_started: 'Pool creation started',
    lp_resume_started: 'Launch resume started',
    pool_create_done: 'Pool created',
    main_open_done: 'Main LP position opened',
    ladder_open_done: 'Ladder position opened',
    bootstrap_open_done: 'Bootstrap opened',
    main_lock_done: 'LP position locked',
    main_lock_failed: 'LP position lock failed',
    ladder_lock_done: 'Ladder position locked',
    ladder_lock_failed: 'Ladder position lock failed',
    bootstrap_lock_done: 'Bootstrap locked',
    bootstrap_lock_failed: 'Bootstrap lock failed',
    phase3_done: 'Lock phase completed',
    main_transfer_done: 'Fee Key transferred',
    main_transfer_failed: 'Fee Key transfer failed',
    phase4_done: 'Fee Key transfer phase completed',
    bootstrap_failed: 'Bootstrap failed',
    lp_created: 'Pools completed',
    lp_pre_flight_failed: 'Validation failed',
    lp_main_positions_failed: 'Pool creation failed',
    lp_bootstrap_failed: 'Bootstrap failed',
    lp_locks_failed: 'Locking failed',
    lp_transfers_failed: 'Fee Key transfer failed',
    transfer_started: 'Final sweep started',
    transfer_partial: 'Final sweep incomplete',
    transfer_completed: 'Final sweep completed',
    transfer_failed: 'Final sweep failed',
  };
  return labels[stage] || stage.replaceAll('_', ' ');
}

function launchJournalRecoveryText(journal) {
  if (journal.transfer?.walletEmpty === false || journal.stage === 'transfer_partial') {
    return 'Final sweep did not prove the launch wallet empty. Check the matching recoverable wallet below and sweep or import it manually.';
  }
  if (journal.lp?.failedPhase === 'bootstrap') {
    return 'Pools and main positions were recorded, but one or more bootstrap positions are missing. Created pools are permanent; sweep the wallet or retry bootstraps from the recorded plan.';
  }
  if (journal.lp?.failedPhase === 'locks') {
    return 'Pools and bootstraps were recorded, but one or more locks failed. Unlocked LP NFTs remain controlled by the launch wallet.';
  }
  if (journal.lp?.failedPhase === 'transfers') {
    return 'The launch reached locked positions, but some Fee Key deliveries failed. Remaining Fee Key NFTs should still be in the launch wallet for sweep or manual transfer.';
  }
  if (journal.lp?.partialResults?.length > 0) {
    return 'Some pool work landed on-chain before the launch stopped. Created pools are permanent; the launch wallet controls any unswept tokens and LP NFTs.';
  }
  if (journal.token?.mint) {
    return 'The token mint was recorded. If the launch stopped before pools or transfer, the minted supply should still be controlled by the launch wallet.';
  }
  return 'A launch wallet was generated, but no token mint was recorded. If you funded this wallet, use the matching recovery entry below to recover the funds.';
}

function launchJournalPoolRows(journal) {
  const lp = journal.lp || {};
  const results = Array.isArray(lp.results) && lp.results.length > 0
    ? lp.results
    : (Array.isArray(lp.partialResults) ? lp.partialResults : []);
  if (results.length === 0) return '';

  const rows = results.slice(0, 6).map((r) => {
    const positions = [
      ...(Array.isArray(r.mainPositions) ? r.mainPositions : []),
      ...(Array.isArray(r.ladderPositions) ? r.ladderPositions : []),
      ...(r.bootstrap ? [r.bootstrap] : []),
    ];
    const locked = positions.filter((p) => p.locked).length;
    const bootstrap = r.bootstrap?.nftMint ? 'bootstrap opened' : 'bootstrap missing';
    return `<li><strong>${escapeHtml(r.quoteSymbol || 'pool')}</strong>: ` +
      `${escapeHtml(shortAddress(r.poolId, 6, 6))}, ` +
      `${positions.length} position${positions.length === 1 ? '' : 's'}, ` +
      `${locked}/${positions.length} locked, ${bootstrap}</li>`;
  }).join('');
  const more = results.length > 6
    ? `<li>${results.length - 6} more pool${results.length - 6 === 1 ? '' : 's'} recorded</li>`
    : '';
  return `<ul class="mt-2 mb-0">${rows}${more}</ul>`;
}

function launchJournalTxRows(journal) {
  const events = Array.isArray(journal.events) ? journal.events : [];
  const txs = [];
  for (const event of events) {
    if (typeof event.txId === 'string' && !txs.includes(event.txId)) {
      txs.push(event.txId);
    }
  }
  if (txs.length === 0) return '';
  const shown = txs.slice(0, 5)
    .map((tx) => `<span class="tag is-light is-family-monospace mr-1 mb-1">${escapeHtml(shortAddress(tx, 8, 6))}</span>`)
    .join('');
  const more = txs.length > 5
    ? `<span class="tag is-light mr-1 mb-1">+${txs.length - 5} more</span>`
    : '';
  return `<div class="mt-2"><strong>Recorded txs:</strong> ${shown}${more}</div>`;
}

function buildLaunchJournalRow(journal) {
  const wrap = document.createElement('div');
  wrap.className = 'box p-3 mb-2 is-size-7';

  const tokenLabel = journal.token?.symbol
    ? `${journal.token.symbol} (${shortAddress(journal.token.mint || '', 6, 6)})`
    : (journal.token?.mint ? shortAddress(journal.token.mint, 6, 6) : 'No token mint recorded');
  const walletShort = shortAddress(journal.walletPublicKey, 6, 6);
  const ageStr = formatAge(journal.updatedAt || journal.createdAt);
  const errorHtml = journal.error
    ? `<div class="notification is-danger is-light is-size-7 py-2 px-3 my-2">${escapeHtml(journal.error)}</div>`
    : '';

  wrap.innerHTML = `
    <div class="mb-1">
      <strong>${escapeHtml(tokenLabel)}</strong>
      <span class="tag is-warning is-light ml-1">${escapeHtml(launchJournalStageLabel(journal))}</span>
      <span class="has-text-grey ml-1">${escapeHtml(ageStr)}</span>
    </div>
    <div><strong>Launch wallet:</strong> <span class="is-family-monospace">${escapeHtml(walletShort)}</span></div>
    ${journal.token?.mint ? `<div><strong>Token mint:</strong> <span class="is-family-monospace">${escapeHtml(shortAddress(journal.token.mint, 8, 8))}</span></div>` : ''}
    ${errorHtml}
    <div class="notification is-warning is-light is-size-7 py-2 px-3 my-2">
      ${escapeHtml(launchJournalRecoveryText(journal))}
    </div>
    ${launchJournalPoolRows(journal)}
    ${launchJournalTxRows(journal)}
    <div class="field is-grouped is-grouped-multiline mt-3">
      ${journal.token?.mint ? `
        <div class="control">
          <button class="button is-small" data-action="copy-token">
            <span class="icon is-small"><i class="fas fa-copy"></i></span>
            <span>Copy token mint</span>
          </button>
        </div>
      ` : ''}
      <div class="control">
        <button class="button is-small" data-action="copy-wallet">
          <span class="icon is-small"><i class="fas fa-copy"></i></span>
          <span>Copy launch wallet</span>
        </button>
      </div>
      <div class="control">
        <button class="button is-small is-danger is-light" data-action="dismiss">
          <span class="icon is-small"><i class="fas fa-trash"></i></span>
          <span>Dismiss journal</span>
        </button>
      </div>
    </div>
  `;

  const copyText = async (text, description) => {
    try {
      await navigator.clipboard.writeText(text);
      log(`${description} copied to clipboard`, 'info');
    } catch (e) {
      log(`Couldn't copy ${description}: ${e.message}`, 'warning');
    }
  };

  wrap.querySelector('[data-action="copy-token"]')?.addEventListener('click', async () => {
    await copyText(journal.token.mint, 'Token mint');
  });
  wrap.querySelector('[data-action="copy-wallet"]').addEventListener('click', async () => {
    await copyText(journal.walletPublicKey, 'Launch wallet public key');
  });
  wrap.querySelector('[data-action="dismiss"]').addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Dismiss launch journal?',
      body:
        `<p>Dismiss the journal for <strong>${escapeHtml(tokenLabel)}</strong>?</p>` +
        `<p>This hides the audit/recovery summary but does not move funds or delete any on-chain assets. ` +
        `Only dismiss it after you have recovered, swept, or intentionally abandoned the launch wallet.</p>`,
      confirmLabel: 'Dismiss journal',
      danger: true,
    });
    if (!ok) return;
    try {
      await fetch('/api/launch-journals/dismiss', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: journal.id }),
      });
      await loadLaunchJournals();
    } catch (e) {
      log(`Failed to dismiss launch journal: ${e.message}`, 'danger');
    }
  });

  return wrap;
}

// ===========================================================================
// Pending-wallet recovery panel
// ---------------------------------------------------------------------------
// The server caches the secret key of any temporary wallet it generates and
// only removes it once the final transfer step has confirmed the wallet is
// on-chain empty. So if the app crashed or was closed mid-launch on a
// previous session, those entries show up here and the user can copy the
// secret key out for manual recovery.
//
// Important: the panel only ever shows entries that existed *at startup*.
// Wallets generated during the current session are not surfaced here —
// the user can already see them in Step 1, and showing them in a "recover
// previous session" panel during the active flow is misleading and
// alarming. After a refresh or restart, anything still in the cache then
// becomes visible — which is exactly when the panel actually matters.
//
// `pendingWalletStartupKeys` is the snapshot taken on first load. Once
// it's set, refreshes filter the server's response down to only entries
// whose publicKey was in the snapshot.
// ===========================================================================

let pendingWalletStartupKeys = null;

async function loadPendingWallets() {
  const panel = document.getElementById('pendingWalletsPanel');
  const list = document.getElementById('pendingWalletsList');
  if (!panel || !list) return;

  try {
    const resp = await fetch('/api/pending-wallets').then((r) => r.json());
    let wallets = (resp && resp.wallets) || [];

    // First call: capture the set of pubkeys present at startup. Anything
    // generated during this session is added to the server-side cache but
    // won't be in this set, so it'll be filtered out below.
    if (pendingWalletStartupKeys === null) {
      pendingWalletStartupKeys = new Set(wallets.map((w) => w.publicKey));
    }

    // Filter: only show entries that were in the startup snapshot AND
    // are still present in the cache. (An entry leaves the cache when
    // transfer-assets verifies the wallet is empty, or when the user
    // explicitly discards.)
    wallets = wallets.filter((w) => pendingWalletStartupKeys.has(w.publicKey));

    if (wallets.length === 0) {
      panel.classList.add('hidden');
      list.innerHTML = '';
      return;
    }

    list.innerHTML = '';
    for (const w of wallets) {
      list.appendChild(buildPendingWalletRow(w));
    }
    panel.classList.remove('hidden');
  } catch (e) {
    console.warn('Failed to load pending wallets:', e);
    // Don't show the panel if we couldn't fetch — better silent than
    // misleading.
    panel.classList.add('hidden');
  }
}

// Construct one row in the recovery panel. Truncated public key, age,
// "Copy secret key" button, "Discard" button.
function buildPendingWalletRow(wallet) {
  const wrap = document.createElement('div');
  wrap.className = 'box p-3 mb-2 is-size-7';

  const pubShort = `${wallet.publicKey.slice(0, 6)}…${wallet.publicKey.slice(-6)}`;
  const ageStr = formatAge(wallet.createdAt);

  // Decryption-failed branch: the file is on disk but we can't read the
  // secret material. Most common cause is the OS keychain has rotated
  // (e.g. file was copied from another machine, user account changed).
  // We can't help recover it from the app — surface the situation, let
  // the user discard.
  if (wallet.decryptionFailed) {
    wrap.innerHTML = `
      <div class="mb-2">
        <strong>Public key:</strong>
        <span class="is-family-monospace">${pubShort}</span>
        &nbsp;<span class="has-text-grey">(${ageStr})</span>
      </div>
      <div class="notification is-danger is-light is-size-7 py-2 px-3 mb-2">
        <strong>Cannot decrypt this entry.</strong> The OS keychain key has
        likely changed since this wallet was generated (file was copied to a
        different user account or machine, or the keychain was reset). The
        secret material in this entry is unrecoverable from inside the app.
        If you have a backup of the recovery phrase elsewhere, use that.
      </div>
      <div class="field is-grouped">
        <div class="control">
          <button class="button is-small" data-action="copy-pubkey">
            <span class="icon is-small"><i class="fas fa-copy"></i></span>
            <span>Copy public key</span>
          </button>
        </div>
        <div class="control">
          <button class="button is-small is-danger is-light" data-action="dismiss">
            <span class="icon is-small"><i class="fas fa-trash"></i></span>
            <span>Discard</span>
          </button>
        </div>
      </div>
    `;
    wireRowButtons(wrap, wallet, pubShort, /*hasMnemonic=*/false);
    return wrap;
  }

  // Prefer the recovery phrase if this wallet was generated with one.
  // Older cached entries from before mnemonic support fall back to the
  // base58 secret key.
  const hasMnemonic = !!wallet.mnemonic;
  const copyLabel = hasMnemonic ? 'Copy recovery phrase' : 'Copy secret key';
  const copyIcon = hasMnemonic ? 'fa-list-ol' : 'fa-key';

  wrap.innerHTML = `
    <div class="mb-2">
      <strong>Public key:</strong>
      <span class="is-family-monospace">${pubShort}</span>
      &nbsp;<span class="has-text-grey">(${ageStr})</span>
    </div>
    <div class="field is-grouped">
      <div class="control">
        <button class="button is-small is-info" data-action="copy-secret">
          <span class="icon is-small"><i class="fas ${copyIcon}"></i></span>
          <span>${copyLabel}</span>
        </button>
      </div>
      <div class="control">
        <button class="button is-small" data-action="copy-pubkey">
          <span class="icon is-small"><i class="fas fa-copy"></i></span>
          <span>Copy public key</span>
        </button>
      </div>
      <div class="control">
        <button class="button is-small is-danger is-light" data-action="dismiss">
          <span class="icon is-small"><i class="fas fa-trash"></i></span>
          <span>Discard</span>
        </button>
      </div>
    </div>
  `;
  wireRowButtons(wrap, wallet, pubShort, hasMnemonic);
  return wrap;
}

// Wire the per-row buttons. Extracted so both the normal and the
// decryption-failed render paths share the same handler logic.
function wireRowButtons(wrap, wallet, pubShort, hasMnemonic) {
  // Centralised clipboard helper so we don't duplicate the try/catch
  // every time. navigator.clipboard.writeText can throw in non-secure
  // contexts (older Electron, http://), if the page doesn't have focus,
  // or if the user has denied clipboard permission. Without this guard
  // the rejection floats up as an unhandled promise rejection and the
  // user has no idea the copy didn't happen.
  const copyToClipboard = async (text, description) => {
    try {
      await navigator.clipboard.writeText(text);
      log(`${description} copied to clipboard`, 'info');
    } catch (e) {
      log(
        `Couldn't copy ${description} (${e.message}). ` +
        `Open the file at the pendingWallets path and copy the secret manually.`,
        'warning',
      );
    }
  };

  // copy-secret button only exists in the normal render path
  const copySecretBtn = wrap.querySelector('[data-action="copy-secret"]');
  if (copySecretBtn) {
    copySecretBtn.addEventListener('click', async () => {
      const text = hasMnemonic ? wallet.mnemonic : wallet.secretKeyB58;
      if (!text) {
        log(`No secret available for ${pubShort}`, 'warning');
        return;
      }
      const what = hasMnemonic ? 'Recovery phrase' : 'Secret key';
      await copyToClipboard(text, `${what} for ${pubShort}`);
    });
  }

  wrap.querySelector('[data-action="copy-pubkey"]').addEventListener('click', async () => {
    await copyToClipboard(wallet.publicKey, `Public key ${pubShort}`);
  });

  wrap.querySelector('[data-action="dismiss"]').addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Discard recovery entry?',
      body:
        `<p>Discard recovery entry for <strong>${escapeHtml(pubShort)}</strong>?</p>` +
        `<p>Only do this if you've already moved any funds out of this wallet, ` +
        `or you're sure none were ever sent there. This action cannot be undone.</p>`,
      confirmLabel: 'Discard',
      danger: true,
    });
    if (!ok) return;
    try {
      await fetch('/api/pending-wallets/dismiss', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ publicKey: wallet.publicKey }),
      });
      await loadPendingWallets();
    } catch (e) {
      log(`Failed to dismiss recovery entry: ${e.message}`, 'danger');
    }
  });
}

// "3 hours ago" / "5 days ago" / etc. Plain-English age display.
function formatAge(isoString) {
  const then = new Date(isoString).getTime();
  if (!Number.isFinite(then)) return 'unknown age';

  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 60)        return 'just now';
  if (seconds < 3600)      return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400)     return `${Math.floor(seconds / 3600)} hr ago`;
  if (seconds < 86400 * 7) return `${Math.floor(seconds / 86400)} days ago`;
  return new Date(isoString).toLocaleDateString();
}

// ===========================================================================
// Initial state
// ===========================================================================
log('Trebuchet is ready. Click "Generate Wallet" to begin.');
loadRpcConfig();
loadLaunchJournals();
loadPendingWallets();
loadFeeTiers();
bindStepHeaders();
updateCancelButtonState();
// Render the simple-config UI right away so it's visible from page load
// (even before the user generates a wallet). The pool list inside the
// customize-mode container starts empty and stays empty until pools[]
// gets populated — by wallet generation, by recovery, or by manual add.
applySimpleConfigMode();
// Initial paint of the token-preview card. With the default values
// pre-filled in the supply and market-cap inputs, the user sees the
// placeholder name + a populated tech line right away.
renderTokenPreview();

// ---------------------------------------------------------------------------
// Tab-close / reload guard
// ---------------------------------------------------------------------------
//
// Once the user has progressed past wallet generation, accidentally
// closing or reloading the window loses session context (tempWallet, the
// in-progress pools array, the funding-requirement estimate, etc).
// The wallet's secret key is still in the pending-wallets recovery
// cache server-side, so funds are never lost, but the user has to
// re-enter their config and re-derive the wallet — friction we can
// prevent with a confirmation prompt before the unload.
//
// We only fire the warning when there's genuine state worth preserving:
//   - currentStep > 1   → wallet has been generated
//   - currentStep < 6   → we're not on the terminal transfer step
//
// Behavior differs by host:
//   - In a regular browser: Chrome/Firefox show their own generic "Leave
//     site? Changes you made may not be saved" dialog. They ignore our
//     message text; we just need to call preventDefault + set returnValue.
//   - In Electron: the renderer's beforeunload preventDefault is reported
//     to the main process via the 'will-prevent-unload' event, which
//     main.js handles by showing a native dialog. The renderer doesn't
//     need to do anything different here — same preventDefault pattern.
//     See main.js for the dialog setup.
window.addEventListener('beforeunload', (e) => {
  if (currentStep <= 1 || currentStep >= 6) return;
  e.preventDefault();
  // Some browsers (older Chrome, Edge) still read the return value;
  // newer ones ignore it. Set it for compatibility. Electron ignores
  // it too — the native dialog in main.js uses its own copy.
  e.returnValue = 'A launch is in progress. Leaving now will reset the UI; ' +
    'you\'ll need to recover the wallet from the pending-wallets panel.';
  return e.returnValue;
});

// ---------------------------------------------------------------------------
// First-run disclaimer
// ---------------------------------------------------------------------------
//
// Show a one-time risk-acknowledgement modal before anything else
// happens on the page. Acceptance is remembered in localStorage so
// returning users skip the dialog. The disclaimer is layered on top
// of the splash (higher z-index in CSS) so on first run the user
// reads and acknowledges before the intro video plays.
//
// Splash gating — implemented in setupSplashScreen() — already waits
// while any .modal.is-active is on the page, so adding the disclaimer
// modal naturally pauses splash playback. When the user clicks Agree,
// the modal class is removed and the splash detects no active modal
// and starts playing.
//
// On Cancel: attempt window.close(). In Electron this terminates the
// app since there's only one window. In plain web mode (npm run web
// served via a browser) window.close() may be blocked by the browser
// for windows not opened by JS — so we replace the modal contents
// with a "please close this tab" fallback message.
//
// Storage is keyed with a namespace prefix so it doesn't collide
// with anything else; we store an ISO timestamp rather than just
// "true" so future debugging can see when the agreement was given.
const DISCLAIMER_STORAGE_KEY = 'trebuchet:disclaimer-agreed';

function setupDisclaimer() {
  const modal = document.getElementById('disclaimerModal');
  if (!modal) return;

  // Check whether the user has already agreed in a previous session.
  // localStorage access can throw in some sandboxed contexts (private
  // browsing, disabled storage); on error, treat as "not agreed" and
  // show the dialog — better safe than skipping the warning.
  let alreadyAgreed = false;
  try {
    alreadyAgreed = !!localStorage.getItem(DISCLAIMER_STORAGE_KEY);
  } catch {
    alreadyAgreed = false;
  }

  if (alreadyAgreed) {
    return; // modal stays inert; splash and main app proceed normally
  }

  // First run (or storage cleared): show the modal.
  modal.classList.add('is-active');

  const checkbox = document.getElementById('disclaimerAgreeCheck');
  const agreeBtn = document.getElementById('disclaimerAgreeBtn');
  const cancelBtn = document.getElementById('disclaimerCancelBtn');

  // Checkbox gates the agree button. The user has to make the
  // explicit gesture before they can proceed — keeps the
  // acknowledgement intentional rather than muscle-memory clicking.
  if (checkbox && agreeBtn) {
    checkbox.addEventListener('change', () => {
      agreeBtn.disabled = !checkbox.checked;
    });
  }

  if (agreeBtn) {
    agreeBtn.addEventListener('click', () => {
      if (checkbox && !checkbox.checked) return; // safety: button shouldn't be enabled, but guard anyway
      try {
        localStorage.setItem(DISCLAIMER_STORAGE_KEY, new Date().toISOString());
      } catch {
        // Storage failed — proceed anyway. The user will just see the
        // disclaimer again on next launch. Annoying but not broken.
      }
      modal.classList.remove('is-active');
    });
  }

  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      // Try to close the window. In Electron this terminates the app.
      // In plain web mode, browsers may block this — fall back to a
      // "please close" message that overwrites the modal body.
      window.close();
      // If we're still here ~50ms later, the close was blocked.
      setTimeout(() => {
        const body = modal.querySelector('.modal-card-body');
        const foot = modal.querySelector('.modal-card-foot');
        if (body) {
          body.innerHTML =
            '<div class="disclaimer-declined">' +
            '<p class="title is-5">You declined.</p>' +
            '<p>Please close this tab to exit Trebuchet.</p>' +
            '</div>';
        }
        if (foot) foot.style.display = 'none';
      }, 50);
    });
  }
}
setupDisclaimer();

// ---------------------------------------------------------------------------
// Universal modal close affordances
// ---------------------------------------------------------------------------
//
// Three modals in the app were originally wired only to their explicit
// footer buttons (Cancel / Keep Going / Got It / etc.) and lacked the
// click-outside-and-Esc-to-dismiss behaviour users expect from modal
// dialogs.  This block backfills both for them:
//
//   - cancelConfirmModal     (Cancel & Refund prompt from the sticky bar)
//   - transferConfirmModal   (final confirm before sweeping assets)
//   - flywheelInfoModal      (informational; already had background click,
//                             but no Esc handler)
//
// Click-outside is wired per-modal via each one's .modal-background
// element.  Esc is handled with a single delegated keydown listener on
// document — when Esc fires, we close whichever of the three modals is
// currently active.  A single listener avoids the listener-accumulation
// failure mode that bit us elsewhere, and avoids the subtle bug where
// every per-modal Esc listener would also fire even when its own modal
// isn't the topmost one.
//
// Note on stacking with confirmDialog(): confirmDialog adds its own
// ephemeral Esc handler when shown and removes it on dismiss.  In a
// stacked scenario (confirmDialog opened on top of one of these
// modals), pressing Esc would fire BOTH handlers, closing both modals.
// In practice the flows in this app never open confirmDialog while
// one of these three modals is showing (cancel/transfer modals close
// themselves before any subsequent confirm prompt; flywheel is purely
// informational and isn't a launching pad for other dialogs), so this
// is a theoretical issue, not a practical one.  Documenting it here so
// if a future flow tries to stack them, the developer knows the gotcha.
const EXTRA_CLOSE_MODAL_IDS = [
  'cancelConfirmModal',
  'transferConfirmModal',
  'flywheelInfoModal',
];
for (const modalId of EXTRA_CLOSE_MODAL_IDS) {
  const modal = document.getElementById(modalId);
  if (!modal) continue;
  const bg = modal.querySelector('.modal-background');
  if (bg) {
    bg.addEventListener('click', () => modal.classList.remove('is-active'));
  }
}
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  for (const modalId of EXTRA_CLOSE_MODAL_IDS) {
    const modal = document.getElementById(modalId);
    if (modal && modal.classList.contains('is-active')) {
      modal.classList.remove('is-active');
    }
  }
});

// ---------------------------------------------------------------------------
// Splash screen dismissal
// ---------------------------------------------------------------------------
//
// The splash markup is in index.html; this wires up:
//   - Gated playback: video only starts playing once the window has
//     focus AND no blocking modal is on the page. Without focus,
//     browsers reliably block unmuted autoplay, and starting playback
//     while a modal is up would mean audio plays under invisible UI.
//   - Dismiss on `ended` (video ran to completion), explicit user
//     skip (click backdrop, Skip button, Esc/Space/Enter), or a
//     `<video>` error (file missing, format unsupported).
//
// There's deliberately NO stall/timeout-based dismiss. If focus never
// arrives, the splash stays — but that's the right call because if the
// user isn't focused on this window, they aren't interacting with the
// app either. The moment they tab back, the video starts.
//
// Console is sprinkled with [splash] log lines so you can open dev
// tools and see what's happening if playback doesn't start.
//
// Idempotent: dismiss runs at most once. Triggers a CSS fade-out via
// the is-dismissing class, then removes the splash node entirely.
function setupSplashScreen() {
  const splash = document.getElementById('splashScreen');
  if (!splash) return; // nothing to do (e.g. someone removed the markup)
  const video = document.getElementById('splashVideo');
  const skipBtn = document.getElementById('splashSkipBtn');

  document.body.classList.add('has-splash');

  let dismissed = false;
  let started = false;

  function dismiss(reason) {
    if (dismissed) return;
    dismissed = true;
    console.log('[splash] dismiss:', reason || 'unknown');
    splash.classList.add('is-dismissing');
    document.body.classList.remove('has-splash');
    // Pause the video so audio stops immediately on dismiss; then
    // remove the node after the fade finishes so it isn't lingering
    // in the DOM as invisible chrome. The 500ms cushion is slightly
    // longer than the 0.4s CSS transition.
    if (video) {
      try { video.pause(); } catch {}
    }
    setTimeout(() => {
      if (splash.parentNode) splash.parentNode.removeChild(splash);
    }, 500);
  }

  // Conditions for starting playback. Both must be true:
  //   - document.hasFocus() — without focus, browsers reliably block
  //     unmuted autoplay. Even when not blocked, playing audio under
  //     a backgrounded tab is bad UX.
  //   - No .modal.is-active — a confirmation dialog or transfer modal
  //     is up. Audio playing under a dialog would be confusing.
  // Once both are true, call video.play() exactly once. If play()
  // rejects (browser still blocks autoplay despite focus, or some
  // other error), surface a click-to-play affordance: the splash
  // backdrop already accepts clicks to dismiss, but we attach a
  // one-shot click handler that retries play() instead.
  function tryStartPlayback() {
    if (started || dismissed || !video) return;
    if (!document.hasFocus()) {
      console.log('[splash] waiting for focus');
      return;
    }
    if (document.querySelector('.modal.is-active')) {
      console.log('[splash] waiting for modal to close');
      return;
    }
    started = true;
    console.log('[splash] calling play()');
    const playPromise = video.play();
    if (playPromise && typeof playPromise.then === 'function') {
      playPromise.then(() => {
        console.log('[splash] play() promise resolved');
      }).catch((err) => {
        // play() was blocked despite our gating. Common causes:
        // browser policy that requires user gesture even with focus,
        // or audio device unavailable. We let the user click the
        // splash to retry.
        console.warn('[splash] play() rejected:', err && err.message);
        started = false; // allow a click-driven retry
      });
    }
  }

  // Re-check the start condition whenever something might have
  // changed: window focus, page visibility, or after a short poll
  // interval (covers modal opens/closes that don't fire focus events).
  // Polling 4× per second is cheap and avoids hooking every modal
  // toggle code path.
  window.addEventListener('focus', tryStartPlayback);
  document.addEventListener('visibilitychange', tryStartPlayback);
  const pollHandle = setInterval(() => {
    if (dismissed) {
      clearInterval(pollHandle);
      return;
    }
    tryStartPlayback();
  }, 250);
  // Try once immediately too — if the page has focus and there are
  // no modals at load, we start right away without waiting for the
  // first poll tick.
  tryStartPlayback();

  // Lifecycle listeners — also useful for debugging.
  if (video) {
    // Track lifecycle for visibility into playback state.
    video.addEventListener('loadedmetadata', () => {
      console.log(`[splash] video metadata loaded: ${video.videoWidth}x${video.videoHeight}, ${video.duration.toFixed(1)}s`);
    });
    video.addEventListener('playing', () => {
      console.log('[splash] playback actually started');
    });
    // Auto-dismiss on natural end of playback.
    video.addEventListener('ended', () => dismiss('video ended'));
    // If the file is missing/corrupt or the format is unsupported,
    // dismiss immediately rather than leaving the user staring at a
    // broken splash. (Doesn't fire for autoplay-blocked — that's a
    // policy block, not a load error.)
    video.addEventListener('error', (e) => {
      console.warn('[splash] video error:', e && (e.message || e.type));
      dismiss('video error');
    });
  }

  // User-initiated skips. The click-on-backdrop handler does double
  // duty: if playback hasn't started yet (because play() was blocked),
  // retry play(); if it has started, dismiss. The retry path comes
  // first so a user click counts as the gesture browsers want.
  splash.addEventListener('click', () => {
    if (!started && !dismissed) {
      tryStartPlayback();
      return;
    }
    dismiss('backdrop click');
  });
  if (skipBtn) {
    skipBtn.addEventListener('click', (e) => {
      // Skip always dismisses, never retries — the user explicitly
      // chose to skip.
      e.stopPropagation();
      dismiss('skip button');
    });
  }

  // Keyboard escape hatches. Esc/Space/Enter dismiss outright. Skip
  // when there's an active modal on top of the splash (e.g. the
  // first-run disclaimer) — those keys belong to the modal in that
  // case, and dismissing the splash silently would mean the user
  // never sees the video once the modal is gone.
  function onKeydown(e) {
    if (dismissed) return;
    if (document.querySelector('.modal.is-active')) return;
    if (e.key === 'Escape' || e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      dismiss(`keydown: ${e.key}`);
    }
  }
  document.addEventListener('keydown', onKeydown);
}
setupSplashScreen();
