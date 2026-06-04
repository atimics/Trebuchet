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
    // Move the Lock-liquidity field into the Advanced details slot
    // inside simple mode. This is done AFTER renderSimpleConfig so the
    // slot element exists. The field is the same DOM element that
    // lives at #lockPositionsSlotPage in customize mode — we physically
    // relocate it between modes rather than duplicating, so the
    // checkbox state and any external listeners stay attached to a
    // single canonical element.
    relocateLockPositionsField('simple');
  } else {
    simpleC.classList.add('hidden');
    customC.classList.remove('hidden');
    // renderSimpleConfig still needs to run in customize mode — it
    // builds the preallocation block (and wires its handlers), which
    // relocatePreallocationBlock (called inside renderSimpleConfig)
    // then moves into #customizePreallocSlot above the pool list.
    // The simple container itself stays hidden; we only need its DOM
    // contents to exist so the block can be detached from it. The
    // mode-aware HTML in the prealloc block hides the auto-back toggle
    // and the "Enable Support position" link in customize mode (those
    // refer to the simple-mode support row which isn't visible here).
    renderSimpleConfig();
    renderPools();
    // Move the Lock-liquidity field back to its page-level home so
    // customize-mode users can access it.
    relocateLockPositionsField('customize');
  }
}

// Move the #lockPositionsField element between its two homes:
//
//   target='simple'    → into the Advanced options slot inside simple mode
//   target='customize' → back to the page-level slot (below the customize
//                        container, where it lives by default)
//
// No-ops if the field or the target slot can't be found (e.g. called
// before the DOM is built, or with an unknown target). The same single
// DOM element moves between locations; its state (checked/unchecked)
// and any attached listeners are preserved by appendChild.
function relocateLockPositionsField(target) {
  const field = document.getElementById('lockPositionsField');
  if (!field) return;
  let slot;
  if (target === 'simple') {
    slot = document.getElementById('lockPositionsSlotSimple');
  } else {
    slot = document.getElementById('lockPositionsSlotPage');
  }
  if (!slot) return;
  // appendChild moves the element if it has a parent; no need to
  // detach first. Re-appending into the same slot is a no-op (the
  // element is already a child).
  if (field.parentElement !== slot) {
    slot.appendChild(field);
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

// Set once we've attached the capture-phase image-error listener to the
// preview block (so a broken pool-logo URL in a chip degrades to the letter
// fallback). Guards against re-adding the listener on every re-render.
let _previewLogoFailBound = false;

// ===========================================================================
// 3D coin preview lifecycle
// ---------------------------------------------------------------------------
// The coin (coinRenderer.js, backed by vendored three.js) replaces the flat
// logo circle in the preview card. Front face = the uploaded token logo
// (same-origin blob); back face = the largest pool's quote-token logo (remote
// https, with a symbol fallback on CORS failure). We init the WebGL context
// once and then only swap face textures — never tear down and rebuild per
// keystroke. The whole thing is feature-flagged so it can be disabled for
// weak hardware or when WebGL/the script isn't available.
// ===========================================================================

// Feature flag for the 3D coin. The coin is an always-on feature (no user
// toggle), so this stays true; it only gates coinCanRun() together with the
// runtime check that coinRenderer/THREE actually loaded.
let coinPreviewEnabled = true;
// Remembers the last front URL and back signature we pushed, so we only
// rebuild a face texture when its source actually changed (texture uploads
// are the expensive part; debounce-by-equality avoids thrashing them).
let _coinFrontUrl = null;
let _coinBackSig = null;
let _coinBackUpdateTimer = null;

// The pool whose quote token shows on the back of the coin: the one holding
// the most of the token's supply (highest supplyPercent). Usually the SOL
// pool. Returns null when there are no pools yet.
function largestPool(poolList) {
  if (!Array.isArray(poolList) || poolList.length === 0) return null;
  return poolList.reduce(
    (best, p) => (Number(p.supplyPercent) > Number(best ? best.supplyPercent : -1) ? p : best),
    null,
  );
}

// Can the coin run right now? Needs: the feature flag on, the global present
// (script loaded), and a usable WebGL context. We probe WebGL once.
let _webglOk = null;
function webglAvailable() {
  if (_webglOk !== null) return _webglOk;
  try {
    const c = document.createElement('canvas');
    _webglOk = !!(window.WebGLRenderingContext &&
      (c.getContext('webgl') || c.getContext('experimental-webgl')));
  } catch (e) {
    _webglOk = false;
  }
  return _webglOk;
}
function coinCanRun() {
  return coinPreviewEnabled &&
    typeof window.coinRenderer !== 'undefined' &&
    typeof THREE !== 'undefined' &&
    webglAvailable();
}

// Wrap a remote logo URL so it loads from our own origin. The 3D coin draws
// the back-face logo into a WebGL texture, which needs CORS-clean pixels;
// many logo hosts don't send CORS headers, so we route through the local
// /api/proxy-image passthrough (same-origin → no CORS, canvas not tainted).
// Same-origin/blob URLs are returned unchanged. This is only needed for the
// canvas/WebGL path — plain <img> tags (pool rows, preview chips) display any
// URL directly, which is why those already work.
function proxiedImageUrl(url) {
  if (!url) return null;
  if (/^(blob:|data:)/i.test(url)) return url;
  if (url.startsWith('/')) return url; // already same-origin
  return '/api/proxy-image?url=' + encodeURIComponent(url);
}

// Compute the back face source from the current pools. Returns
// { url, symbol } — url may be null (then the symbol is embossed instead).
function coinBackSource() {
  const pool = largestPool(pools);
  if (!pool) return { url: null, symbol: 'SOL' };
  return {
    // Proxy the remote logo so the coin's WebGL texture can read it (CORS).
    url: proxiedImageUrl(pool.resolvedImageUrl) || null,
    symbol: pool.resolvedSymbol || pool.quoteSelect || 'SOL',
  };
}

// Main entry, called from renderTokenPreview() after the card markup exists.
// Initialises the coin on first use, then updates faces only as needed.
function updateCoinPreview(frontUrl, symbol) {
  if (!coinCanRun()) return;
  const mount = document.getElementById('tokenPreviewCoin');
  if (!mount) return;

  // Init once. coinRenderer.init() is a no-op if already initialised.
  if (!window.coinRenderer.isActive()) {
    window.coinRenderer.init(mount);
    // Force a fresh push of both faces after init.
    _coinFrontUrl = undefined;
    _coinBackSig = undefined;
  } else if (!mount.querySelector('canvas')) {
    // Already initialised, but this mount has no canvas — the surrounding DOM
    // was re-rendered (e.g. entering "review completed step" rebuilds the
    // step), detaching our canvas. Move the live canvas into the new mount
    // instead of spinning up a second WebGL context.
    window.coinRenderer.reattach(mount);
  }

  // The live 3D coin is mounted, so hide the flat fallback logo that sits
  // behind the canvas — otherwise it shows through when the coin spins
  // edge-on (the canvas is transparent there). CSS keys off this class.
  mount.classList.add('coin-live');

  // Front face: rebuild only when the logo URL changed.
  if (frontUrl !== _coinFrontUrl) {
    _coinFrontUrl = frontUrl;
    const back = coinBackSource();
    // setFaces pushes both; the back rebuild is cheap relative to gating.
    window.coinRenderer.setFaces(frontUrl || null, back.url, back.symbol);
    _coinBackSig = back.url + '|' + back.symbol;
  }
}

// Back-face refresh, called after resolvePoolQuote() updates pool data.
// Debounced so a burst of pool edits doesn't thrash texture uploads.
function refreshCoinBackFace() {
  if (!coinCanRun()) return;
  if (!window.coinRenderer.isActive()) return;
  if (_coinBackUpdateTimer) clearTimeout(_coinBackUpdateTimer);
  _coinBackUpdateTimer = setTimeout(() => {
    _coinBackUpdateTimer = null;
    const back = coinBackSource();
    const sig = back.url + '|' + back.symbol;
    if (sig === _coinBackSig) return; // no change
    _coinBackSig = sig;
    if (back.url) {
      window.coinRenderer.setFaces(_coinFrontUrl || null, back.url, back.symbol);
    } else {
      window.coinRenderer.setBackSymbol(back.symbol);
    }
  }, 250);
}

// Tear the coin down (frees the WebGL context). Called when leaving the
// create-token screen / on reset.
function destroyCoinPreview() {
  if (typeof window.coinRenderer === 'undefined') return;
  if (window.coinRenderer.isActive()) window.coinRenderer.destroy();
  _coinFrontUrl = null;
  _coinBackSig = null;
  if (_coinBackUpdateTimer) {
    clearTimeout(_coinBackUpdateTimer);
    _coinBackUpdateTimer = null;
  }
  // Drop the coin-live marker so that if the mount is visible without a live
  // coin (e.g. the canvas was torn down while step 2 is still on screen) the
  // flat fallback logo shows through instead of a blank circle.
  const mount = document.getElementById('tokenPreviewCoin');
  if (mount) mount.classList.remove('coin-live');
}

// Build the live stat grid shown in the preview card: token facts (supply,
// market cap, start price, decimals) plus pool configuration (how many pools,
// which quote tokens, what share of supply goes to liquidity) and the running
// launch-cost estimate. Reads straight from the inputs, the live `pools`
// array, and the cached `_lastCostEstimate`, so it always reflects the
// current config. Returns a self-contained #tokenPreviewStats element.
function buildPreviewStatsHtml() {
  const supplyEl = document.getElementById('tokenSupply');
  const mcEl = document.getElementById('targetMarketCap');
  const supply = supplyEl ? parseNumberInput(supplyEl) : NaN;
  const mc = mcEl ? parseNumberInput(mcEl) : NaN;
  const supplyValid = Number.isFinite(supply) && supply > 0;
  const mcValid = Number.isFinite(mc) && mc > 0;

  // --- Hero tiles: the few numbers worth reading at a glance. Each is
  //     shown only when we actually have it; they flex to share the row. ---
  const tiles = [];
  const addTile = (label, value, valueClass) => {
    tiles.push(
      `<div class="tps-tile">` +
        `<div class="tps-tile-label">${escapeHtml(label)}</div>` +
        `<div class="tps-tile-value${valueClass ? ' ' + valueClass : ''}">` +
        `${escapeHtml(value)}</div>` +
      `</div>`
    );
  };
  if (mcValid) addTile('Market cap', '$' + mc.toLocaleString());
  if (supplyValid && mcValid) {
    const priceText = formatPreviewPrice(mc / supply);
    if (priceText) addTile('Start price', priceText);
  }
  if (_lastCostEstimate && Number.isFinite(_lastCostEstimate.totalSol)) {
    // Airdrop execution (ATA rent + tx fees per recipient) is computed
    // client-side and added on top of the server's launch-funding total
    // since the server doesn't yet know about the airdrop list. When
    // airdrop is disabled or empty this returns 0.
    const airdropExecutionSol = computeAirdropExecutionCostSol();
    const grandTotal = _lastCostEstimate.totalSol + airdropExecutionSol;
    addTile('Est. cost', `≈ ${grandTotal.toFixed(3)} SOL`, 'is-cost');
  }
  const tilesHtml = tiles.length ? `<div class="tps-tiles">${tiles.join('')}</div>` : '';

  // --- Meta line: supporting facts that don't need their own tile. ---
  const meta = [];
  if (supplyValid) meta.push(`${supply.toLocaleString()} supply`);
  if (Array.isArray(pools) && pools.length) {
    const alloc = pools.reduce((s, p) => s + (Number(p.supplyPercent) || 0), 0);
    if (alloc > 0) {
      const allocText = (alloc % 1 === 0) ? alloc.toFixed(0) : alloc.toFixed(1);
      meta.push(`${allocText}% to liquidity`);
    }
    // When the pool allocations leave some supply uncommitted (sum < 100),
    // call out the gap explicitly as "preallocated". Works in both
    // simple-mode (where the user enables preallocation via the toggle)
    // and customize-mode (where they manually set lower pool percentages).
    // We surface the larger of (100 - alloc) and the simpleConfig pct so
    // the display stays consistent across mode switches.
    const gap = Math.max(0, 100 - alloc);
    if (gap > 0.01) {
      const gapText = (gap % 1 === 0) ? gap.toFixed(0) : gap.toFixed(1);
      meta.push(`${gapText}% preallocated`);
    }
  }
  const metaHtml = `<div class="tps-meta">${meta.map(escapeHtml).join(' &middot; ')}</div>`;

  // --- Pool chips: one pill per unique quote token, with friendly labels
  //     (resolved symbol, override, or a shortened mint — never a raw
  //     44-char address). Updates live as pools are configured. ---
  let chipsHtml = '';
  if (Array.isArray(pools) && pools.length) {
    const seen = new Set();
    const chips = [];
    for (const p of pools) {
      const label = poolQuoteLabel(p);
      const key = label.toUpperCase();
      if (seen.has(key)) continue;
      seen.add(key);
      // Round logo when we have an image URL, otherwise a coloured initial
      // circle — mirrors the pool-editor logos (updatePoolLogo) so the
      // preview reads consistently. Logo-only (no ticker text); the symbol is
      // kept as a hover title for accessibility. A plain <img> displays any
      // remote URL directly (no CORS needed for display — same as the pool
      // rows), with a fail-to-initial fallback for broken/blocked URLs.
      const initial = (label.charAt(0) || '?').toUpperCase();
      const safeLabel = escapeHtml(label);
      const safeInitial = escapeHtml(initial);
      if (p.resolvedImageUrl) {
        chips.push(
          `<span class="tps-pool-logo" title="${safeLabel}" ` +
                `data-fallback-initial="${safeInitial}">` +
            `<img src="${escapeHtml(p.resolvedImageUrl)}" alt="${safeLabel}" ` +
                 `loading="lazy" data-action="preview-pool-logo-fail">` +
          `</span>`
        );
      } else {
        chips.push(
          `<span class="tps-pool-logo tps-pool-logo-fallback" title="${safeLabel}">` +
            safeInitial +
          `</span>`
        );
      }
    }
    chipsHtml =
      `<div class="tps-pools">` +
        `<span class="tps-pools-label">${pools.length === 1 ? 'Pool' : 'Pools'}</span>` +
        chips.join('') +
      `</div>`;
  }

  return `<div class="token-preview-stats" id="tokenPreviewStats">` +
    tilesHtml + metaHtml + chipsHtml +
  `</div>`;
}

// Lightweight refresh of just the stat grid — no logo/coin work — so it's
// cheap to call on every pool edit and cost-estimate update without
// thrashing the WebGL coin texture. No-ops until renderTokenPreview() has
// built the card (then it just swaps the grid in place).
function updatePreviewStats() {
  const existing = document.getElementById('tokenPreviewStats');
  if (!existing) return;
  existing.outerHTML = buildPreviewStatsHtml();
}

