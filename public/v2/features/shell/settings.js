function approvalTransaction() {
  if (state.activeApprovalId) {
    const tx = state.transactions.find((item) => item.id === state.activeApprovalId);
    if (tx) return tx;
  }
  return state.transactions.find((tx) => tx.state === 'pending') || null;
}

function approvalHtml() {
  const current = account();
  const tx = approvalTransaction();
  const selectedLock = selectedManagedWallet() ? walletLockInfo(selectedManagedWallet()) : { state: null };
  const keyGone = selectedLock.state === 'missing' || selectedLock.state === 'wrong-key';
  const lockedWord = keyGone ? selectedLock.label : 'Locked';
  if (!tx) {
    return `
      <div class="approval-head">
        <span>
          <span class="eyebrow">Launch wallet</span>
          <h2>${walletIsUnlocked() ? 'Unlocked' : escapeHtml(lockedWord)}</h2>
        </span>
        <span class="badge">${escapeHtml(authoritativeNetworkLabel())}</span>
      </div>
      <div class="approval-body">
        <div class="kv-row"><span>Wallet</span><strong>${walletIsUnlocked() ? escapeHtml(current.name) : escapeHtml(lockedWord)}</strong></div>
        <p>${keyGone ? escapeHtml(selectedLock.detail) : 'Nothing to approve yet. Set up the token, then fund the launch wallet.'}</p>
      </div>
      <div class="approval-actions">
        <button class="secondary-button" type="button" data-action="close-approval">Close</button>
        <button class="primary-button" type="button" data-action="toggle-wallet" ${keyGone ? 'disabled' : ''}>${walletIsUnlocked() ? 'Lock' : 'Unlock'}</button>
      </div>
    `;
  }
  const rows = signatureRows();
  const pendingRows = rows.filter((item) => item.state === 'pending');
  const config = currentLaunchConfig();
  const recoveryEndpoint = recoveryAuthorizationEndpoint();
  const recoverySpec = {
    '/api/finish-token-creation': {
      eyebrow: 'One saved step',
      title: 'Finish token',
      detail: 'Complete only the missing token work.',
    },
    '/api/resume-launch': {
      eyebrow: 'One saved step',
      title: 'Finish liquidity',
      detail: 'Reuse the recorded pools and finish only what is missing.',
    },
    '/api/reveal-sealed-metadata': {
      eyebrow: 'One saved step',
      title: 'Reveal identity',
      detail: 'Publish the name, symbol and logo, then lock them for good.',
    },
    '/api/transfer-assets': {
      eyebrow: 'Final saved step',
      title: 'Finish launch',
      detail: 'Save the launch record, then send everything to the return wallet.',
    },
  }[recoveryEndpoint] || null;
  const fundingStatus = classicFundingEstimateStatus(config);
  const currentEstimate = window.TrebuchetV2RuntimeState?.fundingEstimate({
    estimateMatches: fundingStatus.matchesConfig,
    estimatedSol: state.classicFundingEstimate?.totalSol,
  }) || { available: false, value: null, label: 'Estimate required' };
  const finishingInterruptedToken = state.executionReadiness?.nextEndpoint === '/api/finish-token-creation';
  const armingTokenCreation = ['/api/create-token', '/api/finish-token-creation'].includes(state.executionReadiness?.nextEndpoint);
  const primaryLabel = recoverySpec && !walletIsUnlocked() ? 'Unlock PIN &amp; approve' : 'Approve';

  return `
    <div class="approval-head">
      <span>
        ${recoverySpec?.eyebrow ? `<span class="eyebrow">${escapeHtml(recoverySpec.eyebrow)}</span>` : ''}
        <h2>${recoverySpec ? escapeHtml(recoverySpec.title) : armingTokenCreation ? `Review before ${finishingInterruptedToken ? 'finishing' : 'creating'} ${escapeHtml(state.launchPlan?.token?.symbol || $('#tokenSymbol').value || 'the token')}` : `Review the ${escapeHtml(state.launchPlan?.token?.symbol || $('#tokenSymbol').value || 'token')} launch`}</h2>
      </span>
    </div>
    <div class="approval-body">
      <div class="kv-row"><span>Wallet</span><strong>${escapeHtml(current.name)}</strong></div>
      <div class="kv-row"><span>Network</span><strong>${escapeHtml(authoritativeNetworkLabel())}</strong></div>
      ${recoverySpec
        ? `<div class="kv-row approval-pin-row"><span>PIN</span><strong>${walletIsUnlocked() ? 'Ready' : 'Unlock required'}</strong></div>`
        : `<div class="kv-row"><span>Estimate</span><strong>${currentEstimate.available ? fmtSol(currentEstimate.value) : 'Required'}</strong></div>`}
      <p class="approval-scope-note"><i class="fa-solid fa-shield-halved"></i> ${recoverySpec?.detail ? `${escapeHtml(recoverySpec.detail)} ` : ''}Approving sends nothing; each step still runs from its own button.</p>
      ${!recoverySpec ? pendingRows.slice(0, 2).map((item) => `<p><i class="fa-solid fa-check"></i> ${escapeHtml(item.label)}</p>`).join('') : ''}
      ${!recoverySpec && pendingRows.length > 2 ? `<p><i class="fa-solid fa-ellipsis"></i> ${pendingRows.length - 2} more</p>` : ''}
    </div>
    <div class="approval-actions">
      <button class="secondary-button" type="button" data-action="close-approval">Cancel</button>
      <button class="primary-button" type="button" data-action="run-launch">${primaryLabel}</button>
    </div>
  `;
}

function renderExtension() {
  const html = approvalHtml();
  const approvalInline = document.getElementById('approvalInline');
  const approvalFloating = $('#approvalFloating');

  if (approvalInline) approvalInline.innerHTML = html;
  if (approvalFloating) {
    approvalFloating.innerHTML = html;
    approvalFloating.classList.toggle('is-recovery', Boolean(recoveryAuthorizationEndpoint()));
    approvalFloating.classList.toggle('needs-pin', !walletIsUnlocked());
    approvalFloating.classList.toggle('is-open', state.approvalOpen && state.activeView === 'launch');
  }

}

function renderReleasePanel() {
  const badge = updateResultLabel();
  const result = state.updateCheck.lastResult || {};
  const releaseUrl = result.releaseUrl || state.releaseUrl;
  const trust = releaseTrustSummary(result.releaseTrust || state.releaseTrust);
  return `
    <article class="release-panel ${escapeHtml(badge.className)}">
      <span>
        <span class="eyebrow">Release state</span>
        <h3>Trebuchet ${state.appVersion ? `v${escapeHtml(state.appVersion)}` : 'local build'}</h3>
        <p>${escapeHtml(updateResultDetail())}</p>
        <p class="release-trust-line"><strong>${escapeHtml(trust.label)}</strong> - ${escapeHtml(trust.detail)}</p>
      </span>
      <span class="release-meta">
        <small>${state.updateCheck.lastCheckedAt ? escapeHtml(formatDate(state.updateCheck.lastCheckedAt)) : 'not checked'}</small>
        <strong>${escapeHtml(result.latest ? `latest v${result.latest}` : result.current ? `current v${result.current}` : state.prefs.checkForUpdatesOnStartup ? 'auto-check on' : 'auto-check off')}</strong>
      </span>
      <span class="secret-pin-actions">
        <span class="risk-badge ${escapeHtml(trust.className)}">${escapeHtml(trust.label)}</span>
        <span class="risk-badge ${escapeHtml(badge.className)}">${escapeHtml(badge.label)}</span>
        <button class="pill-button" type="button" data-action="check-updates" ${state.apiStatus === 'connected' && !state.updateCheck.checking ? '' : 'disabled'}>
          ${state.updateCheck.checking ? 'Checking' : 'Check'}
        </button>
        <button class="pill-button" type="button" data-action="toggle-update-autocheck" ${state.apiStatus === 'connected' ? '' : 'disabled'}>
          ${state.prefs.checkForUpdatesOnStartup ? 'Auto on' : 'Auto off'}
        </button>
        <button class="pill-button" type="button" data-action="open-release-page" data-url="${escapeHtml(releaseUrl)}">
          Releases
        </button>
      </span>
    </article>`;
}

function applyRpcConfig(config = {}) {
  state.rpcActiveUrl = config.active || state.rpcActiveUrl;
  state.rpcSaved = Array.isArray(config.saved) ? config.saved : state.rpcSaved;
  const active = state.rpcSaved.find((item) => item?.url === state.rpcActiveUrl);
  state.rpcName = active?.name || (state.rpcActiveUrl ? safeRpcUrl(state.rpcActiveUrl) : state.rpcName);
  $('#networkLabel').textContent = authoritativeNetworkLabel();
}

function renderRpcSettingsPanel() {
  const activeUrl = state.rpcActiveUrl || '';
  const saved = Array.isArray(state.rpcSaved) ? state.rpcSaved : [];
  const isPublic = isPublicRpcUrl(activeUrl);
  const healthClass = state.rpcHealth === 'error' || isPublic
    ? 'danger'
    : state.rpcHealth === 'slow' || state.rpcHealth === 'unknown'
      ? 'warn'
      : '';
  const test = state.rpcTestResult;
  const testClass = test
    ? test.ok ? '' : 'danger'
    : '';
  const testText = state.rpcBusy === 'test'
    ? 'Testing RPC...'
    : test
      ? test.ok
        ? `OK - Solana ${test.version || 'version'} / ${test.latencyMs ?? '?'}ms`
        : `Failed - ${test.error || 'RPC test failed'}`
      : 'Test a new endpoint before saving it.';
  return `
    <article class="rpc-settings-panel ${escapeHtml(healthClass)}">
      <div class="rpc-settings-head">
        <span>
          <span class="eyebrow">RPC</span>
          <h3>${escapeHtml(state.rpcName || 'Unknown RPC')}</h3>
          <p>${escapeHtml(activeUrl ? safeRpcUrl(activeUrl) : 'Connect through the desktop app to manage launch RPC endpoints.')}</p>
        </span>
        <span class="risk-badge ${escapeHtml(healthClass)}">${escapeHtml(isPublic ? 'Public RPC' : state.rpcHealthLabel)}</span>
      </div>
      ${isPublic ? '<div class="rpc-warning">Public Solana RPCs are launch hazards. Save a dedicated endpoint before creating pools.</div>' : ''}
      <div class="rpc-saved-list">
        ${saved.filter((entry) => entry.url !== activeUrl).length ? `<small class="rpc-saved-title">Other saved endpoints</small>` : ''}
        ${saved.some((entry) => entry.url !== activeUrl) ? saved.filter((entry) => entry.url !== activeUrl).map((entry) => {
          const selected = entry.url === activeUrl;
          return `
            <article class="${selected ? 'is-active' : ''}">
              <span>
                <strong>${escapeHtml(entry.name || 'Unnamed RPC')}</strong>
                <small>${escapeHtml(safeRpcUrl(entry.url))}</small>
              </span>
              <span class="rpc-row-actions">
                <button class="pill-button" type="button" data-action="select-rpc" data-url="${escapeHtml(entry.url)}" ${selected || state.rpcBusy ? 'disabled' : ''}>Use</button>
                <button class="pill-button danger" type="button" data-action="remove-rpc" data-url="${escapeHtml(entry.url)}" ${saved.length <= 1 || state.rpcBusy ? 'disabled' : ''}>Remove</button>
              </span>
            </article>
          `;
        }).join('') : ''}
      </div>
      <div class="rpc-add-grid">
        <label>
          <small>Name</small>
          <input data-rpc-field="name" type="text" autocomplete="off" placeholder="Helius mainnet">
        </label>
        <label>
          <small>URL</small>
          <input data-rpc-field="url" type="url" autocomplete="off" placeholder="https://...">
        </label>
      </div>
      <div class="operator-toolbar compact">
        <button class="pill-button" type="button" data-action="test-rpc" ${state.apiStatus === 'connected' && !state.rpcBusy ? '' : 'disabled'}>${state.rpcBusy === 'test' ? 'Testing' : 'Test'}</button>
        <button class="pill-button" type="button" data-action="add-rpc" ${state.apiStatus === 'connected' && !state.rpcBusy ? '' : 'disabled'}>${state.rpcBusy === 'add' ? 'Saving' : 'Save and use'}</button>
      </div>
      <p class="rpc-test-result ${escapeHtml(testClass)}">${escapeHtml(testText)}</p>
    </article>
  `;
}

function renderSettings() {
  const pinMeta = secretPinMeta();
  $('#settingsList').innerHTML = `
    <article class="setting-row ${state.demoActive ? '' : 'warn'}">
      <span>
        <h3>${state.demoActive ? 'Test mode' : 'Live mode'}</h3>
        <p>${state.demoActive
          ? 'Test launches send nothing and spend no SOL.'
          : 'Launches send real transactions and spend real SOL.'}</p>
      </span>
      <button class="pill-button ${state.demoActive ? '' : 'danger'}" type="button" data-action="toggle-demo-mode" ${state.apiStatus === 'connected' ? '' : 'disabled'}>
        ${state.demoActive ? 'Switch to live' : 'Switch to test'}
      </button>
    </article>
    <article class="secret-pin-panel ${escapeHtml(pinMeta.className)}">
      <span>
        <span class="eyebrow">Recovery PIN</span>
        <h3>${escapeHtml(pinMeta.label)}</h3>
        <p>${escapeHtml(pinMeta.detail)}</p>
      </span>
      <span class="secret-pin-meta">
        <small>Device key</small>
        <strong>${state.secretPin.deviceSecretProtected ? 'OS keychain' : 'This device only'}</strong>
      </span>
      <span class="secret-pin-actions">
        <button class="pill-button" type="button" data-action="${escapeHtml(pinMeta.primaryAction)}" ${pinMeta.disabled || state.secretPin.busy ? 'disabled' : ''}>
          ${escapeHtml(state.secretPin.busy || pinMeta.primaryLabel)}
        </button>
        ${state.secretPin.configured ? `<button class="pill-button" type="button" data-action="change-secret-pin" ${state.apiStatus !== 'connected' || state.secretPin.busy ? 'disabled' : ''}>
          Change
        </button>
        <button class="pill-button danger" type="button" data-action="reset-secret-pin" ${state.apiStatus !== 'connected' || state.secretPin.busy ? 'disabled' : ''}>
          Reset
        </button>` : ''}
      </span>
    </article>
    ${renderReleasePanel()}
    ${renderRpcSettingsPanel()}`;
}
