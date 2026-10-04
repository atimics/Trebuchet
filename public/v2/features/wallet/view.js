// "Locked" only when unlocking the PIN would help. A wallet whose key cannot be
// read with the PIN already unlocked says so instead of pretending to be locked.
function walletLabelState(secretBlocked, unlocked, publicKey) {
  if (walletLockReason() === 'unreadable') return 'Key unreadable';
  return secretBlocked || !unlocked ? 'Locked' : shortAddress(publicKey);
}

// The Wallet screen reads the chain for the wallet it shows: SOL and every token it holds.
// Asked at most once every 30 seconds per wallet, and only while that screen is open.
function walletPanelBalance(publicKey) {
  const cached = state.walletPanel;
  if (cached && cached.publicKey === publicKey) return cached;
  return null;
}

function refreshWalletPanelBalance(publicKey) {
  if (!publicKey || state.activeView !== 'wallet') return;
  if (state.apiStatus !== 'connected' || !state.apiClient?.checkDetailedBalance) return;
  const cached = walletPanelBalance(publicKey);
  if (cached && (cached.loading || Date.now() - cached.at < 30000)) return;
  state.walletPanel = { ...(cached || {}), publicKey, loading: true, at: Date.now() };
  state.apiClient.checkDetailedBalance(publicKey)
    .then((balance) => { state.walletPanel = { publicKey, balance, loading: false, at: Date.now(), error: null }; })
    .catch((error) => { state.walletPanel = { publicKey, balance: cached?.balance || null, loading: false, at: Date.now(), error: error.message || 'Balance check failed' }; })
    .finally(() => { if (state.activeView === 'wallet') renderWallet(); });
}

function walletHoldingRows(balance) {
  const coinSymbol = (mint) => (state.coins?.list || []).find((coin) => coin.mint === mint)?.symbol || null;
  return Object.entries(balance?.tokens && typeof balance.tokens === 'object' ? balance.tokens : {})
    .filter(([, token]) => Number(token?.amountUi) > 0)
    .map(([mint, token]) => ({ mint, symbol: coinSymbol(mint) || token.symbol || shortAddress(mint), amount: Number(token.amountUi) }))
    .sort((a, b) => b.amount - a.amount);
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
  refreshHeldWallets();
  renderHeldWallets();
  $('#accountList').innerHTML = walletRows.map((item) => {
    const isActive = item.publicKey === selectedPublicKey;
    return `
      <article class="account-row wallet-rarity-${escapeHtml(item.rarityGrade)} ${isActive ? 'is-active' : ''}">
        <span class="ident">${escapeHtml(item.name.slice(0, 1))}</span>
        <span class="account-copy">
          <h3>${escapeHtml(item.name)}</h3>
          <p>${item.publicKey ? walletChipHtml(item.publicKey) : escapeHtml(item.address)}</p>
        </span>
        <span class="balance">
          <strong>${Number(item.balance || 0).toFixed(2)} SOL</strong>
          <span class="wallet-rarity-label">${[isActive ? 'In use' : null, /^common$/i.test(String(item.rarity || '')) ? null : item.rarity].filter(Boolean).map(escapeHtml).join(' · ')}</span>
        </span>
        <button class="pill-button" type="button" data-action="select-account" data-account="${escapeHtml(item.id)}">Select</button>
      </article>
    `;
  }).join('') || '<div class="empty-state">Create or import a launch wallet.</div>';

  refreshWalletPanelBalance(selectedPublicKey);
  const panel = selectedPublicKey ? walletPanelBalance(selectedPublicKey) : null;
  const solBalance = panel?.balance ? Number(panel.balance.sol) : null;
  const holdings = walletHoldingRows(panel?.balance);
  const spend = observedExecutionSpendSummary();
  const net = spend.inflowSol - spend.outflowSol;
  const sol4 = (value) => Number(value || 0).toFixed(4);
  const launchedCoins = (state.coins?.list || []).filter((coin) => coin.launchedHere && coin.mint).slice(0, 6);
  const stat = (label, value, unit = '', tone = '') => `<div class="wallet-stat${tone ? ` is-${tone}` : ''}"><span>${escapeHtml(label)}</span><b>${value}</b>${unit ? `<i>${escapeHtml(unit)}</i>` : ''}</div>`;
  $('#walletDetailPanel').innerHTML = selectedPublicKey && selectedRow ? `
    <header class="wallet-head">
      <span class="wallet-head-name"><strong>${escapeHtml(selectedRow.name)}</strong><span>${escapeHtml(shortAddress(selectedPublicKey))}</span></span>
      <span class="wallet-head-actions">
        <button class="pill-button" type="button" data-action="copy-wallet-address"><i class="fa-solid fa-copy"></i><span>Copy</span></button>
        <button class="pill-button" type="button" data-action="${secretBlocked || pinLockedForUnlock ? 'unlock-secret-pin' : 'reveal-wallet-secret'}" ${revealBusy || state.secretPin.busy || (keyGone && !pinLockedForUnlock) ? 'disabled' : ''}>
          <i class="fa-solid fa-key"></i><span>${revealBusy ? 'Revealing' : secretBlocked || pinLockedForUnlock ? 'Unlock PIN' : revealed ? 'Reveal again' : 'Reveal'}</span>
        </button>
        <button class="pill-button danger" type="button" data-action="discard-wallet" ${discardBusy || state.fullRunRunning || state.realExecutionRunning ? 'disabled' : ''}>
          <i class="fa-solid fa-eye-slash"></i><span>${discardBusy ? 'Hiding' : 'Hide'}</span>
        </button>
      </span>
    </header>
    ${keyGone ? `<p class="wallet-detail-error">${escapeHtml(lockReason.detail)}</p>` : ''}
    <div class="wallet-stats">
      ${stat('SOL', solBalance != null ? sol4(solBalance) : (panel?.loading ? '…' : '—'), '', 'main')}
      ${stat('Tokens', String(holdings.length))}
      ${stat('Spent', spend.measuredCount ? sol4(spend.outflowSol) : '—', spend.measuredCount ? 'SOL' : '')}
      ${stat('Returned', spend.measuredCount ? sol4(spend.inflowSol) : '—', spend.measuredCount ? 'SOL' : '')}
      ${stat('Net', spend.measuredCount ? `${net >= 0 ? '+' : '−'}${sol4(Math.abs(net))}` : '—', spend.measuredCount ? 'SOL' : '', spend.measuredCount ? (net >= 0 ? 'ok' : 'warn') : '')}
    </div>
    ${panel?.error ? `<p class="wallet-detail-error">${escapeHtml(panel.error)}</p>` : ''}
    <div class="wallet-cols">
      <section class="wallet-block" aria-label="Holdings">
        <div class="wallet-block-head"><span>Holdings</span><small>${holdings.length ? `${holdings.length} token${holdings.length === 1 ? '' : 's'}` : ''}</small></div>
        <div class="wallet-line"><span>SOL</span><b>${solBalance != null ? sol4(solBalance) : '—'}</b></div>
        ${holdings.slice(0, 5).map((item) => `<div class="wallet-line"><span title="${escapeHtml(item.mint)}">${escapeHtml(item.symbol)}</span><b>${escapeHtml(item.amount.toLocaleString('en-US', { maximumFractionDigits: 2 }))}</b></div>`).join('')}
        ${holdings.length > 5 ? `<div class="wallet-line is-muted"><span>+${holdings.length - 5} more</span></div>` : ''}
      </section>
      <section class="wallet-block" aria-label="Coins">
        <div class="wallet-block-head"><span>Coins</span><small>${launchedCoins.length || ''}</small></div>
        ${launchedCoins.length ? launchedCoins.map((coin) => `<button class="wallet-line is-action" type="button" data-action="open-coin" data-coin-key="${escapeHtml(coin.key)}"><span>${escapeHtml(coin.symbol ? `$${coin.symbol}` : (coin.name || shortAddress(coin.mint)))}</span><b>${escapeHtml(coin.practice ? 'Test' : (coin.status || 'On-chain'))}</b></button>`).join('')
          : '<div class="wallet-line is-muted"><span>None launched</span></div>'}
      </section>
    </div>
    <section class="wallet-deposit" aria-label="Deposit">
      <div class="wallet-qr-box ${qrCode ? 'has-qr' : ''}">
        ${qrCode
          ? `<img src="${escapeHtml(qrCode)}" alt="Funding QR code for ${escapeHtml(fullAddress(selectedPublicKey))}">`
          : `<button class="pill-button" type="button" data-action="load-wallet-qr" ${qrLoading ? 'disabled' : ''}><i class="fa-solid ${qrLoading ? 'fa-spinner fa-spin' : 'fa-qrcode'}"></i><span>QR</span></button>`}
      </div>
      <div class="wallet-deposit-main">
        <span class="wallet-block-head"><span>Deposit address</span></span>
        <code>${escapeHtml(selectedPublicKey)}</code>
        ${qrError ? `<p class="wallet-detail-error">${escapeHtml(qrError)}</p>` : ''}
        ${renderFundingWalletHint()}
      </div>
    </section>
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
        oldWallets ? `${oldWallets} old launch wallet${oldWallets === 1 ? '' : 's'} holding SOL or tokens` : null,
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

// Every key Trebuchet holds, read from the chain: the ones holding anything are listed, and
// Sweep all sends each launch wallet's tokens and SOL to the return wallet, one at a time.
// Read in the background too (every 5 minutes at most), so counts elsewhere come from the chain.
function refreshHeldWallets({ force = false, background = false } = {}) {
  const held = state.heldWallets;
  if ((!background && state.activeView !== 'wallet') || state.apiStatus !== 'connected' || !state.apiClient?.listHeldWallets) return;
  if (held.loading || (!force && held.list && Date.now() - held.at < (background ? 300_000 : 30_000))) return;
  state.heldWallets = { ...held, loading: true, error: null };
  state.apiClient.listHeldWallets()
    .then(async ({ wallets }) => {
      state.heldWallets = { ...state.heldWallets, list: wallets.map((wallet) => ({ ...wallet, contents: null, error: null })), at: Date.now() };
      renderHeldWallets();
      const queue = [...state.heldWallets.list];
      const worker = async () => {
        for (let row = queue.shift(); row; row = queue.shift()) {
          try { row.contents = await walletContents(row.address, { fresh: force }); } catch (error) { row.error = error.message || 'Could not read'; }
          renderHeldWallets();
        }
      };
      // The strip and Recovery count wallets from these reads.
      const settle = () => { if (state.activeView !== 'wallet') renderAll(); };
      await Promise.all([worker(), worker(), worker(), worker()]);
      settle();
    })
    .catch((error) => { state.heldWallets = { ...state.heldWallets, error: error.message || 'Could not list the keys' }; })
    .finally(() => { state.heldWallets = { ...state.heldWallets, loading: false }; renderHeldWallets(); });
}

function heldWalletHoldsAnything(row) {
  return Boolean(row.contents && (row.contents.lamports > 0 || row.contents.tokens.length || row.contents.openAccounts));
}

function sweepAllTargets() {
  return (state.heldWallets.list || [])
    .filter((row) => (row.kind === 'launch' || row.kind === 'retired') && row.readable !== false && walletSweepable(row.contents))
    .map((row) => row.address);
}

function renderHeldWallets() {
  const target = $('#heldWallets');
  if (!target) return;
  const { list, sweep, error } = state.heldWallets;
  if (!list) { target.innerHTML = error ? `<p class="is-error">${escapeHtml(error)}</p>` : ''; return; }
  const read = list.filter((row) => row.contents || row.error).length;
  const holding = list.filter(heldWalletHoldsAnything);
  const targets = sweepAllTargets();
  const running = sweep && !sweep.finished;
  const locked = state.secretPin.locked;
  const button = running
    ? `<button class="primary-button compact" type="button" disabled><span class="rail-spin" aria-hidden="true"></span><span>Sweeping ${sweep.done + 1} of ${sweep.total}</span></button>`
    : locked && targets.length
      ? '<button class="primary-button compact" type="button" data-action="unlock-secret-pin"><i class="fa-solid fa-lock-open"></i><span>Unlock PIN to sweep</span></button>'
      : `<button class="primary-button compact" type="button" data-action="sweep-all-wallets" ${targets.length ? '' : 'disabled'}><i class="fa-solid fa-broom"></i><span>Sweep all${targets.length ? ` (${targets.length})` : ''}</span></button>`;
  const status = (row) => {
    if (sweep?.current === row.address) return '<span class="risk-badge">Sweeping</span>';
    const failure = sweep?.failed.find((item) => item.address === row.address);
    if (failure) return `<span class="risk-badge danger" title="${escapeHtml(failure.error)}">Not swept</span>`;
    return '';
  };
  target.innerHTML = `
    <div class="held-wallets-head">
      <span><strong>Keys in Trebuchet</strong><small>${list.length} keys · ${read < list.length ? `${read} read · ` : ''}${holding.length} holding anything</small></span>
      <span class="held-wallets-action">${button}${!running && !targets.length && read === list.length ? '<small>Nothing to sweep</small>' : ''}</span>
    </div>
    ${holding.length ? `<ul class="held-wallets-list">${holding.map((row) => `
      <li>${walletChipHtml(row.address, { label: WALLET_KEY_LABELS[row.kind] || '' })}<span>${escapeHtml(walletContentsSummary(row.contents))}</span>${status(row)}</li>`).join('')}</ul>` : ''}
    ${sweep?.finished ? `<p class="held-wallets-result" role="status">Swept ${sweep.total - sweep.failed.length} of ${sweep.total}${sweep.failed.length ? `; ${sweep.failed.length} not swept` : ''}.</p>` : ''}`;
}

async function sweepAllWallets() {
  const targets = sweepAllTargets();
  if (!targets.length || state.heldWallets.sweep?.finished === false) return;
  if (state.fullRunRunning || state.realExecutionRunning) return;
  const defaultDestination = state.destinations?.signed?.[0] || state.destinations?.funder || '';
  const confirmation = await openSweepConfirmation({ publicKey: `${targets.length} launch wallet${targets.length === 1 ? '' : 's'}`, defaultDestination });
  if (!confirmation) return;
  const sweep = { total: targets.length, done: 0, current: null, failed: [], finished: false };
  state.heldWallets = { ...state.heldWallets, sweep };
  for (const address of targets) {
    sweep.current = address;
    renderHeldWallets();
    try {
      await state.apiClient.sweepPendingWallet({ walletPublicKey: address, destinationWallet: confirmation.destinationWallet });
    } catch (error) {
      sweep.failed.push({ address, error: error.message || 'Sweep failed' });
    }
    const row = (state.heldWallets.list || []).find((item) => item.address === address);
    if (row) row.contents = await walletContents(address, { fresh: true }).catch(() => row.contents);
    sweep.done += 1;
  }
  sweep.current = null;
  sweep.finished = true;
  renderHeldWallets();
  refreshLocalApiState().catch(() => null);
}
