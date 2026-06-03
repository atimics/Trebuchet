// ===========================================================================
// Initial state
// ===========================================================================
log('Trebuchet is ready. Click "Generate Wallet" to begin.');
loadRpcConfig();
startRpcHealthPolling();
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
  // The demo-mode toggle reloads to reset state, but it has already shown
  // its own HTML confirmation. Let that reload through without also firing
  // the native "launch in progress" dialog.
  if (demoModeReloading) return;
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
// Startup gate for the silent update-check
// ---------------------------------------------------------------------------
//
// The Electron main process runs the actual GitHub API call for the
// auto-update check, but we want the "Update available" modal to land
// ON TOP OF the main UI — not behind the splash video or the
// first-run disclaimer. Both of those mask the renderer at startup.
//
// To coordinate, we keep a tiny gate state here. The splash and
// disclaimer setups flip their gate to false when they're going to
// display something blocking, and back to true when the user has
// dismissed it. When both gates are true, we POST to a server
// endpoint that signals main to run the check.
//
// Default-true semantics handle the "didn't need to show anything"
// cases automatically:
//   - splash element missing → splash gate stays true
//   - disclaimer already agreed in a previous session → disclaimer
//     gate stays true
// In either case the gate never flips false, and the final
// _evaluateStartupGates() call at the bottom of this file picks up
// "both still true" and fires the trigger.

const _startupGates = {
  splash: true,
  disclaimer: true,
};
let _startupTriggerFired = false;

function _gateStartup(name) {
  _startupGates[name] = false;
}

function _releaseStartupGate(name) {
  _startupGates[name] = true;
  _evaluateStartupGates();
}

function _evaluateStartupGates() {
  if (_startupTriggerFired) return;
  if (!_startupGates.splash || !_startupGates.disclaimer) return;
  _startupTriggerFired = true;
  // Fire-and-forget. The server endpoint is local so this should
  // never fail in practice; if it somehow does, the user can still
  // run a manual check via Help → Check for Updates, so we don't
  // surface anything.
  fetch('/api/trigger-startup-update-check', { method: 'POST' })
    .catch((err) => {
      console.warn('Startup update-check trigger failed:', err);
    });
}

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

  // First-run path: gate the silent update-check until the user has
  // acknowledged the disclaimer. Without this, the auto-check modal
  // would land behind this dialog. The agree handler below releases
  // the gate.
  _gateStartup('disclaimer');

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
      // Disclaimer is dismissed — release the startup gate. If the
      // splash gate is also clear (returning user or splash already
      // dismissed), this fires the silent update check.
      _releaseStartupGate('disclaimer');
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

  // Gate the silent update-check until the splash is dismissed. The
  // dismiss() function below releases the gate.
  _gateStartup('splash');

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
    // Splash is dismissed — release the startup gate. If the
    // disclaimer gate is also clear, this fires the silent update
    // check.
    _releaseStartupGate('splash');
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

// ===========================================================================
// User preferences (renderer side)
// ---------------------------------------------------------------------------
// The medieval gauntlet cursor theme and the 3D coin token preview are
// always-on features — not user-toggleable. We apply the cursor theme
// unconditionally here; the coin preview is gated by coinPreviewEnabled,
// which defaults to true. (No settings UI and no persisted pref for either.)
// ===========================================================================
(function setupAppearance() {
  // Cursor theme: always on.
  document.body.classList.add('medieval-cursor');

  // Global mousedown clench: a click ANYWHERE adds .cursor-clenched so the
  // gauntlet shows the fist even over non-interactive space, then relaxes on
  // release. Listeners are passive — we never preventDefault.
  document.addEventListener('mousedown', () => {
    document.body.classList.add('cursor-clenched');
  }, { passive: true });
  document.addEventListener('mouseup', () => {
    document.body.classList.remove('cursor-clenched');
  }, { passive: true });
  // If the pointer leaves the window mid-press, clear the clench so it
  // doesn't get stuck clenched when the mouse comes back.
  window.addEventListener('blur', () => {
    document.body.classList.remove('cursor-clenched');
  });
})();
// ===========================================================================
// Demo mode (renderer side)
// ---------------------------------------------------------------------------
// On load we ask the server whether demo mode is on (/api/demo/status) and
// reflect that in the UI. Toggling the setting (or clicking the banner's
// Disable button) persists the new value via /api/user-prefs, then VERIFIES
// the change by reading /api/demo/status back before touching any demo UI.
//
// Why verify instead of trusting the POST: userPrefs.persist() swallows
// disk-write errors — set() reports success even if the write never reached
// disk (e.g. a packaged build without write access to its config folder).
// isDemoMode() on the server reads the pref fresh per request, so if the
// write silently failed the server would still be in REAL mode. Showing the
// demo banner in that case would be dangerous — it would promise "no real
// transactions" over a live server. Reading the status back closes that gap:
// we only show demo UI once the server CONFIRMS it is in demo mode.
//
// Toggling always asks for confirmation first: switching mode discards any
// current launch progress and starts over. On confirm we persist, verify
// the server entered the new mode, then reload — the most reliable way to
// reset every in-memory launch variable and restart the flow from the
// beginning in the new mode.
// ===========================================================================
(function setupDemoMode() {
  // Single source of truth for demo-dependent UI: the top banner, the Step 3
  // "Pretend funding arrived" button, and the settings checkbox.
  function applyDemoModeUi(active) {
    demoModeActive = !!active;
    const toggle = document.getElementById('demoModeToggle');
    if (toggle) toggle.checked = demoModeActive;
    const banner = document.getElementById('demoBanner');
    if (banner) banner.style.display = demoModeActive ? 'flex' : 'none';
    const fundWrap = document.getElementById('demoFundWrap');
    if (fundWrap) fundWrap.style.display = demoModeActive ? 'block' : 'none';
  }

  // Persist a new demoMode value and switch the app into it. Switching mode
  // discards the current launch and starts over, so we always confirm first.
  async function setDemoMode(enabled) {
    const want = !!enabled;

    // If a REAL launch is mid-flight (steps 2..5, and we're currently in real
    // mode), the ephemeral wallet has been stashed for recovery — surface that
    // here, since this single HTML dialog now replaces the old native one.
    const launchInProgress =
      typeof currentStep === 'number' && currentStep > 1 && currentStep < 6;
    const recoveryNote =
      launchInProgress && !demoModeActive
        ? '<p>If you already created an on-chain wallet for this launch, you ' +
          'can still recover it from the pending-wallets panel.</p>'
        : '';

    // Always warn: changing mode resets the app to defaults and restarts the
    // launch from the beginning, discarding anything entered so far.
    const proceed = await confirmDialog({
      title: want ? 'Enable demo mode?' : 'Disable demo mode?',
      body:
        '<p>Switching demo mode resets the app to defaults and restarts the ' +
        'launch from the beginning, with demo mode ' +
        (want ? '<strong>enabled</strong>' : '<strong>disabled</strong>') +
        '.</p><p>Any wallet, token, or pool data you have entered for the ' +
        'current launch will be lost.</p>' +
        recoveryNote,
      confirmLabel: want ? 'Enable & restart' : 'Disable & restart',
      danger: true,
    });
    if (!proceed) {
      // User backed out — put the checkbox back the way it was.
      const toggle = document.getElementById('demoModeToggle');
      if (toggle) toggle.checked = !want;
      return;
    }

    try {
      const postResp = await fetch('/api/user-prefs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ demoMode: want }),
      });
      if (!postResp.ok) throw new Error('save failed (HTTP ' + postResp.status + ')');

      // Confirm the server actually entered the requested mode BEFORE we
      // reset/restart. persist() swallows disk-write errors, so a POST can
      // report success while the value never reached disk (e.g. a packaged
      // build without write access to its config folder). If it didn't take,
      // don't reload into a mismatched state — surface the reason instead.
      const statusResp = await fetch('/api/demo/status');
      const status = await statusResp.json();
      if (!!(status && status.active) !== want) {
        throw new Error(
          'the setting did not persist — the app may not have write access to ' +
          'its config folder. Demo mode was NOT changed.',
        );
      }

      // Reset to defaults and restart the launch from the beginning in the new
      // mode. A full reload is the most reliable reset: it clears every
      // in-memory launch variable and re-runs init, and the on-load path below
      // re-reads the (now-persisted) status to show or hide the demo banner.
      // Set the bypass first so the reload doesn't also trip the native
      // "launch in progress" dialog — we've already confirmed above.
      demoModeReloading = true;
      window.location.reload();
    } catch (e) {
      // Revert the checkbox to the real (unchanged) state and surface why.
      const toggle = document.getElementById('demoModeToggle');
      if (toggle) toggle.checked = !want;
      console.error('Failed to change demo mode:', e);
      log('Could not change demo mode: ' + e.message, 'danger');
    }
  }

  // Wire the settings toggle and the banner Disable button up front — they
  // exist in the DOM regardless of the current mode.
  bind('demoModeToggle', 'change', (e) => setDemoMode(e.target.checked));
  bind('demoBannerDisable', 'click', () => setDemoMode(false));

  // Reflect the current server state on load.
  fetch('/api/demo/status')
    .then((r) => r.json())
    .then((data) => applyDemoModeUi(data && data.active))
    .catch((err) => {
      // If the status check fails, assume real mode (the safe default).
      console.warn('Demo-mode status check failed; assuming real mode:', err);
      applyDemoModeUi(false);
    });
})();

// Final gate evaluation. Both setupDisclaimer() and setupSplashScreen()
// have run by this point. If either gated itself (showed a modal or
// played the splash), the gate is currently false and this call is a
// no-op — the trigger will fire later when the user dismisses
// whichever is still blocking. If NEITHER gated (returning user +
// splash element missing), both gates are still default-true and this
// is the only place the trigger ever fires.
_evaluateStartupGates();
