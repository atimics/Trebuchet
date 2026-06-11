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
// Structured error display — categorization and "What happened?" explainers
// ===========================================================================
//
// Categorises error messages into types so the UI can show category-specific
// recovery suggestions and plain-language explanations. Categories:
//   rpc        — RPC endpoint errors (rate limiting, connection refused, etc.)
//   onchain    — On-chain transaction failures (instruction errors, etc.)
//   validation — User input / config errors (invalid addresses, bad amounts)
//   network    — HTTP / fetch errors from our own server or third-parties
//   unknown    — Anything that doesn\'t match a known pattern

const ERROR_CATEGORIES = {
  rpc: {
    label: 'RPC',
    cssClass: 'cat-rpc',
    patterns: [
      /rate.?limit/i, /429/i, /too many requests/i, /throttl/i,
      /sendTransaction.*failed/i, /getHealth/i, /rpc.*error/i,
      /Couldn\'t verify the wallet balance.*RPC/i, /RPC.*down/i,
      /RPC.*unreachable/i, /Balance polling is failing/i,
      /Connection.*refused/i, /ECONNREFUSED/i,
      /getVersion.*error/i, /getBlockHeight.*error/i,
    ],
    suggestion: 'Try switching to a dedicated RPC endpoint (Helius, QuickNode, Triton). '
      + 'Open the RPC settings panel above to add one — free tiers are plenty '
      + 'for a launch. Public endpoints get rate-limited mid-flow.',
    explainer: 'Solana RPC nodes have rate limits that can throttle or reject '
      + 'transactions when they receive too many requests in a short window. '
      + 'Pool creation sends dozens of transactions in rapid succession, which '
      + 'is exactly the pattern that triggers these limits on shared/public endpoints. '
      + 'A dedicated endpoint (even a free tier) has a much higher limit.',
  },
  onchain: {
    label: 'On-chain',
    cssClass: 'cat-onchain',
    patterns: [
      /instruction.?error/i, /custom.*program.*error/i, /0x[0-9a-f]{1,4}\b/i,
      /insufficient.*lamports/i, /insufficient.*funds/i,
      /ConstraintMintTokenProgram/i, /Token.*2022/i,
      /Anchor.*constraint/i, /program.*failed/i,
      /blockhash.*not found/i, /transaction.*expired/i,
      /comput.*budget/i, /exceeded.*limit/i,
    ],
    suggestion: 'If this is a Token-2022 mint issue, use a standard SPL Token mint. '
      + 'If it\'s a funds issue, your ephemeral wallet may need more SOL — add extra '
      + 'SOL to the launch wallet and use Resume Launch. For compute-budget errors, '
      + 'try reducing the number of pools or increasing the priority fee.',
    explainer: 'This error means the Solana network rejected an on-chain transaction '
      + 'during pool creation. Common causes: the token uses Token-2022 extensions that '
      + 'Raydium CLMM pools don\'t support; the ephemeral wallet ran out of SOL for fees; '
      + 'or the transaction hit a compute budget limit. Your assets remain safe in the '
      + 'ephemeral wallet and can be recovered via Cancel & Refund or Resume Launch.',
  },
  validation: {
    label: 'Validation',
    cssClass: 'cat-validation',
    patterns: [
      /invalid.*(address|mint|token)/i, /(address|mint).*invalid/i,
      /not.*valid/i, /must be/i, /required/i, /missing/i,
      /unsupported.*(token|extension|program)/i,
      /can\'t.*(be|use|create)/i, /cannot/i,
      /token.*not found/i, /mint.*not found/i,
      /no.*pool/i, /empty/i, /undefined/i,
    ],
    suggestion: 'Check your token details — the mint address, decimals, or symbol '
      + 'may be incorrect. If you\'re using a pump.fun or other Token-2022 token, '
      + 'those aren\'t directly supported for CLMM pools. Consider wrapping or '
      + 'using a standard SPL Token instead.',
    explainer: 'This error means something in your launch configuration doesn\'t '
      + 'meet the requirements. It could be an invalid token address, unsupported '
      + 'token format, or a missing required field. No on-chain actions have been '
      + 'performed — you can fix the config and try again without losing any SOL.',
  },
  network: {
    label: 'Network',
    cssClass: 'cat-network',
    patterns: [
      /fetch.*fail/i, /network.*error/i, /timeout/i, /abort/i,
      /ENOTFOUND/i, /EAI_AGAIN/i, /ECONNRESET/i, /ETIMEDOUT/i,
      /Couldn\'t.*reach/i, /Couldn\'t.*connect/i, /unreachable/i,
      /HTTP.*\d{3}/i, /response.*error/i, /server.*error/i,
      /5\d\d/i, /internal.*server/i,
    ],
    suggestion: 'Check your internet connection and try again. If this persists, '
      + 'the Trebuchet server or a third-party service (Jupiter, Raydium API) '
      + 'may be temporarily down. Wait a minute and retry — on-chain state '
      + 'from partial progress is preserved.',
    explainer: 'A network request failed — either to your RPC endpoint, to the '
      + 'Trebuchet server itself, or to an external service called during the '
      + 'launch. Transient network issues are common on Solana mainnet. Your '
      + 'on-chain state (created tokens, partially-created pools) is not affected '
      + 'by network errors between requests.',
  },
};

function categorizeError(message) {
  if (!message || typeof message !== 'string') return 'unknown';
  // Check categories in priority order: rpc > onchain > network > validation
  // RPC errors should be caught first because many on-chain errors are
  // actually downstream of RPC failures.
  const order = ['rpc', 'onchain', 'network', 'validation'];
  for (const cat of order) {
    for (const pat of ERROR_CATEGORIES[cat].patterns) {
      if (pat.test(message)) return cat;
    }
  }
  return 'unknown';
}

function getErrorCategoryInfo(category) {
  return ERROR_CATEGORIES[category] || null;
}

// Render a structured error block into a container element. Adds a category
// badge, the error message, a "What happened?" expandable section, and a
// recovery suggestion. Leaves existing content below the injected block
// intact (e.g. the Resume Launch / Skip buttons in lpFailInfo).
function renderStructuredError(container, message, category) {
  if (!container || !message) return;
  const cat = category || categorizeError(message);
  const info = getErrorCategoryInfo(cat);

  // Build the structured error block
  let html = '<div class="error-banner">';
  if (info && info.label) {
    html += `<span class="error-banner-category ${info.cssClass}">${info.label}</span>`;
  }
  html += `<span class="has-text-weight-semibold">${escapeHtml(String(message))}</span>`;

  if (info) {
    html += '<details class="error-what-happened">';
    html += '<summary>What happened?</summary>';
    html += `<div class="what-happened-body"><p>${escapeHtml(info.explainer)}</p></div>`;
    html += '</details>';
    html += `<div class="error-recovery-suggestion">${escapeHtml(info.suggestion)}</div>`;
  }

  html += '</div>';
  container.insertAdjacentHTML('afterbegin', html);
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
// Depth counter for the data-treb-busy DOM signal below. withRunState
// can nest (a balance poll can overlap a user action); the flag must
// only clear when the LAST operation finishes.
let _runStateDepth = 0;

async function withRunState(fn) {
  isRunningOperation = true;
  updateCancelButtonState();
  // Automation/readiness signal: <body data-treb-busy="1"> while any
  // wrapped operation is in flight. The screenshot harness (and any
  // future e2e tooling) waits on this instead of guessing from side
  // effects — e.g. "Continue to Funding" runs a full estimate
  // round-trip against live price APIs BEFORE the step advances, and
  // without a signal the only observable is a button that was clicked
  // and a step that hasn't changed yet.
  _runStateDepth += 1;
  document.body.dataset.trebBusy = '1';
  try {
    return await fn();
  } finally {
    isRunningOperation = false;
    updateCancelButtonState();
    _runStateDepth = Math.max(0, _runStateDepth - 1);
    if (_runStateDepth === 0) {
      delete document.body.dataset.trebBusy;
    }
  }
}



// RPC health polling state (used by rpc-panel.js)
let _rpcHealthPollTimer = null;
let _rpcHealthLastResult = null;
let _rpcHealthLaunchActive = false;
const RPC_HEALTH_INTERVAL_MS = 30000;
const RPC_HEALTH_SLOW_THRESHOLD_MS = 400;


