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

