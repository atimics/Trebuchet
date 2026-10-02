function personalTokenName(token) {
  return token?.symbol || token?.name || shortAddress(token?.mint);
}

function personalTokenDetail(token, type, knownByMint) {
  if (type === 'known') {
    const walletCount = Number(token.walletCount) || 0;
    return `${walletCount} wallet${walletCount === 1 ? '' : 's'} · ${formatDiscoveryPrice(token.priceUsd)}`;
  }
  const holderCount = Number(token.holderCount) || 0;
  const seedCount = Number(token.seedCount) || 0;
  return `${holderCount} holder${holderCount === 1 ? '' : 's'} · ${seedCount} connection${seedCount === 1 ? '' : 's'}`;
}

function personalTokenCards(tokens, type, knownByMint) {
  return tokens.map((rawToken) => {
    const token = discoveryDisplayToken(rawToken);
    const label = personalTokenName(token);
    const brandStatus = token.brand?.classification || null;
    return `
      <button class="personal-token-card" type="button" data-action="inspect-personal-token" data-token="${escapeHtml(token.mint)}" ${discoveryPaletteAttributes(token)}>
        ${discoveryTokenMark(token, 'personal-token-mark')}
        <span class="personal-token-copy">
          <strong>${escapeHtml(label)} ${token.name && token.name !== token.symbol ? `<span class="muted">${escapeHtml(token.name)}</span>` : ''}</strong>
          <small>${escapeHtml(personalTokenDetail(token, type, knownByMint))}</small>
        </span>
        ${type === 'candidate'
          ? `<span class="network-score ${brandStatus ? discoveryStatusClass(brandStatus) : ''}" title="${escapeHtml(brandStatus ? `${brandStatus} · ` : '')}Relevance ${Math.max(0, Math.min(100, Number(token.networkScore) || 0))}/100"><strong>${Math.max(0, Math.min(100, Number(token.networkScore) || 0))}</strong></span>`
          : '<span class="network-score is-known" title="Held by a tracked wallet"><i class="fa-solid fa-wallet"></i></span>'}
      </button>
    `;
  }).join('');
}

function discoveryWalletChip(wallet) {
  return `
    <span class="discovery-wallet-chip ${wallet.enabled === false ? 'is-paused' : ''}" title="${escapeHtml(wallet.publicKey)}">
      <i class="fa-solid ${wallet.source === 'managed' ? 'fa-key' : 'fa-eye'}"></i>
      <strong>${escapeHtml(wallet.label || shortAddress(wallet.publicKey))}</strong>
      <span>${escapeHtml(fullAddress(wallet.publicKey))}</span>
      <button type="button" data-action="toggle-discovery-wallet" data-wallet="${escapeHtml(wallet.publicKey)}" data-enabled="${wallet.enabled === false ? 'true' : 'false'}" aria-label="${wallet.enabled === false ? 'Resume' : 'Pause'} ${escapeHtml(wallet.label || 'wallet')}" ${state.discovery.walletBusy || state.discovery.scanning ? 'disabled' : ''}>
        <i class="fa-solid ${wallet.enabled === false ? 'fa-play' : 'fa-pause'}"></i>
      </button>
      ${wallet.source === 'watch-only' ? `
        <button type="button" data-action="remove-discovery-wallet" data-wallet="${escapeHtml(wallet.publicKey)}" aria-label="Remove ${escapeHtml(wallet.label || 'wallet')}" ${state.discovery.walletBusy || state.discovery.scanning ? 'disabled' : ''}>
          <i class="fa-solid fa-xmark"></i>
        </button>
      ` : ''}
    </span>
  `;
}

function renderPersonalDiscovery() {
  const connected = state.apiStatus === 'connected';
  const wallets = state.discovery.wallets || [];
  const watchOnlyWallets = wallets.filter((wallet) => wallet.source !== 'managed');
  const managedWallets = wallets.filter((wallet) => wallet.source === 'managed');
  const scanConcurrency = Number(state.discovery.limits?.scanConcurrency) || 4;
  const enabledWatchOnlyCount = watchOnlyWallets.filter((wallet) => wallet.enabled !== false).length;
  const enabledManagedCount = managedWallets.filter((wallet) => wallet.enabled !== false).length;
  const walletRenderLimit = Math.max(100, Number(state.discovery.walletRenderLimit) || 100);
  const visibleWatchOnlyWallets = watchOnlyWallets.slice(-walletRenderLimit).reverse();
  const visibleManagedWallets = managedWallets.slice(0, walletRenderLimit);
  const snapshot = state.discovery.snapshot;
  const knownTokens = Array.isArray(snapshot?.knownTokens) ? snapshot.knownTokens : [];
  const candidates = Array.isArray(snapshot?.candidates) ? snapshot.candidates : [];
  const knownByMint = new Map(knownTokens.map((token) => [token.mint, token]));
  const scanButton = $('#personalDiscoveryScanButton');
  const addButton = $('#discoveryWalletAddButton');
  const sortInput = $('#personalDiscoverySort');
  if (sortInput && sortInput.value !== state.discovery.sort) sortInput.value = state.discovery.sort;
  if (scanButton) {
    scanButton.disabled = !connected
      || state.discovery.scanning
      || enabledWatchOnlyCount + enabledManagedCount === 0;
    scanButton.innerHTML = state.discovery.scanning
      ? '<i class="fa-solid fa-spinner fa-spin"></i><span>Scanning</span>'
      : '<i class="fa-solid fa-rotate"></i><span>Refresh</span>';
  }
  if (addButton) {
    addButton.disabled = !connected || state.discovery.walletBusy || state.discovery.scanning;
    addButton.title = '';
  }
  ['discoveryWalletInput', 'discoveryWalletLabelInput'].forEach((id) => {
    if ($(`#${id}`)) $(`#${id}`).disabled = !connected || state.discovery.walletBusy || state.discovery.scanning;
  });

  $('#discoveryWallets').innerHTML = `
    <section class="discovery-wallet-group">
      <header>
        <span><i class="fa-solid fa-eye"></i> Watched wallets</span>
        <small>${watchOnlyWallets.length}</small>
      </header>
      <div class="discovery-wallet-chip-list">
        ${watchOnlyWallets.length
          ? visibleWatchOnlyWallets.map(discoveryWalletChip).join('')
          : '<span class="muted">Add addresses you want Trebuchet to follow.</span>'}
      </div>
      ${watchOnlyWallets.length > visibleWatchOnlyWallets.length ? `
        <button class="pill-button discovery-wallet-show-more" type="button" data-action="show-more-discovery-wallets">
          Show ${Math.min(100, watchOnlyWallets.length - visibleWatchOnlyWallets.length)} more watched wallets
        </button>
      ` : ''}
    </section>
    ${managedWallets.length ? `
      <details class="managed-discovery-wallets">
        <summary>
          <span><i class="fa-solid fa-key"></i> ${managedWallets.length} launch wallet${managedWallets.length === 1 ? '' : 's'}</span>
          <small>Automatic</small>
        </summary>
        <div class="discovery-wallet-chip-list">${visibleManagedWallets.map(discoveryWalletChip).join('')}</div>
        ${managedWallets.length > visibleManagedWallets.length ? `
          <button class="pill-button discovery-wallet-show-more" type="button" data-action="show-more-discovery-wallets">
            Show ${Math.min(100, managedWallets.length - visibleManagedWallets.length)} more launch wallets
          </button>
        ` : ''}
      </details>
    ` : ''}
    ${enabledWatchOnlyCount + enabledManagedCount ? `<p class="discovery-scan-budget">Refresh looks through ${enabledWatchOnlyCount + enabledManagedCount} wallet${enabledWatchOnlyCount + enabledManagedCount === 1 ? '' : 's'}, ${scanConcurrency} at a time.</p>` : ''}
  `;

  const progressLabel = personalDiscoveryProgressLabel();
  const rawScanWarnings = Array.isArray(snapshot?.warnings) ? snapshot.warnings : [];
  const legacyBoundedScan = rawScanWarnings.some((warning) => /Scanned \d+ of \d+ enabled wallets/i.test(String(warning)));
  const scanWarnings = [
    ...(legacyBoundedScan ? ['Previous result used the retired bounded scanner. Scan again to include every enabled wallet.'] : []),
    ...rawScanWarnings.filter((warning) => !/Scanned \d+ of \d+ enabled wallets/i.test(String(warning))),
  ];
  const tokenCount = knownTokens.length + candidates.length;
  if ($('#personalDiscoveryTokenCount')) $('#personalDiscoveryTokenCount').textContent = `${tokenCount}`;
  const scanSummary = snapshot
    ? `${candidates.length} network · ${knownTokens.length} held · ${formatAge(snapshot.completedAt)}`
    : null;
  const status = state.discovery.personalError
    || progressLabel
    || (snapshot
      ? scanSummary
      : enabledWatchOnlyCount + enabledManagedCount > 0
        ? 'Refresh to find tokens.'
        : 'Add a wallet first.');
  const progress = state.discovery.job?.progress || {};
  const progressTotal = Math.max(0, Number(progress.total) || 0);
  const progressCurrent = Math.max(0, Math.min(progressTotal, Number(progress.current) || 0));
  const progressPercent = progressTotal > 0 ? Math.round((progressCurrent / progressTotal) * 100) : 0;
  ['personalDiscoveryStatus', 'discoveryWalletStatus'].forEach((id) => {
    const statusNode = $(`#${id}`);
    if (!statusNode) return;
    // The Wallets tab already says to add an address; don't say it twice.
    if (id === 'discoveryWalletStatus' && !snapshot && !state.discovery.personalError && !state.discovery.scanning
      && enabledWatchOnlyCount + enabledManagedCount === 0) {
      statusNode.innerHTML = '';
      return;
    }
    statusNode.classList.toggle('is-error', Boolean(state.discovery.personalError));
    statusNode.classList.toggle('is-warning', !state.discovery.personalError && scanWarnings.length > 0);
    statusNode.title = scanWarnings.join('\n');
    statusNode.innerHTML = `
      <span><i class="fa-solid ${state.discovery.personalError || scanWarnings.length ? 'fa-triangle-exclamation' : state.discovery.scanning ? 'fa-spinner fa-spin' : 'fa-shield-halved'}"></i> ${escapeHtml(status)}</span>
      ${state.discovery.scanning && progressTotal > 0 ? `<span class="discovery-progress-meter" role="progressbar" aria-valuemin="0" aria-valuemax="${progressTotal}" aria-valuenow="${progressCurrent}"><i style="width:${progressPercent}%"></i></span>` : ''}
    `;
  });

  if (!snapshot) {
    if ($('#personalDiscoveryTokenCount')) $('#personalDiscoveryTokenCount').textContent = '0';
    $('#personalTokenNetwork').innerHTML = '<div class="discovery-feed-empty">Refresh to find tokens.</div>';
    return;
  }
  const feed = [
    ...candidates.map((token) => ({ token, type: 'candidate' })),
    ...knownTokens.map((token) => ({ token, type: 'known' })),
  ];
  const sortedFeed = [...feed].sort((left, right) => {
    if (state.discovery.sort === 'name') {
      return String(personalTokenName(left.token)).localeCompare(String(personalTokenName(right.token)));
    }
    if (state.discovery.sort === 'connections') {
      const leftConnections = left.type === 'known' ? Number(left.token.walletCount) || 0 : Number(left.token.holderCount) || 0;
      const rightConnections = right.type === 'known' ? Number(right.token.walletCount) || 0 : Number(right.token.holderCount) || 0;
      return rightConnections - leftConnections
        || (Number(right.token.networkScore) || 0) - (Number(left.token.networkScore) || 0);
    }
    const leftRelevance = left.type === 'known' ? 101 : Number(left.token.networkScore) || 0;
    const rightRelevance = right.type === 'known' ? 101 : Number(right.token.networkScore) || 0;
    return rightRelevance - leftRelevance
      || (Number(right.token.holderCount) || 0) - (Number(left.token.holderCount) || 0);
  });
  $('#personalTokenNetwork').innerHTML = `
    <div class="personal-token-feed" role="list" aria-label="Discovered tokens">
      ${sortedFeed.length
        ? sortedFeed.map(({ token, type }) => personalTokenCards([token], type, knownByMint)).join('')
        : '<span class="discovery-feed-empty">No tokens found.</span>'}
    </div>
  `;
}

function renderDiscoveryPanes() {
  const pane = state.discovery.activePane === 'wallets' ? 'wallets' : 'tokens';
  state.discovery.activePane = pane;
  $$('.discovery-pane-tab').forEach((button) => {
    const selected = button.dataset.discoveryPane === pane;
    button.classList.toggle('is-selected', selected);
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
  });
  $$('[data-discovery-pane-panel]').forEach((panel) => {
    const selected = panel.dataset.discoveryPanePanel === pane;
    panel.hidden = !selected;
    panel.classList.toggle('is-active', selected);
  });
  $('.discovery-grid')?.classList.toggle('is-wallet-tracking', pane === 'wallets');
}

function renderDiscovery() {
  const selected = selectedDiscovery();
  const rows = filteredDiscoveryRecords();
  const connected = state.apiStatus === 'connected';
  const queryInput = $('#discoverySearchInput');
  const mintInput = $('#discoveryMintInput');
  const inspectButton = $('#discoveryInspectButton');

  renderPersonalDiscovery();
  renderDiscoveryPanes();

  const shield = state.discovery.brandShield;
  const shieldAlerts = Number(shield?.alertCount || 0);
  const shieldCritical = Number(shield?.criticalAlertCount || 0);
  const watcherCandidates = Number(shield?.watcherCandidateCount || 0);
  $('#discoverySourceBanner').innerHTML = `
    <span class="risk-badge ${!connected ? 'warn' : shieldCritical ? 'danger' : ''}">${!connected ? 'Offline' : shieldCritical ? `${shieldCritical} critical` : 'Brand Shield'}</span>
    <span>${connected
      ? `${Number(shield?.officialLaunchCount || 0)} verified · ${shieldAlerts} alerts · ${watcherCandidates} signals`
      : 'Local API unavailable.'}</span>
  `;

  if (queryInput && queryInput.value !== state.discovery.query) queryInput.value = state.discovery.query;
  if (mintInput && state.discovery.lastInspectedMint && !mintInput.value) mintInput.value = state.discovery.lastInspectedMint;
  if (inspectButton) {
    inspectButton.disabled = state.discovery.inspecting || !connected;
    inspectButton.innerHTML = state.discovery.inspecting
      ? '<i class="fa-solid fa-spinner fa-spin"></i><span>Analyzing</span>'
      : '<i class="fa-solid fa-magnifying-glass-chart"></i><span>Analyze token</span>';
  }
  $('#discoveryRegistryCount').textContent = `${state.discovery.records.length}`;
  document.querySelectorAll('[data-discovery-filter]').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.discoveryFilter === state.discovery.filter);
  });
  $('#discoveryError').innerHTML = state.discovery.error
    ? `<span><i class="fa-solid fa-triangle-exclamation"></i> ${escapeHtml(state.discovery.error)}</span>`
    : '';

  $('#discoveryTable').innerHTML = rows.length ? rows.map((token) => {
    const change24h = token.market?.priceChange?.h24 ?? token.metrics?.change24h;
    const liquidityUsd = token.market?.liquidityUsd ?? token.metrics?.liquidityUsd;
    const volume24hUsd = token.market?.volume24hUsd ?? token.metrics?.volume24hUsd;
    const provenance = discoveryLocalProvenance(token);
    return `
      <button class="discovery-row ${token.id === state.selectedDiscoveryId ? 'is-active' : ''}" type="button" data-action="select-discovery" data-token="${escapeHtml(token.id)}" ${discoveryPaletteAttributes(token)}>
        ${discoveryTokenMark(token)}
        <span class="discovery-copy">
          <h3>${escapeHtml(token.name)} <span class="muted">${escapeHtml(token.symbol)}</span></h3>
          <span class="market-line">
            <strong>${formatDiscoveryPrice(token.priceUsd)}</strong>
            <span class="${discoveryTrendClass(change24h)}">${formatDiscoveryPercent(change24h, '24h —')}</span>
            <span>${formatDiscoveryUsd(liquidityUsd)} pool value</span>
            <span>${formatDiscoveryUsd(volume24hUsd)} volume</span>
            ${provenance.proof || provenance.journal ? '<span class="has-provenance" title="Local launch proof">✓</span>' : ''}
          </span>
        </span>
        <span class="score-block">
          <strong>${token.score}</strong>
          <span class="meter"><span style="width:${token.score}%"></span></span>
        </span>
        <span class="source-block">
          <span class="risk-badge ${discoveryStatusClass(token.status)}">${escapeHtml(token.status)}</span>
          <span>${formatAge(token.inspectedAt)}</span>
        </span>
      </button>
    `;
  }).join('') : `
    <div class="discovery-empty">
      <i class="fa-solid fa-satellite-dish"></i>
      <strong>${state.discovery.records.length ? 'No matches' : 'No saved analysis'}</strong>
      <span>${state.discovery.records.length
        ? 'Change the filter.'
        : 'Inspect a mint above.'}</span>
    </div>
  `;

  if (!selected) {
    const snapshot = state.discovery.snapshot;
    const knownCount = Array.isArray(snapshot?.knownTokens) ? snapshot.knownTokens.length : 0;
    const networkCount = Array.isArray(snapshot?.candidates) ? snapshot.candidates.length : 0;
    const watchedCount = (state.discovery.wallets || []).filter((wallet) => wallet.source !== 'managed').length;
    const managedCount = (state.discovery.wallets || []).filter((wallet) => wallet.source === 'managed').length;
    const trackedCount = watchedCount + managedCount;
    $('#evidencePanel').innerHTML = `
      <div class="discovery-detail-empty">
        <i class="fa-solid fa-compass"></i>
        <strong>Select a token</strong>
        <span>${knownCount + networkCount
          ? `${knownCount + networkCount} in the feed.`
          : trackedCount
            ? `Refresh ${trackedCount} wallet${trackedCount === 1 ? '' : 's'}.`
            : 'Add a wallet first.'}</span>
        <div class="discovery-overview-stats">
          <span><small>Held</small><strong>${knownCount}</strong></span>
          <span><small>Network</small><strong>${networkCount}</strong></span>
          <span><small>Tracked wallets</small><strong>${trackedCount}</strong></span>
        </div>
        <button class="primary-button compact" type="button" data-action="${trackedCount ? 'scan-personal-discovery' : 'open-wallet-tracking'}">${trackedCount ? 'Refresh' : 'Add wallet'}</button>
      </div>
    `;
    hydrateDiscoveryTokenPalettes();
    return;
  }

  const provenance = discoveryLocalProvenance(selected);
  const evidence = Array.isArray(selected.evidence)
    ? selected.evidence.filter((item) => !['Trebuchet provenance', 'Market price'].includes(item.label))
    : [];
  const market = selected.market || null;
  const marketPrice = market?.priceUsd ?? selected.priceUsd;
  const change24h = market?.priceChange?.h24 ?? selected.metrics?.change24h;
  const change7d = market?.history?.changePercent;
  const marketTrend = change7d ?? change24h;
  const supply = selected.metrics?.supply
    ? compactAmount(Number(selected.metrics.supply))
    : '—';
  const topTenValue = selected.metrics?.topTenPercent == null
    ? '—'
    : `${Number(selected.metrics.topTenPercent).toFixed(2)}%`;
  const transactions = market?.transactions24h || {};
  const buys = Number(transactions.buys);
  const sells = Number(transactions.sells);
  const tradeCount = (Number.isFinite(buys) ? buys : 0) + (Number.isFinite(sells) ? sells : 0);
  const marketChart = discoveryPriceChart(market);
  const inspectionSource = String(selected.source || 'Configured RPC')
    .replace(/\s*\+\s*local Trebuchet journals$/i, '');
  const warningSummaries = (selected.warnings || []).map(discoveryWarningSummary);
  const brand = selected.brand || null;
  const brandDetail = brand?.evidence?.[0]?.detail
    || (brand?.official
      ? brand.provenanceVerified ? 'Signed Trebuchet launch provenance verified.' : 'Registered in this Trebuchet installation.'
      : 'No matching signed Trebuchet launch provenance was found.');
  const brandRiskClass = ['critical', 'high'].includes(String(brand?.risk || '').toLowerCase())
    ? 'danger'
    : String(brand?.risk || '').toLowerCase() === 'medium'
      ? 'warn'
      : discoveryStatusClass(brand?.classification);
  const localEvidence = [
    provenance.journal ? `
      <div class="audit-line">
        <span class="evidence-dot pass"></span>
        <span><strong>Launch journal</strong><small>${escapeHtml(provenance.journal.status || 'recorded')} · ${formatDate(provenance.journal.updatedAt)}</small></span>
      </div>
    ` : '',
    provenance.proof ? `
      <div class="audit-line">
        <span class="evidence-dot pass"></span>
        <span><strong>Trebuchet proof bundle</strong><small>Matching local proof loaded</small></span>
      </div>
    ` : '',
  ].filter(Boolean).join('');

  $('#evidencePanel').innerHTML = `
    <div class="evidence-head" ${discoveryPaletteAttributes(selected)}>
      ${discoveryTokenMark(selected)}
      <span class="evidence-identity">
        <h3>${escapeHtml(selected.name)} <span>${escapeHtml(selected.symbol)}</span></h3>
        <span class="evidence-identity-meta">
          <code title="${escapeHtml(selected.mint)}">${escapeHtml(fullAddress(selected.mint))}</code>
          ${brand ? `<span class="risk-badge ${brandRiskClass}" title="${escapeHtml(brandDetail)}"><i class="fa-solid ${brand.official ? 'fa-shield-halved' : 'fa-shield'}"></i>${escapeHtml(brand.classification)}</span>` : ''}
        </span>
      </span>
      <span class="evidence-price">
        <strong>${formatDiscoveryPrice(marketPrice)}</strong>
        <small class="${discoveryTrendClass(change24h)}">${formatDiscoveryPercent(change24h, '24h —')}</small>
      </span>
    </div>
    <section class="market-card" aria-label="Token market history">
      <div class="market-card-head">
        <span><small>${market ? 'GeckoTerminal' : 'Price'}</small><strong>7 days</strong></span>
        <span class="${discoveryTrendClass(marketTrend)}">${formatDiscoveryPercent(change7d)}</span>
      </div>
      ${marketChart || `
        <div class="market-chart-empty">
          <i class="fa-solid fa-chart-area"></i>
          <span><strong>No market history</strong></span>
        </div>
      `}
      ${marketChart ? `
        <div class="market-chart-range">
          <span><small>Low</small><strong>${formatDiscoveryPrice(market?.history?.lowUsd)}</strong></span>
          <span><small>Updated</small><strong>${formatAge(market?.history?.asOf)}</strong></span>
          <span><small>High</small><strong>${formatDiscoveryPrice(market?.history?.highUsd)}</strong></span>
        </div>
      ` : ''}
    </section>
    <div class="market-stats">
      <span><small>Pool inventory value</small><strong>${formatDiscoveryUsd(market?.liquidityUsd)}</strong></span>
      <span><small>Volume</small><strong>${formatDiscoveryUsd(market?.volume24hUsd)}</strong></span>
      <span><small>${market?.marketCapUsd != null ? 'Market cap' : 'FDV'}</small><strong>${formatDiscoveryUsd(market?.marketCapUsd ?? market?.fdvUsd)}</strong></span>
      <span><small>Trades</small><strong>${tradeCount || '—'}</strong></span>
    </div>
    ${window.TrebuchetMarketEvidence?.reserves(market?.reserves) || ''}
    <p class="pool-support-intro">Pool value includes the token inventory. Quote reserves span price ranges. Check a sell quote for the amount you plan to sell.</p>
    <p class="pool-support-intro">Volume: ${formatDiscoveryUsd(market?.volume6hUsd)} over 6 hours · ${formatDiscoveryUsd(market?.volume24hUsd)} over 24 hours.</p>
    <button class="secondary-button compact" type="button" data-action="open-market-evidence" data-mint="${escapeHtml(selected.mint)}">Pool locks, fee owners and sell quotes</button>
    <div class="detail-section-label">
      <span>Chain</span>
      <small>${selected.score} · ${escapeHtml(selected.status)}</small>
    </div>
    <div class="evidence-summary-strip">
      <span><small>Supply</small><strong>${escapeHtml(supply)}</strong></span>
      <span><small>Top 10</small><strong>${escapeHtml(topTenValue)}</strong></span>
    </div>
    <div class="evidence-facts">
      ${evidence.map((item) => `
        <div class="evidence-fact">
          <span>${escapeHtml(item.label)}</span>
          <strong><span class="evidence-dot ${escapeHtml(item.state || 'unknown')}"></span>${escapeHtml(item.value)}</strong>
        </div>
      `).join('')}
    </div>
    <div class="evidence-mint-line">
      <small>Mint</small>
      <code title="${escapeHtml(selected.mint)}">${escapeHtml(selected.mint)}</code>
    </div>
    <div class="discovery-actions">
      <button class="secondary-button compact" type="button" data-action="refresh-discovery" data-token="${escapeHtml(selected.mint)}" ${state.discovery.inspecting ? 'disabled' : ''}>
        <i class="fa-solid fa-rotate"></i><span>Refresh</span>
      </button>
      <button class="secondary-button compact" type="button" data-action="copy-discovery-mint" data-token="${escapeHtml(selected.mint)}">
        <i class="fa-solid fa-copy"></i><span>Copy</span>
      </button>
    </div>
    <details class="discovery-more">
      <summary><span>Details</span>${warningSummaries.length ? `<small>${warningSummaries.length} warning${warningSummaries.length === 1 ? '' : 's'}</small>` : ''}</summary>
      <div class="discovery-audit">
      <div class="audit-line">
        <span class="evidence-dot pass"></span>
        <span><strong>${escapeHtml(inspectionSource)}</strong><small>Inspected ${formatAge(selected.inspectedAt)}</small></span>
      </div>
      ${localEvidence || `
        <div class="audit-line muted">
          <i class="fa-solid fa-link-slash"></i>
          <span><strong>RPC only</strong><small>No local launch artifacts linked</small></span>
        </div>
      `}
      ${warningSummaries.map((warning) => `
        <details class="discovery-warning-line">
          <summary>
            <i class="fa-solid fa-triangle-exclamation"></i>
            <span><strong>${escapeHtml(warning.title)}</strong><small>${escapeHtml(warning.detail)}</small></span>
            <i class="fa-solid fa-chevron-down"></i>
          </summary>
          <code>${escapeHtml(warning.raw)}</code>
        </details>
      `).join('')}
      <details class="discovery-notes" ${selected.notes ? 'open' : ''}>
        <summary><span>Notes</span><small>${selected.notes ? 'Saved' : 'Add'}</small></summary>
        <label class="discovery-notes-editor">
          <textarea id="discoveryNotesInput" rows="2" maxlength="500" placeholder="Questions or verification context…">${escapeHtml(selected.notes || '')}</textarea>
        </label>
      </details>
      <button class="secondary-button compact danger-button" type="button" data-action="remove-discovery" data-token="${escapeHtml(selected.mint)}">
        <i class="fa-solid fa-trash"></i><span>Remove saved analysis</span>
      </button>
      </div>
    </details>
  `;
  hydrateDiscoveryTokenPalettes();
}
