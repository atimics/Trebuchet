// ===========================================================================
// Step orchestrator — step state machine, activation, cancel & refund
// ===========================================================================
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
    // Mirror the header-collapse path: free the coin's WebGL context when
    // leaving a peeked step 2 (it was rebuilt on peek-open).
    if (stepNum === 2 && currentStep !== 2 &&
        typeof destroyCoinPreview === 'function') {
      destroyCoinPreview();
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

  // The 3D coin only lives on step 2 (the token-config screen). When the
  // user moves forward into the funding/launch flow, free its WebGL context
  // so it never accumulates across the launch. Returning to step 2 re-inits
  // it lazily via renderTokenPreview(). We re-render the preview when
  // arriving at step 2 so the coin mount gets (re)built and initialised.
  if (num === 2) {
    if (typeof renderTokenPreview === 'function') renderTokenPreview();
  } else {
    if (typeof destroyCoinPreview === 'function') destroyCoinPreview();
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
        // Free the coin's WebGL context again when leaving a peeked step 2
        // (we rebuilt it on peek-open). Guard on currentStep so we never tear
        // down a coin that legitimately belongs to the active step.
        if (i === 2 && currentStep !== 2 &&
            typeof destroyCoinPreview === 'function') {
          destroyCoinPreview();
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
      // The 3D coin lives on step 2 and is torn down when the user navigates
      // past it (activateStep frees its WebGL context). Peeking step 2 for
      // review re-shows the step body but does NOT go through activateStep,
      // so the coin would be missing — rebuild the preview here.
      if (i === 2 && typeof renderTokenPreview === 'function') {
        renderTokenPreview();
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
