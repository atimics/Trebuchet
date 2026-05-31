function showCancelledPanel(cancelStep, panelBodyText) {
  document.getElementById('step6NormalBody').classList.add('hidden');
  document.getElementById('step6CancelledPanel').classList.remove('hidden');

  const bodyEl = document.getElementById('step6CancelledPanelBody');
  if (bodyEl) bodyEl.textContent = panelBodyText;

  // Only safe to start over if no on-chain ops have run yet. Steps 1-3
  // are pre-mint; step 4+ creates the token / pools.
  const canStartOver = cancelStep <= 3;
  const startOverWrap = document.getElementById('step6StartOverWrap');
  const closeHint = document.getElementById('step6CancelledCloseHint');
  if (canStartOver) {
    startOverWrap.classList.remove('hidden');
    // Hide the "close and reopen" hint — that's the fallback advice
    // for when start-over isn't available.
    closeHint.classList.add('hidden');
  } else {
    startOverWrap.classList.add('hidden');
    closeHint.classList.remove('hidden');
  }
}

bind('cancelConfirmProceedBtn', 'click', async () => {
  // ---------- End-launch path ----------
  // Wallet is empty — nothing to sweep, nothing to refund. Just stop
  // polling, lock the UI at step 6, and log it. The wallet's secret
  // key stays in the pending-wallets recovery cache server-side so
  // a delayed deposit (one the user sent right before clicking
  // cancel, say) can still be claimed via that panel later.
  if (cancelMode === 'end_launch') {
    document.getElementById('cancelConfirmModal').classList.remove('is-active');

    if (balancePollHandle) {
      clearInterval(balancePollHandle);
      balancePollHandle = null;
    }

    log('Launch ended. The ephemeral wallet was empty — no sweep needed.', 'info');
    // Mark the user's CURRENT step (before activateStep flips it) as
    // cancelled so its summary reflects that context. activateStep(6)
    // below will mark every step 1..5 as completed/preserved and make
    // step 6 the active terminal step.
    setStepSummary(currentStep, 'cancelled — wallet was empty');

    // Swap Step 6's body: hide the normal transfer form (destination
    // wallet input + Transfer Assets button), show the cancellation
    // notice instead. Without this, the user sees a form prompting
    // them for a destination address even though there's nothing in
    // the wallet to transfer — confusing and dead-ends them because
    // we also hide the Transfer Assets button (no submit affordance).
    // showCancelledPanel also decides whether to offer "Start over"
    // based on whether on-chain ops have run.
    showCancelledPanel(
      currentStep,
      'The ephemeral wallet was empty, so there was nothing to refund. ' +
      'Nothing was spent on-chain, and no token or pools were created.',
    );

    // Mark Step 6's summary too, so the collapsed/peek view of the
    // terminal step also makes the cancellation context obvious
    // (without this, the user could glance at Step 6 in the step
    // overview and not realize it was reached via cancel rather
    // than normal completion).
    setStepSummary(6, 'launch cancelled');

    activateStep(6);

    // Refresh the pending-wallets panel — server kept this wallet
    // in the recovery cache (we didn't dismiss), so the user can
    // see it there if they want to claim a delayed deposit later or
    // discard the entry permanently.
    loadPendingWallets();
    return;
  }

  // ---------- Refund path (existing flow) ----------
  const dest = document.getElementById('cancelDestInput').value.trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(dest)) {
    log('Invalid destination address', 'danger');
    return;
  }
  document.getElementById('cancelConfirmModal').classList.remove('is-active');

  // Stop balance polling so we don't fight with the sweep
  if (balancePollHandle) {
    clearInterval(balancePollHandle);
    balancePollHandle = null;
  }

  await withRunState(async () => {
    log(`Cancelling: sweeping wallet to ${dest}...`, 'warning');
    try {
      const resp = await fetch('/api/transfer-assets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tempWalletSecretKey: tempWallet.secretKey,
          destinationWallet: dest,
          tokenMint: createdTokenInfo ? createdTokenInfo.mint : '',
        }),
      });
      const data = await resp.json();
      if (!data.success) throw new Error(data.error);

      const swept = [
        data.tokensTransferred ? `${data.tokensTransferred} tokens` : null,
        data.solTransferred ? `${data.solTransferred} SOL` : null,
        data.nftSweep?.transferred?.length ? `${data.nftSweep.transferred.length} NFT(s)` : null,
      ].filter(Boolean).join(', ');

      // Surface partial-failure modes — same detection logic as runTransfer().
      // The cancel path uses the same /api/transfer-assets endpoint, so it
      // has identical sub-step failure modes (SOL sweep failure with
      // tokens already moved, individual token/NFT transfer errors).
      // Without these warnings the user might think the cancel completed
      // cleanly when SOL is actually stranded in the ephemeral wallet.
      const tokenErrors = data.tokenSweep?.errors || [];
      const nftErrors = data.nftSweep?.errors || [];
      const hasPartialFailure =
        data.solSweepError || tokenErrors.length > 0 || nftErrors.length > 0;

      if (data.solSweepError) {
        log(`Cancel: SOL sweep failed: ${data.solSweepError}`, 'warning');
        log(
          'Tokens and NFTs were moved, but SOL remained in the ephemeral wallet. ' +
          'Use the pending-wallets panel above to recover the SOL with the wallet\'s ' +
          'secret key.',
          'warning',
        );
      }
      for (const e of tokenErrors) {
        log(`Cancel: token sweep error (${e.mint?.slice(0, 8) || 'unknown'}…): ${e.error}`, 'warning');
      }
      for (const e of nftErrors) {
        log(`Cancel: NFT sweep error (${e.mint?.slice(0, 8) || 'unknown'}…): ${e.error}`, 'warning');
      }

      if (hasPartialFailure) {
        log(`Cancel partially complete. Swept: ${swept || 'nothing'} — see warnings`, 'warning');
        setStepSummary(currentStep, `cancelled — partial sweep, see warnings`);
      } else {
        log(`Cancel complete. Swept: ${swept || 'nothing'}`, 'success');
        setStepSummary(currentStep, `cancelled — funds returned`);
      }

      // Show the cancelled panel with the swept summary, and offer
      // start-over when no on-chain ops have run (cancel happened
      // before step 4). showCancelledPanel hides the normal transfer
      // body so the user doesn't see a stale form prompting for a
      // destination they've already used.
      const partialNote = hasPartialFailure
        ? ' Some sub-steps failed — see the activity log for details and use the pending-wallets panel to recover anything stranded.'
        : '';
      const sweptText = swept ? `Swept ${swept} back to ${dest}.` : 'Wallet was already empty.';
      showCancelledPanel(
        currentStep,
        `${sweptText}${partialNote}`,
      );
      setStepSummary(6, 'launch cancelled');
      activateStep(6);

      // Refresh pending-wallets panel — server retains a recovery
      // entry in case of partial-failure or delayed deposits.
      loadPendingWallets();
      markLaunchActiveForRpcHealth(false);
    } catch (e) {
      log(`Cancel failed: ${e.message}`, 'danger');
      markLaunchActiveForRpcHealth(false);
    }
  });
});

bind('cancelBtn', 'click', openCancelConfirm);

