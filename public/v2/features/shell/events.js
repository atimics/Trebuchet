function drawLaunchCanvas() {
  const canvas = document.getElementById('launchCanvas');
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const scale = window.devicePixelRatio || 1;
  canvas.width = Math.floor(rect.width * scale);
  canvas.height = Math.floor(rect.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(scale, 0, 0, scale, 0, 0);

  const styles = getComputedStyle(document.documentElement);
  const green = styles.getPropertyValue('--green').trim();
  const amber = styles.getPropertyValue('--amber').trim();
  const red = styles.getPropertyValue('--red').trim();
  const blue = styles.getPropertyValue('--blue').trim();
  const muted = styles.getPropertyValue('--muted').trim();
  const panel = styles.getPropertyValue('--panel').trim();
  const width = rect.width;
  const height = rect.height;
  const colors = [green, blue, amber, green, red];
  const points = launchStages.map((_, index) => {
    const x = 42 + ((width - 84) * index) / (launchStages.length - 1);
    const y = index % 2 === 0 ? height * 0.62 : height * 0.33;
    return [x, y];
  });

  ctx.clearRect(0, 0, width, height);
  ctx.strokeStyle = muted;
  ctx.globalAlpha = 0.16;
  ctx.lineWidth = 1;
  for (let y = 32; y < height; y += 32) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  ctx.globalAlpha = 1;
  ctx.strokeStyle = green;
  ctx.lineWidth = 3;
  ctx.beginPath();
  points.forEach(([x, y], index) => {
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  points.forEach(([x, y], index) => {
    const active = index === state.launchStage;
    ctx.beginPath();
    ctx.fillStyle = colors[index];
    ctx.arc(x, y, active ? 12 : 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = panel;
    ctx.font = '800 11px system-ui';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(index + 1), x, y);
  });
}

// Fields the vortex draws from. Editing one of these with the keyboard should
// move the funnel immediately, not only on the next full render.
const VORTEX_INPUT_IDS = new Set([
  'mainPoolPercent',
  'quotePoolPercent',
  'quotePoolVenue',
  'liquidityBudgetSol',
  'launchSol',
  'sweepDestination',
]);

function handleDynamicInput(event) {
  if (event.target.id === 'hubTokenCa') {
    hubPicker.mint = event.target.value;
    hubPicker.requestId += 1;
    hubPicker.result = null;
    hubPicker.loading = false;
    hubPicker.error = '';
    $('#hubPicker .hub-picker-result')?.remove();
    const status = $('#hubPicker .hub-picker-status');
    if (status) status.textContent = '';
    return;
  }
  const quoteMint = event.target?.dataset?.sellQuoteMint;
  if (quoteMint) {
    coinEvidence.set(quoteMint, { ...coinEvidence.get(quoteMint), amount: event.target.value });
    return;
  }
  if (SUPPLY_SHARE_INPUT_IDS.has(event.target?.id)
      || event.target?.dataset?.customPoolField === 'supplyPercent') {
    scheduleMainPoolRebalance();
  }
  const supplyInput = event.target.closest?.('[data-supply-target]');
  if (supplyInput && supplyInput.tagName === 'INPUT') {
    const field = $(supplyInput.dataset.supplyTarget);
    if (field) {
      field.value = supplyInput.value;
      field.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return;
  }
  if (handleOperatorPromptInput(event)) return;
  if (handleRecoveryPinInput(event)) return;
  if (event.target.closest?.('#advancedLaunchControls')) renderMoreOptionsSummary(); if (['tokenName', 'tokenSymbol'].includes(event.target?.id)) { renderCoinContext(); renderWorkingCoinCards(); }
  if (event.target?.dataset?.supportField) {
    resetPoolSupport();
    return;
  }

  if (VORTEX_INPUT_IDS.has(event.target?.id)) {
    renderVortexControl();
  }

  if (event.target.id === 'discoverySearchInput') {
    state.discovery.query = event.target.value;
    renderDiscovery();
    return;
  }

  if (event.target.id === 'discoveryNotesInput') {
    const selected = selectedDiscovery();
    if (!selected) return;
    selected.notes = event.target.value.slice(0, 500);
    persistDiscoveryRegistry();
    return;
  }

  const solInput = event.target.closest('[data-sol-pool-field]');
  if (solInput) {
    const solField = solInput.dataset.solPoolField;
    if (solField === 'venue') state.solPoolVenue = solInput.value === 'meteora-damm-v2' ? 'meteora-damm-v2' : 'raydium';
    else if (solField === 'dammFeeBps') state.solPoolDamm = { ...state.solPoolDamm, feeBps: Number(solInput.value) || 25 };
    else if (solField === 'dammRange') state.solPoolDamm = { ...state.solPoolDamm, rangeMultiple: Number(solInput.value) || 1000 };
    else state.solPoolConfigIndex = Math.floor(parseNumericInput(solInput.value, DEFAULT_POOL_CONFIG_INDEX));
    invalidateClassicOutputs();
    refreshClassicPreview();
    renderSupplyEditorAfterTier(solInput);
    return;
  }

  const quoteInput = event.target.closest('[data-quote-pool-field]');
  if (quoteInput) {
    if (quoteInput.dataset.quotePoolField === 'ammConfigIndex') {
      state.pairPoolConfigIndex = Math.floor(parseNumericInput(quoteInput.value, DEFAULT_POOL_CONFIG_INDEX));
      if (quoteInput.classList.contains('supply-tier')) { invalidateClassicOutputs(); refreshClassicPreview(); renderSupplyEditorAfterTier(quoteInput); return; }
    } else if (quoteInput.dataset.quotePoolField === 'startPremiumPct') {
      state.pairStartPremiumPct = clampNumber(parseNumericInput(quoteInput.value, state.pairStartPremiumPct), 0, 500);
    }
    invalidateClassicOutputs();
    refreshClassicPreview();
    return;
  }

  const customInput = event.target.closest('[data-custom-pool-field]');
  if (customInput) {
    const pool = state.customPools.find((item) => item.id === customInput.dataset.poolId);
    if (!pool) return;
    pool[customInput.dataset.customPoolField] = customInput.value;
    if (customInput.classList.contains('supply-tier')) { invalidateClassicOutputs(); refreshClassicPreview(); renderSupplyEditorAfterTier(customInput); return; }
    if (['quoteMint', 'quoteSymbol'].includes(customInput.dataset.customPoolField)) {
      delete state.quoteTokenInfo[pool.id];
    }
    invalidateClassicOutputs();
    refreshClassicPreview();
    return;
  }

  const baseInput = event.target.closest('[data-base-field]');
  if (baseInput) {
    if (baseInput.dataset.baseField === 'manualLadderText') {
      state.baseManualLadderText = baseInput.value;
    } else if (baseInput.dataset.baseField === 'baseSupportDepth') {
      state.baseSupportDepth = baseInput.value;
    } else if (baseInput.dataset.baseField === 'baseSupportLayersText') {
      state.baseSupportLayersText = baseInput.value;
    }
    invalidateClassicOutputs();
    refreshClassicPreview();
    return;
  }

  if (event.target.id === 'airdropCsvText') {
    state.airdropCsvText = event.target.value;
    invalidateClassicOutputs();
    refreshClassicPreview();
    return;
  }

  if (event.target.id === 'vanityStart' || event.target.id === 'vanityEnd') {
    state.vanityInputError = null;
    $('#vanityStart')?.removeAttribute('aria-invalid');
    $('#vanityEnd')?.removeAttribute('aria-invalid');
    renderVanityCandidates();
  }

}

function handleClick(event) {
  const nav = event.target.closest('[data-view]');
  if (nav) {
    // Coins in the nav always opens the list, freshly read: a launch may
    // have added a coin since it was last loaded.
    if (nav.dataset.view === 'coins') {
      state.coins = { ...state.coins, key: null };
      setView('coins');
      refreshCoins().catch(() => null);
      return;
    }
    setView(nav.dataset.view);
    return;
  }

  const planTab = event.target.closest('[data-plan-tab]');
  if (planTab) {
    setPlanSlide(planTab.dataset.planTab);
    return;
  }

  const workspaceControl = event.target.closest('button[data-launch-workspace]');
  if (workspaceControl) {
    setLaunchWorkspace(workspaceControl.dataset.launchWorkspace, {
      focus: workspaceControl.classList.contains('coin-fact'),
    });
    return;
  }

  const discoveryFilter = event.target.closest('[data-discovery-filter]');
  if (discoveryFilter) {
    state.discovery.filter = discoveryFilter.dataset.discoveryFilter;
    renderDiscovery();
    return;
  }

  const discoveryPane = event.target.closest('[data-discovery-pane]');
  if (discoveryPane) {
    state.discovery.activePane = ['wallets', 'inspect', 'saved'].includes(discoveryPane.dataset.discoveryPane) ? discoveryPane.dataset.discoveryPane : 'tokens';
    renderDiscoveryPanes();
    return;
  }

  const actionTarget = event.target.closest('[data-action]');
  if (!actionTarget) return;
  // A greyed-out action shows its reason beside it; clicking it does nothing.
  if (actionTarget.dataset.blockedReason) return;

  const { action } = actionTarget.dataset;
  if (action === 'quick-launch-run') {
    quickLaunchDemoRun();
    renderLaunchPreview();
    renderLaunchWorkspace();
    return;
  }
  if (action === 'open-saved-launch') {
    switchActiveLaunch(actionTarget.dataset.launchId);
    return;
  }
  if (action === 'new-launch') {
    switchActiveLaunch(null);
    return;
  }
  if (action === 'open-launch-identity') {
    setView('launch');
    renderLaunchIdentity();
    return;
  }
  if (action === 'apply-launch-preset') {
    applyLaunchPreset(actionTarget.dataset.preset).catch((error) => notify(error.message || 'Could not apply the preset'));
    return;
  }
  if (action === 'select-launch-budget') {
    applyLaunchBudgetRecommendation(actionTarget.dataset.budget);
    return;
  }
  if (action === 'show-more-discovery-wallets') {
    state.discovery.walletRenderLimit = Math.max(100, Number(state.discovery.walletRenderLimit) || 100) + 100;
    renderPersonalDiscovery();
    return;
  }
  if (action === 'launch-rail-act') {
    runLaunchRailAction();
    return;
  }
  if (action === 'hub-picker-page') {
    hubPicker.page = (Number(hubPicker.page) || 0) + Number(actionTarget.dataset.dir || 0);
    renderHubPicker();
    return;
  }
  if (action === 'customize-quote-pool') {
    customizeQuotePool();
    return;
  }
  if (action === 'set-pool-venue' || action === 'set-pool-fee') {
    applyPoolSwitch(action, actionTarget);
    return;
  }
  if (action === 'set-pool-tier' || action === 'set-pool-range') {
    applyPoolSwitch(action, actionTarget);
    return;
  }
  if (action === 'reconcile-network') {
    reconcileNetwork(actionTarget.dataset.match);
    return;
  }
  if (action === 'export-pool-config') {
    exportPoolConfig();
    return;
  }
  if (action === 'import-pool-config') {
    importPoolConfig();
    return;
  }
  if (action === 'toggle-nav') {
    setNavMode(document.body.dataset.nav === 'icons' ? 'full' : 'icons');
    return;
  }
  if (action === 'select-environment') {
    setExecutionEnvironment(actionTarget.dataset.environment).catch((error) => {
      notify(error.message || 'Could not change the execution environment');
    });
    return;
  }
  if (action === 'open-wallet-tracking') {
    state.discovery.activePane = 'wallets';
    renderDiscoveryPanes();
    return;
  }
  if (action === 'cancel-operator-prompt') {
    closeOperatorPrompt(null);
    return;
  }
  if (action === 'submit-operator-prompt') {
    submitOperatorPrompt();
    return;
  }
  if (action === 'cancel-sweep-confirm') {
    closeSweepConfirmation(null);
    return;
  }
  if (action === 'submit-sweep-confirm') {
    submitSweepConfirmation();
    return;
  }
  if (action === 'step-number') {
    const input = actionTarget.closest('.number-stepper')?.querySelector('input[type="number"]');
    stepNumberInput(input, Number(actionTarget.dataset.direction));
    return;
  }
  if (state.activeView === 'launch') {
    const actionWorkspace = {
      'start-vanity': 'mint',
      'estimate-funding': 'fund',
      'start-quote-acquire': 'fund',
      'publish-launch-report': 'finish',
      'download-launch-dossier': 'finish',
      'cancel-refund-launch': 'finish',
    }[action];
    if (actionWorkspace && !actionTarget.dataset.stay) {
      // Each of these acts on the phase's own panel, or on the address settings.
      state.phaseSlide = { ...(state.phaseSlide || {}), [actionWorkspace]: action === 'start-vanity' ? 'address' : actionWorkspace === 'fund' ? 'cost' : 'run' };
      setLaunchWorkspace(actionWorkspace);
    }
  }
  if (action === 'review') {
    if (!walletIsUnlocked()) {
      setView('wallet');
      notify(selectedLaunchWalletPublicKey() ? 'Unlock the launch wallet before review' : 'Generate or select a launch wallet first');
      return;
    }
    state.activeApprovalId = actionTarget.dataset.tx;
    state.approvalOpen = true;
    renderAll();
    return;
  }

  if (action === 'run-launch') {
    runLaunchEnvelope();
    return;
  }

  if (action === 'generate-wallet') {
    generateManagedWallet().catch((error) => notify(error.message || 'Wallet generation failed'));
    return;
  }

  if (action === 'start-vanity') {
    startVanityGrind().catch((error) => notify(error.message || 'Vanity grind failed'));
    return;
  }

  if (action === 'focus-recovery-pin') {
    focusRecoveryPinGate();
    return;
  }

  if (action === 'cancel-recovery-pin') {
    cancelRecoveryPinGate();
    return;
  }

  if (action === 'select-verify-panel') {
    state.verifyPanel = actionTarget.dataset.verifyPanel === 'audit' ? 'audit' : 'proof';
    renderClassicBridge();
    renderLaunchWorkspace();
    return;
  }

  if (action === 'shuffle-flywheel') {
    shuffleMemeFlywheel();
    return;
  }

  if (action === 'select-vanity') {
    state.selectedVanityPublicKey = actionTarget.dataset.publicKey || null;
    renderAll();
    notify(state.selectedVanityPublicKey ? 'Vanity CA selected' : 'Random CA selected');
    return;
  }

  if (action === 'remove-selected-vanity') {
    removeVanityCandidateByPublicKey(state.selectedVanityPublicKey).catch((error) => notify(error.message || 'Failed to remove Vanity CA'));
    return;
  }

  if (action === 'prune-hidden-vanity') {
    pruneHiddenVanityCandidates().catch((error) => notify(error.message || 'Failed to prune Vanity CAs'));
    return;
  }

  if (action === 'estimate-funding') {
    estimateClassicFunding();
    return;
  }

  if (action === 'edit-return-wallet') {
    editReturnWallet();
    return;
  }

  if (action === 'set-finish-return-wallet') {
    openWalletSigning();
    return;
  }

  if (action === 'detect-funding-wallet') {
    detectFundingWallet();
    return;
  }

  if (action === 'new-coin') {
    newCoin();
    return;
  }
  if (action === 'open-coin') {
    openCoin(actionTarget.dataset.coinKey);
    return;
  }
  if (action === 'open-coin-mint') {
    openCoinByMint(actionTarget.dataset.mint);
    return;
  }
  if (action === 'coins-back') {
    state.coins = { ...state.coins, key: null };
    setView('coins');
    refreshCoins().catch(() => null);
    return;
  }
  if (action === 'continue-coin-step') {
    continueCoinStep(actionTarget.dataset.mint);
    return;
  }
  if (action === 'add-coin') {
    addCoinByMint().catch((error) => notify(error.message || 'Could not add that coin'));
    return;
  }
  if (action === 'remove-coin') {
    removeAddedCoin(actionTarget.dataset.mint).catch(() => null);
    return;
  }
  if (action === 'open-market-evidence') {
    openCoinByMint(actionTarget.dataset.mint);
    return;
  }
  if (action === 'read-coin-evidence') {
    readCoinMarketEvidence(actionTarget.dataset.mint);
    return;
  }
  if (action === 'quote-coin-sale') {
    quoteCoinSale(actionTarget.dataset.mint);
    return;
  }
  if (action === 'download-coin-evidence') {
    const evidence = coinEvidence.get(actionTarget.dataset.mint)?.evidence;
    if (evidence) downloadJsonFile(`trebuchet-${evidence.mint}-market-evidence.json`, evidence, 'Market evidence');
    return;
  }
  if (action === 'refresh-coin') {
    const coin = coinByKey(state.coins.key);
    if (coin?.mint) loadCoinDetail(coin.mint).catch(() => null);
    return;
  }
  if (action === 'resume-coin-withdrawal') {
    resumeCoinWithdrawal(actionTarget.dataset.job).catch((error) => notify(error.message || 'Read the saved withdrawal again.'));
    return;
  }
  if (action === 'withdraw-coin-position') {
    withdrawCoinPosition(actionTarget.dataset.nft).catch((error) => notify(error.message || 'Withdrawing failed'));
    return;
  }
  if (action === 'refresh-coin-positions') {
    if (state.coinPositions.mint) loadCoinPositions(state.coinPositions.mint).catch(() => null);
    return;
  }
  if (action === 'preview-pool-support') {
    previewPoolSupport().catch((error) => notify(error.message || 'Preview failed'));
    return;
  }
  if (action === 'resume-support-job') { resumeSupportPositionJob(actionTarget.dataset.jobId); return; }
  if (action === 'open-pool-support') {
    openPoolSupport().catch((error) => notify(error.message || 'Adding support failed'));
    return;
  }
  if (action === 'toggle-held-share') {
    toggleHeldShareFunder(actionTarget.dataset.address);
    return;
  }
  if (action === 'use-funding-wallet-sweep') {
    setReturnWallet('');
    notify('Assets return to the funding wallet');
    return;
  }

  if (action === 'sign-return-wallet') {
    openWalletSigning();
    return;
  }

  if (action === 'use-signed-wallet') {
    setReturnWallet(actionTarget.dataset.address);
    return;
  }

  if (action === 'connect-solflare') {
    connectSolflareWallet().catch((error) => notify(error.message || 'Solflare connection failed'));
    return;
  }

  if (action === 'disconnect-solflare') {
    disconnectSolflareWallet().catch((error) => notify(error.message || 'Solflare disconnect failed'));
    return;
  }

  if (action === 'use-solflare-destination') {
    applySolflareAsSweepDestination();
    return;
  }

  if (action === 'check-readiness') {
    checkExecutionReadiness();
    return;
  }

  if (action === 'review-and-arm-run') {
    reviewAndArmRun().catch((error) => notify(error.message || 'Could not prepare the launch review'));
    return;
  }

  if (action === 'run-demo-launch') {
    runDemoLaunch();
    return;
  }

  if (action === 'execute-next-run') {
    executeNextRunOperation();
    return;
  }

  if (action === 'run-full-launch') {
    runFullLaunch();
    return;
  }

  if (action === 'start-quote-acquire') {
    startQuoteAcquire();
    return;
  }

  if (action === 'poll-quote-acquire') {
    pollQuoteAcquire();
    return;
  }

  if (action === 'clear-quote-acquire') {
    clearQuoteAcquire();
    return;
  }

  if (action === 'refresh-manual-prefund') {
    refreshManualPrefundBalance();
    return;
  }

  if (action === 'open-activity-log') {
    activityLogReturnFocus = actionTarget;
    state.activityLog.open = true;
    renderActivityLogDrawer();
    window.requestAnimationFrame(() => $('#activityLogDrawer .activity-drawer-head button')?.focus());
    return;
  }

  if (action === 'close-activity-log') {
    state.activityLog.open = false;
    renderActivityLogDrawer();
    const returnFocus = activityLogReturnFocus;
    activityLogReturnFocus = null;
    restoreDialogFocus(returnFocus);
    return;
  }

  if (action === 'filter-activity-log') {
    const nextFilter = actionTarget.dataset.logFilter;
    if (['all', 'progress', 'airdrop', 'log', 'warn', 'error'].includes(nextFilter)) {
      state.activityLog.filter = nextFilter;
      renderActivityLogDrawer();
    }
    return;
  }


  if (action === 'cancel-refund-launch') {
    cancelRefundLaunch();
    return;
  }

  if (action === 'round-slices-100') {
    normalizeAllSlices();
    return;
  }

  if (action === 'add-custom-pool') {
    openHubPicker();
    return;
  }

  if (action === 'close-hub-picker') {
    closeHubPicker();
    return;
  }
  if (action === 'find-hub-pool') {
    findHubPool(actionTarget.dataset.hubMint);
    return;
  }
  if (action === 'use-hub-token') {
    useHubToken();
    return;
  }

  if (action === 'resolve-custom-quote') {
    resolveCustomQuoteToken(actionTarget.dataset.poolId).catch((error) => notify(error.message || 'Quote-token verification failed'));
    return;
  }

  if (action === 'supply-toggle-settings') {
    const row = actionTarget.dataset.supplyRow;
    state.supplyOpenRow = state.supplyOpenRow === row ? null : row;
    renderSupplyEditor();
    return;
  }

  if (action === 'supply-clear') {
    const field = $(actionTarget.dataset.supplyTarget);
    if (field) {
      field.value = '0';
      field.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return;
  }

  if (action === 'remove-custom-pool') {
    removeCustomPool(actionTarget.dataset.poolId);
    return;
  }

  if (action === 'sample-airdrop') {
    setAirdropText([
      'wallet,tokens',
      '11111111111111111111111111111111,1000',
      'So11111111111111111111111111111111111111112,2500',
    ].join('\n'));
    return;
  }

  if (action === 'fit-airdrop-budget') {
    fitAirdropBudget();
    return;
  }

  if (action === 'clear-airdrop') {
    setAirdropText('');
    return;
  }

  if (action === 'clear-token-logo') {
    clearTokenLogo();
    return;
  }

  if (action === 'toggle-report-publish') {
    toggleReportPublishingPref().catch((error) => notify(error.message || 'Report publishing preference failed'));
    return;
  }

  if (action === 'download-report-preview') {
    downloadReportPreview();
    return;
  }

  if (action === 'publish-v2-report') {
    publishV2LaunchReport();
    return;
  }

  if (action === 'run-v2-airdrop') {
    runV2Airdrop();
    return;
  }

  if (action === 'retry-v2-airdrop') {
    runV2Airdrop({ retry: true });
    return;
  }

  if (action === 'download-v2-proof') {
    downloadV2Proof();
    return;
  }

  if (action === 'download-v2-dossier') {
    downloadV2DossierHtml();
    return;
  }

  if (action === 'load-v2-proof') {
    requestV2ProofImport();
    return;
  }

  if (action === 'copy-v2-proof-summary') {
    copyText(buildProofShareSummary(), 'Launch record summary');
    return;
  }




  if (action === 'inspect-recovery') {
    // A launch with a token is recovered on its coin page, which shows what is left and runs it.
    const mint = proofTokenMint(currentLaunchProof());
    if (mint && !isDemoLaunchProof(currentLaunchProof())) {
      openCoinByMint(mint);
      return;
    }
    state.coins = { ...state.coins, key: null };
    setView('coins');
    return;
  }

  if (action === 'review-plan') {
    stageTransactions();
    return;
  }

  if (action === 'retry-local-api') {
    bootLocalApi().catch((error) => notify(error.message || 'Local API retry failed'));
    return;
  }

  if (action === 'inspect-proof-asset') {
    const url = actionTarget.dataset.url;
    if (url) {
      window.open?.(url, '_blank', 'noopener,noreferrer');
      return;
    }
    setView('launch');
    state.verifyPanel = 'proof';
    setLaunchWorkspace('finish', { focus: true });
    renderAll();
    window.requestAnimationFrame(() => document.getElementById('proofExplorer')?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
    return;
  }

  if (action === 'inspect-runbook-blocker') {
    setView('launch');
    state.verifyPanel = 'audit';
    setLaunchWorkspace('finish', { focus: true });
    renderAll();
    notify(actionTarget.dataset.message || 'Review the active field-verification blocker');
    window.requestAnimationFrame(() => $('#stageList .is-active')?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
    return;
  }

  if (action === 'import-wallet') {
    importManagedWallet().catch((error) => notify(error.message || 'Wallet import failed'));
    return;
  }

  if (action === 'close-approval') {
    state.approvalOpen = false;
    state.launchAfterArm = false;
    renderExtension();
    return;
  }

  if (action === 'choose-launch-wallet') {
    setView('wallet');
    return;
  }

  if (action === 'unlock-wallet-and-continue') {
    unlockLaunchWalletAndContinue().catch((error) => notify(error.message || 'Wallet unlock failed'));
    return;
  }

  if (action === 'toggle-wallet') {
    state.approvalOpen = false;
    if (!selectedLaunchWalletPublicKey()) {
      setView('wallet');
      notify('Generate or select a launch wallet first');
      return;
    }
    if (!state.secretPin.configured) {
      setView('wallet');
      notify('Set a Recovery PIN to add explicit wallet lock controls');
      return;
    }
    if (state.secretPin.locked || !walletIsUnlocked()) {
      // The button reads "Unlock" whenever the wallet is not usable, so it must
      // never lock the PIN in that state (an unreadable wallet is not a locked PIN).
      unlockSecretPin().catch((error) => notify(error.message || 'Wallet unlock failed'));
    } else {
      lockSecretPin().catch((error) => notify(error.message || 'Wallet lock failed'));
    }
    return;
  }

  if (action === 'select-account') {
    const selectedAccountId = actionTarget.dataset.account;
    const selectedAccount = walletAccounts().find((item) => item.id === selectedAccountId);
    state.accountId = selectedAccountId;
    state.selectedWalletPublicKey = selectedAccount?.publicKey || null;
    state.revealedWallet = null;
    state.revealError = null;
    resetManualPrefundState();
    resetFundingWalletState();
    renderAll();
    notify(`${account().name} selected`);
    return;
  }





  if (action === 'cancel-support-job') {
    cancelSavedSupportJob(actionTarget.dataset.jobId).catch((error) => notify(error.message || 'Support cancel failed'));
    return;
  }

  if (action === 'sweep-recovery-wallet') {
    sweepRecoveryWallet(actionTarget.dataset.wallet).catch((error) => notify(error.message || 'Recovery sweep failed'));
    return;
  }


  if (action === 'copy-wallet-address') {
    copyText(selectedLaunchWalletPublicKey(), 'Funding address');
    return;
  }

  if (action === 'load-wallet-qr') {
    loadWalletQr().catch((error) => notify(error.message || 'Wallet QR failed'));
    return;
  }

  if (action === 'reveal-wallet-secret') {
    revealWalletSecret().catch((error) => notify(error.message || 'Recovery secret reveal failed'));
    return;
  }

  if (action === 'hide-wallet-secret') {
    clearRevealedWalletSecret();
    return;
  }

  if (action === 'discard-wallet') {
    discardSelectedWallet().catch((error) => notify(error.message || 'Wallet discard failed'));
    return;
  }

  if (action === 'copy-wallet-secret') {
    const revealed = state.revealedWallet?.publicKey === selectedLaunchWalletPublicKey()
      ? state.revealedWallet
      : null;
    if (!revealed) {
      notify('Reveal the recovery secret first');
      return;
    }
    const secretType = actionTarget.dataset.secretType;
    const value = secretType === 'mnemonic'
      ? revealed.mnemonic
      : secretType === 'secretKeyJson'
        ? JSON.stringify(revealed.secretKey || [])
        : revealed.secretKeyB58;
    copyText(value, secretType === 'mnemonic' ? 'Mnemonic' : 'Recovery secret');
    return;
  }

  if (action === 'copy-manual-prefund') {
    const copyKind = actionTarget.dataset.copy;
    if (copyKind === 'wallet') {
      copyText(selectedLaunchWalletPublicKey(), 'Manual prefund wallet');
      return;
    }
    const item = quoteManualPrefundItems().find((row) => row.mint === actionTarget.dataset.mint);
    if (!item) {
      notify('Manual prefund row is unavailable');
      return;
    }
    if (copyKind === 'mint') {
      copyText(item.mint, 'Quote token mint');
      return;
    }
    if (copyKind === 'amount') {
      copyText(plainManualPrefundAmount(item.amount) || item.rawAmount, 'Manual prefund amount');
      return;
    }
    return;
  }

  if (action === 'setup-secret-pin') {
    setupSecretPin().catch((error) => notify(error.message || 'Recovery PIN setup failed'));
    return;
  }

  if (action === 'sweep-all-wallets') {
    sweepAllWallets().catch((error) => notify(error.message || 'Sweep all failed'));
    return;
  }
  if (action === 'unlock-secret-pin') {
    unlockSecretPin().catch((error) => notify(error.message || 'Recovery PIN unlock failed'));
    return;
  }

  if (action === 'change-secret-pin') {
    changeSecretPin().catch((error) => notify(error.message || 'Recovery PIN change failed'));
    return;
  }

  if (action === 'lock-secret-pin') {
    lockSecretPin().catch((error) => notify(error.message || 'Recovery PIN lock failed'));
    return;
  }

  if (action === 'reset-secret-pin') {
    resetSecretPin().catch((error) => notify(error.message || 'Recovery PIN reset failed'));
    return;
  }

  if (action === 'refresh-secret-pin') {
    refreshSecretPinStatus({ reloadBoot: true })
      .then(() => {
        renderAll();
      })
      .catch((error) => notify(error.message || 'Recovery PIN refresh failed'));
    return;
  }

  if (action === 'check-updates') {
    checkForUpdates().catch((error) => notify(error.message || 'Update check failed'));
    return;
  }

  if (action === 'toggle-demo-mode') {
    setDemoMode(!state.demoActive).catch((error) => notify(error.message || 'Execution mode change failed'));
    return;
  }

  if (action === 'test-rpc') {
    testRpcEndpoint();
    return;
  }

  if (action === 'add-rpc') {
    addRpcEndpoint();
    return;
  }

  if (action === 'select-rpc') {
    selectRpcEndpoint(actionTarget.dataset.url);
    return;
  }

  if (action === 'remove-rpc') {
    removeRpcEndpoint(actionTarget.dataset.url);
    return;
  }

  if (action === 'toggle-update-autocheck') {
    toggleUpdateAutocheck().catch((error) => notify(error.message || 'Update preference failed'));
    return;
  }

  if (action === 'open-release-page') {
    const url = actionTarget.dataset.url || state.releaseUrl;
    if (typeof window.open === 'function') {
      window.open(url, '_blank');
    } else {
      notify(url);
    }
    return;
  }

  if (action === 'select-discovery') {
    state.selectedDiscoveryId = actionTarget.dataset.token;
    persistDiscoveryRegistry();
    renderDiscovery();
    return;
  }

  if (action === 'refresh-discovery') {
    inspectDiscoveryMint(actionTarget.dataset.token);
    return;
  }

  if (action === 'copy-discovery-mint') {
    copyText(actionTarget.dataset.token, 'Token mint');
    return;
  }

  if (action === 'remove-discovery') {
    removeDiscoveryRecord(actionTarget.dataset.token);
    return;
  }

  if (action === 'scan-personal-discovery') {
    startPersonalDiscoveryScan();
    return;
  }

  if (action === 'toggle-discovery-wallet') {
    setTrackedDiscoveryWalletEnabled(
      actionTarget.dataset.wallet,
      actionTarget.dataset.enabled === 'true',
    );
    return;
  }

  if (action === 'remove-discovery-wallet') {
    removeTrackedDiscoveryWallet(actionTarget.dataset.wallet);
    return;
  }

  if (action === 'inspect-personal-token') {
    inspectDiscoveryMint(actionTarget.dataset.token);
    return;
  }

}
