// "Locked" only when unlocking the PIN would help. A wallet whose key cannot be
// read with the PIN already unlocked says so instead of pretending to be locked.
function walletLabelState(secretBlocked, unlocked, publicKey) {
  if (walletLockReason() === 'unreadable') return 'Key unreadable';
  return secretBlocked || !unlocked ? 'Locked' : shortAddress(publicKey);
}

function renderWallet() {
  const current = account();
  const unlocked = walletIsUnlocked();
  const walletRows = walletAccounts();
  const selectedPublicKey = selectedLaunchWalletPublicKey();
  const selectedRow = (
    selectedPublicKey
      ? walletRows.find((item) => item.publicKey === selectedPublicKey || item.id === selectedPublicKey)
      : null
  ) || walletRows[0] || null;
  const lockReason = selectedRow ? walletLockInfo(selectedRow) : { state: null, canUnlock: true };
  const keyGone = lockReason.state === 'missing' || lockReason.state === 'wrong-key';
  const secretBlocked = !keyGone && (state.secretPin.locked || selectedRow?.secretPinLocked === true);
  // Even when this wallet's key is gone, a locked PIN is still the way into every other saved key.
  const pinLockedForUnlock = keyGone && state.secretPin.configured && state.secretPin.locked && !state.secretPin.damaged;
  $('#walletLabel').textContent = selectedPublicKey
    ? `${selectedRow?.name || current.name} ${keyGone ? lockReason.label : walletLabelState(secretBlocked, unlocked, selectedPublicKey)}`
    : 'Choose launch wallet';
  $('.wallet-led').classList.toggle('is-on', Boolean(selectedPublicKey && unlocked && !secretBlocked));
  const activeRarity = selectedRow?.rarity || 'Common';
  const activeRarityGrade = selectedRow?.rarityGrade || 'common';
  const activeRarityClass = `wallet-rarity-${activeRarityGrade}`;
  const walletView = $('#view-wallet');
  const walletButton = $('#walletButton');
  [walletView, walletButton].forEach((element) => {
    if (!element) return;
    element.classList.remove(...WALLET_RARITY_CLASSES);
    if (selectedRow) element.classList.add(activeRarityClass);
  });
  if (walletButton) {
    const walletButtonLabel = !selectedRow
      ? 'Choose a launch wallet'
      : keyGone
        ? lockReason.detail
      : secretBlocked || !unlocked
        ? `Unlock ${selectedRow.name || 'launch wallet'} with Recovery PIN`
        : `Open ${selectedRow.name || 'launch wallet'}`;
    walletButton.title = walletButtonLabel;
    walletButton.setAttribute('aria-label', walletButtonLabel);
    walletButton.dataset.locked = secretBlocked || !unlocked ? 'true' : 'false';
  }
  const activeRarityBadge = $('#activeWalletRarityBadge');
  if (activeRarityBadge) {
    activeRarityBadge.className = `risk-badge wallet-rarity-badge${selectedRow ? ` ${activeRarityClass}` : ''}`;
    activeRarityBadge.textContent = selectedRow ? activeRarity : '';
    // A rarity grade only means something for a vanity address.
    activeRarityBadge.hidden = !selectedRow || /^common$/i.test(String(activeRarity || ''));
  }
  const rawWallet = selectedManagedWallet();
  const qrCode = rawWallet?.qrCode || (
    state.walletQr.publicKey === selectedPublicKey ? state.walletQr.qrCode : null
  );
  const qrLoading = state.walletQr.publicKey === selectedPublicKey && state.walletQr.loading;
  const qrError = state.walletQr.publicKey === selectedPublicKey ? state.walletQr.error : null;
  const revealed = state.revealedWallet?.publicKey === selectedPublicKey ? state.revealedWallet : null;
  const secretKeyB58 = revealed?.secretKeyB58 || '';
  const secretKeyJson = Array.isArray(revealed?.secretKey) ? JSON.stringify(revealed.secretKey) : '';
  const mnemonic = revealed?.mnemonic || '';
  const revealBusy = state.revealingWalletPublicKey === selectedPublicKey;
  const discardBusy = state.discardingWalletPublicKey === selectedPublicKey;
  const revealError = state.revealError && !revealed ? state.revealError : null;

  const proof = currentLaunchProof();
  const proofMint = proof?.token?.mint || proof?.mint || null;
  const proofPools = launchProofPoolIds(proof);
  const proofReportUri = proof?.report?.jsonUri || proof?.reportPublish?.jsonUri || null;
  // A simulated run produces no chain evidence, so none of its artifacts may
  // claim 'Verified' — that word is reserved for proof-layer evidence.
  const proofIsDemo = isDemoLaunchProof(proof);
  const proofAssetState = proofIsDemo ? 'Test' : 'Verified';
  const proofAssets = proof ? [
    proofMint ? {
      kind: 'token',
      type: proofIsDemo ? 'Token (test)' : 'Token proof',
      name: proof?.token?.symbol || shortAddress(proofMint),
      detail: proofMint,
      state: proofAssetState,
    } : null,
    proofPools.length ? {
      kind: 'liquidity',
      type: proofIsDemo ? 'Liquidity (test)' : 'Liquidity proof',
      name: `${proofPools.length} recorded pool${proofPools.length === 1 ? '' : 's'}`,
      detail: proofPools.map(shortAddress).join(', '),
      state: proofAssetState,
    } : null,
    proofReportUri ? {
      kind: 'report',
      type: proofIsDemo ? 'Launch report (test)' : 'Launch report',
      name: proofIsDemo ? 'Simulated report artifact' : 'Published report artifact',
      detail: proofReportUri,
      state: proofAssetState,
    } : null,
  ].filter(Boolean) : [];
  $('#accountList').innerHTML = walletRows.map((item) => {
    const isActive = item.publicKey === selectedPublicKey;
    return `
      <article class="account-row wallet-rarity-${escapeHtml(item.rarityGrade)} ${isActive ? 'is-active' : ''}">
        <span class="ident">${escapeHtml(item.name.slice(0, 1))}</span>
        <span class="account-copy">
          <h3>${escapeHtml(item.name)}</h3>
          <p>${escapeHtml(item.address)}</p>
        </span>
        <span class="balance">
          <strong>${Number(item.balance || 0).toFixed(2)} SOL</strong>
          <span class="wallet-rarity-label">${[isActive ? 'In use' : null, /^common$/i.test(String(item.rarity || '')) ? null : item.rarity].filter(Boolean).map(escapeHtml).join(' · ')}</span>
        </span>
        <button class="pill-button" type="button" data-action="select-account" data-account="${escapeHtml(item.id)}">Select</button>
      </article>
    `;
  }).join('') || '<div class="empty-state">Create or import a launch wallet.</div>';

  $('#walletDetailPanel').innerHTML = selectedPublicKey && selectedRow ? `
    <div class="wallet-detail-grid">
      <div class="wallet-qr-box ${qrCode ? 'has-qr' : ''}">
        ${qrCode
          ? `<img src="${escapeHtml(qrCode)}" alt="Funding QR code for ${escapeHtml(fullAddress(selectedPublicKey))}">`
          : `<span><i class="fa-solid ${qrLoading ? 'fa-spinner fa-spin' : 'fa-qrcode'}"></i></span>`}
      </div>
      <div class="wallet-funding-box">
        <span class="eyebrow">Funding address</span>
        <h3>${escapeHtml(selectedRow.name)}</h3>
        <code>${escapeHtml(selectedPublicKey)}</code>
        <div class="operator-toolbar compact">
          <button class="pill-button" type="button" data-action="copy-wallet-address">
            <i class="fa-solid fa-copy"></i><span>Copy</span>
          </button>
          <button class="pill-button" type="button" data-action="load-wallet-qr" ${qrLoading ? 'disabled' : ''}>
            <i class="fa-solid fa-qrcode"></i><span>${qrCode ? 'Refresh QR' : 'Load QR'}</span>
          </button>
          <button class="pill-button" type="button" data-action="${secretBlocked || pinLockedForUnlock ? 'unlock-secret-pin' : 'reveal-wallet-secret'}" ${revealBusy || state.secretPin.busy || (keyGone && !pinLockedForUnlock) ? 'disabled' : ''}>
            <i class="fa-solid fa-key"></i><span>${revealBusy ? 'Revealing' : secretBlocked || pinLockedForUnlock ? 'Unlock PIN' : revealed ? 'Reveal again' : 'Reveal'}</span>
          </button>
          <button class="pill-button danger" type="button" data-action="discard-wallet" ${discardBusy || state.fullRunRunning || state.realExecutionRunning ? 'disabled' : ''}>
            <i class="fa-solid fa-trash"></i><span>${discardBusy ? 'Discarding' : 'Discard'}</span>
          </button>
        </div>
        ${keyGone ? `<p class="wallet-detail-error">${escapeHtml(lockReason.detail)}</p>` : ''}
        ${qrError ? `<p class="wallet-detail-error">${escapeHtml(qrError)}</p>` : ''}
        ${renderFundingWalletHint()}
      </div>
    </div>
    ${renderSolflarePanel()}
    ${revealError ? `<p class="wallet-detail-error">${escapeHtml(revealError)}</p>` : ''}
    ${revealed ? `<div class="wallet-recovery-box is-revealed">
      <div>
        <span class="eyebrow">Wallet secret</span>
        <p>Anyone with this can take the wallet's funds. Keep it out of screenshots.</p>
      </div>
        <div class="secret-stack">
          ${mnemonic ? `
            <div class="secret-value">
              <span>Mnemonic</span>
              <code>${escapeHtml(mnemonic)}</code>
              <button class="pill-button" type="button" data-action="copy-wallet-secret" data-secret-type="mnemonic">
                <i class="fa-solid fa-copy"></i><span>Copy</span>
              </button>
            </div>
          ` : ''}
          ${secretKeyB58 ? `
            <div class="secret-value">
              <span>Base58 secret</span>
              <code>${escapeHtml(secretKeyB58)}</code>
              <button class="pill-button" type="button" data-action="copy-wallet-secret" data-secret-type="secretKeyB58">
                <i class="fa-solid fa-copy"></i><span>Copy</span>
              </button>
            </div>
          ` : ''}
          ${secretKeyJson ? `
            <div class="secret-value">
              <span>JSON secret</span>
              <code>${escapeHtml(secretKeyJson)}</code>
              <button class="pill-button" type="button" data-action="copy-wallet-secret" data-secret-type="secretKeyJson">
                <i class="fa-solid fa-copy"></i><span>Copy</span>
              </button>
            </div>
          ` : ''}
          <button class="secondary-button compact" type="button" data-action="hide-wallet-secret">
            <i class="fa-solid fa-eye-slash"></i><span>Hide</span>
          </button>
        </div>
    </div>` : ''}
  ` : '<div class="empty-state">No launch wallet.</div>';

  // Old launch wallets and unfinished launches live in History; here they
  // only get a pointer, and only when there is something to look at.
  const oldWallets = recoveryWalletsNeedingAttention().length;
  const openJournals = state.recovery.activeJournalCount || 0;
  $('#walletRecoveryInventory').innerHTML = oldWallets || openJournals ? `
    <p class="wallet-recovery-pointer">
      <span>${escapeHtml([
        openJournals ? `${openJournals} unfinished launch${openJournals === 1 ? '' : 'es'}` : null,
        oldWallets ? `${oldWallets} old launch wallet${oldWallets === 1 ? '' : 's'} may still hold assets` : null,
      ].filter(Boolean).join(' · '))}.</span>
      <button class="text-button" type="button" data-action="inspect-recovery">Open in History</button>
    </p>
  ` : '';

  $('#assetTable').innerHTML = proofAssets.length ? `
    <div class="wallet-proof-heading">
      <strong>${proofIsDemo ? 'From the test launch (not on-chain)' : 'From the last launch'}</strong>
    </div>
    ${proofAssets.map((item) => `
      <article class="asset-row">
        <span>
          <h3>${escapeHtml(item.name)}</h3>
          <p>${escapeHtml(item.type)} / ${escapeHtml(item.detail)}</p>
        </span>
        <span class="risk-badge ${stateClass(item.state)}">${escapeHtml(item.state)}</span>
        <button class="pill-button" type="button" data-action="inspect-proof-asset" data-proof-kind="${escapeHtml(item.kind)}" ${item.kind === 'report' ? `data-url="${escapeHtml(item.detail)}"` : ''}>Inspect</button>
      </article>
    `).join('')}
  ` : '';
}
