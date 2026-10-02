function addManagedWallet(wallet, { select = true } = {}) {
  if (!wallet?.publicKey) return;
  const existingIndex = state.managedWallets.findIndex((item) => item.publicKey === wallet.publicKey);
  if (existingIndex >= 0) state.managedWallets[existingIndex] = { ...state.managedWallets[existingIndex], ...wallet };
  else state.managedWallets.unshift(wallet);
  if (select) {
    state.selectedWalletPublicKey = wallet.publicKey;
    state.accountId = wallet.publicKey;
    resetManualPrefundState();
    resetFundingWalletState();
  }
}

function selectRecoveryWallet(publicKey, { switchToWallet = true } = {}) {
  const wallet = pendingRecoveryWallet(publicKey);
  if (!wallet) {
    notify('Recovery wallet not found');
    return null;
  }
  addManagedWallet({
    ...wallet,
    label: 'Recovery Wallet',
    source: wallet.source || 'pending-recovery',
    hasSecretKey: wallet.hasSecretKey === true,
    hasMnemonic: wallet.hasMnemonic === true,
  });
  state.revealedWallet = null;
  state.revealError = null;
  if (switchToWallet) setView('wallet');
  renderAll();
  notify('Recovery wallet selected');
  return wallet;
}

async function generateManagedWallet() {
  if (state.apiStatus === 'connected' && state.apiClient?.generateManagedWallet) {
    const wallet = await state.apiClient.generateManagedWallet();
    addManagedWallet(wallet);
    renderAll();
    notify('Launch wallet created');
    return wallet;
  }

  notify('Launch wallet generation requires the Trebuchet desktop app');
  return null;
}

async function importManagedWallet() {
  if (state.apiStatus !== 'connected' || !state.apiClient?.importManagedWallet) {
    notify('Import requires the Trebuchet desktop app');
    return;
  }
  const secret = await openOperatorPrompt({
    eyebrow: 'Local wallet import',
    title: 'Import Solana wallet',
    detail: 'Paste a mnemonic, base58 secret key, or JSON secret-key array. Trebuchet handles it locally and never sends it to a remote service.',
    label: 'Wallet secret',
    type: 'password',
    placeholder: 'Mnemonic, base58 secret, or JSON array',
    confirmLabel: 'Import wallet',
    message: 'Secret input is masked and handled only by the local Trebuchet API.',
    emptyMessage: 'Paste the wallet secret to continue.',
  });
  if (!secret) return;
  const wallet = await state.apiClient.importManagedWallet(secret);
  addManagedWallet(wallet);
  renderAll();
  notify('Wallet imported into Trebuchet');
}

async function refreshSecretPinStatus({ reloadBoot = false } = {}) {
  if (state.apiStatus !== 'connected' || !state.apiClient?.getSecretPinStatus) return;
  if (reloadBoot && state.apiClient?.bootstrap) {
    await refreshLocalApiState();
    return;
  }
  const status = await state.apiClient.getSecretPinStatus();
  applySecretPinStatus(status);
}

async function setupSecretPin() {
  if (state.apiStatus !== 'connected' || !state.apiClient?.setupSecretPin) {
    notify('Recovery PIN requires the Trebuchet desktop app');
    return false;
  }
  if (state.secretPin.configured) {
    notify('Recovery PIN is already configured');
    return false;
  }
  const pin = await requestRecoveryPin({
    title: 'Set Recovery PIN',
    detail: 'Choose four digits to protect local launch wallets and saved Vanity CAs.',
  });
  if (!pin) return false;
  const confirmPin = await requestRecoveryPin({
    title: 'Confirm Recovery PIN',
    detail: 'Enter the same four digits again before Trebuchet encrypts local recovery secrets.',
  });
  if (!confirmPin) return false;
  if (pin !== confirmPin) {
    notify('Recovery PIN entries did not match');
    return false;
  }

  state.secretPin.busy = 'Setting';
  renderAll();
  try {
    const status = await state.apiClient.setupSecretPin(pin);
    applySecretPinStatus(status);
    await refreshSecretPinStatus({ reloadBoot: true });
    notify('Recovery PIN set');
    return true;
  } catch (error) {
    state.secretPin.busy = null;
    notify(error.message || 'Recovery PIN setup failed');
    return false;
  } finally {
    state.secretPin.busy = null;
    renderAll();
  }
}

async function unlockSecretPin({ reason = 'unlock' } = {}) {
  if (state.apiStatus !== 'connected' || !state.apiClient?.unlockSecretPin) {
    notify('Recovery PIN requires the Trebuchet desktop app');
    return false;
  }
  if (!state.secretPin.configured) {
    return setupSecretPin();
  }
  if (state.secretPin.unlocked) {
    // The PIN is open but the wallet may still look locked from data loaded
    // before the unlock: reload once, and only then say what is really wrong.
    if (selectedLaunchWalletPublicKey() && !walletIsUnlocked()) {
      await refreshLocalApiState();
      if (walletIsUnlocked()) {
        notify('Launch wallet ready');
        return true;
      }
      if (walletLockReason() === 'unreadable') {
        setView('wallet');
        notify('The Recovery PIN is unlocked, but this launch wallet\'s key cannot be read. Choose or create another launch wallet.');
        return false;
      }
    }
    notify('Recovery PIN already unlocked');
    return true;
  }
  return openRecoveryPinGate({ reason });
}

async function unlockLaunchWalletAndContinue() {
  if (!selectedLaunchWalletPublicKey()) {
    setView('wallet');
    notify('Create or select a launch wallet first');
    return false;
  }

  if (!walletIsUnlocked()) {
    const unlocked = await unlockSecretPin({ reason: 'unlock' });
    if (!unlocked) return false;
  }

  if (!walletIsUnlocked()) {
    notify('The launch wallet is still locked');
    return false;
  }

  state.launchWorkspace = 'configure';
  renderAll();
  setLaunchWorkspace('configure');
  notify('Launch wallet ready. Continue with token and pools.');
  return true;
}

async function changeSecretPin() {
  if (state.apiStatus !== 'connected' || !state.apiClient?.changeSecretPin) {
    notify('Recovery PIN change requires the Trebuchet desktop app');
    return;
  }
  if (!state.secretPin.configured) {
    notify('Set a Recovery PIN first');
    return;
  }
  const currentPin = await requestRecoveryPin({
    title: 'Verify current PIN',
    detail: 'Enter the current four-digit Recovery PIN before changing it.',
  });
  if (!currentPin) return;
  const newPin = await requestRecoveryPin({
    title: 'Choose a new PIN',
    detail: 'Enter the new four-digit Recovery PIN for local recovery secrets.',
  });
  if (!newPin) return;
  const confirmPin = await requestRecoveryPin({
    title: 'Confirm the new PIN',
    detail: 'Enter the new four digits once more to finish the rotation.',
  });
  if (!confirmPin) return;
  if (newPin !== confirmPin) {
    notify('New Recovery PIN entries did not match');
    return;
  }

  state.secretPin.busy = 'Changing';
  renderAll();
  try {
    const status = await state.apiClient.changeSecretPin({ currentPin, newPin });
    applySecretPinStatus(status);
    await refreshSecretPinStatus({ reloadBoot: true });
    notify('Recovery PIN changed');
  } catch (error) {
    state.secretPin.busy = null;
    notify(error.message || 'Recovery PIN change failed');
  } finally {
    state.secretPin.busy = null;
    renderAll();
  }
}

async function lockSecretPin() {
  if (state.apiStatus !== 'connected' || !state.apiClient?.lockSecretPin) {
    notify('Recovery PIN requires the Trebuchet desktop app');
    return;
  }

  state.secretPin.busy = 'Locking';
  renderAll();
  try {
    const status = await state.apiClient.lockSecretPin();
    applySecretPinStatus(status);
    state.revealedWallet = null;
    state.revealError = null;
    await refreshSecretPinStatus({ reloadBoot: true });
    notify('Recovery PIN locked');
  } catch (error) {
    state.secretPin.busy = null;
    notify(error.message || 'Recovery PIN lock failed');
  } finally {
    state.secretPin.busy = null;
    renderAll();
  }
}

async function resetSecretPin() {
  if (state.apiStatus !== 'connected' || !state.apiClient?.resetSecretPin) {
    notify('Recovery PIN reset requires the Trebuchet desktop app');
    return;
  }
  if (!state.secretPin.configured) {
    notify('No Recovery PIN is configured');
    return;
  }
  const phrase = await openOperatorPrompt({
    eyebrow: 'Destructive local reset',
    title: 'Reset Recovery PIN',
    detail: 'This deletes the PIN wrapper and permanently discards locally saved launch wallets and Vanity CAs encrypted by that PIN. Use it only if the PIN is lost and no recoverable launch is in progress.',
    label: 'Type RESET RECOVERY PIN',
    placeholder: 'RESET RECOVERY PIN',
    confirmLabel: 'Reset local secrets',
    danger: true,
    message: 'This local deletion cannot be undone.',
    validate: (value) => value === 'RESET RECOVERY PIN' ? null : 'Confirmation phrase does not match.',
  });
  if (!phrase) return;

  state.secretPin.busy = 'Resetting';
  renderAll();
  try {
    const result = await state.apiClient.resetSecretPin(phrase);
    applySecretPinStatus(result.status);
    state.revealedWallet = null;
    state.revealError = null;
    state.vanityCandidates = state.vanityCandidates.filter((candidate) => candidate.persisted !== true);
    await refreshLocalApiState();
    const removedWallets = Number(result.removed?.pendingWallets || 0);
    const removedCAs = Number(result.removed?.vanityCAs || 0);
    state.lastSecretPinReset = {
      at: new Date().toISOString(),
      removed: {
        pendingWallets: removedWallets,
        vanityCAs: removedCAs,
      },
      status: result.status || state.secretPin,
    };
    notify(`Recovery PIN reset; discarded ${removedWallets} wallet${removedWallets === 1 ? '' : 's'} and ${removedCAs} Vanity CA${removedCAs === 1 ? '' : 's'}`);
  } catch (error) {
    state.secretPin.busy = null;
    notify(error.message || 'Recovery PIN reset failed');
  } finally {
    state.secretPin.busy = null;
    renderAll();
  }
}

async function loadWalletQr(publicKey = selectedLaunchWalletPublicKey()) {
  if (!publicKey) {
    notify('Select a launch wallet first');
    return;
  }
  const wallet = state.managedWallets.find((item) => item.publicKey === publicKey);
  if (wallet?.qrCode) {
    state.walletQr = { publicKey, qrCode: wallet.qrCode, loading: false, error: null };
    renderWallet();
    return;
  }
  if (state.apiStatus !== 'connected' || !state.apiClient?.getWalletQr) {
    state.walletQr = {
      publicKey,
      qrCode: null,
      loading: false,
      error: 'Open through the Trebuchet desktop app to render the funding QR.',
    };
    renderWallet();
    notify('Wallet QR requires the Trebuchet desktop app');
    return;
  }

  state.walletQr = { publicKey, qrCode: null, loading: true, error: null };
  renderWallet();
  try {
    const result = await state.apiClient.getWalletQr(publicKey);
    state.walletQr = {
      publicKey: result.publicKey || publicKey,
      qrCode: result.qrCode,
      loading: false,
      error: null,
    };
    state.managedWallets = state.managedWallets.map((item) => (
      item.publicKey === publicKey ? { ...item, qrCode: result.qrCode } : item
    ));
    notify('Funding QR loaded');
  } catch (error) {
    state.walletQr = {
      publicKey,
      qrCode: null,
      loading: false,
      error: error.message || 'Wallet QR failed',
    };
    notify(state.walletQr.error);
  } finally {
    renderWallet();
  }
}

async function revealWalletSecret(publicKey = selectedLaunchWalletPublicKey()) {
  if (!publicKey) {
    notify('Select a launch wallet first');
    return;
  }
  if (state.apiStatus !== 'connected' || !state.apiClient?.revealPendingWallet) {
    notify('Secret reveal requires the Trebuchet desktop app');
    return;
  }
  const revealConfirmed = await confirmOperatorAction({
    title: 'Reveal recovery secret',
    detail: 'Only reveal this secret when you are ready to back it up or recover manually. Keep it out of screenshots and support logs.',
    confirmLabel: 'Reveal secret',
    danger: true,
  });
  if (!revealConfirmed) return;

  state.revealingWalletPublicKey = publicKey;
  state.revealError = null;
  renderAll();
  try {
    state.revealedWallet = await state.apiClient.revealPendingWallet(publicKey);
    notify('Recovery secret revealed');
  } catch (error) {
    state.revealedWallet = null;
    state.revealError = error.message || 'Recovery secret reveal failed';
    notify(state.revealError);
  } finally {
    state.revealingWalletPublicKey = null;
    renderAll();
  }
}

function clearRevealedWalletSecret(publicKey = selectedLaunchWalletPublicKey()) {
  if (!state.revealedWallet || state.revealedWallet.publicKey !== publicKey) return;
  state.revealedWallet = null;
  state.revealError = null;
  renderWallet();
  notify('Recovery secret hidden');
}

async function discardSelectedWallet(publicKey = selectedLaunchWalletPublicKey()) {
  if (!publicKey) {
    notify('Select a launch wallet first');
    return;
  }
  if (state.fullRunRunning || state.realExecutionRunning) {
    notify('Wait for the launch operation to finish before discarding a wallet');
    return;
  }
  if (state.apiStatus !== 'connected' || !state.apiClient?.dismissPendingWallet) {
    notify('Wallet discard requires the Trebuchet desktop app');
    return;
  }
  const typed = await openOperatorPrompt({
    eyebrow: 'Destructive wallet operation',
    title: 'Discard local recovery entry',
    detail: `This deletes Trebuchet's local secret for ${fullAddress(publicKey)}. Continue only if the wallet is empty, intentionally abandoned, or backed up elsewhere.`,
    label: 'Type the full wallet address',
    placeholder: publicKey,
    confirmLabel: 'Discard local secret',
    danger: true,
    message: 'The wallet address must match exactly. This deletion cannot be undone.',
    validate: (value) => value === publicKey ? null : 'Full wallet address does not match.',
  });
  if (!typed) return;

  state.discardingWalletPublicKey = publicKey;
  renderAll();
  try {
    await state.apiClient.dismissPendingWallet(publicKey);
    state.managedWallets = state.managedWallets.filter((wallet) => wallet.publicKey !== publicKey);
    state.recovery.pendingWallets = state.recovery.pendingWallets.filter((wallet) => wallet.publicKey !== publicKey);
    state.recovery.pendingWalletCount = state.recovery.pendingWallets.length;
    if (state.revealedWallet?.publicKey === publicKey) {
      state.revealedWallet = null;
      state.revealError = null;
    }
    if (state.walletQr.publicKey === publicKey) {
      state.walletQr = { publicKey: null, qrCode: null, loading: false, error: null };
    }
    const nextWallet = state.managedWallets[0] || null;
    state.selectedWalletPublicKey = nextWallet?.publicKey || null;
    state.accountId = nextWallet?.publicKey || 'launch';
    await refreshLocalApiState();
    notify('Local wallet recovery entry discarded');
  } catch (error) {
    notify(error.message || 'Wallet discard failed');
  } finally {
    state.discardingWalletPublicKey = null;
    renderAll();
  }
}
