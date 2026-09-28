function defaultQuoteAcquireState() {
  return {
    jobId: null,
    job: null,
    running: false,
    polling: false,
    error: null,
    lastUpdatedAt: null,
    fingerprint: null,
    notifiedDone: false,
  };
}

function resetQuoteAcquireState({ keepRunning = true } = {}) {
  if (keepRunning && state.quoteAcquire.running) return;
  state.quoteAcquire = defaultQuoteAcquireState();
  if (quoteAcquireTimer) {
    window.clearInterval(quoteAcquireTimer);
    quoteAcquireTimer = null;
  }
}

function resetManualPrefundState() {
  state.manualPrefund = {
    walletPublicKey: null,
    balance: null,
    polling: false,
    error: null,
    lastUpdatedAt: null,
  };
}

function resetFundingWalletState() {
  state.fundingWallet = {
    walletPublicKey: null,
    funder: null,
    amount: null,
    checking: false,
    checkedAt: null,
    exhausted: false,
    error: null,
  };
}

function selectedFundingWalletHint() {
  const walletPublicKey = selectedLaunchWalletPublicKey();
  if (!walletPublicKey || state.fundingWallet.walletPublicKey !== walletPublicKey) {
    return {
      walletPublicKey,
      funder: null,
      amount: null,
      checking: false,
      checkedAt: null,
      exhausted: false,
      error: null,
    };
  }
  return state.fundingWallet;
}

// Where the funded SOL goes, grouped from the estimate's line items. Always
// shown with the total: the total alone hides that most of it is rent.
const FUNDING_RECEIPT_GROUPS = [
  { key: 'token', label: 'Create the token', test: /^Token creation/ },
  { key: 'pools', label: 'Pool accounts', test: /: pool creation$/ },
  { key: 'rent', label: 'Price-range rent', test: /: price-range rent/ },
  { key: 'positions', label: 'Locked positions (Fee Keys)', test: /NFT mint \+ lock/ },
  { key: 'buy', label: 'Buy pair tokens', test: /auto-swap/ },
  { key: 'support', label: 'Support liquidity', test: /support position/ },
  { key: 'fees', label: 'Network fees and report', test: /network\/priority fees|Launch report|SOL, dust|[Aa]irdrop/ },
  { key: 'buffer', label: 'Safety buffer (returned if unused)', test: /^Safety buffer/ },
];

function renderFundingReceipt(estimate) {
  const lines = Array.isArray(estimate?.solBreakdown) ? estimate.solBreakdown : [];
  if (!lines.length) return '';
  const groups = FUNDING_RECEIPT_GROUPS.map((group) => ({ ...group, sol: 0, count: 0 }));
  const other = [];
  lines.forEach((line) => {
    const group = groups.find((item) => item.test.test(String(line.label || '')));
    if (group) {
      group.sol += Number(line.sol || 0);
      group.count += 1;
    } else {
      other.push(line);
    }
  });
  const poolCount = groups.find((group) => group.key === 'pools').count;
  const detail = {
    pools: `${poolCount} pool${poolCount === 1 ? '' : 's'}`,
    rent: 'Raydium tick accounts',
    positions: `${groups.find((group) => group.key === 'positions').count} positions`,
    buy: `${groups.find((group) => group.key === 'buy').count} auto-buy${groups.find((group) => group.key === 'buy').count === 1 ? '' : 's'}`,
  };
  const row = (label, sol, note = '') => `
    <li><span>${escapeHtml(label)}${note ? `<small>${escapeHtml(note)}</small>` : ''}</span><strong>${Number(sol).toFixed(4)}</strong></li>`;
  const rows = [
    ...groups.filter((group) => group.sol > 0).map((group) => row(group.label, group.sol, detail[group.key] || '')),
    ...other.map((line) => row(line.label, line.sol)),
  ].join('');
  const manual = Array.isArray(estimate.quoteBreakdown) ? estimate.quoteBreakdown : [];
  const manualHtml = manual.length ? `
    <div class="funding-receipt-manual">
      <small>Tokens you send yourself (no swap route)</small>
      <ul>${manual.map((item) => `<li><span>${escapeHtml(item.symbol || shortAddress(item.mint))}</span><strong>${escapeHtml(Number(item.amount || 0).toLocaleString('en-US', { maximumFractionDigits: 2 }))}</strong></li>`).join('')}</ul>
    </div>` : '';
  const perPool = lines.filter((line) => /^Pool \d+/.test(String(line.label || '')));
  // The split that matters: SOL that becomes liquidity, SOL that is spent on
  // accounts and fees for good, and SOL that comes back.
  const groupSol = (key) => groups.find((group) => group.key === key)?.sol || 0;
  const intoPools = groupSol('support') + groupSol('buy');
  const returned = groupSol('buffer');
  const spent = Math.max(0, Number(estimate.totalSol || 0) - intoPools - returned);
  const split = `
      <div class="funding-split" role="group" aria-label="Where the SOL ends up">
        <span class="is-pool"><small>Into the pool</small><strong>${intoPools.toFixed(4)}</strong><em>buy support</em></span>
        <span class="is-spent"><small>Rent and fees</small><strong>${spent.toFixed(4)}</strong><em>not returned</em></span>
        <span class="is-back"><small>Buffer</small><strong>${returned.toFixed(4)}</strong><em>returned if unused</em></span>
      </div>
      ${groupSol('support') <= 0
        ? '<p class="funding-split-warning" role="note"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i> No SOL goes into the pool. Until someone buys, sellers have nothing to sell into. Set a liquidity budget on Token &amp; pools to add buy support.</p>'
        : ''}`;
  return `
    <div class="funding-receipt">
      ${split}
      <div class="funding-receipt-total"><span>Total</span><strong>${Number(estimate.totalSol || 0).toFixed(4)} SOL</strong></div>
      ${manualHtml}
      <details class="funding-receipt-lines"><summary>Breakdown</summary><ul>${perPool.length ? lines.map((line) => row(line.label, line.sol)).join('') : rows}</ul></details>
    </div>`;
}

function renderFundingWalletHint({ compact = false } = {}) {
  const walletPublicKey = selectedLaunchWalletPublicKey();
  const hint = selectedFundingWalletHint();
  const status = returnWalletStatus();
  const isAvailable = state.apiStatus === 'connected' && Boolean(walletPublicKey) && Boolean(state.apiClient?.findFundingWallet);
  const title = status.kind === 'unverified'
    ? 'Return wallet not verified'
    : status.kind === 'signed'
      ? 'Signed return wallet'
      : status.address
        ? 'Returning to the funding wallet'
        : 'Funding wallet not found yet';
  const detail = status.kind === 'unverified'
    ? `${shortAddress(status.address)} was typed, not proven. Sign with it or use the funding wallet.`
    : status.address
      ? `${shortAddress(status.address)} receives Fee Keys, remaining tokens, and leftover SOL.`
      : 'Fund the launch wallet from your own wallet. That wallet receives everything after launch.';
  const className = status.kind === 'unverified' ? 'danger' : status.address ? '' : 'warn';
  const detectLabel = hint.checking ? 'Checking history' : 'Find funding wallet';
  return `<div class="funding-wallet-hint ${className} ${compact ? 'compact' : ''}">
    <span>
      <small>Return wallet</small>
      <strong>${escapeHtml(title)}</strong>
      <em>${escapeHtml(detail)}</em>
    </span>
    <div class="operator-toolbar compact">
      <button class="pill-button" type="button" data-action="sign-return-wallet">Sign with another wallet</button>
      ${status.kind === 'unverified' ? '<button class="pill-button" type="button" data-action="use-funding-wallet-sweep">Use funding wallet</button>' : ''}
      ${!status.address ? `<button class="pill-button" type="button" data-action="detect-funding-wallet" ${isAvailable && !hint.checking ? '' : 'disabled'}>${escapeHtml(detectLabel)}</button>` : ''}
    </div>
  </div>`;
}

function renderSolflarePanel() {
  const connected = Boolean(state.solflare.publicKey);
  const busy = state.solflare.connecting || state.solflare.disconnecting;
  const className = state.solflare.error ? 'danger' : connected ? 'is-connected' : 'warn';
  const badgeLabel = state.solflare.connecting
    ? 'Connecting'
    : state.solflare.disconnecting
      ? 'Disconnecting'
      : connected
        ? 'Connected'
        : state.solflare.error
          ? 'Unavailable'
          : 'Optional';
  const detail = connected
    ? `Connected as ${shortAddress(state.solflare.publicKey)}.`
    : state.solflare.error
      ? state.solflare.error
      : 'Optional. Connect it to fund the launch wallet, or to use it as the return wallet.';

  return `
    <div class="solflare-panel ${escapeHtml(className)}">
      <div class="solflare-head">
        <span>
          <strong>Solflare</strong>
          <em>${escapeHtml(detail)}</em>
        </span>
        ${busy || state.solflare.error ? `<span class="risk-badge ${state.solflare.error ? 'danger' : 'warn'}">${escapeHtml(badgeLabel)}</span>` : ''}
      </div>
      <div class="operator-toolbar compact">
        ${connected
          ? `<button class="pill-button" type="button" data-action="use-solflare-destination"><i class="fa-solid fa-arrow-right"></i><span>Use as return wallet</span></button>
             <button class="pill-button" type="button" data-action="disconnect-solflare" ${busy ? 'disabled' : ''}><i class="fa-solid fa-link-slash"></i><span>${state.solflare.disconnecting ? 'Disconnecting' : 'Disconnect'}</span></button>`
          : `<button class="pill-button" type="button" data-action="connect-solflare" ${busy ? 'disabled' : ''}><i class="fa-solid fa-link"></i><span>${state.solflare.connecting ? 'Connecting' : 'Connect'}</span></button>`}
      </div>
    </div>
  `;
}

async function connectSolflareWallet() {
  if (state.solflare.connecting) return null;
  state.solflare = {
    ...state.solflare,
    connecting: true,
    disconnecting: false,
    status: 'Looking...',
    error: null,
  };
  renderAll();

  try {
    const provider = await waitForSolflareProvider();
    if (!provider) {
      state.solflare = {
        ...state.solflare,
        publicKey: null,
        connectedAt: null,
        status: 'Solflare not found',
        connecting: false,
        error: 'Unlock or install Solflare, allow this site, then try again.',
      };
      notify('Solflare was not detected');
      return null;
    }
    wireSolflareProviderEvents(provider);
    const result = await provider.connect();
    const wallet = setConnectedSolflareWallet(provider, provider.publicKey || result?.publicKey);
    notify(`Solflare connected: ${shortAddress(wallet.publicKey)}`);
    return wallet;
  } catch (error) {
    state.solflare = {
      ...state.solflare,
      publicKey: null,
      connectedAt: null,
      status: 'Connection failed',
      connecting: false,
      error: error.message || 'Solflare connection rejected',
    };
    notify(state.solflare.error);
    return null;
  } finally {
    state.solflare.connecting = false;
    renderAll();
  }
}

async function disconnectSolflareWallet() {
  if (state.solflare.disconnecting) return;
  const provider = solflareWalletProvider || getSolflareProvider();
  state.solflare = {
    ...state.solflare,
    disconnecting: true,
    connecting: false,
    error: null,
  };
  renderAll();

  try {
    if (provider && typeof provider.disconnect === 'function') {
      await provider.disconnect();
    }
    clearSolflareWallet();
    notify('Solflare disconnected');
  } catch (error) {
    state.solflare = {
      ...state.solflare,
      disconnecting: false,
      status: 'Disconnect failed',
      error: error.message || 'Solflare disconnect failed',
    };
    notify(state.solflare.error);
  } finally {
    state.solflare.disconnecting = false;
    renderAll();
  }
}

function applySolflareAsSweepDestination() {
  // A connected wallet still has to sign before it can receive assets.
  openWalletSigning();
  return true;
}

async function refreshManualPrefundBalance({ quiet = false } = {}) {
  const walletPublicKey = selectedLaunchWalletPublicKey();
  if (!walletPublicKey) {
    resetManualPrefundState();
    if (!quiet) notify('Generate or select a launch wallet first');
    return null;
  }
  if (state.apiStatus !== 'connected' || !state.apiClient?.checkDetailedBalance) {
    if (!quiet) notify('Manual prefund balance check requires the Trebuchet desktop app');
    return null;
  }

  state.manualPrefund = {
    ...state.manualPrefund,
    walletPublicKey,
    polling: true,
    error: null,
  };
  renderClassicBridge();

  try {
    const balance = await state.apiClient.checkDetailedBalance(walletPublicKey);
    state.manualPrefund = {
      walletPublicKey,
      balance,
      polling: false,
      error: null,
      lastUpdatedAt: new Date().toISOString(),
    };
    if (!quiet) notify('Launch wallet balance refreshed');
    refreshDestinations({ force: true }).catch(() => null);
    return balance;
  } catch (error) {
    state.manualPrefund = {
      ...state.manualPrefund,
      walletPublicKey,
      polling: false,
      error: error.message || 'Launch wallet balance check failed',
      lastUpdatedAt: new Date().toISOString(),
    };
    if (!quiet) notify(state.manualPrefund.error);
    return null;
  } finally {
    renderCustodySignal();
    renderClassicBridge();
  }
}

function invalidateClassicOutputs() {
  state.classicFundingEstimate = null;
  state.executionReadiness = null;
  clearLaunchProof();
  state.lastReportPublish = null;
  state.lastAirdropResult = null;
  resetQuoteAcquireState();
  resetManualPrefundState();
}

function refreshClassicPreview({ includePoolEditor = false } = {}) {
  renderLaunchPreview();
  renderLaunchIdentity();
  renderLaunchBudgetRecommendation();
  renderTokenLogoPreview();
  renderChartDeck();
  renderVanityCandidates();
  if (includePoolEditor) renderPoolEditorPanel();
  renderSupplyEditor();
  renderAirdropPanel();
  renderReportPanel();
  renderClassicBridge();
  renderParityPanel();
  renderQueue();
  drawLaunchCanvas();
}

function addCustomPool() {
  state.customPoolCounter += 1;
  state.customPools.push({
    id: `custom-pool-${state.customPoolCounter}`,
    quoteSymbol: 'QUOTE',
    quoteMint: '',
    supplyPercent: 5,
    ammConfigIndex: DEFAULT_POOL_CONFIG_INDEX,
    sliceShares: '100',
    feeKeyRecipient: '',
    ladderBands: 0,
    ladderText: '',
    supportSol: 0,
    supportDepth: 12,
  });
  invalidateClassicOutputs();
  renderAll();
  scheduleMainPoolRebalance();
  notify('Pair added');
}

function removeCustomPool(poolId) {
  state.customPools = state.customPools.filter((pool) => pool.id !== poolId);
  delete state.quoteTokenInfo[poolId];
  invalidateClassicOutputs();
  renderAll();
  scheduleMainPoolRebalance();
  notify('Pair removed');
}

function normalizeAllSlices() {
  $('#sliceShares').value = normalizedSliceText($('#sliceShares').value);
  state.customPools = state.customPools.map((pool) => ({
    ...pool,
    sliceShares: normalizedSliceText(pool.sliceShares || '100'),
  }));
  invalidateClassicOutputs();
  renderAll();
  notify('Slice percentages rounded to 100%');
}

function setAirdropText(value) {
  state.airdropCsvText = value;
  const input = document.getElementById('airdropCsvText');
  if (input) input.value = value;
  invalidateClassicOutputs();
  refreshClassicPreview({ includePoolEditor: true });
  scheduleMainPoolRebalance();
}

function fitAirdropBudget() {
  const plan = currentClassicModel().airdrop;
  const input = document.getElementById('airdropSupplyPercent');
  if (!input) {
    notify('Airdrop budget input is unavailable');
    return;
  }
  if (!plan.enabled) {
    notify('Add airdrop recipients first');
    return;
  }
  if (!plan.requiredSupplyPercent) {
    notify('No explicit CSV token amounts need fitting');
    return;
  }
  input.value = formatPercent(plan.requiredSupplyPercent);
  invalidateClassicOutputs();
  refreshClassicPreview({ includePoolEditor: true });
  scheduleMainPoolRebalance();
  notify(`Airdrop budget fitted to ${formatPercent(plan.requiredSupplyPercent)}%`);
}
