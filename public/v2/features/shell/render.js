function renderVanitySummary() {
  const summary = $('#vanitySummary');
  if (!summary) return;
  summary.textContent = state.selectedVanityPublicKey
    ? `${shortAddress(state.selectedVanityPublicKey)} · vanity`
    : 'Random address · recommended';
  // A section that holds the chosen address should not start collapsed, or the
  // address looks missing. Open it once per selected address; the operator can
  // still collapse it and it stays that way.
  const details = summary.closest('details');
  if (details && state.selectedVanityPublicKey
    && state.vanityDetailsOpenedFor !== state.selectedVanityPublicKey) {
    state.vanityDetailsOpenedFor = state.selectedVanityPublicKey;
    details.open = true;
  }
}

// "More options" stays folded, so its header names every choice inside it:
// defaults are visible without opening it, and changes are never hidden.
function renderMoreOptionsSummary() {
  const summary = $('#launchMoreSummary');
  if (!summary) return;
  const supply = parseWholeNumber($('#tokenSupply')?.value) || 1000000000;
  const compactSupply = supply >= 1e9 && supply % 1e9 === 0
    ? `${supply / 1e9}B`
    : supply >= 1e6 && supply % 1e6 === 0
      ? `${supply / 1e6}M`
      : supply.toLocaleString('en-US');
  const poolCount = Math.max(0, Number(currentLaunchConfig().poolTopology?.pools?.length || 0));
  const share = heldSharePlan(supply);
  const airdrop = currentAirdropPlan();
  summary.textContent = [
    `${compactSupply} supply`,
    $('#sealedLaunch')?.checked ? 'sealed' : 'not sealed',
    $('#mintFormat')?.value === 'classic-spl' ? 'Classic SPL' : 'Token-2022',
    state.selectedVanityPublicKey ? 'vanity address' : 'random address',
    `${poolCount} pool${poolCount === 1 ? '' : 's'}`,
    share.heldPercent > 0
      ? `${Number(share.heldPercent.toFixed(1))}% held back${share.active ? ` · shared with ${share.rows.length} funder${share.rows.length === 1 ? '' : 's'}` : ''}`
      : null,
    airdrop.csvRecipientCount > 0 ? `airdrop to ${airdrop.csvRecipientCount}` : null,
  ].filter(Boolean).join(' · ');
}

function renderLaunchRunningBar() {
  const bar = $('#launchRunningBar');
  if (bar) bar.hidden = state.realExecutionRunning !== true;
  document.body.dataset.launchRunning = state.realExecutionRunning === true ? 'true' : 'false';
}

function renderAll() {
  renderLaunchRunningBar();
  renderVanitySummary();
  renderCoins();
  renderCoinContext();
  renderPoolSupport();
  renderMoreOptionsSummary();
  renderCustodySignal();
  renderLaunchPreview();
  renderLaunchIdentity();
  renderLiveLaunchMonitor();
  renderLaunchBudgetRecommendation();
  renderTokenLogoPreview();
  renderEnvironmentControls();
  renderChartDeck();
  renderVanityCandidates();
  renderFlywheelPick();
  renderVortexControl();
  renderPoolEditorPanel();
  renderSupplyEditor();
  renderAirdropPanel();
  renderReportPanel();
  renderClassicBridge();
  renderLiveOpsPanel();
  renderSignaturePanel();
  renderGlobalStrip();
  renderStages();
  renderQueue();
  renderGuardrails();
  renderWallet();
  renderDiscovery();
  renderExtension();
  renderSettings();
  renderActivityLogDrawer();
  renderRecoveryPinGate();
  renderLaunchWorkspace();
  enhanceNumberSteppers();
  drawLaunchCanvas();
}
