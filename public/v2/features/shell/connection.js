async function checkForUpdates() {
  if (state.apiStatus !== 'connected' || !state.apiClient?.checkForUpdates) {
    notify('Update checks require the Trebuchet desktop app');
    return;
  }
  if (state.updateCheck.checking) {
    notify('Update check already running');
    return;
  }
  state.updateCheck = {
    ...state.updateCheck,
    checking: true,
    error: null,
  };
  renderSettings();
  try {
    const result = await state.apiClient.checkForUpdates();
    if (result?.ran === false) {
      state.updateCheck = {
        ...state.updateCheck,
        checking: false,
        error: result.reason || 'Update check unavailable',
        lastResult: {
          status: 'error',
          message: result.reason === 'no-handler'
            ? 'Update checking is only available in the Electron app.'
            : result.reason || 'Update check unavailable.',
          releasesUrl: state.releaseUrl,
          checkOnStartup: state.prefs.checkForUpdatesOnStartup,
        },
        lastCheckedAt: new Date().toISOString(),
      };
      renderSettings();
      notify(state.updateCheck.lastResult.message);
      return;
    }
    notify('Update check requested');
    setTimeout(() => {
      if (!state.updateCheck.checking) return;
      state.updateCheck = {
        ...state.updateCheck,
        checking: false,
        lastCheckedAt: new Date().toISOString(),
      };
      if (state.activeView === 'settings') renderSettings();
    }, 20000);
  } catch (error) {
    state.updateCheck = {
      ...state.updateCheck,
      checking: false,
      error: error.message || 'Update check failed',
      lastResult: {
        status: 'error',
        message: error.message || 'Update check failed',
        releasesUrl: state.releaseUrl,
        checkOnStartup: state.prefs.checkForUpdatesOnStartup,
      },
      lastCheckedAt: new Date().toISOString(),
    };
    renderSettings();
    notify(state.updateCheck.error);
  }
}

async function toggleUpdateAutocheck() {
  const next = !state.prefs.checkForUpdatesOnStartup;
  if (state.apiStatus !== 'connected' || !state.apiClient?.setUserPrefs) {
    notify('Auto-update preference requires the Trebuchet desktop app');
    return;
  }
  state.prefs.checkForUpdatesOnStartup = next;
  renderSettings();
  try {
    const prefs = await state.apiClient.setUserPrefs({ checkForUpdatesOnStartup: next });
    state.prefs.checkForUpdatesOnStartup = prefs.checkForUpdatesOnStartup !== false;
    notify(`Startup update checks ${state.prefs.checkForUpdatesOnStartup ? 'enabled' : 'disabled'}`);
  } catch (error) {
    state.prefs.checkForUpdatesOnStartup = !next;
    notify(error.message || 'Update preference failed');
  } finally {
    renderSettings();
  }
}

async function toggleReportPublishingPref() {
  const next = state.prefs.publishLaunchReport === false;
  if (state.apiStatus !== 'connected' || !state.apiClient?.setUserPrefs) {
    notify('Report publishing preference requires the Trebuchet desktop app');
    return;
  }
  state.prefs.publishLaunchReport = next;
  invalidateClassicOutputs();
  refreshClassicPreview();
  try {
    const prefs = await state.apiClient.setUserPrefs({ publishLaunchReport: next });
    const previous = state.prefs.publishLaunchReport;
    state.prefs.publishLaunchReport = prefs.publishLaunchReport !== false;
    if (state.prefs.publishLaunchReport !== previous) {
      invalidateClassicOutputs();
      refreshClassicPreview();
    }
    notify(`Report publishing ${state.prefs.publishLaunchReport ? 'enabled' : 'disabled'}`);
  } catch (error) {
    state.prefs.publishLaunchReport = !next;
    invalidateClassicOutputs();
    refreshClassicPreview();
    notify(error.message || 'Report publishing preference failed');
  } finally {
    renderSettings();
  }
}

function rpcInputValues() {
  return {
    name: String($('[data-rpc-field="name"]')?.value || '').trim(),
    url: String($('[data-rpc-field="url"]')?.value || '').trim(),
  };
}

async function testRpcEndpoint() {
  const { url } = rpcInputValues();
  if (!url) {
    state.rpcTestResult = { ok: false, error: 'Enter an RPC URL first' };
    renderSettings();
    return;
  }
  if (state.apiStatus !== 'connected' || !state.apiClient?.testRpc) {
    notify('RPC testing requires the Trebuchet desktop app');
    return;
  }
  state.rpcBusy = 'test';
  state.rpcTestResult = null;
  renderSettings();
  try {
    state.rpcTestResult = await state.apiClient.testRpc(url);
    notify(state.rpcTestResult.ok ? 'RPC test passed' : 'RPC test failed');
  } catch (error) {
    state.rpcTestResult = { ok: false, error: error.message || 'RPC test failed' };
    notify(state.rpcTestResult.error);
  } finally {
    state.rpcBusy = null;
    renderSettings();
  }
}

async function addRpcEndpoint() {
  const { name, url } = rpcInputValues();
  if (!name || !url) {
    state.rpcTestResult = { ok: false, error: 'RPC name and URL are required' };
    renderSettings();
    return;
  }
  if (state.apiStatus !== 'connected' || !state.apiClient?.addRpc) {
    notify('RPC management requires the Trebuchet desktop app');
    return;
  }
  state.rpcBusy = 'add';
  renderSettings();
  try {
    const config = await state.apiClient.addRpc({ name, url, setActive: true });
    applyRpcConfig(config);
    state.rpcTestResult = null;
    await refreshLocalApiState();
    notify(`RPC added: ${name}`);
  } catch (error) {
    state.rpcTestResult = { ok: false, error: error.message || 'RPC save failed' };
    notify(state.rpcTestResult.error);
  } finally {
    state.rpcBusy = null;
    renderAll();
  }
}

async function selectRpcEndpoint(url) {
  if (!url) return;
  if (state.apiStatus !== 'connected' || !state.apiClient?.selectRpc) {
    notify('RPC management requires the Trebuchet desktop app');
    return;
  }
  state.rpcBusy = 'select';
  renderSettings();
  try {
    const config = await state.apiClient.selectRpc(url);
    applyRpcConfig(config);
    await refreshLocalApiState();
    notify(`RPC selected: ${safeRpcUrl(url)}`);
  } catch (error) {
    notify(error.message || 'RPC switch failed');
  } finally {
    state.rpcBusy = null;
    renderAll();
  }
}

async function removeRpcEndpoint(url) {
  if (!url) return;
  if (state.rpcSaved.length <= 1) {
    notify('Cannot remove the last saved RPC');
    return;
  }
  if (state.apiStatus !== 'connected' || !state.apiClient?.removeRpc) {
    notify('RPC management requires the Trebuchet desktop app');
    return;
  }
  {
    const ok = await confirmOperatorAction({
      title: 'Remove saved RPC',
      detail: `Remove ${safeRpcUrl(url)} from local settings?`,
      confirmLabel: 'Remove RPC',
      danger: true,
    });
    if (!ok) return;
  }
  state.rpcBusy = 'remove';
  renderSettings();
  try {
    const config = await state.apiClient.removeRpc(url);
    applyRpcConfig(config);
    await refreshLocalApiState();
    notify('RPC removed');
  } catch (error) {
    notify(error.message || 'RPC remove failed');
  } finally {
    state.rpcBusy = null;
    renderAll();
  }
}

function applyBootState(boot) {
  if (!boot?.api) {
    state.apiStatus = 'static';
    state.apiDetail = 'Static preview; local API is unavailable.';
    return;
  }

  state.apiStatus = boot.api.status || (boot.api.available ? 'connected' : 'static');
  state.apiDetail = boot.api.detail || 'Static preview; local API is unavailable.';
  state.demoActive = boot.demo?.active === true || state.apiStatus !== 'connected';
  state.launchMode = state.demoActive ? 'dry-run' : 'guarded';
  state.environmentReady = true;
  state.rpcActiveUrl = boot.rpc?.activeUrl || null;
  state.chainNetwork = boot.rpc?.network || null;
  state.rpcNetwork = boot.rpc?.rpcNetwork || null;
  state.networkMismatch = boot.rpc?.networkMismatch === true;
  state.rpcSaved = Array.isArray(boot.rpc?.saved) ? boot.rpc.saved : [];
  state.rpcName = boot.rpc?.label || 'Unknown RPC';
  state.rpcHealth = boot.rpc?.health || 'unknown';
  state.rpcHealthLabel = boot.rpc?.healthLabel || 'unknown';
  state.rpcLatencyMs = boot.rpc?.latencyMs ?? null;
  state.rpcError = boot.rpc?.error || null;
  state.viewportSmoke = boot.viewportSmoke || null;
  state.appVersion = boot.app?.version || null;
  state.releaseUrl = boot.app?.releaseUrl || state.releaseUrl;
  state.releaseTrust = boot.app?.releaseTrust || state.releaseTrust;
  state.updateCheck.available = boot.app?.updateCheckAvailable === true;
  // Keep the last verified PIN state when this bootstrap's status read failed.
  if (boot.api.available !== false && boot.endpointStatus?.secretPin !== false) applySecretPinStatus(boot.secretPin || {});
  state.prefs = {
    demoMode: boot.prefs?.demoMode === true,
    publishLaunchReport: boot.prefs?.publishLaunchReport !== false,
    checkForUpdatesOnStartup: boot.prefs?.checkForUpdatesOnStartup !== false,
  };
  state.recovery = {
    journals: Array.isArray(boot.recovery?.journals) ? boot.recovery.journals : [],
    pendingWallets: Array.isArray(boot.recovery?.pendingWallets) ? boot.recovery.pendingWallets : [],
    journalCount: boot.recovery?.journalCount || 0,
    activeJournalCount: boot.recovery?.activeJournalCount || 0,
    failedJournalCount: boot.recovery?.failedJournalCount || 0,
    pendingWalletCount: boot.recovery?.pendingWalletCount || 0,
  };
  applyPersonalDiscoveryState(boot.discovery || {});
  state.managedWallets = Array.isArray(boot.wallets?.managed)
    ? boot.wallets.managed
    : state.recovery.pendingWallets;
  if (state.selectedWalletPublicKey
    && !state.managedWallets.some((wallet) => wallet.publicKey === state.selectedWalletPublicKey)) {
    state.selectedWalletPublicKey = null;
    state.accountId = null;
  }
  state.vanityCandidates = Array.isArray(boot.vanity?.candidates)
    ? boot.vanity.candidates.filter((candidate) => candidate && candidate.publicKey && !candidate.decryptionFailed)
    : [];
  // A failed saved-launch request comes back as an empty list. Keep what we
  // already had then: the coin list is a separate request and would still show
  // the drafts, and clicking one would say it was no longer saved.
  if (boot.savedLaunches?.available !== false || !state.savedLaunches?.length) {
    state.savedLaunches = Array.isArray(boot.savedLaunches?.launches)
      ? boot.savedLaunches.launches.filter((entry) => entry && entry.id && entry.config)
      : [];
  }
  state.flywheelPools = {
    meme: Array.isArray(boot.flywheelPools?.pools?.meme) ? boot.flywheelPools.pools.meme : [],
    reserve: Array.isArray(boot.flywheelPools?.pools?.reserve) ? boot.flywheelPools.pools.reserve : [],
  };
  restoreDetectedLaunch();
  renderSavedLaunchList();
  state.vanityAvailable = boot.vanity?.available === true;
  state.vanityReason = boot.vanity?.reason || null;
  state.clmmFeeTiers = normalizeClmmFeeTiers(boot.feeTiers?.tiers);
  state.clmmFeeTiersSource = boot.feeTiers?.available ? 'local-api' : 'fallback';
  state.clmmFeeTiersError = boot.feeTiers?.error || null;
  if (!state.selectedVanityPublicKey) {
    state.selectedVanityPublicKey = freeVanityCandidates().at(-1)?.publicKey || null;
  }
  // Prefer a wallet whose key still exists (readable, then locked) over one whose saved key is gone
  // from this computer. A key-gone wallet can never sign, and selecting one made the screen say
  // "unlocking will not help" while 3 usable wallets sat behind the locked PIN.
  const keyRank = (wallet) => ({ readable: 0, locked: 1 })[wallet?.secretState] ?? (wallet?.secretState ? 3 : 2);
  const bestWallet = [...state.managedWallets].sort((a, b) => keyRank(a) - keyRank(b))[0] || null;
  const selectedNow = state.managedWallets.find((wallet) => wallet.publicKey === state.selectedWalletPublicKey) || null;
  if (bestWallet && (!selectedNow || (selectedNow.secretState === 'missing' && keyRank(bestWallet) < keyRank(selectedNow)))) {
    state.selectedWalletPublicKey = bestWallet.publicKey;
    state.accountId = bestWallet.publicKey;
  }
  // With the PIN open, a selected wallet whose key still cannot be read can never
  // sign (typically it was auto-selected while the PIN was locked). Move to the
  // first wallet that can, rather than leaving the launch stuck on "locked".
  if (state.managedWallets.length && walletLockReason() === 'unreadable') {
    const readable = state.managedWallets.find((wallet) => wallet.hasSecretKey === true && wallet.decryptionFailed !== true);
    if (readable) {
      state.selectedWalletPublicKey = readable.publicKey;
      state.accountId = readable.publicKey;
      notify('Switched to a launch wallet whose key can be read');
    }
  }
  // A locked Recovery PIN is the first thing to deal with, so show the PIN screen once per page load.
  // It can be closed, and every locked screen also has its own Unlock button.
  if (state.secretPin.configured && state.secretPin.locked && !state.secretPin.damaged && !state.recoveryPinOffered) {
    state.recoveryPinOffered = true;
    setTimeout(() => { Promise.resolve(openRecoveryPinGate({ reason: 'unlock' })).catch(() => {}); }, 0);
  }
  $('#networkLabel').textContent = authoritativeNetworkLabel();
}

async function bootLocalApi() {
  const createClient = window.TrebuchetV2Api?.createV2ApiClient;
  if (!createClient) {
    applyBootState({
      api: {
        available: false,
        status: 'static',
        detail: 'Static preview; the Trebuchet API client did not load.',
      },
    });
    renderAll();
    refreshQuickLaunchPrice();
    return;
  }

  const client = createClient();
  state.apiClient = client;
  const boot = await client.bootstrap();
  applyBootState(boot);
  const recoveryFirst = routeStartupRecoveryFirst();
  renderAll();
  refreshCoins().catch(() => null);
  if (recoveryFirst) {
    setView(recoveryFirst.view);
    if (recoveryFirst.workspace) setLaunchWorkspace(recoveryFirst.workspace);
    if (recoveryFirst.kind === 'token') {
      notify(recoveryFirst.restored
        ? 'Interrupted token found · launch plan restored'
        : 'Interrupted token found · recovery opened');
      checkExecutionReadiness().catch(() => null);
    } else {
      notify(recoveryFirst.restored
        ? 'Interrupted launch found · launch plan restored'
        : 'Interrupted launch found · recovery opened');
      if (['mint', 'liquidity', 'finish'].includes(recoveryFirst.workspace)) {
        checkExecutionReadiness().catch(() => null);
      }
    }
  }
  if (state.discovery.scanning) schedulePersonalDiscoveryPoll();
  if (boot.api?.available) {
    client.syncRentRate?.().then(() => { state.classicFundingEstimate = null; renderAll(); }).catch(() => null);
    refreshDestinations({ force: true });
    // The one-step card is the static web host's launcher. On the desktop it
    // duplicates the launch flow and hides the saved launch below it.
    const quickCard = $('.quick-launch-card');
    if (quickCard) quickCard.hidden = true;
  } else {
    refreshQuickLaunchPrice();
  }
}

async function refreshLocalApiState() {
  if (state.apiStatus !== 'connected' || !state.apiClient?.bootstrap) return;
  const boot = await state.apiClient.bootstrap();
  applyBootState(boot);
}

async function pollLiveOps() {
  if (state.apiStatus !== 'connected' || !state.apiClient) {
    state.liveOps.polling = false;
    return;
  }
  refreshLaunchChecks().catch(() => null);
  const walletPublicKey = selectedLaunchWalletPublicKey();
  // Keep the proven return wallets current (throttled inside).
  refreshDestinations().catch(() => null);
  if (walletPublicKey !== state.liveOps.walletPublicKey) {
    state.liveOps.walletPublicKey = walletPublicKey;
    state.liveOps.lp = null;
    state.liveOps.lpCursor = 0;
    state.liveOps.lpEvents = [];
    state.liveOps.airdrop = null;
    state.liveOps.airdropSnapshots = [];
    resetManualPrefundState();
  }

  state.liveOps.polling = true;
  const tasks = [];
  if (walletPublicKey && state.apiClient.getLpProgress) {
    tasks.push(state.apiClient.getLpProgress({
      walletPublicKey,
      since: state.liveOps.lpCursor,
    }).then((lp) => ({ type: 'lp', value: lp })));
  }
  if (walletPublicKey && state.apiClient.getActiveAcquireQuoteTokens && !state.demoActive) {
    tasks.push(state.apiClient.getActiveAcquireQuoteTokens(walletPublicKey).then((job) => ({ type: 'quotes', value: { walletPublicKey, job } })));
  }
  if (walletPublicKey && state.apiClient.getSupportJobs && !state.demoActive) {
    tasks.push(state.apiClient.getSupportJobs(walletPublicKey).then((response) => ({ type: 'support', value: { walletPublicKey, jobs: response.jobs || [] } }))
      .catch((error) => ({ type: 'supportError', value: { walletPublicKey, error } })));
  }
  if (walletPublicKey && state.apiClient.getAirdropProgress) {
    tasks.push(state.apiClient.getAirdropProgress(walletPublicKey).then((airdrop) => ({ type: 'airdrop', value: airdrop })));
  }
  if (state.apiClient.getServerLogs) {
    tasks.push(state.apiClient.getServerLogs({
      since: state.liveOps.logCursor,
      limit: 25,
    }).then((logs) => ({ type: 'logs', value: logs })));
  }
  const shouldCheckWalletBalance = Boolean(
    walletPublicKey
    && state.apiClient.checkDetailedBalance
  );
  if (!shouldCheckWalletBalance && (state.manualPrefund.balance || state.manualPrefund.error || state.manualPrefund.polling)) {
    resetManualPrefundState();
  }
  const lastManualCheckMs = Date.parse(state.manualPrefund.lastUpdatedAt || '');
  const manualCheckDue = !Number.isFinite(lastManualCheckMs) || Date.now() - lastManualCheckMs > WALLET_BALANCE_REFRESH_INTERVAL_MS;
  if (
    shouldCheckWalletBalance
    && !state.manualPrefund.polling
    && manualCheckDue
  ) {
    state.manualPrefund = {
      ...state.manualPrefund,
      walletPublicKey,
      polling: true,
      error: null,
    };
    tasks.push(state.apiClient.checkDetailedBalance(walletPublicKey)
      .then((balance) => ({ type: 'manualPrefund', value: { walletPublicKey, balance } }))
      .catch((error) => ({ type: 'manualPrefundError', value: { walletPublicKey, error } })));
  }

  const results = await Promise.allSettled(tasks);
  let classicBridgeDirty = false;
  results.forEach((result) => {
    if (result.status !== 'fulfilled') return;
    const { type, value } = result.value;
    if (type === 'lp') {
      state.liveOps.lp = value;
      if (value?.totalEvents != null) state.liveOps.lpCursor = Number(value.totalEvents) || 0;
      if (Array.isArray(value?.events) && value.events.length) {
        state.liveOps.lpEvents = [...state.liveOps.lpEvents, ...value.events].slice(-20);
      }
    } else if (type === 'quotes' && value?.walletPublicKey === selectedLaunchWalletPublicKey() && value.job) {
      state.quoteAcquire.jobId = value.job.jobId; applyQuoteAcquireJob(value.job);
      if (value.job.status === 'running') startQuoteAcquirePolling();
      classicBridgeDirty = true;
    } else if (type === 'support') {
      applySavedSupportJobs(value.walletPublicKey, value.jobs);
    } else if (type === 'supportError') {
      applySavedSupportJobs(value.walletPublicKey, state.supportJobs?.walletPublicKey === value.walletPublicKey ? state.supportJobs.jobs : [], value.error?.message || 'Read saved support jobs');
    } else if (type === 'airdrop') {
      state.liveOps.airdrop = value;
      rememberAirdropProgress(value);
    } else if (type === 'logs' && Array.isArray(value)) {
      if (value.length) {
        state.liveOps.logs = [...state.liveOps.logs, ...value].slice(-20);
        state.liveOps.logCursor = Math.max(state.liveOps.logCursor, ...value.map((entry) => Number(entry.seq || 0)));
      }
    } else if (type === 'manualPrefund' && value?.walletPublicKey === selectedLaunchWalletPublicKey()) {
      state.manualPrefund = {
        walletPublicKey: value.walletPublicKey,
        balance: value.balance,
        polling: false,
        error: null,
        lastUpdatedAt: new Date().toISOString(),
      };
      classicBridgeDirty = true;
    } else if (type === 'manualPrefundError' && value?.walletPublicKey === selectedLaunchWalletPublicKey()) {
      state.manualPrefund = {
        ...state.manualPrefund,
        walletPublicKey: value.walletPublicKey,
        polling: false,
        error: value.error?.message || 'Launch-wallet balance check failed',
        lastUpdatedAt: new Date().toISOString(),
      };
      classicBridgeDirty = true;
    }
  });
  state.liveOps.lastUpdatedAt = new Date().toISOString();
  renderChartDeck();
  renderLiveOpsPanel();
  renderSignaturePanel();
  renderGlobalStrip();
  renderLiveLaunchMonitor();
  if (classicBridgeDirty) renderClassicBridge();
}

function startLiveOpsPolling() {
  if (liveOpsTimer) return;
  liveOpsTimer = window.setInterval(() => {
    pollLiveOps().catch(() => {
      state.liveOps.polling = false;
      renderLiveOpsPanel();
      renderSignaturePanel();
    });
  }, 2500);
  pollLiveOps().catch(() => null);
}
