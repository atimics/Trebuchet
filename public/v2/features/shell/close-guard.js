// Closing the window while wallet work is sending transactions asks first. The desktop app shows
// its own Stay / Leave dialog when beforeunload is cancelled (main.js will-prevent-unload).

function walletWorkRunning() {
  if (state.fullRunRunning || state.realExecutionRunning || state.demoLaunchRunning) return 'A launch step is running';
  if (state.sweepingWalletPublicKey || state.cancelRefund.running) return 'A wallet sweep is running';
  if (state.heldWallets?.sweep && state.heldWallets.sweep.finished === false) return 'A wallet sweep is running';
  if (state.airdropRunning) return 'An airdrop is sending';
  if (state.quoteAcquire.running) return 'A pair-token purchase is running';
  if (state.reportPublishing) return 'A report is publishing';
  return null;
}

function bindCloseGuard() {
  window.addEventListener('beforeunload', (event) => {
    const reason = walletWorkRunning();
    if (!reason) return undefined;
    event.preventDefault();
    event.returnValue = reason;
    return reason;
  });
}
