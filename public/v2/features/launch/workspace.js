function operationsToTransactions(operations) {
  return (Array.isArray(operations) ? operations : []).map((item) => ({
    id: item.id,
    label: item.label,
    risk: item.risk || 'Low',
    cost: costFromOperation(item),
    state: item.state || 'pending',
    stage: item.stage || 'config',
    effects: Array.isArray(item.effects) && item.effects.length
      ? item.effects
      : ['No decoded effects supplied'],
    source: item.source || 'launch-plan',
    signer: item.signer || 'trebuchet-managed-launch-wallet',
    authorization: item.authorization || { type: 'run-envelope', requiredUserAction: 'fund-and-arm' },
    simulation: item.simulation || null,
    checks: Array.isArray(item.checks) ? item.checks : [],
  }));
}

function recoveryAuthorizationEndpoint() {
  const endpoint = String(state.executionReadiness?.nextEndpoint || '').trim();
  return [
    '/api/finish-token-creation',
    '/api/resume-launch',
    '/api/reveal-sealed-metadata',
    '/api/transfer-assets',
  ].includes(endpoint) ? endpoint : null;
}

function recoveryAuthorizationTransaction(endpoint = recoveryAuthorizationEndpoint()) {
  const spec = {
    '/api/finish-token-creation': {
      id: 'v2-recovery-finish-token',
      label: 'Finish the existing token',
      stage: 'mint',
      effects: ['Reuse the recorded mint and execute only missing token-safety steps.'],
    },
    '/api/resume-launch': {
      id: 'v2-recovery-resume-liquidity',
      label: 'Resume missing liquidity work',
      stage: 'liquidity',
      effects: ['Reuse recorded pools and positions; execute only missing durable checkpoints.'],
    },
    '/api/reveal-sealed-metadata': {
      id: 'v2-recovery-reveal-metadata',
      label: 'Reveal the committed token identity',
      stage: 'liquidity',
      effects: ['Publish the committed identity after liquidity is locked, then make metadata immutable.'],
    },
    '/api/transfer-assets': {
      id: 'v2-recovery-final-sweep',
      label: 'Run final distribution and sweep',
      stage: 'sweep',
      effects: ['Distribute configured assets, sweep the launch wallet, and record terminal proof.'],
    },
  }[endpoint];
  if (!spec) return null;
  return {
    ...spec,
    endpoint,
    risk: 'High',
    cost: 0,
    state: 'pending',
    source: 'recovery-journal',
    signer: 'trebuchet-managed-launch-wallet',
    authorization: { type: 'recovery-envelope', requiredUserAction: 'unlock-and-arm' },
    simulation: state.executionReadiness?.nextAction || spec.label,
    checks: ['Journal checkpoint verified', 'Endpoint revalidated before execution'],
  };
}

function stageRecoveryAuthorization(endpoint = recoveryAuthorizationEndpoint()) {
  const transaction = recoveryAuthorizationTransaction(endpoint);
  if (!transaction) return false;
  state.transactions = [transaction];
  state.activeApprovalId = transaction.id;
  state.approvalOpen = true;
  state.launchStage = Math.max(state.launchStage, 1);
  return true;
}

function fallbackLaunchPlan() {
  const config = currentLaunchConfig();
  const symbol = String(config.token.symbol || 'TOK').trim().toUpperCase() || 'TOK';
  return {
    contractVersion: 0,
    id: `static-${symbol}`,
    source: 'static-preview',
    runtime: 'static',
    mode: config.mode,
    token: {
      name: String(config.token.name || 'Untitled').trim() || 'Untitled',
      symbol,
      supply: String(config.token.supply || '1000000000').replaceAll(',', ''),
      decimals: 9,
    },
    funding: {
      launchSol: config.launchSol,
      estimatedSolCost: baseTransactions.reduce((total, tx) => total + tx.cost, 0),
    },
    guardrails: [],
    operations: baseTransactions.map((tx) => ({
      ...tx,
      costSol: tx.cost,
      source: 'static-preview',
      stage: tx.id === 'tx-config'
        ? 'config'
        : tx.id === 'tx-funding'
          ? 'fund'
          : tx.id === 'tx-pool' || tx.id === 'tx-lock'
          ? 'liquidity'
          : tx.id === 'tx-report' ? 'sweep' : 'mint',
    })),
  };
}

function applyLaunchPlan(plan, config = currentLaunchConfig(), { openApproval = true } = {}) {
  const rawPlan = plan || fallbackLaunchPlan();
  const effectivePlan = rawPlan?.source === 'local-api'
    ? rawPlan
    : stampLaunchPlanConfigFingerprint(rawPlan, config);
  const transactions = operationsToTransactions(effectivePlan?.operations);
  state.launchPlan = effectivePlan;
  state.launchStage = Math.max(state.launchStage, 1);
  state.transactions = transactions.length
    ? transactions
    : operationsToTransactions(fallbackLaunchPlan().operations);
  state.activeApprovalId = openApproval ? state.transactions[0]?.id || null : null;
  state.approvalOpen = openApproval && Boolean(state.activeApprovalId);
}

function setView(view) {
  if (!views[view]) return;
  state.activeView = view;
  document.body.dataset.activeView = view;
  if (view !== 'launch') {
    state.approvalOpen = false;
  }
  // A coin's creation steps are part of its coin page, under Coins.
  const navView = view === 'launch' ? 'coins' : view;
  $$('.nav-item').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.view === navView);
  });
  $$('.view').forEach((panel) => {
    panel.classList.toggle('is-active', panel.id === `view-${view}`);
  });
  $('#viewEyebrow').textContent = views[view].eyebrow;
  $('#viewTitle').textContent = views[view].title;
  if (view === 'nfts') window.TrebuchetNfts?.onShow();
  renderCoinContext();
  renderLaunchWorkspace();
  renderExtension();
  drawLaunchCanvas();
}

// What is true about the coin being created, one fact per row, read from
// the launch proof, the funding check, and (for a live mint) the chain.
// No row is a place in a sequence: a row says what holds now, and the
// first row that doesn't hold yet is the one that needs doing.
const COIN_FACT_MARKS = {
  done: { icon: 'fa-check', label: 'True' },
  recorded: { icon: 'fa-file-circle-check', label: 'Recorded; not checked on-chain' },
  mismatch: { icon: 'fa-triangle-exclamation', label: 'Recorded, but the chain disagrees' },
  draft: { icon: 'fa-pen', label: 'Can change until the token is created' },
  running: { icon: 'fa-spinner fa-spin', label: 'Happening now' },
  todo: { icon: 'fa-circle', label: 'Not yet' },
  unrecorded: { icon: 'fa-circle-question', label: 'Not recorded; not checked on-chain' },
};

function coinFacts() {
  const config = currentLaunchConfig();
  const proof = currentLaunchProof();
  const readiness = state.executionReadiness;
  const practice = Boolean(state.demoActive);
  const sol = (value) => `${Number(value || 0).toFixed(4)} SOL`;
  const poolCount = config.poolTopology.pools.length;
  const pools = `${poolCount} pool${poolCount === 1 ? '' : 's'}`;
  const mint = proofTokenMint(proof);
  const proofToken = proof?.token || {};
  const tokenComplete = Boolean(
    isReadinessPhaseComplete('token')
    || (mint && proofToken.mintAuthorityRenounced === true && proofToken.freezeAuthorityDisabled === true)
  );
  const recordedPools = launchProofPoolIds(proof).length;
  const liquidityComplete = Boolean(
    isReadinessPhaseComplete('liquidity')
    || (poolCount > 0 && recordedPools >= poolCount)
  );
  const revealPending = readiness?.nextEndpoint === '/api/reveal-sealed-metadata'
    || (liquidityComplete && (readiness?.completion?.metadataRevealPending === true || proofToken.sealedMetadataPending === true));
  const sweepComplete = transferHasWalletEmptyFinalSweepEvidence(proof?.transfer);
  const running = state.fullRunRunning || state.realExecutionRunning || state.demoLaunchRunning;
  const nextEndpoint = readiness?.nextEndpoint || '';
  // A finished launch's record, when the proof doesn't carry every detail.
  const finishedRecord = Boolean(completedLaunchJournal(proof));
  // The chain's answer for this mint, when it has been read (live mints only).
  const chain = state.launchChainCheck?.mint && state.launchChainCheck.mint === mint
    ? Object.fromEntries((state.launchChainCheck.steps || []).map((step) => [step.id, step]))
    : null;
  // A recorded fact becomes true once the chain agrees, and a mismatch when it disagrees.
  const checked = (fact, ...stepIds) => {
    if (fact.state !== 'done' || practice) return fact;
    const steps = stepIds.map((id) => chain?.[id]).filter(Boolean);
    const mismatch = steps.find((step) => step.state === 'mismatch' || step.state === 'todo');
    if (mismatch) return { ...fact, state: 'mismatch', value: mismatch.detail, action: fact.repair };
    if (steps.length && steps.every((step) => step.state === 'done')) return fact;
    return { ...fact, state: 'recorded' };
  };

  // Practice needs a wallet to name the signer, but never its secret.
  const walletKey = practice
    ? state.selectedWalletPublicKey || state.managedWallets[0]?.publicKey || ''
    : selectedLaunchWalletPublicKey();
  const signer = practice && walletKey
    ? { state: 'done', value: `${shortAddress(walletKey)} · test mode` }
    : !walletKey
      ? { state: 'todo', value: 'None chosen', action: state.managedWallets.length ? 'Choose a launch wallet' : 'Create a launch wallet' }
      : walletIsUnlocked()
        ? { state: 'done', value: `${shortAddress(walletKey)} · unlocked` }
        : { state: 'todo', value: `${shortAddress(walletKey)} · locked`, action: 'Unlock the launch wallet' };

  const symbol = String(proofToken.symbol || config.token.symbol || '').trim().toUpperCase();
  const named = Boolean(String(proofToken.name || config.token.name || '').trim() && symbol);
  const plan = mint
    ? { state: 'done', value: symbol ? `$${symbol} · fixed by the mint` : 'Fixed by the mint' }
    : !named
      ? { state: 'todo', value: 'Not named yet', action: 'Name the token' }
      : { state: 'draft', value: `$${symbol} · ${pools}` };

  const estimateStatus = classicFundingEstimateStatus(config);
  const estimate = estimateStatus.matchesConfig ? state.classicFundingEstimate : null;
  const funding = fundingMeterSnapshot(config);
  const balanceKnown = Boolean(funding.hasWalletBalance && funding.walletBalanceFresh);
  const quoteReady = quoteAcquireStatus(config).ready
    && (!quoteAcquireManualCount() || manualPrefundSummary(quoteManualPrefundItems()).className === '');
  const total = Number(estimate?.totalSol || 0);
  const fund = practice
    ? { state: 'done', value: 'Not needed in test mode' }
    : mint
      ? { state: 'done', value: 'Not needed now the token exists' }
      : estimateStatus.stale
        ? { state: 'todo', value: 'Estimate out of date', action: 'Estimate the cost again' }
        : !estimate
          ? { state: 'todo', value: 'Not estimated', action: 'Estimate the cost' }
          : !balanceKnown
            ? { state: 'todo', value: `Needs ${sol(total)} · balance not checked`, action: `Send ${sol(total)} to the launch wallet` }
            : Number(funding.missingSol || 0) > 0.001
              ? { state: 'todo', value: `Needs ${sol(total)} · holds ${sol(funding.availableSol)}`, action: `Send ${sol(funding.missingSol)} more` }
              : !quoteReady
                ? { state: 'todo', value: `Holds ${sol(funding.availableSol)} · pair tokens missing`, action: 'Get the pair tokens' }
                : { state: 'done', value: `Holds ${sol(funding.availableSol)} of ${sol(total)} needed` };

  const tokenRunning = (running && ['/api/create-token', '/api/finish-token-creation'].includes(nextEndpoint))
    || (state.demoLaunchRunning && !tokenComplete);
  const token = checked(
    tokenComplete || (finishedRecord && mint)
      ? { state: 'done', value: practice ? 'Created in test mode' : 'On-chain · mint authority revoked', repair: 'Finish the token' }
      : tokenRunning
        ? { state: 'running', value: 'Being created' }
        : mint
          ? { state: 'todo', value: 'On-chain · not finished', action: 'Finish the token' }
          : { state: 'todo', value: 'Not on-chain', action: practice ? 'Run the test launch' : 'Create the token' },
    'token',
  );

  const liquidityRunning = running && ['/api/create-lp', '/api/resume-launch', '/api/reveal-sealed-metadata'].includes(nextEndpoint);
  const liquidity = checked(
    revealPending
      ? { state: 'todo', value: `${pools} locked · identity still sealed`, action: 'Reveal the identity' }
      : liquidityComplete || (finishedRecord && mint)
        ? { state: 'done', value: practice ? `${pools} opened in test mode` : recordedPools ? `${recordedPools} pool${recordedPools === 1 ? '' : 's'} open · locked` : 'Pools open · locked', repair: 'Open and lock the rest' }
        : liquidityRunning
          ? { state: 'running', value: 'Being opened' }
          : !mint && !tokenComplete
            ? { state: 'todo', value: 'No pools yet', action: 'Open the pools' }
            : { state: 'todo', value: `${Math.min(recordedPools, poolCount)} of ${pools} open`, action: 'Open the pools' },
    'pools', 'locks', 'reveal',
  );

  const sweepRunning = running && nextEndpoint === '/api/transfer-assets';
  const wallet = checked(
    practice
      ? { state: 'done', value: 'Not needed in test mode' }
      : sweepComplete || finishedRecord
        ? { state: 'done', value: 'Empty · assets returned', repair: 'Sweep the launch wallet' }
        : sweepRunning
          ? { state: 'running', value: 'Being swept' }
          : { state: 'todo', value: balanceKnown ? `Holds ${sol(funding.availableSol)}` : 'Balance not checked', action: 'Sweep the launch wallet' },
    'return',
  );

  return [
    { id: 'wallet', ...signer },
    { id: 'configure', ...plan },
    { id: 'fund', ...fund },
    { id: 'mint', ...token },
    { id: 'liquidity', ...liquidity },
    { id: 'finish', ...wallet },
  ];
}

// The row that needs doing: happening now, or the first that doesn't hold.
function nextCoinFact(facts = coinFacts()) {
  return facts.find((fact) => fact.state === 'running')
    || facts.find((fact) => ['todo', 'mismatch'].includes(fact.state))
    || null;
}

// Read a live mint's creation steps from the chain once per change in what
// the launch record says, not on every render: each read costs RPC calls.
function refreshLaunchChainCheck(facts) {
  const proof = currentLaunchProof();
  const mint = proofTokenMint(proof);
  if (!mint || state.demoActive || isDemoLaunchProof(proof) || state.apiStatus !== 'connected' || !state.apiClient?.getCoin) return;
  const key = `${mint}:${facts.map((fact) => `${fact.id}=${fact.state === 'mismatch' || fact.state === 'recorded' ? 'done' : fact.state}`).join(',')}`;
  if (state.launchChainCheckKey === key) return;
  state.launchChainCheckKey = key;
  state.apiClient.getCoin(mint)
    .then((response) => {
      if (proofTokenMint(currentLaunchProof()) !== mint) return;
      state.launchChainCheck = { mint, steps: response?.coin?.creation?.steps || [] };
      renderLaunchWorkspace();
    })
    .catch(() => null);
}

function renderLaunchWorkspace() {
  const facts = coinFacts();
  const next = nextCoinFact(facts);
  const previous = state.launchFactStates || {};
  const open = launchWorkspaces.some((item) => item.id === state.launchWorkspace) ? state.launchWorkspace : null;
  // The open row stays open while you look at it. When what it shows becomes
  // true, the row that needs doing opens instead: that is the only "next".
  const openFact = facts.find((fact) => fact.id === open);
  const openJustHeld = openFact && previous[open] && previous[open] !== openFact.state && ['done', 'recorded'].includes(openFact.state);
  const workspace = !open || openJustHeld ? (next?.id || open || 'finish') : open;
  state.launchWorkspace = workspace;
  state.launchFactStates = Object.fromEntries(facts.map((fact) => [fact.id, fact.state]));
  document.body.dataset.launchWorkspace = workspace;

  for (const fact of facts) {
    const button = $(`.coin-fact[data-coin-fact="${fact.id}"]`);
    if (!button) continue;
    const mark = COIN_FACT_MARKS[fact.state] || COIN_FACT_MARKS.todo;
    const selected = fact.id === workspace;
    button.className = `coin-fact is-${fact.state}${selected ? ' is-selected' : ''}${next?.id === fact.id ? ' is-next' : ''}`;
    button.setAttribute('aria-pressed', selected ? 'true' : 'false');
    const icon = button.querySelector('.coin-fact-mark');
    if (icon) icon.className = `fa-solid ${mark.icon} coin-fact-mark`;
    const value = button.querySelector('[data-coin-fact-value]');
    if (value) value.textContent = fact.value || '';
    button.title = mark.label;
  }
  // The one action the coin's state asks for, offered wherever it isn't already open.
  $$('[data-next-fact]').forEach((button) => {
    const show = Boolean(next && next.action && next.id !== workspace && next.state !== 'running');
    button.hidden = !show;
    if (!show) return;
    button.dataset.launchWorkspace = next.id;
    button.innerHTML = `<span>${escapeHtml(next.action)}</span><i class="fa-solid fa-arrow-right" aria-hidden="true"></i>`;
  });
  $$('[data-launch-pane]').forEach((panel) => {
    const workspaces = String(panel.dataset.launchPane || '').split(/\s+/).filter(Boolean);
    const active = workspaces.includes(workspace);
    panel.hidden = !active;
    panel.classList.toggle('is-active-launch-pane', active);
  });
  $$('[data-classic-workspace]').forEach((panel) => {
    panel.hidden = panel.dataset.classicWorkspace !== workspace;
  });

  renderVortexControl();
  const selectedWorkspace = launchWorkspaces.find((item) => item.id === workspace);
  const viewport = $('#launchWorkspaceViewport');
  if (viewport && selectedWorkspace) {
    viewport.setAttribute('aria-label', `${selectedWorkspace.title}: ${selectedWorkspace.detail}`);
  }
  refreshLaunchChainCheck(facts);
}

// Open a row. Which row is open is a view, never saved and never progress.
function setLaunchWorkspace(workspace, { focus = false } = {}) {
  if (!launchWorkspaces.some((item) => item.id === workspace)) return;
  const changed = state.launchWorkspace !== workspace;
  state.launchWorkspace = workspace;
  renderLaunchWorkspace();
  renderLaunchIdentity();
  // A different row opens at its top. Re-selecting the open row (e.g. Grind
  // on Token & pools) must not move the screen.
  if (changed) setViewScrollTop($('#view-launch'), 0);
  if (focus) {
    $(`.coin-fact[data-coin-fact="${workspace}"]`)?.focus();
  }
}

function renderGlobalStrip() {
  renderCustodySignal();
  // Stable hook for tests and tooling; the strip itself hides when healthy.
  document.body.dataset.apiStatus = state.apiStatus || 'unknown';
  const { pending, signed, total } = signatureStats();
  const apiLabel = state.apiStatus === 'loading' ? 'Starting…' : 'Open the Trebuchet desktop app to launch.';
  const recoveryWallets = recoveryWalletsNeedingAttention().length;
  // Only what needs attention; a healthy idle app shows no strip. The wallet
  // is in the top bar already.
  const metrics = [
    state.realExecutionRunning ? ['Launch', `${signed} of ${total} steps done`] : null,
    state.apiStatus === 'connected' ? null : ['App', apiLabel],
    state.recovery.activeJournalCount + recoveryWallets > 0
      ? ['Recovery', [
        state.recovery.activeJournalCount ? `${state.recovery.activeJournalCount} unfinished launch${state.recovery.activeJournalCount === 1 ? '' : 'es'}` : null,
        recoveryWallets ? `${recoveryWallets} old launch wallet${recoveryWallets === 1 ? '' : 's'}` : null,
      ].filter(Boolean).join(' · ')]
      : null,
  ].filter(Boolean);
  const strip = $('#globalStrip');
  strip.hidden = metrics.length === 0;
  strip.innerHTML = metrics.map(([label, value]) => `
    <span class="global-metric">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </span>
  `).join('');
}

function launchIdentityReducedMotion() {
  try {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
  } catch (_) {
    return false;
  }
}

function launchIdentityImageSrc(logo = state.tokenLogo, { animate = false } = {}) {
  if (!logo?.dataUrl) return '';
  if (logo.animated && (!animate || launchIdentityReducedMotion())) {
    return state.launchIdentity?.posterDataUrl || logo.dataUrl;
  }
  return logo.dataUrl;
}

function applyLaunchIdentityPalette(palette = null) {
  const style = document.body.style;
  const properties = [
    '--identity-primary',
    '--identity-primary-rgb',
    '--identity-accent',
    '--identity-accent-rgb',
    '--identity-contrast',
  ];
  if (!palette?.primary || !palette?.accent) {
    properties.forEach((property) => style.removeProperty(property));
    return;
  }
  style.setProperty('--identity-primary', palette.primaryHex || launchIdentityRgbHex(palette.primary));
  style.setProperty('--identity-primary-rgb', palette.primary.join(' '));
  style.setProperty('--identity-accent', palette.accentHex || launchIdentityRgbHex(palette.accent));
  style.setProperty('--identity-accent-rgb', palette.accent.join(' '));
  style.setProperty('--identity-contrast', palette.contrast || '#03100a');
}

function launchIdentityModel() {
  const config = currentLaunchConfig();
  const proof = currentLaunchProof();
  const logo = config.token.logo;
  const name = String(proof?.token?.name || config.token.name || '').trim() || 'Untitled token';
  const symbol = String(proof?.token?.symbol || config.token.symbol || 'TOK').trim().toUpperCase();
  const mint = String(
    proof?.token?.mint
    || state.lastDemoLaunchRun?.token?.tokenMint
    || state.lastDemoLaunchRun?.token?.mint
    || '',
  ).trim();
  const workspaceIndex = Math.max(0, launchWorkspaces.findIndex((item) => item.id === state.launchWorkspace));
  const sweepComplete = transferHasWalletEmptyFinalSweepEvidence(proof?.transfer);
  const liquidityComplete = Boolean(
    isReadinessPhaseComplete('liquidity')
    || proof?.liquidity?.lockedPositionCount > 0
    || state.lastDemoLaunchRun?.liquidity?.success,
  );
  const tokenComplete = Boolean(mint || isReadinessPhaseComplete('token'));
  const status = sweepComplete
    ? state.demoActive ? 'Test launch complete' : 'Launch complete'
    : liquidityComplete
      ? 'Liquidity locked'
      : tokenComplete
        ? 'Token minted'
        : state.launchPlan
          ? 'Run armed'
          : logo
            ? 'Identity attached'
            : 'Awaiting identity';
  const phase = launchWorkspaces[workspaceIndex] || launchWorkspaces[0];
  return { config, proof, logo, name, symbol, mint, status, phase, workspaceIndex };
}

function launchOperationIsActive() {
  const lpStatus = String(state.liveOps.lp?.status || '').toLowerCase();
  const airdropStatus = String(state.liveOps.airdrop?.status || '').toLowerCase();
  return Boolean(
    state.fullRunRunning
    || state.realExecutionRunning
    || state.demoLaunchRunning
    || state.reportPublishing
    || state.airdropRunning
    || state.quoteAcquire.running
    || state.executionChecking
    || ['running', 'active'].includes(lpStatus)
    || ['running', 'active'].includes(airdropStatus)
  );
}

function renderLiveLaunchMonitor() {
  const monitor = $('#liveLaunchMonitor');
  if (!monitor) return;
  const active = state.activeView === 'launch'
    && launchOperationIsActive();
  if (!active) {
    monitor.hidden = true;
    monitor.innerHTML = '';
    document.body.dataset.launchFocus = 'idle';
    state.launchDetailsExpanded = false;
    return;
  }

  const context = runProgressContext();
  const model = launchIdentityModel();
  const activeRow = context.rows.find((row) => row.id === context.activeId)
    || context.rows.find((row) => row.state !== 'signed')
    || context.rows[context.rows.length - 1]
    || null;
  const blocked = activeRow?.state === 'blocked';
  const currentAction = String(
    state.fullRunStep
    || activeRow?.label
    || context.headingLabel
    || 'Advancing launch',
  ).trim();
  const currentDetail = String(
    activeRow?.effects?.[0]
    || (blocked ? 'Trebuchet needs your attention before it can continue.' : 'Trebuchet is recording each confirmed launch checkpoint.'),
  ).trim();
  const logoSrc = launchIdentityImageSrc(model.logo, { animate: true });
  // What exists so far, as facts: the same rows the coin shows, not a percentage.
  const chainFacts = coinFacts().filter((fact) => ['mint', 'liquidity', 'finish'].includes(fact.id));
  const factLabels = { mint: 'Token', liquidity: 'Liquidity', finish: 'Launch wallet' };
  const expanded = state.launchDetailsExpanded === true;
  document.body.dataset.launchFocus = expanded ? 'details' : 'active';
  monitor.hidden = false;
  monitor.className = `live-launch-monitor ${blocked ? 'is-blocked' : 'is-running'}`;
  monitor.innerHTML = `
    <div class="live-launch-token">
      ${logoSrc
    ? `<span class="live-launch-coin"><img src="${escapeHtml(logoSrc)}" alt="${escapeHtml(`${model.name} logo`)}"></span>`
    : '<span class="live-launch-coin is-placeholder" aria-hidden="true"><i class="fa-solid fa-coins"></i></span>'}
      <span>
        <small>${blocked ? 'Launch needs attention' : 'Live launch'}</small>
        <strong>${escapeHtml(model.name)} <em>$${escapeHtml(model.symbol)}</em></strong>
      </span>
    </div>
    <div class="live-launch-now">
      <span class="live-launch-pulse" aria-hidden="true"></span>
      <span>
        <small>${blocked ? 'Stopped here' : 'Happening now'}</small>
        <strong>${escapeHtml(currentAction)}</strong>
        <em>${escapeHtml(currentDetail)}</em>
      </span>
    </div>
    <ul class="live-launch-facts" aria-label="What is true now">
      ${chainFacts.map((fact) => `<li class="is-${escapeHtml(fact.state)}">
        <i class="fa-solid ${(COIN_FACT_MARKS[fact.state] || COIN_FACT_MARKS.todo).icon}" aria-hidden="true"></i>
        <span><small>${escapeHtml(factLabels[fact.id])}</small><strong>${escapeHtml(fact.value || '')}</strong></span>
      </li>`).join('')}
    </ul>
    <button class="live-launch-details-button" type="button" data-action="toggle-launch-details" aria-expanded="${expanded}">
      <span>${expanded ? 'Focus on current action' : 'Show launch details'}</span>
      <i class="fa-solid fa-chevron-${expanded ? 'up' : 'down'}" aria-hidden="true"></i>
    </button>
  `;
}

// The coin being worked on, in the sidebar and the top bar: the same coin
// card as everywhere else, shown once the coin has a name or a logo.
function renderWorkingCoinCards(model = launchIdentityModel()) {
  const sidebar = $('#launchIdentitySidebar');
  const chip = $('#launchIdentityChip');
  const typedName = String($('#tokenName')?.value || '').trim();
  const typedSymbol = String($('#tokenSymbol')?.value || '').trim();
  const show = Boolean(typedName || typedSymbol || model.logo?.dataUrl || model.mint);
  const coin = {
    name: typedName || (model.mint ? model.name : ''),
    symbol: typedSymbol || (model.mint ? model.symbol : ''),
    address: model.mint || state.selectedVanityPublicKey || null,
    image: model.logo?.dataUrl ? launchIdentityImageSrc(model.logo, { animate: false }) : null,
  };
  [[sidebar, 'Working on'], [chip, '']].forEach(([element, status]) => {
    if (!element) return;
    element.hidden = !show;
    element.innerHTML = show ? coinCardHtml(coin, { variant: 'mini', tag: 'span', status }) : '';
    element.setAttribute('aria-label', show ? `Open ${coin.name || coin.symbol || 'the coin being worked on'}` : '');
  });
  if (show) hydrateCoinCards();
  renderCoinContext();
}

function renderLaunchIdentity() {
  const model = launchIdentityModel();
  const active = Boolean(model.logo?.dataUrl);
  const dock = $('#launchIdentityDock');
  const sidebar = $('#launchIdentitySidebar');
  const chip = $('#launchIdentityChip');
  document.body.dataset.launchIdentity = active ? 'active' : 'empty';
  renderWorkingCoinCards(model);
  if (!active) {
    applyLaunchIdentityPalette(null);
    if (dock) {
      dock.hidden = true;
      dock.innerHTML = '';
    }
    return;
  }

  const palette = state.launchIdentity?.palette || defaultLaunchIdentityArt().palette;
  applyLaunchIdentityPalette(palette);
  const heroSrc = launchIdentityImageSrc(model.logo, { animate: true });
  const stillSrc = launchIdentityImageSrc(model.logo, { animate: false });
  const animated = Boolean(model.logo.animated && !launchIdentityReducedMotion());
  const hero = false;
  const mintLabel = model.mint ? shortAddress(model.mint) : 'Mint address pending';
  const phaseDetail = `${model.phase.title} / ${model.status}`;

  // The sidebar card and header chip already show the token; the large dock
  // only appears on the first step, where the artwork is being set.
  if (dock && !hero) {
    dock.hidden = true;
    dock.innerHTML = '';
  } else if (dock) {
    dock.hidden = false;
    dock.className = `launch-identity-dock ${hero ? 'is-hero' : 'is-compact'} ${animated ? 'is-animated' : ''}`;
    dock.innerHTML = `
      <div class="launch-identity-visual">
        <span class="launch-identity-coin"><img src="${escapeHtml(heroSrc)}" alt="${escapeHtml(`${model.name} logo`)}"></span>
        ${animated ? '<span class="launch-identity-motion"><i class="fa-solid fa-wave-square"></i> Live artwork</span>' : ''}
      </div>
      <div class="launch-identity-copy">
        <span class="eyebrow">Working on</span>
        <h2>${escapeHtml(model.name)} <em>$${escapeHtml(model.symbol)}</em></h2>
        <p>${escapeHtml(phaseDetail)}</p>
        <div class="launch-identity-facts">
          <span><small>Identity</small><strong>${escapeHtml(model.status)}</strong></span>
          <span><small>Contract</small><strong>${escapeHtml(mintLabel)}</strong></span>
        </div>
      </div>
      <div class="launch-identity-palette" aria-label="Palette extracted from token artwork">
        <span class="identity-swatch identity-swatch-primary"></span>
        <span class="identity-swatch identity-swatch-accent"></span>
        <small>Palette from artwork</small>
      </div>
    `;
  }

}

function renderLaunchPreview() {
  const name = $('#tokenName').value.trim() || 'Untitled';
  const symbol = ($('#tokenSymbol').value.trim() || 'TOK').toUpperCase();
  const config = currentLaunchConfig();
  const liquidityBudgetSol = Math.max(
    0,
    parseNumericInput($('#liquidityBudgetSol')?.value, config.launchSol),
  );
  const logo = config.token.logo;
  $('#assetName').textContent = name;
  $('#assetSymbol').textContent = symbol;
  const assetMark = $('#assetMark');
  assetMark.classList.toggle('has-logo', Boolean(logo?.dataUrl));
  assetMark.innerHTML = logo?.dataUrl
    ? `<img src="${escapeHtml(launchIdentityImageSrc(logo, { animate: false }))}" alt="">`
    : escapeHtml(symbol.slice(0, 2));
  $('#launchName').textContent = `${name} token launch`;
  $('#launchStatus').textContent = state.transactions.length ? 'Staged' : state.simulated ? 'Simulated' : 'Draft';
  $('#launchStatus').className = `badge ${state.transactions.length ? 'warn' : ''}`;
  const poolCount = Math.max(0, Number(config.poolTopology?.pools?.length || 0));
  $('#setupSummary').textContent = `${symbol} / ${poolCount} pool${poolCount === 1 ? '' : 's'}`;
  $('#setupHelp').textContent = state.environmentReady
    ? practiceEnvironmentSelected()
      ? 'Test · nothing is sent'
      : 'Live · guarded on-chain launch'
    : 'Checking environment…';
  $('#runbookSummary').textContent = `${launchStages.length} phases`;
  $('#launchReadout').innerHTML = `
    <span><strong>${poolCount}</strong><small>Pool${poolCount === 1 ? '' : 's'}</small></span>
    <span><strong>${liquidityBudgetSol.toFixed(2)} SOL</strong><small>Liquidity budget</small></span>
  `;
}

const LOGO_STAMP_SKIP_REASONS = {
  'logo-too-small': 'Logo is too small to carry a readable CA.',
  'stamped-logo-too-large': 'Stamped logo would pass the upload limit; it launches unstamped.',
  'logo-format-unsupported': 'Only PNG, JPG and GIF logos can be stamped.',
  'logo-unreadable': 'Logo could not be decoded for stamping.',
};

// Ask the local server to stamp the logo the way the launch will. Keyed on the
// logo and the chosen CA so re-renders don't re-request.
async function refreshTokenLogoStamp() {
  const logo = state.tokenLogo;
  const mint = currentVanityConfig().selectedPublicKey || null;
  const key = logo?.dataUrl ? `${logo.sizeBytes}:${logo.dataUrl.length}:${logo.dataUrl.slice(-64)}:${mint || ''}` : null;
  if (!key || typeof state.apiClient?.previewLogoStamp !== 'function') {
    state.tokenLogoStamp = null;
    return;
  }
  if (state.tokenLogoStamp?.key === key) return;
  state.tokenLogoStamp = { key, pending: true };
  try {
    const preview = await state.apiClient.previewLogoStamp({ logo: logo.dataUrl, mint });
    if (state.tokenLogoStamp?.key !== key) return;
    state.tokenLogoStamp = { key, ...preview };
  } catch (error) {
    if (state.tokenLogoStamp?.key !== key) return;
    state.tokenLogoStamp = { key, stamped: false, reason: 'preview-unavailable' };
  }
  // Patch only the preview slots so a form being typed in keeps its focus.
  const markup = tokenLogoStampMarkup();
  document.querySelectorAll('[data-logo-stamp-slot]').forEach((slot) => { slot.innerHTML = markup; });
}

function tokenLogoStampMarkup() {
  const stamp = state.tokenLogoStamp;
  if (!state.tokenLogo || !stamp || stamp.pending) return '';
  if (!stamp.stamped) {
    const reason = LOGO_STAMP_SKIP_REASONS[stamp.reason] || 'CA stamp preview unavailable.';
    return `<p class="token-logo-stamp-note">${escapeHtml(reason)}</p>`;
  }
  // Before the address exists the preview can only show a made-up one,
  // which reads as a broken logo; say what will happen instead.
  if (stamp.sample) {
    return '<p class="token-logo-stamp-note">The contract address is printed along the bottom of the logo at launch.</p>';
  }
  const caption = `Printed on the logo: ${fullAddress(stamp.mint)}`;
  return `
    <figure class="token-logo-stamp-preview">
      <img src="${escapeHtml(stamp.dataUrl)}" alt="Logo with the contract address stamped along the bottom">
      <figcaption>${escapeHtml(caption)}</figcaption>
    </figure>
  `;
}

function renderTokenLogoPreview() {
  const target = $('#tokenLogoPreview');
  const logo = state.tokenLogo;
  const error = state.tokenLogoError;
  void refreshTokenLogoStamp();
  target.className = `token-logo-preview ${logo ? 'has-logo' : ''} ${error ? 'danger' : ''}`;
  target.hidden = !logo && !error;
  target.innerHTML = `
    <span class="token-logo-thumb">
      ${logo?.dataUrl ? `<img src="${escapeHtml(launchIdentityImageSrc(logo, { animate: false }))}" alt="">` : '<i class="fa-solid fa-image"></i>'}
    </span>
    <span>
      <small>${escapeHtml(error ? 'Logo rejected' : 'Logo')}</small>
      <strong>${escapeHtml(error || logoSummary(logo))}</strong>
    </span>
    ${logo || error ? '<button class="pill-button" type="button" data-action="clear-token-logo">Clear</button>' : ''}
    <div class="token-logo-stamp-slot" data-logo-stamp-slot>${tokenLogoStampMarkup()}</div>
  `;
}

function fundingMeterSnapshot(config = currentLaunchConfig()) {
  const launchSol = Number.isFinite(config.launchSol) ? config.launchSol : 0;
  const detailedBalance = selectedWalletDetailedBalance();
  const walletSol = Number(detailedBalance?.balance?.sol);
  const walletBalanceFresh = Boolean(detailedBalance?.fresh);
  const walletBalanceStale = Boolean(detailedBalance?.stale);
  const hasWalletBalance = walletBalanceFresh && Number.isFinite(walletSol) && state.apiStatus === 'connected';
  const availableSol = hasWalletBalance ? walletSol : launchSol;
  const fundingEstimateStatus = classicFundingEstimateStatus(config);
  const estimate = window.TrebuchetV2RuntimeState?.fundingEstimate({
    estimateMatches: fundingEstimateStatus.matchesConfig,
    estimatedSol: state.classicFundingEstimate?.totalSol,
  }) || { available: false, value: null, label: 'Estimate required' };
  const estimatedCost = estimate.value;
  const missingSol = estimate.available ? Math.max(0, estimatedCost - availableSol) : null;
  const routes = quoteAcquireRoutes();
  const quoteStatus = quoteAcquireStatus(config);
  const acquire = quoteStatus.progress;
  const routeTotal = Math.max(acquire.total, routes.length);
  const jobResults = Array.isArray(state.quoteAcquire.job?.results) ? state.quoteAcquire.job.results : [];
  const acquiredCount = jobResults.filter((result) => result && result.success !== false).length;
  const failedCount = jobResults.filter((result) => result && result.success === false).length;
  const manualItems = quoteManualPrefundItems();
  const manual = manualPrefundSummary(manualItems);
  const observedSpend = observedExecutionSpendSummary();
  const observedLabel = observedSpend.measuredCount
    ? `${fmtSol(observedSpend.outflowSol)} spent${observedSpend.inflowSol > 0 ? ` / ${fmtSol(observedSpend.inflowSol)} in` : ''}`
    : observedSpend.errorCount
      ? 'Unavailable'
      : 'Waiting';
  const observedClass = observedSpend.measuredCount
    ? ''
    : observedSpend.errorCount ? 'warn' : '';

  const acquireLabel = state.quoteAcquire.job
    ? quoteStatus.stale
      ? 'Run again'
      : `${acquiredCount}/${routeTotal} acquired${failedCount ? ` / ${failedCount} failed` : ''}`
    : fundingEstimateStatus.stale
      ? 'Re-estimate'
      : fundingEstimateStatus.hasEstimate
        ? (routes.length
          ? `${routes.length} route${routes.length === 1 ? '' : 's'} ready`
          : 'None')
        : 'Estimate first';
  const acquireClass = failedCount || state.quoteAcquire.error
    ? 'danger'
    : fundingEstimateStatus.stale || quoteStatus.stale
      ? 'warn'
    : routes.length && (!state.quoteAcquire.job || acquiredCount < routeTotal)
      ? 'warn'
      : '';
  const manualLabel = manualItems.length
    ? `${manualItems.length} token${manualItems.length === 1 ? '' : 's'} / ${manual.label}`
    : 'None';
  const badge = !estimate.available
    ? { label: 'Estimate first', className: 'warn' }
    : state.quoteAcquire.error
    ? { label: 'Acquire error', className: 'danger' }
    : fundingEstimateStatus.matchesConfig && !hasWalletBalance
      ? { label: walletBalanceStale ? 'Stale balance' : 'Check wallet', className: 'warn' }
    : missingSol > 0.001
      ? { label: 'Needs SOL', className: 'warn' }
      : manual.className === 'danger'
        ? { label: 'Quote short', className: 'danger' }
        : manual.className === 'warn'
          ? { label: 'Check quote', className: 'warn' }
          : acquireClass === 'warn'
            ? { label: 'Acquire', className: 'warn' }
            : { label: 'Ready', className: '' };

  return {
    availableSol,
    availableLabel: hasWalletBalance ? 'In the wallet' : 'Budget',
    availableClass: fundingEstimateStatus.matchesConfig && !hasWalletBalance ? 'warn' : '',
    hasWalletBalance,
    walletBalanceFresh,
    walletBalanceStale,
    walletBalanceCheckedAt: detailedBalance?.checkedAt || null,
    estimateAvailable: estimate.available,
    estimateLabel: estimate.label,
    estimatedCost,
    fundedPercent: estimate.available && estimatedCost > 0 ? clampPercent((availableSol / estimatedCost) * 100) : 0,
    missingSol,
    missingClass: estimate.available && missingSol > 0.001 ? 'warn' : '',
    acquireLabel,
    acquireClass,
    manualLabel,
    manualClass: manualItems.length ? manual.className : '',
    observedSpend,
    observedLabel,
    observedClass,
    badge,
  };
}

function selectedWalletDetailedBalance() {
  const snapshot = manualPrefundBalanceSnapshotStatus();
  if (!snapshot.matchesWallet || !snapshot.hasBalance) return null;
  return {
    walletPublicKey: snapshot.walletPublicKey,
    balance: snapshot.balance,
    checkedAt: snapshot.checkedAt,
    ageMs: snapshot.ageMs,
    fresh: snapshot.fresh,
    stale: snapshot.stale,
  };
}

function balanceContainsControlledFunds(balance) {
  if (!balance || typeof balance !== 'object') return false;
  if (Number(balance.sol) > 0.000001) return true;
  const tokens = balance.tokens && typeof balance.tokens === 'object'
    ? Object.values(balance.tokens)
    : [];
  return tokens.some((token) => {
    if (Number(token?.amountUi) > 0) return true;
    return (parseRawTokenAmount(token?.amountRaw) || 0n) > 0n;
  });
}

function custodySignalState() {
  if (!state.environmentReady) {
    return {
      id: 'loading',
      label: 'Checking…',
      detail: 'Loading test or live mode.',
    };
  }
  if (practiceEnvironmentSelected()) {
    return {
      id: 'practice',
      label: 'Test mode',
      detail: 'Nothing is sent and no SOL is spent.',
    };
  }
  const detailedBalance = selectedWalletDetailedBalance();
  const managedWallet = selectedManagedWallet();
  const hasFunds = balanceContainsControlledFunds(detailedBalance?.balance)
    || Number(managedWallet?.balanceSol) > 0.000001;
  return hasFunds
    ? {
      id: 'funded',
      label: 'Live · funds in launch wallet',
      detail: 'The launch wallet holds funds, and Trebuchet can spend them.',
    }
    : {
      id: 'live',
      label: managedWallet ? 'Live · waiting for funds' : 'Live · no wallet',
      detail: 'Live mode. The launch wallet holds no funds yet.',
    };
}

function renderCustodySignal() {
  const signal = custodySignalState();
  document.body.dataset.custodySignal = signal.id;
  const label = $('#custodySignalLabel');
  if (label) {
    label.textContent = signal.label;
    label.title = signal.detail;
  }
  if ($('#networkLabel')) $('#networkLabel').textContent = authoritativeNetworkLabel();
  return signal;
}

function liquidityDepthRows(topology) {
  return topology.pools.map((pool, poolIndex) => {
    const events = state.liveOps.lpEvents.filter((event) => Number(event?.allocationIndex) === poolIndex);
    const ladderCount = poolLadderCount(pool);
    const supportCount = pool.support?.mode === 'custom' ? 1 : 0;
    const mainCount = pool.distribution?.length || 1;
    const expectedOpen = 1 + mainCount + ladderCount + supportCount;
    const expectedLock = mainCount + ladderCount + supportCount;
    const opened = events.filter((event) => /_open_done$|pool_create_done/.test(String(event.stage || ''))).length;
    const locked = events.filter((event) => /_lock_done$|fee_key_transfer_done/.test(String(event.stage || ''))).length;
    const complete = expectedLock > 0 && locked >= expectedLock;
    const active = events.length > 0;
    const overlays = [
      `${formatPercent(pool.supplyPercent)}% supply`,
      `${opened}/${expectedOpen} open`,
      `${locked}/${expectedLock} lock`,
    ];
    if (ladderCount) overlays.push(`${ladderCount} ladder`);
    if (supportCount) overlays.push('support');
    return {
      label: pool.quoteSymbol || pool.quoteToken,
      width: clampPercent(pool.supplyPercent),
      value: `${formatPercent(pool.supplyPercent)}%`,
      detail: overlays.join(' / '),
      className: complete ? 'complete' : active ? 'active' : '',
    };
  });
}

const V2_TOKENOMICS_COLORS = ['#2f6f52', '#2e5f86', '#b5791f', '#6d568e', '#8f463f', '#557332', '#8a6330'];

function buildV2TokenomicsItems(config, results = []) {
  const topology = config?.poolTopology || {};
  const pools = Array.isArray(topology.pools) ? topology.pools : [];
  const items = pools.map((pool, index) => {
    const result = results.find((row) => Number(row?.allocationIndex) === index) || results[index] || null;
    return {
      label: `${result?.quoteSymbol || pool.quoteSymbol || pool.quoteToken || `Pool ${index + 1}`} pool`,
      percent: Number(result?.supplyPercent ?? pool.supplyPercent ?? 0),
      color: V2_TOKENOMICS_COLORS[index % V2_TOKENOMICS_COLORS.length],
    };
  }).filter((item) => item.percent > 0);
  const preallocationPercent = Number(topology.preallocation?.supplyPercent || 0);
  if (preallocationPercent > 0) items.push({ label: 'Prealloc', percent: preallocationPercent, color: '#7b5a3f' });
  const airdropPercent = Number(topology.airdrop?.supplyPercent || 0);
  if (airdropPercent > 0) items.push({ label: 'Airdrop', percent: airdropPercent, color: '#b8821a' });
  const reservePercent = Number(topology.reservePercent || 0);
  if (reservePercent > 0) items.push({ label: 'Unallocated reserve', percent: reservePercent, color: '#6b6657' });
  if (!items.length) items.push({ label: 'Supply not allocated yet', percent: 100, color: '#b8ad8a' });
  return items;
}

function v2DonutArcPath(cx, cy, rOuter, rInner, startA, endA) {
  if (Math.abs(endA - startA) < 1e-6) return '';
  const large = (endA - startA) > Math.PI ? 1 : 0;
  const x1 = cx + rOuter * Math.cos(startA);
  const y1 = cy + rOuter * Math.sin(startA);
  const x2 = cx + rOuter * Math.cos(endA);
  const y2 = cy + rOuter * Math.sin(endA);
  const x3 = cx + rInner * Math.cos(endA);
  const y3 = cy + rInner * Math.sin(endA);
  const x4 = cx + rInner * Math.cos(startA);
  const y4 = cy + rInner * Math.sin(startA);
  return [
    `M ${x1} ${y1}`,
    `A ${rOuter} ${rOuter} 0 ${large} 1 ${x2} ${y2}`,
    `L ${x3} ${y3}`,
    `A ${rInner} ${rInner} 0 ${large} 0 ${x4} ${y4}`,
    'Z',
  ].join(' ');
}

function renderV2TokenomicsDonutSvg(items, {
  size = 112,
  centerLabel = '',
  centerDetail = '',
  logoSrc = null,
} = {}) {
  const cx = size / 2;
  const cy = size / 2;
  const rOuter = size * 0.45;
  const rInner = size * 0.27;
  const total = items.reduce((sum, item) => sum + Math.max(0, Number(item.percent) || 0), 0);
  if (total <= 0) {
    return `<svg class="tokenomics-svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="No tokenomics configured">
      <text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="middle" fill="#9a9182" font-size="10">No split</text>
    </svg>`;
  }

  let startA = -Math.PI / 2;
  const segments = items.map((item) => {
    const share = Math.max(0, Number(item.percent) || 0);
    const sweep = (share / total) * (2 * Math.PI);
    const endA = startA + sweep;
    const path = v2DonutArcPath(cx, cy, rOuter, rInner, startA, endA);
    startA = endA;
    return `<path d="${path}" fill="${escapeHtml(item.color)}" stroke="#f7f1e3" stroke-width="${Math.max(1, size * 0.006)}">
      <title>${escapeHtml(`${item.label}: ${reportPercent(item.percent)} of supply`)}</title>
    </path>`;
  }).join('');

  const clipId = `v2-donut-logo-${size}`;
  const center = logoSrc
    ? `<defs><clipPath id="${clipId}"><circle cx="${cx}" cy="${cy}" r="${rInner - 2}"></circle></clipPath></defs>
      <circle cx="${cx}" cy="${cy}" r="${rInner}" fill="#f7f1e3" stroke="#c8bd9a" stroke-width="1"></circle>
      <image href="${escapeHtml(logoSrc)}" x="${cx - rInner + 2}" y="${cy - rInner + 2}" width="${(rInner - 2) * 2}" height="${(rInner - 2) * 2}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${clipId})"></image>`
    : `<circle cx="${cx}" cy="${cy}" r="${rInner}" fill="#f7f1e3" stroke="#c8bd9a" stroke-width="1"></circle>
      <text x="${cx}" y="${cy - (centerDetail ? 3 : 0)}" text-anchor="middle" dominant-baseline="middle" fill="#181613" font-size="${Math.max(11, size * 0.13)}" font-weight="700">${escapeHtml(centerLabel)}</text>
      ${centerDetail ? `<text x="${cx}" y="${cy + size * 0.12}" text-anchor="middle" dominant-baseline="middle" fill="#6f6658" font-size="${Math.max(6, size * 0.07)}" font-weight="700">${escapeHtml(centerDetail)}</text>` : ''}`;

  return `<svg class="tokenomics-svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="Tokenomics supply split">
    ${segments}
    ${center}
  </svg>`;
}

function chartEvidenceBadge({ proof = currentLaunchProof(), results = [], liveEventCount = 0 } = {}) {
  const hasLiquidityProof = Array.isArray(results) && results.length > 0;
  if (proof?.token?.mint && hasLiquidityProof) return { label: 'Proof', className: '' };
  if (liveEventCount > 0) return { label: 'Live', className: '' };
  if (localApiLaunchPlanStatus().ready) return { label: 'Model', className: 'warn' };
  return { label: 'Preview', className: 'warn' };
}

function setChartBadge(selector, badge) {
  const target = $(selector);
  target.textContent = badge.label;
  target.className = `risk-badge ${badge.className || ''}`;
}

function renderChartDeck() {
  const config = currentLaunchConfig();
  const topology = config.poolTopology;
  const supply = parseWholeNumber(config.token.supply) || 1000000000;
  const funding = fundingMeterSnapshot(config);
  const proof = currentLaunchProof();
  const results = Array.isArray(proof?.liquidity?.results) ? proof.liquidity.results : [];
  const liveLpEventCount = state.liveOps.lpEvents.length;
  const tokenomicsBadge = chartEvidenceBadge({ proof, results, liveEventCount: liveLpEventCount });
  const liquidityBadge = results.length
    ? { label: 'Proof', className: '' }
    : liveLpEventCount
      ? { label: 'Live', className: '' }
      : tokenomicsBadge;
  const identityPalette = state.launchIdentity?.palette;
  const slices = buildV2TokenomicsItems(config, results).map((item, index) => ({
    ...item,
    color: index === 0 && config.token.logo?.dataUrl
      ? identityPalette?.primaryHex || item.color
      : index === 1 && config.token.logo?.dataUrl
        ? identityPalette?.accentHex || item.color
        : item.color,
    value: clampPercent(item.percent),
    amount: supply * ((Number(item.percent) || 0) / 100),
  }));
  const placedPercent = clampPercent(slices.reduce((sum, item) => sum + (Number(item.percent) || 0), 0));
  const sliceCount = topology.pools.reduce((sum, pool) => sum + (pool.distribution?.length || 1), 0);
  const ladderCount = topology.pools.reduce((sum, pool) => {
    if (pool.ladder?.mode === 'manual') return sum + (pool.ladder.bands?.length || 0);
    if (pool.ladder?.mode === 'simple') return sum + Number(pool.ladder.bandCount || 0);
    return sum;
  }, 0);
  const supportSolTotal = topology.pools.reduce((sum, pool) => sum + Number(pool.support?.solValue || 0), 0);
  const bands = [
    ...liquidityDepthRows(topology),
    ['Locked positions', clampPercent(sliceCount * 16), String(sliceCount)],
    ['Extra bands', clampPercent(ladderCount * 12), ladderCount ? String(ladderCount) : 'none'],
    ['Buy support', clampPercent(supportSolTotal * 60), `${supportSolTotal.toFixed(2)} SOL`],
  ].slice(0, 5);

  $('#tokenomicsChart').classList.add('has-svg');
  setChartBadge('#tokenomicsState', tokenomicsBadge);
  $('#tokenomicsChart').innerHTML = renderV2TokenomicsDonutSvg(slices, {
    size: 112,
    centerLabel: `${Math.round(placedPercent)}%`,
    centerDetail: 'placed',
    logoSrc: config.token.logo?.dataUrl
      ? launchIdentityImageSrc(config.token.logo, { animate: false })
      : null,
  });
  $('#tokenomicsLegend').innerHTML = slices.map((item) => `
    <div class="legend-row">
      <span class="legend-dot" style="background:${item.color}"></span>
      <span>${escapeHtml(item.label)}</span>
      <strong>${item.value}% / ${compactAmount(item.amount)}</strong>
    </div>
  `).join('');

  setChartBadge('#liquidityState', liquidityBadge);
  $('#liquidityChart').innerHTML = bands.map((row) => {
    const item = Array.isArray(row)
      ? { label: row[0], width: row[1], value: row[2], detail: '', className: '' }
      : row;
    return `
    <div class="depth-band ${escapeHtml(item.className || '')}">
      <span>${escapeHtml(item.label)}</span>
      <span class="depth-bar"><span style="width:${clampPercent(item.width)}%"></span></span>
      <strong>${escapeHtml(item.value)}</strong>
      ${item.detail ? `<em>${escapeHtml(item.detail)}</em>` : ''}
    </div>
  `;
  }).join('');

  $('#fundingState').textContent = funding.badge.label;
  $('#fundingState').className = `risk-badge ${funding.badge.className}`;
  $('#fundingMeter').innerHTML = `
    <div class="funding-track" aria-label="Funding progress">
      <span style="width:${funding.fundedPercent}%"></span>
    </div>
    <div class="funding-row ${escapeHtml(funding.availableClass)}"><span>${escapeHtml(funding.availableLabel)}</span><strong>${funding.estimateAvailable ? `${funding.availableSol.toFixed(2)} / ${funding.estimatedCost.toFixed(2)} SOL` : `${funding.availableSol.toFixed(2)} SOL`}</strong></div>
    <div class="funding-row ${escapeHtml(funding.missingClass)}"><span>${funding.estimateAvailable ? 'Still needed' : 'Cost'}</span><strong>${funding.estimateAvailable ? `${funding.missingSol.toFixed(2)} SOL` : 'Not estimated yet'}</strong></div>
    <div class="funding-row ${escapeHtml(funding.acquireClass)}"><span>Pair tokens bought</span><strong>${escapeHtml(funding.acquireLabel)}</strong></div>
    <div class="funding-row ${escapeHtml(funding.manualClass)}"><span>Pair tokens to send</span><strong>${escapeHtml(funding.manualLabel)}</strong></div>
    <div class="funding-row ${escapeHtml(funding.observedClass)}"><span>Spent so far</span><strong>${escapeHtml(funding.observedLabel)}</strong></div>
  `;
}
