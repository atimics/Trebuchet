async function runV2Airdrop({ retry = false, skipConfirm = false, quiet = false, refreshReadiness = true, ledger = true } = {}) {
  const proof = currentLaunchProof();
  if (!proof?.token?.mint) {
    if (!quiet) notify('Create the token before running an airdrop');
    return;
  }
  if (state.demoActive) {
    if (!quiet) notify('The test launch runs the airdrop for you');
    return;
  }
  if (state.apiStatus !== 'connected' || !state.apiClient?.runAirdrop || !state.apiClient?.retryAirdrop) {
    if (!quiet) notify('Airdrop requires the Trebuchet desktop app');
    return;
  }
  const allRecipients = Array.isArray(proof.airdrop?.recipients) ? proof.airdrop.recipients : [];
  const failedRecipients = Array.isArray(proof.airdrop?.failed)
    ? proof.airdrop.failed.map((row) => ({ wallet: row.wallet, tokens: row.tokens }))
    : [];
  const recipients = retry ? failedRecipients : allRecipients;
  if (!recipients.length) {
    if (!quiet) notify(retry ? 'No failed airdrop recipients to retry' : 'Attach airdrop recipients first');
    return;
  }
  if (!skipConfirm) {
    const ok = await confirmOperatorAction({
      title: retry ? 'Retry failed airdrop recipients' : 'Run airdrop before final sweep',
      detail: 'Trebuchet will sign token transfers from the managed launch wallet.',
      confirmLabel: retry ? 'Retry airdrop' : 'Run airdrop',
      danger: true,
    });
    if (!ok) return;
  }

  state.airdropRunning = retry ? 'retry' : 'run';
  const ledgerId = ledger ? startExecutionLedgerEntry({
    kind: retry ? 'airdrop-retry' : 'airdrop',
    retry,
    recipientCount: recipients.length,
  }) : null;
  renderAll();
  try {
    const payload = {
      walletPublicKey: proof.walletPublicKey || selectedLaunchWalletPublicKey(),
      tokenMint: proof.airdrop?.tokenMint || proof.token.mint,
      tokenDecimals: proof.airdrop?.tokenDecimals ?? proof.token.decimals ?? currentLaunchConfig().token.decimals,
      isToken2022: proof.token.mintFormat === 'token-2022' || proof.token.isToken2022 === true || proof.airdrop?.isToken2022 === true,
      recipients,
    };
    const result = retry
      ? await state.apiClient.retryAirdrop(payload)
      : await state.apiClient.runAirdrop(payload);
    state.lastAirdropResult = result;
    const updatedProof = rememberLaunchProof({
      ...proof,
      airdrop: {
        ...(proof.airdrop || {}),
        deliveredCount: Array.isArray(result.transferred) ? result.transferred.length : 0,
        failedCount: Array.isArray(result.failed) ? result.failed.length : 0,
        transferred: Array.isArray(result.transferred) ? result.transferred : [],
        failed: Array.isArray(result.failed) ? result.failed : [],
      },
    });
    const failedCount = Array.isArray(result.failed) ? result.failed.length : 0;
    const deliveredCount = Array.isArray(result.transferred) ? result.transferred.length : 0;
    finishExecutionLedgerEntry(ledgerId, {
      status: failedCount ? 'warn' : 'complete',
      detail: `${deliveredCount} delivered, ${failedCount} failed.`,
    });
    history.unshift({
      title: retry ? 'Airdrop retry completed' : 'Airdrop completed',
      detail: `${updatedProof.airdrop.deliveredCount} delivered, ${updatedProof.airdrop.failedCount} failed.`,
      time: 'Just now',
    });
    pollLiveOps().catch(() => null);
    if (!quiet) notify(`${retry ? 'Retry' : 'Airdrop'}: ${updatedProof.airdrop.failedCount} failed`);
    if (refreshReadiness) await checkExecutionReadiness();
    return result;
  } catch (error) {
    finishExecutionLedgerEntry(ledgerId, {
      status: 'error',
      error: error.message || 'Airdrop failed',
      detail: error.message || 'Airdrop failed.',
    });
    if (!quiet) notify(error.message || 'Airdrop failed');
  } finally {
    state.airdropRunning = false;
    renderAll();
  }
}

function applyQuoteAcquireJob(job) {
  const fingerprint = job?.v2QuoteAcquireFingerprint
    || state.quoteAcquire.fingerprint
    || state.quoteAcquire.job?.v2QuoteAcquireFingerprint
    || null;
  state.quoteAcquire.job = job ? {
    ...job,
    v2QuoteAcquireFingerprint: fingerprint,
  } : null;
  state.quoteAcquire.fingerprint = fingerprint;
  state.quoteAcquire.error = job?.error || null;
  state.quoteAcquire.lastUpdatedAt = new Date().toISOString();
  state.quoteAcquire.running = job?.status === 'running';
  state.quoteAcquire.polling = state.quoteAcquire.running;
  if (job?.status === 'done') {
    if (quoteAcquireTimer) {
      window.clearInterval(quoteAcquireTimer);
      quoteAcquireTimer = null;
    }
    const failed = Array.isArray(job.results) ? job.results.filter((row) => row.success === false).length : 0;
    if (!state.quoteAcquire.notifiedDone) {
      notify(failed ? `Quote acquire finished with ${failed} failure${failed === 1 ? '' : 's'}` : 'Quote tokens acquired');
      state.quoteAcquire.notifiedDone = true;
    }
  }
}

async function pollQuoteAcquire() {
  const { jobId } = state.quoteAcquire;
  if (!jobId || state.apiStatus !== 'connected' || !state.apiClient?.getAcquireQuoteTokens) return;
  try {
    const job = await state.apiClient.getAcquireQuoteTokens(jobId);
    applyQuoteAcquireJob(job);
  } catch (error) {
    state.quoteAcquire.error = error.message || 'Quote acquire status failed';
    state.quoteAcquire.polling = false;
    if (quoteAcquireTimer) {
      window.clearInterval(quoteAcquireTimer);
      quoteAcquireTimer = null;
    }
  }
  renderChartDeck();
  renderClassicBridge();
}

function startQuoteAcquirePolling() {
  if (quoteAcquireTimer) return;
  quoteAcquireTimer = window.setInterval(() => {
    pollQuoteAcquire().catch(() => null);
  }, 2000);
  pollQuoteAcquire().catch(() => null);
}

async function startQuoteAcquire() {
  const fundingEstimateStatus = classicFundingEstimateStatus(currentLaunchConfig());
  const routes = quoteAcquireRoutes();
  const walletPublicKey = selectedLaunchWalletPublicKey();
  if (!fundingEstimateStatus.matchesConfig) {
    notify(fundingEstimateStatus.stale ? 'Rerun funding estimate first' : 'Run funding estimate first');
    return;
  }
  if (!routes.length) {
    notify(quoteAcquireManualCount() ? 'This estimate needs manual quote-token prefund' : 'No quote acquire needed');
    return;
  }
  if (!walletPublicKey) {
    notify('Generate or select a launch wallet first');
    return;
  }
  if (state.apiStatus !== 'connected' || !state.apiClient?.acquireQuoteTokens) {
    notify('Quote acquire requires the Trebuchet desktop app');
    return;
  }
  if (!state.demoActive) {
    // Buying signs with the launch wallet: unlock first, then carry on.
    if (!walletIsUnlocked()) {
      const unlocked = await unlockSecretPin({ reason: 'unlock' });
      if (!unlocked || !walletIsUnlocked()) return;
    }
    // Only confirm a spend when something is actually missing. The job
    // still covers every route; the server re-checks each balance and
    // spends nothing on tokens already in the wallet.
    const balance = await refreshManualPrefundBalance({ quiet: true });
    const heldRaw = (mint) => {
      try { return BigInt(String(balance?.tokens?.[mint]?.amountRaw || '0')); } catch { return 0n; }
    };
    const missing = routes.filter((route) => {
      let needRaw = 0n;
      try { needRaw = BigInt(String(route.minRaw || route.targetRaw || '0')); } catch { needRaw = 0n; }
      return heldRaw(route.quoteMint) < needRaw;
    });
    if (missing.length) {
      const maxSol = missing.reduce((sum, route) => sum + Math.max(0, Number(route.estSolSpend || 0)), 0);
      const ok = await confirmOperatorAction({
        title: 'Buy pair tokens',
        detail: `Buy ${missing.map((route) => route.quoteSymbol || shortAddress(route.quoteMint)).join(', ')} with up to ${maxSol.toFixed(4)} SOL from the launch wallet.`
          + (missing.length < routes.length ? ` ${routes.length - missing.length} already in the wallet.` : ''),
        confirmLabel: 'Buy tokens',
        danger: true,
        confirmationText: 'SPEND SOL',
      });
      if (!ok) return;
    } else {
      notify(`All ${routes.length} pair tokens are already in the launch wallet; confirming balances`);
    }
  }

  const v2QuoteAcquireFingerprint = quoteAcquireFingerprint(currentLaunchConfig(), walletPublicKey);
  state.quoteAcquire = {
    ...defaultQuoteAcquireState(),
    running: true,
    polling: true,
    fingerprint: v2QuoteAcquireFingerprint,
    job: {
      status: 'running',
      total: routes.length,
      completed: 0,
      results: [],
      pendingMints: routes.map((route) => route.quoteMint).filter(Boolean),
      inProgressMints: [],
      v2QuoteAcquireFingerprint,
    },
  };
  renderClassicBridge();

  try {
    const started = await state.apiClient.acquireQuoteTokens({
      walletPublicKey,
      autoSwapPlan: routes,
    });
    state.quoteAcquire.jobId = started.jobId;
    state.quoteAcquire.job = {
      ...state.quoteAcquire.job,
      jobId: started.jobId,
      v2QuoteAcquireFingerprint,
    };
    startQuoteAcquirePolling();
    notify('Quote acquire job started');
  } catch (error) {
    state.quoteAcquire.running = false;
    state.quoteAcquire.polling = false;
    state.quoteAcquire.error = error.message || 'Quote acquire failed to start';
    renderClassicBridge();
    notify(state.quoteAcquire.error);
  }
}

async function clearQuoteAcquire() {
  const { jobId, running } = state.quoteAcquire;
  if (running) {
    notify('Quote acquire is still running');
    return;
  }
  if (jobId && state.apiStatus === 'connected' && state.apiClient?.cancelAcquireQuoteTokens) {
    await state.apiClient.cancelAcquireQuoteTokens(jobId).catch(() => null);
  }
  resetQuoteAcquireState({ keepRunning: false });
  renderChartDeck();
  renderClassicBridge();
  notify('Quote acquire job cleared');
}

async function reviewAndArmRun() {
  if (state.demoActive) {
    notify('Switch to Live before arming an on-chain launch');
    return;
  }
  if (!walletIsUnlocked()) {
    const unlocked = await unlockSecretPin({ reason: 'arm' });
    if (!unlocked || !walletIsUnlocked()) {
      notify('Unlock the Recovery PIN to review this action');
      return;
    }
  }
  if (state.executionReadiness?.status !== 'ready' || !state.executionReadiness?.nextEndpoint) {
    await checkExecutionReadiness();
    if (state.executionReadiness?.status !== 'ready' || !state.executionReadiness?.nextEndpoint) return;
  }
  if (state.lastRunEnvelope?.status === 'armed') {
    renderClassicBridge();
    notify('Approved. It can run now.');
    return;
  }
  const recoveryEndpoint = recoveryAuthorizationEndpoint();
  if (recoveryEndpoint && stageRecoveryAuthorization(recoveryEndpoint)) {
    renderAll();
    notify('Review the one remaining recovery action, then arm it');
    return;
  }
  if (!state.transactions.length) {
    await stageTransactions({ openApproval: true, announce: false });
  } else {
    state.activeApprovalId = state.transactions.find((item) => item.state === 'pending')?.id || state.transactions[0]?.id || null;
    state.approvalOpen = Boolean(state.activeApprovalId);
    renderAll();
  }
  if (state.approvalOpen) notify('Review the decoded operations, then arm the launch');
}

async function stageTransactions({ openApproval = true, announce = true } = {}) {
  if (state.staging) return;
  state.staging = true;
  renderQueue();
  const config = currentLaunchConfig();
  try {
    let plan = null;
    if (state.apiStatus === 'connected' && state.apiClient?.stageLaunchPlan) {
      plan = await state.apiClient.stageLaunchPlan({
        ...config,
        walletPublicKey: selectedLaunchWalletPublicKey(),
      });
    }
    if (!plan && state.apiStatus === 'connected') {
      throw new Error('The local API did not return a launch plan.');
    }
    applyLaunchPlan(plan || fallbackLaunchPlan(), config, { openApproval });
    if (announce) {
      notify(plan?.source === 'local-api'
        ? `Run plan staged from local API (${state.transactions.length} operations)`
        : 'Static run plan staged');
    }
  } catch (error) {
    console.warn('v2 launch-plan staging failed:', error);
    state.launchPlan = null;
    state.transactions = [];
    state.activeApprovalId = null;
    state.approvalOpen = false;
    if (announce) notify(error.message || 'The local launch plan could not be staged');
  } finally {
    state.staging = false;
    renderAll();
  }
}

async function setDemoMode(next, { announce = true } = {}) {
  if (state.apiStatus !== 'connected' || !state.apiClient?.setUserPrefs) {
    notify('Test mode requires the Trebuchet desktop app');
    return false;
  }
  const prefs = await state.apiClient.setUserPrefs({ demoMode: next === true });
  state.prefs.demoMode = prefs.demoMode === true;
  await refreshLocalApiState();
  state.launchMode = state.demoActive ? 'dry-run' : 'guarded';
  if (announce) {
    notify(state.demoActive
      ? 'Test mode on: nothing is sent'
      : 'Live mode active: guarded operations use the configured RPC');
  }
  renderAll();
  return state.demoActive === (next === true);
}

async function simulateLaunch() {
  try {
    if (!state.demoActive && !(await setDemoMode(true, { announce: false }))) return;
    state.launchMode = 'dry-run';
    await stageTransactions();
    setLaunchWorkspace('mint', { focus: true });
    notify('Test mode on');
  } catch (error) {
    notify(error.message || 'Could not enable Test mode');
  }
}
