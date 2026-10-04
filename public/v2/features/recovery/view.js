// Launch wallets the chain shows still holding something to sweep. The top strip and the
// Wallet page count these; the Wallet page sweeps them.
function recoveryWalletsNeedingAttention() {
  if (state.apiStatus !== 'connected') return [];
  const selectedPublicKey = selectedLaunchWalletPublicKey();
  const selectedHasOpenJournal = (state.recovery.journals || [])
    .some((journal) => !isTerminalJournal(journal) && journal.walletPublicKey === selectedPublicKey);
  // Counted only once the chain shows something to sweep: an unread wallet is not called a problem.
  return (state.recovery.pendingWallets || [])
    .filter((wallet) => wallet.publicKey !== selectedPublicKey || selectedHasOpenJournal)
    .filter((wallet) => walletSweepable(cachedWalletContents(wallet.publicKey)));
}
