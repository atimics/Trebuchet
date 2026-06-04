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
    // Closing a peek of step 2: the card was moved into the config slot for
    // the peek, so move it back to wherever the active step keeps it. The
    // coin now travels through steps 2–6, so we relocate rather than tear it
    // down.
    if (stepNum === 2 && currentStep !== 2) {
      relocateTokenPreview(slotKeyForStep(currentStep));
      if (typeof renderTokenPreview === 'function') renderTokenPreview();
    }
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
  // #8: total step count, derived from STEP_TITLES so the "/ N" stays
  // correct on its own if the flow ever gains or loses a step.
  const stepTotalEl = document.getElementById('stickyStepTotal');
  if (stepTotalEl) stepTotalEl.textContent = String(Object.keys(STEP_TITLES).length);
  document.getElementById('stickyStepTitle').textContent = STEP_TITLES[num];
  document.getElementById('stickyBar').classList.add('is-visible');

  // Demo mode folds its badge + Disable into the sticky bar (rather than a
  // second fixed banner that would cover it). Now that the bar is visible,
  // sync that chrome. Guarded for load-order safety.
  if (typeof syncDemoChrome === 'function') syncDemoChrome();

  // #9: the cost echo belongs only on step 2 (the config stage). The cost
  // preview already hides itself off step 2, but clear the echo explicitly
  // here too so it can never linger if a step change races the preview's
  // own update.
  if (num !== 2) {
    const stickyCost = document.getElementById('stickyCost');
    if (stickyCost) stickyCost.classList.add('hidden');
  }

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

  // When entering step 6, surface the pre-transfer airdrop summary so
  // the user sees what's about to happen before clicking Transfer
  // Assets. No-op when no airdrop is configured. typeof guards the
  // hoisting order — renderAirdropPreTransferSummary is defined further
  // down in this file.
  if (num === 6 && typeof renderAirdropPreTransferSummary === 'function') {
    renderAirdropPreTransferSummary();
  }

  // The token preview block (with its 3D coin) is a singleton DOM element
  // that travels with the active step. It lives in the config slot on step 2,
  // moves beside the QR on step 3, and now follows through steps 4–6 into
  // their per-step slots so the coin and the launch-progress bar stay visible
  // for the whole flow. The WebGL context survives each relocation because
  // we move the same DOM node — appendChild() doesn't destroy its canvas.
  //
  // Only step 1 (the wallet-generation stage, before a token is configured)
  // and a reset tear the coin down to free its WebGL context.
  if (num >= 2 && num <= 6) {
    relocateTokenPreview(slotKeyForStep(num));
    // Re-render so the card reflects the current config and its stat tiles
    // re-layout in the new slot. updateCoinPreview() (called from within)
    // reattaches the live canvas rather than spinning up a second context.
    if (typeof renderTokenPreview === 'function') renderTokenPreview();
  } else {
    relocateTokenPreview('config');
    if (typeof destroyCoinPreview === 'function') destroyCoinPreview();
  }

  // Refresh the overall launch-progress bar for the new step position.
  if (typeof updateLaunchProgress === 'function') updateLaunchProgress();
}

// Move the singleton #tokenPreviewBlock between its config-stage slot
// and its funding-stage slot. The card uses its full size in both
// locations — the funding stage's column layout gives it room to
// render alongside the QR code without needing a compact variant.
//
// where: 'config' | 'funding'
//
// Safe to call when the block isn't currently in either slot (e.g.
// during early init) — querySelector returns null and the function
// bails. Idempotent: calling with the same destination twice is a
// no-op (appendChild a node already in the target is harmless).
// Slot-id map for the singleton preview card. Steps 4–6 each have their own
// slot so the card (and its 3D coin) travels with the active step.
const TOKEN_PREVIEW_SLOTS = {
  config:  'tokenPreviewSlotConfig',
  funding: 'tokenPreviewSlotFunding',
  step4:   'tokenPreviewSlotStep4',
  step5:   'tokenPreviewSlotStep5',
  step6:   'tokenPreviewSlotStep6',
};

// Which slot the preview card belongs in for a given step: step 2 → config,
// step 3 → funding (beside the QR), steps 4–6 → their own per-step slot.
// Anything outside 2–6 has no card and defaults to config.
function slotKeyForStep(num) {
  if (num === 2) return 'config';
  if (num === 3) return 'funding';
  if (num >= 4 && num <= 6) return 'step' + num;
  return 'config';
}

function relocateTokenPreview(where) {
  const block = document.getElementById('tokenPreviewBlock');
  if (!block) return;
  const slotId = TOKEN_PREVIEW_SLOTS[where] || TOKEN_PREVIEW_SLOTS.config;
  const slot = document.getElementById(slotId);
  if (!slot) return;
  // appendChild moves the same DOM node (and the live coin canvas inside it)
  // without destroying it — the WebGL context survives the relocation.
  slot.appendChild(block);
}

// ---------------------------------------------------------------------------
// Overall launch progress
// ---------------------------------------------------------------------------
// The preview card carries a progress bar that fills as the launch advances
// through its six steps and reaches 100% when the final transfer completes.
// We base the in-flight percentage on currentStep (stable across "peeking" a
// completed step, which momentarily toggles the is-completed classes) rather
// than counting completed-step classes. The transfer-complete flag forces the
// bar to 100% on the final sweep, since step 6 isn't marked is-completed.
let _launchTransferComplete = false;

function updateLaunchProgress() {
  const fill = document.getElementById('tokenPreviewProgressFill');
  const label = document.getElementById('tokenPreviewProgressLabel');
  if (!fill || !label) return;
  let pct;
  if (_launchTransferComplete) {
    pct = 100;
  } else {
    const step = (typeof currentStep === 'number') ? currentStep : 1;
    // Steps before the active one are done; six steps total.
    pct = Math.max(0, Math.min(100, Math.round(((step - 1) / 6) * 100)));
  }
  fill.style.width = pct + '%';
  fill.classList.toggle('is-complete', pct >= 100);
  label.textContent = pct >= 100 ? 'Launch complete' : `Launch progress · ${pct}%`;
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
        // If we just closed a peek of step 2, the preview block is
        // currently in step 2's config slot (we moved it there when the
        // peek opened — see below). Move it back to the slot that matches
        // the actual current step (funding on step 3, the per-step slot on
        // steps 4–6). The coin travels with it; no teardown.
        if (i === 2 && currentStep !== 2) {
          relocateTokenPreview(slotKeyForStep(currentStep));
          if (typeof renderTokenPreview === 'function') renderTokenPreview();
        }
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
      // The token preview block is a singleton. While the user is on
      // step 3 it sits next to the QR in the funding slot. Peeking
      // step 2 needs to show the preview INSIDE step 2 again, so move
      // it back to the config slot for the duration of the peek. The
      // peek-close handler above moves it back to wherever it should
      // live afterwards.
      if (i === 2) {
        relocateTokenPreview('config');
        if (typeof renderTokenPreview === 'function') renderTokenPreview();
      }
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

