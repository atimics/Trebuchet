// ===========================================================================
// STEP 6: Transfer assets
// ===========================================================================

bind('transferAssetsBtn', 'click', () => {
  const dest = document.getElementById('destinationWallet').value.trim();
  if (!dest) {
    log('Destination wallet required', 'warning');
    return;
  }
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(dest)) {
    log("Destination address doesn't look like a valid Solana address", 'danger');
    return;
  }
  showTransferConfirmModal(dest);
});

function showTransferConfirmModal(dest) {
  const modal = document.getElementById('transferConfirmModal');
  const chunked = dest.match(/.{1,8}/g).join(' ');
  document.getElementById('transferConfirmAddress').textContent = chunked;

  const confirmCheckbox = document.getElementById('transferConfirmCheckbox');
  const confirmBtn = document.getElementById('transferConfirmBtn');
  confirmCheckbox.checked = false;
  confirmBtn.disabled = true;

  modal.classList.add('is-active');
}

bind('transferConfirmCheckbox', 'change', (e) => {
  document.getElementById('transferConfirmBtn').disabled = !e.target.checked;
});

bind('transferConfirmCancelBtn', 'click', () => {
  document.getElementById('transferConfirmModal').classList.remove('is-active');
});

bind('transferConfirmBtn', 'click', async () => {
  document.getElementById('transferConfirmModal').classList.remove('is-active');
  await runTransfer();
});

async function runTransfer() {
  const btn = document.getElementById('transferAssetsBtn');
  const dest = document.getElementById('destinationWallet').value.trim();
  await withRunState(async () => {
    setLoading(btn, true);
    try {
      log(`Transferring assets to ${dest}...`);
      const resp = await fetch('/api/transfer-assets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          walletPublicKey: tempWallet.publicKey,
          // F5: the server resolves the secret from its encrypted store using
          // the public key for real launches; only demo mode (in-memory
          // ledger, no server-side secret) still sends the key inline.
          ...(demoModeActive ? { tempWalletSecretKey: tempWallet.secretKey } : {}),
          destinationWallet: dest,
          tokenMint: createdTokenInfo ? createdTokenInfo.mint : '',
        }),
      });
      const data = await resp.json();
      if (!data.success) throw new Error(data.error);

      document.getElementById('transferResult').classList.remove('hidden');
      document.getElementById('tokensTransferred').textContent = data.tokensTransferred ?? '—';
      renderLaunchReportPreview('step6');
      document.getElementById('solTransferred').textContent = data.solTransferred ?? '—';
      document.getElementById('nftsTransferred').textContent =
        data.nftSweep?.transferred?.length ?? '0';

      // Detect partial-failure modes. The server's transfer endpoint can
      // succeed at the top level (tokens + NFTs moved) but still have
      // individual sub-steps fail. Without surfacing these the user thinks
      // the transfer completed cleanly and may not realize funds were
      // left behind in the ephemeral wallet:
      //
      //   solSweepError       — SOL sweep failed; tokens/NFTs succeeded.
      //                         Most common cause: ephemeral wallet didn't
      //                         have enough SOL left for the tx fee after
      //                         the earlier transfers ate into it.
      //   tokenSweep.errors[] — per-token transfer failures (e.g. an ATA
      //                         creation that ran out of lamports).
      //   nftSweep.errors[]   — per-NFT failures (e.g. a locked LP NFT
      //                         that the lock contract rejected releasing).
      //
      // Each gets a warning log line so the user can investigate. The
      // wallet's pending-recovery entry is also preserved server-side
      // when the post-sweep balance check finds anything left, so the
      // user can come back later with the secret key and try again.
      const tokenErrors = data.tokenSweep?.errors || [];
      const nftErrors = data.nftSweep?.errors || [];
      const hasPartialFailure =
        data.solSweepError || tokenErrors.length > 0 || nftErrors.length > 0;

      if (data.solSweepError) {
        log(`SOL sweep failed: ${data.solSweepError}`, 'warning');
        log(
          'Tokens and NFTs were transferred successfully, but SOL stayed in the ' +
          'ephemeral wallet. Use the pending-wallets panel above to recover the ' +
          'remaining SOL with the wallet\'s secret key.',
          'warning',
        );
      }
      for (const e of tokenErrors) {
        log(`Token sweep error (${e.mint?.slice(0, 8) || 'unknown'}…): ${e.error}`, 'warning');
      }
      for (const e of nftErrors) {
        log(`NFT sweep error (${e.mint?.slice(0, 8) || 'unknown'}…): ${e.error}`, 'warning');
      }

      // Hide the Transfer button — flow is complete. Re-clicking would attempt
      // to transfer from an empty wallet, which would error confusingly.
      // EXCEPTION: when there was a partial failure (some assets stuck), leave
      // the button visible so the user can retry. The server-side post-sweep
      // verification keeps the recovery cache entry alive in this case, so a
      // retry won't lose the wallet's secret key.
      if (!hasPartialFailure) {
        document.getElementById('transferAssetsBtn').classList.add('hidden');
        log('Transfer complete', 'success');
        setStepSummary(6, 'transferred');

        // Reveal the "View launch summary" button next to the report
        // download. The launch-success modal is about to auto-open, but
        // if the user dismisses it accidentally this button gets them
        // back to the listing / verification / community links. Markup
        // for it starts with .hidden and we only drop the class here,
        // on the fully-clean path that also auto-opens the modal — the
        // two stay in lock-step.
        document.getElementById('viewLaunchSummaryBtn')?.classList.remove('hidden');

        // Auto-open the launch-success modal. Async (reads the logo
        // as a data URL inside) but we don't need to await it — the
        // rest of this success branch is independent. Catch on the
        // promise so a coin-init failure doesn't surface as an
        // unhandled rejection; showLaunchSuccessModal already logs
        // its own warnings on internal failures.
        try {
          markLaunchActiveForRpcHealth(false);
          Promise.resolve(showLaunchSuccessModal()).catch((err) => {
            console.warn('showLaunchSuccessModal rejected:', err);
          });
        } catch (err) {
          console.warn('showLaunchSuccessModal threw synchronously:', err);
        }
      } else {
        log('Transfer partially complete — see warnings above', 'warning');
        setStepSummary(6, 'partial — see warnings');
      }
      // The server has already removed this wallet from the recovery
      // cache (provided the on-chain balance check confirmed it's empty).
      // Refresh the panel so it reflects the new state.
      loadLaunchJournals();
      loadPendingWallets();
    } catch (e) {
      log(`Transfer failed: ${e.message}`, 'danger');
    } finally {
      setLoading(btn, false);
    }
  });
}

