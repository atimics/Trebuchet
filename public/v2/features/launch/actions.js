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
  // Once this launch has saved its airdrop plan, that plan is what runs: the server refuses any other
  // amounts, so the screen confirms and sends the saved recipients and amounts, not a recomputed list.
  const walletPublicKey = proof.walletPublicKey || selectedLaunchWalletPublicKey();
  const savedPlan = state.apiClient.getAirdropPlan
    ? await state.apiClient.getAirdropPlan(walletPublicKey).catch(() => null)
    : null;
  const savedRows = Array.isArray(savedPlan?.recipients) ? savedPlan.recipients.map((row) => ({ wallet: row.wallet, tokens: row.tokens })) : null;
  const allRecipients = savedRows || (Array.isArray(proof.airdrop?.recipients) ? proof.airdrop.recipients : []);
  const failedRecipients = Array.isArray(proof.airdrop?.failed)
    ? proof.airdrop.failed.map((row) => savedRows?.find((saved) => saved.wallet === row.wallet) || { wallet: row.wallet, tokens: row.tokens })
    : [];
  const recipients = retry ? failedRecipients : allRecipients;
  if (!recipients.length) {
    if (!quiet) notify(retry ? 'No failed airdrop recipients to retry' : 'Attach airdrop recipients first');
    return;
  }
  if (!skipConfirm) {
    const total = recipients.reduce((sum, row) => sum + (Number(row.tokens) || 0), 0);
    const ok = await confirmOperatorAction({
      title: retry ? 'Retry failed airdrop recipients' : 'Run airdrop before final sweep',
      detail: `Trebuchet will send ${total.toLocaleString('en-US', { maximumFractionDigits: 4 })} tokens to ${recipients.length} wallet${recipients.length === 1 ? '' : 's'}${savedRows ? ', the amounts saved for this launch' : ''}, signed by the managed launch wallet.`,
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
      walletPublicKey,
      tokenMint: savedPlan?.tokenMint || proof.airdrop?.tokenMint || proof.token.mint,
      tokenDecimals: savedPlan?.tokenDecimals ?? proof.airdrop?.tokenDecimals ?? proof.token.decimals ?? currentLaunchConfig().token.decimals,
      isToken2022: savedPlan?.programId
        ? savedPlan.programId === 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
        : proof.token.mintFormat === 'token-2022' || proof.token.isToken2022 === true || proof.airdrop?.isToken2022 === true,
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
  if (job?.status !== 'running' && quoteAcquireTimer) { window.clearInterval(quoteAcquireTimer); quoteAcquireTimer = null; }
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

async function reviewQuoteAcquireJob(job) {
  if (job.walletPublicKey !== selectedLaunchWalletPublicKey()) throw new Error('Select the saved quote wallet to continue.');
  if (!walletIsUnlocked()) {
    const unlocked = await unlockSecretPin({ reason: 'unlock' });
    if (!unlocked || !walletIsUnlocked()) return;
  }
  applyQuoteAcquireJob(job);
  if (job.status === 'done') return;
  if (job.status === 'running') { startQuoteAcquirePolling(); return; }
  const cleanup = job.status === 'recovery_required';
  if (cleanup) job = await state.apiClient.prepareAcquireQuoteCleanup({ jobId: job.jobId, walletPublicKey: job.walletPublicKey });
  const limit = cleanup ? job.recoveryMaxSpendLamports : job.maxSpendLamports;
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('Refresh the quote with its complete spending ceiling.');
  const sol = (lamports) => formatRawTokenAmount(String(lamports), 9);
  const targets = (job.rows || []).filter((row) => row.state === 'purchase').map((row) =>
    `${formatRawTokenAmount(row.minimumOutputRaw, row.quoteDecimals)} ${row.quoteSymbol || shortAddress(row.quoteMint)}`).join(', ');
  const detail = `Wallet: ${job.walletPublicKey}. Network: ${job.network}. ` + (cleanup
    ? `Recover the saved wrapped SOL. Cleanup fees are at most ${sol(job.cleanupFeeCeilingLamports || 0)} SOL. Total costs, including past purchases, stay within ${sol(limit)} SOL.`
    : `Receive at least ${targets || 'the saved token amounts'}. Swap ${sol(job.inputLamports)} SOL, with fees up to ${sol(job.feeCeilingLamports)} SOL and account rent up to ${sol(job.rentCeilingLamports)} SOL. Maximum total: ${sol(limit)} SOL.`
      + (job.grossDebitLamports ? ` Recorded payments: ${sol(job.grossDebitLamports)} SOL. Resume uses the saved receipts.` : ''));
  if (limit > 0) {
    const ok = await confirmOperatorAction({ title: cleanup ? 'Recover quote purchase' : job.status === 'paused' ? 'Resume quote purchase' : 'Buy pair tokens',
      detail, confirmLabel: cleanup ? 'Recover funds' : job.status === 'paused' ? 'Resume purchase' : 'Buy tokens', danger: true, confirmationText: 'SPEND SOL' });
    if (!ok) { applyQuoteAcquireJob(job); renderClassicBridge(); return; }
  }
  if (job.status === 'review_required' && !quoteAcquireSafetyCheck()) { applyQuoteAcquireJob(job); renderClassicBridge(); return; }
  if (job.walletPublicKey !== selectedLaunchWalletPublicKey()) throw new Error('Select the saved quote wallet before continuing.');
  const started = await state.apiClient.executeAcquireQuoteTokens({ jobId: job.jobId, walletPublicKey: job.walletPublicKey, planDigest: job.planDigest,
    maxSpendLamports: limit, ...(cleanup ? { recoveryDigest: job.recoveryDigest } : {}) });
  applyQuoteAcquireJob(started); startQuoteAcquirePolling(); renderClassicBridge();
}

async function startQuoteAcquire() {
  const walletPublicKey = selectedLaunchWalletPublicKey();
  if (state.apiStatus !== 'connected' || !state.apiClient?.acquireQuoteTokens) { notify('Quote acquire requires the Trebuchet desktop app'); return; }
  if (!walletPublicKey) { notify('Generate or select a launch wallet first'); return; }
  const savedJob = state.quoteAcquire.jobId && ['review_required', 'paused', 'recovery_required'].includes(state.quoteAcquire.job?.status);
  if (!savedJob && !quoteAcquireSafetyCheck()) return;
  try {
    if (savedJob) {
      const job = await state.apiClient.getAcquireQuoteTokens(state.quoteAcquire.jobId);
      if (job.status !== 'review_required' || job.expiresAtMs > Date.now()) return await reviewQuoteAcquireJob(job);
      await state.apiClient.cancelAcquireQuoteTokens(job.jobId);
      resetQuoteAcquireState({ keepRunning: false });
    }
    const fundingEstimateStatus = classicFundingEstimateStatus(currentLaunchConfig()), routes = quoteAcquireRoutes();
    if (!fundingEstimateStatus.matchesConfig) { notify(fundingEstimateStatus.stale ? 'Funding estimate is out of date' : 'No funding estimate yet'); return; }
    if (!routes.length) { notify(quoteAcquireManualCount() ? 'This estimate needs manual quote-token prefund' : 'No quote acquire needed'); return; }
    if (!state.demoActive && !walletIsUnlocked()) {
      const unlocked = await unlockSecretPin({ reason: 'unlock' }); if (!unlocked || !walletIsUnlocked()) return;
    }
    const fingerprint = quoteAcquireFingerprint(currentLaunchConfig(), walletPublicKey);
    state.quoteAcquire = { ...defaultQuoteAcquireState(), running: true, polling: false, fingerprint,
      job: { status: 'running', total: routes.length, completed: 0, results: [], pendingMints: routes.map((route) => route.quoteMint), inProgressMints: [], v2QuoteAcquireFingerprint: fingerprint } };
    renderClassicBridge();
    const prepared = await state.apiClient.acquireQuoteTokens({ walletPublicKey, autoSwapPlan: routes, requestId: window.crypto?.randomUUID?.() });
    state.quoteAcquire.jobId = prepared.jobId;
    applyQuoteAcquireJob({ ...prepared, v2QuoteAcquireFingerprint: fingerprint });
    if (state.demoActive) { startQuoteAcquirePolling(); notify('Quote acquire job started'); }
    else await reviewQuoteAcquireJob(prepared);
  } catch (error) {
    state.quoteAcquire.running = false; state.quoteAcquire.polling = false;
    state.quoteAcquire.error = error.message || 'Quote acquire failed to start'; notify(state.quoteAcquire.error);
  } finally { renderClassicBridge(); }
}

async function clearQuoteAcquire() {
  const { jobId, running } = state.quoteAcquire;
  if (running || ['paused', 'recovery_required'].includes(state.quoteAcquire.job?.status)) {
    notify('Resume the saved quote job before clearing its view');
    return;
  }
  if (jobId && state.apiStatus === 'connected' && state.apiClient?.cancelAcquireQuoteTokens) {
    await state.apiClient.cancelAcquireQuoteTokens(jobId).catch(() => null);
  }
  resetQuoteAcquireState({ keepRunning: false });
  renderChartDeck();
  renderClassicBridge();
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
    return;
  }
  const recoveryEndpoint = recoveryAuthorizationEndpoint();
  if (recoveryEndpoint && stageRecoveryAuthorization(recoveryEndpoint)) {
    renderAll();
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
  } catch (error) {
    notify(error.message || 'Could not enable Test mode');
  }
}
