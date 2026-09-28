function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function walletAccounts() {
  if (state.managedWallets.length) {
    return state.managedWallets.map((wallet, index) => {
      const rarity = String(wallet.rarity || 'Common').trim() || 'Common';
      return {
        id: wallet.publicKey,
        name: wallet.label || (index === 0 ? 'Launch Wallet' : `Local Wallet ${index + 1}`),
        address: shortAddress(wallet.publicKey),
        publicKey: wallet.publicKey,
        balance: Number(wallet.balanceSol || 0),
        role: wallet.source === 'imported-local'
          ? 'Imported local wallet'
          : wallet.hasSecretKey ? 'Launch wallet' : 'Locked local wallet',
        rarity,
        rarityGrade: vanityRarityGrade(rarity),
        hasSecretKey: wallet.hasSecretKey === true,
        hasMnemonic: wallet.hasMnemonic === true || typeof wallet.mnemonic === 'string',
        decryptionFailed: wallet.decryptionFailed === true,
        secretPinLocked: wallet.secretPinLocked === true,
        qrCode: wallet.qrCode || null,
        createdAt: wallet.createdAt || null,
        source: wallet.source || 'local',
      };
    });
  }
  return [];
}

function account() {
  const rows = walletAccounts();
  return rows.find((item) => item.id === state.accountId) || rows[0] || EMPTY_ACCOUNT;
}

function selectedDiscovery() {
  return state.discovery.records.find((item) => item.id === state.selectedDiscoveryId)
    || state.discovery.records[0]
    || null;
}

function selectedLaunchWalletPublicKey() {
  const selectedExists = state.managedWallets.some((wallet) => wallet.publicKey === state.selectedWalletPublicKey);
  return selectedExists ? state.selectedWalletPublicKey : state.managedWallets[0]?.publicKey || null;
}

function selectedManagedWallet() {
  const publicKey = selectedLaunchWalletPublicKey();
  return state.managedWallets.find((wallet) => wallet.publicKey === publicKey) || null;
}

function pendingRecoveryWallet(publicKey) {
  return state.recovery.pendingWallets.find((wallet) => wallet.publicKey === publicKey) || null;
}

function recoveryWalletState(wallet) {
  if (wallet?.decryptionFailed) {
    return {
      label: 'Secret missing',
      className: 'danger',
      detail: 'Local metadata exists, but Trebuchet cannot decrypt the saved secret here.',
    };
  }
  if (state.secretPin.locked || wallet?.secretPinLocked) {
    return {
      label: 'PIN locked',
      className: 'warn',
      detail: 'Unlock the Recovery PIN before revealing this launch wallet.',
    };
  }
  if (wallet?.publicKey && wallet.publicKey === selectedLaunchWalletPublicKey()) {
    return {
      label: 'Selected',
      className: '',
      detail: 'This wallet is active for funding, recovery, and guarded launch execution.',
    };
  }
  return {
    label: 'Recoverable',
    className: 'warn',
    detail: 'Saved launch wallet secret is available through the guarded reveal flow.',
  };
}

function fmtSol(value) {
  return `${value.toFixed(3)} SOL`;
}

function clampPercent(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function parseWholeNumber(value) {
  const cleaned = String(value || '').replace(/[^\d]/g, '');
  const parsed = Number(cleaned || 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function parseNumericInput(value, fallback = 0) {
  const parsed = Number(String(value ?? '').replace(/[$,%\s]/g, ''));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

// Unknown decimals must stay undefined so the server reads them from the
// mint. Number(null) is 0, which would be sent as a real override and skip
// the lookup (a 6-decimal token planned as 0 decimals).
function optionalDecimals(value) {
  if (value === undefined || value === null || String(value).trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : undefined;
}

function parsePercentInput(value, fallback = 0) {
  return clampNumber(parseNumericInput(value, fallback), 0, 100);
}

function parsePositiveInteger(value, fallback = 0) {
  const parsed = Math.floor(parseNumericInput(value, fallback));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

// The most recent completed journal for the launch being edited: same token
// identity. Survives restarts (journals are on disk), unlike browser proof.
// The finished launch of the coin being worked on, matched by its mint:
// a coin's name and ticker are set by its creator and prove nothing.
