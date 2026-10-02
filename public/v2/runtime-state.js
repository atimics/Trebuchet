(function installTrebuchetV2RuntimeState(global) {
  function walletUnlocked({ wallet = null, secretPin = {}, demoActive = false } = {}) {
    if (!wallet || wallet.hasSecretKey !== true || wallet.decryptionFailed === true) return false;
    if (demoActive) return true;
    if (secretPin.locked === true) return false;
    if (secretPin.configured === true) return secretPin.unlocked === true;
    return true;
  }

  const MISSING_KEY_DETAIL = 'The saved key is gone from this computer. Unlocking will not help. Restore it from a backup, or create a new wallet.';
  const WRONG_KEY_DETAIL = 'This key was saved under a different PIN and cannot be opened with this one.';

  // Honest reason a wallet cannot sign. `secretState` is computed by the server
  // (readable, locked, wrong-key, missing). Only `locked` can be fixed by unlocking.
  function walletLockReason({ wallet = null, secretPin = {} } = {}) {
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
    walletUnlocked,
  });
}(window));
