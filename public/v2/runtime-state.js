(function installTrebuchetV2RuntimeState(global) {
  // Why the launch wallet cannot sign, so the UI can say the right thing and
  // offer the right action:
  //   'none'        usable
  //   'no-wallet'   nothing selected, or it has no key stored
  //   'pin-locked'  the Recovery PIN is locked: unlock it
  //   'unreadable'  the PIN is unlocked but this wallet's key still cannot be
  //                 read (stale data or a key from another PIN/device): unlocking
  //                 again will not help
  function walletLockReason({ wallet = null, secretPin = {}, demoActive = false } = {}) {
    if (!wallet) return 'no-wallet';
    // The server derives hasSecretKey and decryptionFailed from the same decrypt
    // result, so an unreadable managed wallet arrives as hasSecretKey: false AND
    // decryptionFailed: true. Only a wallet with neither (an external signer) has
    // no key to speak of.
    if (wallet.hasSecretKey !== true && wallet.decryptionFailed !== true) return 'no-wallet';
    if (demoActive) return wallet.decryptionFailed === true ? 'unreadable' : 'none';
    if (secretPin.locked === true) return 'pin-locked';
    if (secretPin.configured === true && secretPin.unlocked !== true) return 'pin-locked';
    if (wallet.decryptionFailed === true) return 'unreadable';
    return 'none';
  }

  function walletUnlocked(input = {}) {
    return walletLockReason(input) === 'none';
  }

  const MISSING_KEY_DETAIL = 'The saved key is gone from this computer. Unlocking will not help. Restore it from a backup, or create a new wallet.';
  const WRONG_KEY_DETAIL = 'This key was saved under a different PIN and cannot be opened with this one.';

  // Honest reason a wallet cannot sign, as words for the screen. `secretState` is computed by
  // the server (readable, locked, wrong-key, missing). Only `locked` can be fixed by unlocking.
  // (walletLockReason above answers the yes/no question of whether the wallet can sign.)
  function walletSecretReason({ wallet = null, secretPin = {} } = {}) {
    const secretState = wallet?.secretState || null;
    if (secretState === 'missing') {
      return { state: 'missing', label: 'Key missing', detail: MISSING_KEY_DETAIL, canUnlock: false, canReset: false };
    }
    if (secretState === 'wrong-key') {
      return { state: 'wrong-key', label: 'Different PIN', detail: WRONG_KEY_DETAIL, canUnlock: false, canReset: false };
    }
    if (secretState === 'locked' || secretPin.locked === true || wallet?.secretPinLocked === true) {
      return { state: 'locked', label: 'Locked', detail: 'Unlock with the Recovery PIN to use this wallet.', canUnlock: true, canReset: false };
    }
    if (!wallet) return { state: null, label: '', detail: '', canUnlock: false, canReset: false };
    if (wallet.decryptionFailed === true && !secretState) {
      return { state: 'missing', label: 'Key unavailable', detail: 'The saved key could not be read. Restore it from a backup, or create a new wallet.', canUnlock: false, canReset: false };
    }
    return { state: 'readable', label: '', detail: '', canUnlock: false, canReset: false };
  }

  function networkLabel({ demoActive = false, rpcName = '', rpcActiveUrl = '' } = {}) {
    if (demoActive) return 'Nothing is sent';
    if (String(rpcName || '').trim()) return String(rpcName).trim();
    try {
      return new URL(rpcActiveUrl).hostname || 'RPC unavailable';
    } catch {
      return 'RPC unavailable';
    }
  }

  function fundingEstimate({ estimateMatches = false, estimatedSol = null } = {}) {
    const value = Number(estimatedSol);
    if (!estimateMatches || !Number.isFinite(value) || value <= 0) {
      return { available: false, value: null, label: 'Estimate required' };
    }
    return { available: true, value, label: 'Verified estimate' };
  }

  global.TrebuchetV2RuntimeState = Object.freeze({
    fundingEstimate,
    networkLabel,
    walletLockReason,
    walletSecretReason,
    walletUnlocked,
  });
}(window));
