// An action that can't run is greyed out with the reason beside it, not answered with a toast.
// Each guard mirrors the check its handler makes and returns the reason as a short fact, or null
// when the action can run. Handlers keep their checks as a backstop.

const noDesktopApp = () => (state.apiStatus !== 'connected' ? 'Needs the desktop app' : null);
const noLaunchWallet = () => (selectedLaunchWalletPublicKey() ? null : 'No launch wallet chosen');
const launchBusy = () => (state.fullRunRunning || state.realExecutionRunning ? 'A launch step is running' : null);
const pinDamaged = () => (state.secretPin.damaged ? 'Recovery PIN file is damaged' : null);
const firstReason = (...checks) => {
  for (const check of checks) {
    const reason = check();
    if (reason) return reason;
  }
  return null;
};

const ACTION_GUARDS = {
  'add-coin': () => noDesktopApp(),
  'start-quote-acquire': () => firstReason(noDesktopApp, noLaunchWallet, () => {
    const status = classicFundingEstimateStatus(currentLaunchConfig());
    if (!status.matchesConfig) return status.stale ? 'Funding estimate is out of date' : 'No funding estimate yet';
    if (!quoteAcquireRoutes().length) return quoteAcquireManualCount() ? 'Pair tokens need a manual deposit' : 'No pair tokens to buy';
    return null;
  }),
  'clear-quote-acquire': () => (state.quoteAcquire.running || ['paused', 'recovery_required'].includes(state.quoteAcquire.job?.status)
    ? 'A saved purchase is unfinished' : null),
  'review-and-arm-run': () => firstReason(
    () => (state.demoActive ? 'Test mode is on' : null),
    () => (walletIsUnlocked() ? null : 'Launch wallet is locked'),
  ),
  'toggle-demo-mode': () => noDesktopApp(),
  'run-demo-launch': () => firstReason(noDesktopApp, () => (state.demoActive ? null : 'Test mode is off'), noLaunchWallet),
  'execute-next-run': () => firstReason(noDesktopApp, noLaunchWallet, () => (state.demoActive ? 'Test mode is on' : null)),
  'run-full-launch': () => firstReason(noDesktopApp, noLaunchWallet, launchBusy),
  'run-launch': () => firstReason(noDesktopApp, () => (walletIsUnlocked() ? null : 'Launch wallet is locked')),
  'fit-airdrop-budget': () => {
    const plan = currentAirdropPlan();
    if (!plan.enabled) return 'No airdrop recipients';
    return plan.requiredSupplyPercent ? null : 'No amounts to fit';
  },
  'preview-pool-support': () => noDesktopApp(),
  'open-pool-support': () => noLaunchWallet(),
  'download-v2-dossier': () => {
    const proof = currentLaunchProof();
    if (!proof?.token?.mint) return null;
    const config = proofConfigForFingerprint(proof, currentLaunchConfig());
    if (!proofCanCreateLocalDossier(proof, config)) return 'Token and pool IDs not recorded yet';
    return airdropCompletionIssue(airdropCompletionStatus(proof, config.poolTopology));
  },
  'sweep-recovery-wallet': (element) => firstReason(noDesktopApp, launchBusy, () => {
    const wallet = pendingRecoveryWallet(element.dataset.wallet);
    if (!wallet) return null;
    if (wallet.decryptionFailed && !wallet.secretPinLocked) return 'Key unreadable';
    return state.secretPin.locked || wallet.secretPinLocked ? 'Recovery PIN is locked' : null;
  }),
  'cancel-refund-launch': () => firstReason(noDesktopApp, noLaunchWallet, () => (
    state.fullRunRunning || state.realExecutionRunning || state.demoLaunchRunning || state.reportPublishing || state.airdropRunning || state.quoteAcquire.running
      ? 'A launch step is running' : null
  ), () => (state.secretPin.locked ? 'Recovery PIN is locked' : null), () => {
    const destination = currentLaunchConfig().poolTopology.sweepDestination || '';
    if (!isProbablySolanaAddress(destination)) return 'No return wallet set';
    return destination === selectedLaunchWalletPublicKey() ? 'Return wallet is the launch wallet' : null;
  }),
  'check-updates': () => firstReason(noDesktopApp, () => (state.updateCheck.checking ? 'Checking…' : null)),
  'toggle-update-autocheck': () => noDesktopApp(),
  'toggle-report-publish': () => noDesktopApp(),
  'test-rpc': () => noDesktopApp(),
  'add-rpc': () => noDesktopApp(),
  'select-rpc': () => noDesktopApp(),
  'remove-rpc': () => firstReason(noDesktopApp, () => (state.rpcSaved.length <= 1 ? 'The only saved RPC' : null)),
  'import-wallet': () => noDesktopApp(),
  'setup-secret-pin': () => firstReason(noDesktopApp, pinDamaged, () => (state.secretPin.configured ? 'Already set' : null)),
  'unlock-secret-pin': () => firstReason(noDesktopApp, pinDamaged),
  'change-secret-pin': () => firstReason(noDesktopApp, pinDamaged, () => (state.secretPin.configured ? null : 'No Recovery PIN set')),
  'lock-secret-pin': () => noDesktopApp(),
  'reset-secret-pin': () => firstReason(noDesktopApp, () => (state.secretPin.configured ? null : 'No Recovery PIN set')),
  'load-wallet-qr': () => noLaunchWallet(),
  'reveal-wallet-secret': () => firstReason(noDesktopApp, noLaunchWallet),
  'discard-wallet': () => firstReason(noDesktopApp, noLaunchWallet, launchBusy),
  'sign-return-wallet': () => noDesktopApp(),
  'set-finish-return-wallet': () => noDesktopApp(),
  'prune-hidden-vanity': () => {
    const visible = new Set(state.vanityCandidates.slice(-VANITY_VISIBLE_CANDIDATE_LIMIT).map((candidate) => candidate.publicKey));
    if (state.selectedVanityPublicKey) visible.add(state.selectedVanityPublicKey);
    return state.vanityCandidates.some((candidate) => !visible.has(candidate.publicKey)) ? null : 'No hidden addresses';
  },
  'calibrate-vanity': () => firstReason(noDesktopApp, () => (runningGrindJob() ? 'A grind is running' : null), () => (state.vanityAvailable ? null : 'No grinder in this build')),
  'select-vanity': (element) => vanityAddressUsedReason(element.dataset.publicKey),
  'remove-selected-vanity': () => (state.vanityCandidates.some((item) => item.publicKey === state.selectedVanityPublicKey) ? null : 'No saved address selected'),
  'toggle-held-share': () => (heldShareLocked() ? 'Locked once the token exists' : null),
};

function actionBlockedReason(element) {
  const guard = ACTION_GUARDS[element.dataset.action];
  if (!guard) return null;
  try { return guard(element) || null; } catch { return null; }
}

// Grey out every guarded action on the page that can't run, and show why. Only re-enables what it
// disabled itself, so a button a renderer disabled for its own reason stays disabled.
function applyActionGuards(root = document) {
  for (const element of root.querySelectorAll('[data-action]')) {
    if (!ACTION_GUARDS[element.dataset.action]) continue;
    const reason = actionBlockedReason(element);
    if (reason) {
      if (element.dataset.blockedReason !== reason) element.dataset.blockedReason = reason;
      if ('disabled' in element && !element.disabled) { element.disabled = true; element.dataset.guardDisabled = 'true'; }
      element.setAttribute('aria-disabled', 'true');
      if (element.title !== reason) element.title = reason;
    } else if (element.dataset.blockedReason) {
      delete element.dataset.blockedReason;
      element.removeAttribute('aria-disabled');
      element.removeAttribute('title');
      if (element.dataset.guardDisabled) { element.disabled = false; delete element.dataset.guardDisabled; }
    }
  }
}

let actionGuardFrame = 0;
function scheduleActionGuards() {
  if (actionGuardFrame) return;
  actionGuardFrame = requestAnimationFrame(() => { actionGuardFrame = 0; applyActionGuards(); });
}

// Renderers replace markup all the time; re-check guards whenever new elements appear.
function bindActionGuards() {
  new MutationObserver((records) => {
    if (records.some((record) => record.addedNodes.length)) scheduleActionGuards();
  }).observe(document.body, { childList: true, subtree: true });
  scheduleActionGuards();
}
