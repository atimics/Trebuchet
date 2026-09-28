function recoverySweepWarningCount(result = {}) {
  const detailedWarnings = Number(result.solSweepError ? 1 : 0)
    + (Array.isArray(result.tokenSweep?.errors) ? result.tokenSweep.errors.length : 0)
    + (Array.isArray(result.nftSweep?.errors) ? result.nftSweep.errors.length : 0)
    + (Array.isArray(result.airdrop?.failed) ? result.airdrop.failed.length : 0)
    + Number(result.walletEmpty === false ? 1 : 0);
  return detailedWarnings || Number(result.hasPartialFailure === true ? 1 : 0);
}

function recoverySweepIsPartial(result = {}, stillPending = false) {
  return recoverySweepWarningCount(result) > 0
    || result.hasPartialFailure === true
    || stillPending;
}

function recoverySweepMetrics(sweep = {}) {
  const result = sweep.result || {};
  const tokenRows = Array.isArray(result.tokenSweep?.transferred) ? result.tokenSweep.transferred : [];
  const nftRows = Array.isArray(result.nftSweep?.transferred) ? result.nftSweep.transferred : [];
  const warnings = sweep.warningCount ?? recoverySweepWarningCount(result);
  return {
    tokens: Number(result.tokensTransferred ?? tokenRows.length ?? 0),
    nfts: nftRows.length,
    sol: Number(result.solTransferred || 0),
    warnings,
    entryState: sweep.stillPending ? 'Kept' : sweep.error ? 'Unknown' : 'Cleared',
  };
}

function recoverySweepNextSteps(sweep = {}) {
  if (sweep.error) {
    return [
      'Check the Recovery PIN, RPC health, and destination address, then retry Sweep.',
      'Reveal the recovery secret only if you need to recover the wallet manually.',
    ];
  }
  if (sweep.partial || sweep.stillPending) {
    return [
      'Recovery entry is still kept locally. Retry Sweep after RPC or token-account state settles.',
      'Inspect the destination wallet and Activity log before deciding anything is clean.',
      'Only Discard after confirming the wallet is empty or the secret is backed up elsewhere.',
    ];
  }
  return [
    'Assets moved to the destination and the local recovery entry was cleared.',
    'Keep the report/proof bundle with the launch notes if this was final cleanup.',
  ];
}

function renderRecoverySweepResult(sweep) {
  if (!sweep) return '';
  const metrics = recoverySweepMetrics(sweep);
  const steps = recoverySweepNextSteps(sweep);
  const state = sweep.error ? 'danger' : (sweep.partial || sweep.stillPending) ? 'warn' : '';
  const badge = sweep.error ? 'Failed' : (sweep.partial || sweep.stillPending) ? 'Review' : 'Clean';
  return `
    <div class="recovery-sweep-result ${state}">
      <div class="recovery-sweep-head">
        <span>
          <span class="eyebrow">Post-sweep cleanup</span>
          <strong>${escapeHtml(shortAddress(sweep.publicKey))} to ${escapeHtml(shortAddress(sweep.destinationWallet))}</strong>
        </span>
        <span class="risk-badge ${state}">${escapeHtml(badge)}</span>
      </div>
      <p>${escapeHtml(sweep.message)}</p>
      <div class="recovery-sweep-grid">
        <span><small>Tokens</small><strong>${metrics.tokens}</strong></span>
        <span><small>NFTs</small><strong>${metrics.nfts}</strong></span>
        <span><small>SOL</small><strong>${metrics.sol.toFixed(4)}</strong></span>
        <span><small>Warnings</small><strong>${metrics.warnings}</strong></span>
        <span><small>Recovery entry</small><strong>${escapeHtml(metrics.entryState)}</strong></span>
      </div>
      <ul class="recovery-sweep-steps">
        ${steps.map((step) => `<li>${escapeHtml(step)}</li>`).join('')}
      </ul>
    </div>
  `;
}

let sweepConfirmationResolver = null;

function setSweepConfirmationMessage(message, { error = false, input = null } = {}) {
  const messageNode = $('#sweepConfirmMessage');
  if (messageNode) {
    messageNode.textContent = message;
    messageNode.classList.toggle('is-error', error);
  }
  ['#sweepConfirmDestination', '#sweepConfirmTypedAddress'].forEach((selector) => {
    $(selector)?.removeAttribute('aria-invalid');
  });
  if (input) input.setAttribute('aria-invalid', 'true');
}

function closeSweepConfirmation(result = null) {
  const gate = $('#sweepConfirmGate');
  if (gate) {
    gate.hidden = true;
    gate.setAttribute('aria-hidden', 'true');
    gate.removeAttribute('data-public-key');
  }
  document.body.classList.remove('sweep-confirm-open');
  const resolve = sweepConfirmationResolver;
  const returnFocus = sweepConfirmationReturnFocus;
  sweepConfirmationResolver = null;
  sweepConfirmationReturnFocus = null;
  if (resolve) resolve(result);
  restoreDialogFocus(returnFocus);
}

function submitSweepConfirmation() {
  const gate = $('#sweepConfirmGate');
  if (!gate || gate.hidden) return;
  const publicKey = gate.dataset.publicKey || '';
  const destinationInput = $('#sweepConfirmDestination');
  const typedInput = $('#sweepConfirmTypedAddress');
  const destinationWallet = String(destinationInput?.value || '').trim();
  const typedAddress = String(typedInput?.value || '').trim();

  if (!destinationWallet) {
    setSweepConfirmationMessage('Enter the destination wallet for recovered assets.', { error: true, input: destinationInput });
    destinationInput?.focus();
    return;
  }
  if (!isProbablySolanaAddress(destinationWallet)) {
    setSweepConfirmationMessage('Destination wallet does not look like a Solana address.', { error: true, input: destinationInput });
    destinationInput?.focus();
    return;
  }
  if (destinationWallet === publicKey) {
    setSweepConfirmationMessage('Destination must be different from the recovery wallet.', { error: true, input: destinationInput });
    destinationInput?.focus();
    return;
  }
  if (typedAddress !== publicKey) {
    setSweepConfirmationMessage('Full recovery wallet address does not match.', { error: true, input: typedInput });
    typedInput?.focus();
    return;
  }

  closeSweepConfirmation({ destinationWallet });
}

function openSweepConfirmation({ publicKey, defaultDestination = '' } = {}) {
  const gate = $('#sweepConfirmGate');
  if (!gate || !publicKey) return Promise.resolve(null);
  if (sweepConfirmationResolver) closeSweepConfirmation(null);

  gate.dataset.publicKey = publicKey;
  sweepConfirmationReturnFocus = document.activeElement;
  $('#sweepConfirmSource').textContent = publicKey;
  $('#sweepConfirmDestination').value = defaultDestination;
  $('#sweepConfirmTypedAddress').value = '';
  setSweepConfirmationMessage('The local recovery entry is removed only after Trebuchet verifies the source wallet is empty.');
  gate.hidden = false;
  gate.setAttribute('aria-hidden', 'false');
  document.body.classList.add('sweep-confirm-open');

  return new Promise((resolve) => {
    sweepConfirmationResolver = resolve;
    window.requestAnimationFrame(() => {
      (defaultDestination ? $('#sweepConfirmTypedAddress') : $('#sweepConfirmDestination'))?.focus();
    });
  });
}

async function sweepRecoveryWallet(publicKey) {
  if (!publicKey) {
    notify('Select a recovery wallet first');
    return;
  }
  const wallet = pendingRecoveryWallet(publicKey);
  if (!wallet) {
    notify('Recovery wallet not found');
    return;
  }
  if (wallet.decryptionFailed) {
    notify('Saved secret is unavailable for this wallet');
    return;
  }
  if (state.fullRunRunning || state.realExecutionRunning) {
    notify('Wait for the launch operation to finish before sweeping a wallet');
    return;
  }
  if (state.secretPin.locked || wallet.secretPinLocked) {
    notify('Unlock the Recovery PIN before sweeping this wallet');
    return;
  }
  if (state.apiStatus !== 'connected' || !state.apiClient?.sweepPendingWallet) {
    notify('Recovery sweep requires the Trebuchet desktop app');
    return;
  }
  const defaultDestination = currentLaunchConfig().poolTopology.sweepDestination || '';
  const confirmation = await openSweepConfirmation({ publicKey, defaultDestination });
  if (!confirmation) {
    notify('Recovery sweep cancelled');
    return;
  }
  const { destinationWallet } = confirmation;

  state.sweepingWalletPublicKey = publicKey;
  state.lastRecoverySweep = null;
  renderAll();
  try {
    const result = await state.apiClient.sweepPendingWallet({ walletPublicKey: publicKey, destinationWallet });
    const warningCount = recoverySweepWarningCount(result);
    await refreshLocalApiState();
    const stillPending = state.recovery.pendingWallets.some((walletRow) => walletRow.publicKey === publicKey);
    const partial = recoverySweepIsPartial(result, stillPending);
    state.lastRecoverySweep = {
      publicKey,
      destinationWallet,
      result,
      partial,
      stillPending,
      warningCount,
      error: false,
      message: partial
        ? `Sweep returned ${warningCount} warning${warningCount === 1 ? '' : 's'}${stillPending ? '; recovery entry remains for another attempt' : ''}.`
        : 'Recovery wallet swept and cleared from the local pending-wallet store.',
    };
    notify(partial ? 'Recovery sweep finished with warnings' : 'Recovery sweep completed');
  } catch (error) {
    state.lastRecoverySweep = {
      publicKey,
      destinationWallet,
      result: null,
      partial: false,
      error: true,
      message: error.message || 'Recovery sweep failed',
    };
    notify(error.message || 'Recovery sweep failed');
  } finally {
    state.sweepingWalletPublicKey = null;
    renderAll();
  }
}

async function cancelRefundLaunch() {
  const walletPublicKey = selectedLaunchWalletPublicKey();
  const destinationWallet = currentLaunchConfig().poolTopology.sweepDestination || '';
  if (!walletPublicKey) {
    notify('Select a launch wallet first');
    return;
  }
  if (state.fullRunRunning || state.realExecutionRunning || state.demoLaunchRunning || state.reportPublishing || state.airdropRunning || state.quoteAcquire.running) {
    notify('Wait for the current launch operation to finish before cancelling');
    return;
  }
  if (state.secretPin.locked) {
    notify('Unlock the Recovery PIN before cancelling and refunding');
    return;
  }
  if (state.apiStatus !== 'connected' || (!state.apiClient?.cancelLaunchRefund && !state.apiClient?.sweepPendingWallet)) {
    notify('Cancel & Refund requires the Trebuchet desktop app');
    return;
  }
  if (!isProbablySolanaAddress(destinationWallet)) {
    notify('Set a valid return wallet before cancelling');
    return;
  }
  if (destinationWallet === walletPublicKey) {
    notify('Destination must be different from the launch wallet');
    return;
  }
  const typed = await openOperatorPrompt({
    eyebrow: 'Launch recovery operation',
    title: 'Cancel and refund launch',
    detail: `Trebuchet will sweep tokens, SOL, and Fee Key NFTs from ${shortAddress(walletPublicKey)} to ${shortAddress(destinationWallet)}. Token mints and pools already created on-chain cannot be undone.`,
    label: 'Type the full launch wallet address',
    placeholder: walletPublicKey,
    confirmLabel: 'Cancel and refund',
    danger: true,
    message: 'The source wallet address must match exactly before Trebuchet signs the sweep.',
    validate: (value) => value === walletPublicKey ? null : 'Full launch wallet address does not match.',
  });
  if (!typed) return;

  state.cancelRefund = {
    running: true,
    lastResult: null,
    error: null,
    completedAt: null,
  };
  const ledgerId = startExecutionLedgerEntry({
    kind: 'cancel-refund',
    endpoint: '/api/transfer-assets',
    detail: `Sweeping ${shortAddress(walletPublicKey)} to ${shortAddress(destinationWallet)}.`,
  });
  renderAll();
  try {
    const run = state.apiClient.cancelLaunchRefund || state.apiClient.sweepPendingWallet;
    const result = await run({ walletPublicKey, destinationWallet });
    const warningCount = recoverySweepWarningCount(result);
    await refreshLocalApiState();
    const stillPending = state.recovery.pendingWallets.some((walletRow) => walletRow.publicKey === walletPublicKey);
    const partial = recoverySweepIsPartial(result, stillPending);
    const message = partial
      ? `Cancel & Refund needs recovery review: ${warningCount} warning${warningCount === 1 ? '' : 's'}${stillPending ? '; the recovery entry remains for another attempt' : ''}.`
      : 'Cancel & Refund swept the launch wallet to the destination.';
    state.cancelRefund = {
      running: false,
      lastResult: {
        walletPublicKey,
        destinationWallet,
        result,
        warningCount,
        partial,
        stillPending,
        message,
      },
      error: null,
      completedAt: new Date().toISOString(),
    };
    finishExecutionLedgerEntry(ledgerId, {
      status: partial ? 'warn' : 'complete',
      detail: message,
    });
    pollLiveOps().catch(() => null);
    notify(partial ? 'Cancel & Refund completed with warnings' : 'Cancel & Refund completed');
  } catch (error) {
    const message = error.message || 'Cancel & Refund failed';
    state.cancelRefund = {
      running: false,
      lastResult: null,
      error: message,
      completedAt: new Date().toISOString(),
    };
    finishExecutionLedgerEntry(ledgerId, {
      status: 'error',
      error: message,
      detail: message,
    });
    notify(message);
  } finally {
    renderAll();
  }
}
