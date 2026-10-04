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
  { key: 'sol', label: 'SOL pool funding', test: /bootstrap.*as SOL|bootstrap quote-side \(SOL, dust\)/ },
  { key: 'support', label: 'Support liquidity', test: /support position/ },
  { key: 'fees', label: 'Network fees and report', test: /network\/priority fees|Launch report|[Aa]irdrop/ },
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
  const groupSol = (key) => groups.find((group) => group.key === key)?.sol || 0;
  const solPoolFunding = groupSol('support') + groupSol('sol');
  const pairTokenBuys = groupSol('buy');
  const returned = groupSol('buffer');
  const spent = Math.max(0, Number(estimate.totalSol || 0) - solPoolFunding - pairTokenBuys - returned);
  const directSolSupport = lines
    .filter((line) => /(?:bootstrap support|support position).*as SOL/.test(String(line.label || '')))
    .reduce((sum, line) => sum + Number(line.sol || 0), 0);
  const split = `
      <div class="funding-split" role="group" aria-label="Where the SOL ends up">
        <span class="is-pool"><small>SOL pool funding</small><strong>${solPoolFunding.toFixed(4)}</strong><em>deposit budget</em></span>
        <span class="is-pool"><small>Pair-token buys</small><strong>${pairTokenBuys.toFixed(4)}</strong><em>swap budget</em></span>
        <span class="is-spent"><small>Accounts and fees</small><strong>${spent.toFixed(4)}</strong><em>pool setup</em></span>
        <span class="is-back"><small>Buffer</small><strong>${returned.toFixed(4)}</strong><em>returned if unused</em></span>
      </div>
      ${directSolSupport <= 0
        ? '<p class="funding-split-warning" role="note"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i> Set SOL in the pool on Token &amp; pools to add direct SOL buy support. The opening deposit and pair-token purchases are budgeted separately above.</p>'
        : ''}`;
  return `
    <div class="funding-receipt">
      ${split}
      <div class="funding-receipt-total"><span>Total</span><strong>${Number(estimate.totalSol || 0).toFixed(4)} SOL</strong></div>
      ${manualHtml}
    </div>`;
}

// The line-by-line cost: its own tab on the Funding row, not a fold under the total.
function renderFundingBreakdown(estimate) {
  const lines = Array.isArray(estimate?.solBreakdown) ? estimate.solBreakdown : [];
  if (!lines.length) return '';
  const row = (label, sol, note = '') => `
    <li><span>${escapeHtml(label)}${note ? `<small>${escapeHtml(note)}</small>` : ''}</span><strong>${Number(sol).toFixed(4)}</strong></li>`;
  const groups = FUNDING_RECEIPT_GROUPS.map((group) => ({ ...group, sol: 0, count: 0 }));
  const other = [];
  lines.forEach((line) => {
    const group = groups.find((item) => item.test.test(String(line.label || '')));
    if (group) { group.sol += Number(line.sol || 0); group.count += 1; } else other.push(line);
  });
  const perPool = lines.filter((line) => /^Pool \d+/.test(String(line.label || '')));
  const rows = [
    ...groups.filter((group) => group.sol > 0).map((group) => row(group.label, group.sol)),
    ...other.map((line) => row(line.label, line.sol)),
  ].join('');
  return `<div class="funding-receipt-lines"><ul>${perPool.length ? lines.map((line) => row(line.label, line.sol)).join('') : rows}</ul></div>`;
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
    ? `${fullAddress(status.address)} was typed, not proven. Sign with it or use the funding wallet.`
    : status.address
      ? `${fullAddress(status.address)} receives Fee Keys, remaining tokens, and leftover SOL.`
      : '';
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
    ? `Connected as ${fullAddress(state.solflare.publicKey)}.`
    : state.solflare.error
      ? state.solflare.error
      : '';

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
    notify(`Solflare connected: ${fullAddress(wallet.publicKey)}`);
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
    renderRecoverLedger();
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
  renderQueue();
  drawLaunchCanvas();
}

let hubPicker = { open: false, requestId: 0, catalog: null, result: null, loading: false, error: '', mint: '' };

function hubPickerRows(catalog = {}, records = []) {
  const rows = [];
  const seen = new Set();
  for (const hub of [...(catalog.defaults || []), ...(catalog.discovery || []), ...records.map((token) => ({
    ...token, source: 'discovery', solPool: token.market?.solPool
      || (token.market?.pool?.quoteMint === DEFAULT_SOL_MINT ? { ...token.market.pool, baseMint: token.mint } : null),
  }))]) {
    const pool = hub.solPool;
    const directSol = pool?.address && ((pool.baseMint === hub.mint && pool.quoteMint === DEFAULT_SOL_MINT)
      || (pool.quoteMint === hub.mint && pool.baseMint === DEFAULT_SOL_MINT));
    if (!hub.mint || hub.mint === DEFAULT_SOL_MINT || seen.has(hub.mint)) continue;
    if (hub.source !== 'default' && !directSol) continue;
    seen.add(hub.mint);
    rows.push(hub);
  }
  return rows;
}

// The picker is a page of the Pairs slide, not a list inside a scrolling box: the pair list steps
// aside while it is open, the token CA is the first thing in it, and the tokens are a fixed grid
// that fit the frame, with a pager when there are more.
const HUB_PICKER_PAGE_SIZE = 9;

// As many tokens as fit the space left in the frame, in whole rows: a tall window shows them all,
// a short one pages. Measured after each draw; a change redraws once.
let hubPickerFitSize = HUB_PICKER_PAGE_SIZE;
function measureHubPickerFit() {
  const grid = $('#hubPicker .hub-picker-grid');
  const frame = $('#launchWorkspaceViewport');
  if (!grid?.getBoundingClientRect || !frame?.getBoundingClientRect || typeof getComputedStyle !== 'function') return hubPickerFitSize;
  const tile = grid.firstElementChild;
  const tileHeight = tile ? tile.getBoundingClientRect().height + 4 : 60;
  const columns = Math.max(1, getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length);
  const bottom = Math.min(frame.getBoundingClientRect().bottom, window.innerHeight);
  const pagerRoom = 56;
  const rows = Math.max(2, Math.floor((bottom - grid.getBoundingClientRect().top - pagerRoom) / tileHeight));
  return rows * columns;
}
globalThis.window?.addEventListener?.('resize', () => {
  if (!hubPicker?.open) return;
  window.clearTimeout(measureHubPickerFit.timer);
  measureHubPickerFit.timer = window.setTimeout(() => renderHubPicker(), 120);
});

function renderHubPicker() {
  const host = $('#hubPicker');
  if (!host) return;
  host.hidden = !hubPicker.open;
  const editor = $('#supplyEditor');
  if (editor) editor.hidden = hubPicker.open;
  if (!hubPicker.open) return;
  const rows = hubPickerRows(hubPicker.catalog || {}, state.discovery.records);
  const pageSize = hubPickerFitSize;
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  hubPicker.page = Math.min(Math.max(0, Number(hubPicker.page) || 0), pages - 1);
  const shown = rows.slice(hubPicker.page * pageSize, (hubPicker.page + 1) * pageSize);
  const result = hubPicker.result;
  const pool = result?.solPool;
  host.innerHTML = `
    <div class="hub-picker-heading"><strong>Add pair</strong><button type="button" class="pill-button" data-action="close-hub-picker" aria-label="Close hub picker"><i class="fa-solid fa-xmark" aria-hidden="true"></i><span>Close</span></button></div>
    <div class="hub-picker-find">
      <input id="hubTokenCa" aria-label="Token CA" value="${escapeHtml(hubPicker.mint)}" placeholder="Token CA" autocomplete="off" spellcheck="false">
      <button class="pill-button primary" type="button" data-action="find-hub-pool">Find pool</button>
    </div>
    <p class="hub-picker-status" role="status">${escapeHtml(hubPicker.loading ? 'Finding a pool…' : hubPicker.error)}</p>
    ${result ? `<div class="hub-picker-result">
      ${hubTileHtml({ ...result, mint: result.mint }, { tag: 'div', trailing: `<button class="pill-button primary" type="button" data-action="use-hub-token">Use ${escapeHtml(result.symbol)}</button>`, status: `${pool.dex}${result.via ? ` · routes SOL → ${result.via.symbol} → ${result.symbol}` : ''} · ${pool.source}` })}</div>` : ''}
    <div class="hub-picker-grid" role="group" aria-label="Hub tokens">
      ${shown.map((hub) => hubTileHtml(hub, { tag: 'button', attrs: `type="button" data-action="find-hub-pool" data-hub-mint="${escapeHtml(hub.mint)}" title="${escapeHtml(hub.mint)}"` })).join('')}
    </div>
    ${pages > 1 ? `<div class="hub-picker-pager"><button type="button" class="pill-button" data-action="hub-picker-page" data-dir="-1" aria-label="Previous tokens" ${hubPicker.page === 0 ? 'disabled' : ''}><i class="fa-solid fa-chevron-left" aria-hidden="true"></i></button><span>${hubPicker.page + 1} / ${pages}</span><button type="button" class="pill-button" data-action="hub-picker-page" data-dir="1" aria-label="Next tokens" ${hubPicker.page >= pages - 1 ? 'disabled' : ''}><i class="fa-solid fa-chevron-right" aria-hidden="true"></i></button></div>` : ''}`;
  hydrateCoinCards();
  requestHubLogos(shown.map((hub) => hub.mint));
  const fit = measureHubPickerFit();
  if (fit !== hubPickerFitSize && rows.length > 0) {
    hubPickerFitSize = fit;
    renderHubPicker();
  }
}

// The standard coin tile, as on Coins and Discovery. Logos are read once per token and kept.
const hubLogos = new Map();
const hubLogoPending = new Set();

function hubTileHtml(hub = {}, options = {}) {
  const mint = hub.mint || hubPicker.mint || '';
  return coinCardHtml(
    { name: hub.name || hub.symbol, symbol: hub.symbol, address: mint, image: hub.image || hub.imageUrl || hub.logoDataUrl || hubLogos.get(mint) || '' },
    { variant: 'row', ...options },
  );
}

function requestHubLogos(mints) {
  const missing = mints.filter((mint) => mint && !hubLogos.has(mint) && !hubLogoPending.has(mint));
  if (!missing.length || !state.apiClient?.getTokenLogos || state.apiStatus !== 'connected') return;
  missing.forEach((mint) => hubLogoPending.add(mint));
  state.apiClient.getTokenLogos(missing)
    .then((logos) => { missing.forEach((mint) => hubLogos.set(mint, logos?.[mint] || null)); })
    .catch(() => { missing.forEach((mint) => hubLogos.set(mint, null)); })
    .finally(() => {
      missing.forEach((mint) => hubLogoPending.delete(mint));
      if (hubPicker.open) renderHubPicker();
      // Pool lines show these logos too.
      const editor = $('#supplyEditor');
      if (editor?.contains && !editor.contains(document.activeElement)) renderSupplyEditor();
    });
}

async function openHubPicker() {
  const requestId = hubPicker.requestId + 1;
  hubPicker = { open: true, requestId, catalog: null, result: null, loading: false, error: '', mint: '', page: 0 };
  const picker = hubPicker;
  renderHubPicker();
  $('#hubTokenCa')?.focus({ preventScroll: true });
  try {
    if (!state.apiClient?.listFlywheelHubs) throw new Error('Connect to the Trebuchet app to load hub tokens.');
    const catalog = await state.apiClient.listFlywheelHubs();
    // A token lookup may already be running while the short list loads.
    if (!hubPicker.open || hubPicker !== picker) return;
    hubPicker.catalog = catalog;
    renderHubPicker();
  } catch (error) {
    if (!hubPicker.open || hubPicker.requestId !== requestId) return;
    hubPicker.error = error.message || 'Try loading hub tokens again.';
    renderHubPicker();
  }
}

function closeHubPicker() {
  hubPicker.open = false;
  hubPicker.requestId += 1;
  renderHubPicker();
  document.querySelector('[data-action="add-custom-pool"]')?.focus();
}

async function findHubPool(mint) {
  const query = String(mint || $('#hubTokenCa')?.value || '').trim();
  hubPicker.mint = query;
  hubPicker.result = null;
  hubPicker.error = '';
  const requestId = ++hubPicker.requestId;
  hubPicker.loading = true;
  renderHubPicker();
  try {
    if (!isProbablySolanaAddress(query)) throw new Error('Enter a valid Solana token CA.');
    if (!state.apiClient?.resolveFlywheelHub) throw new Error('Connect to the Trebuchet app to find a pool.');
    const hub = await state.apiClient.resolveFlywheelHub(query);
    if (!hubPicker.open || requestId !== hubPicker.requestId) return;
    if (hub.mint !== query || !hub.solPool?.address) throw new Error('Refresh the pool lookup.');
    hubPicker.result = hub;
  } catch (error) {
    if (!hubPicker.open || requestId !== hubPicker.requestId) return;
    hubPicker.error = error.message || 'Try the pool lookup again.';
  } finally {
    if (hubPicker.open && requestId === hubPicker.requestId) {
      hubPicker.loading = false;
      renderHubPicker();
    }
  }
}

function useHubToken() {
  const hub = hubPicker.result;
  if (!hub?.solPool?.address || hubPicker.loading || hub.mint !== hubPicker.mint) return;
  if (hub.mint === ownTokenMint() || hub.mint === DEFAULT_SOL_MINT) {
    hubPicker.error = 'Choose another hub token for this pair.';
    renderHubPicker();
    return;
  }
  if (state.customPools.some((pool) => pool.quoteMint === hub.mint)
    || (Number($('#quotePoolPercent')?.value) > 0 && selectedClassicQuoteVenue().quoteMint === hub.mint)) {
    hubPicker.error = 'This token is already in the supply split. Edit its pair settings there.';
    renderHubPicker();
    return;
  }
  closeHubPicker();
  const poolId = addCustomPool(hub);
  resolveCustomQuoteToken(poolId, { quiet: true }).catch(() => {});
}

// Every pair has its own id: its settings are looked up by it, so two pairs sharing
// one would edit the same pair and show the same values.
function nextCustomPoolId() {
  let id;
  do {
    state.customPoolCounter += 1;
    id = `custom-pool-${state.customPoolCounter}`;
  } while (state.customPools.some((pool) => pool.id === id));
  return id;
}

// Turns the flywheel preset pair into an ordinary pair with the same token, share, fee tier and
// start premium, so its slices, ladder and support can be set like any other pair's.
function customizeQuotePool() {
  const venue = selectedClassicQuoteVenue();
  const percent = parsePercentInput($('#quotePoolPercent').value, 0);
  if (percent <= 0 || !venue.quoteMint) return;
  const id = nextCustomPoolId();
  state.customPools.push({
    id,
    quoteSymbol: venue.symbol,
    quoteMint: venue.quoteMint,
    supplyPercent: percent,
    ammConfigIndex: state.pairPoolConfigIndex,
    startPremiumPct: state.pairStartPremiumPct,
    sliceShares: '100',
    feeKeyRecipient: '',
    ladderBands: 0,
    ladderText: '',
    supportSol: 0,
    supportDepth: 12,
    supportLayersText: '',
  });
  $('#quotePoolPercent').value = '0';
  $('#quotePoolPercent').dispatchEvent(new Event('input', { bubbles: true }));
  state.supplyOpenRow = `custom:${id}`;
  invalidateClassicOutputs();
  renderAll();
  scheduleLaunchAutoSave();
  notify(`${venue.symbol} pair is now editable`);
}

function addCustomPool(hub = null) {
  state.customPools.push({
    id: nextCustomPoolId(),
    quoteSymbol: hub?.symbol || 'QUOTE',
    quoteMint: hub?.mint || '',
    supplyPercent: 5,
    ammConfigIndex: DEFAULT_POOL_CONFIG_INDEX,
    sliceShares: '100',
    feeKeyRecipient: '',
    ladderBands: 0,
    ladderText: '',
    supportSol: 0,
    supportDepth: 12,
    supportLayersText: '',
  });
  invalidateClassicOutputs();
  renderAll();
  scheduleMainPoolRebalance();
  scheduleLaunchAutoSave();
  notify(hub ? `${hub.symbol} pair added` : 'Pair added');
  return state.customPools.at(-1).id;
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
  const before = [$('#sliceShares').value, ...state.customPools.map((pool) => pool.sliceShares ?? '100')];
  $('#sliceShares').value = normalizedSliceText($('#sliceShares').value);
  state.customPools = state.customPools.map((pool) => ({
    ...pool,
    sliceShares: normalizedSliceText(pool.sliceShares || '100'),
  }));
  const after = [$('#sliceShares').value, ...state.customPools.map((pool) => pool.sliceShares)];
  const changed = after.some((value, index) => value !== before[index]);
  invalidateClassicOutputs();
  renderAll();
  notify(changed ? 'Slice percentages rounded to 100%' : 'Slices already add up to 100%');
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
