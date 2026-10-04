function activityLogEntries() {
  const providerPattern = /tokenInfoService|GeckoTerminal|DexScreener|Jupiter|no USD price|HTTP 429/i;
  const technicalLogs = state.liveOps.logs.map((entry, index) => ({
    id: `log-${entry.seq || index}`,
    type: providerPattern.test(String(entry.msg || '')) ? 'technical' : 'log',
    level: String(entry.level || 'log').toLowerCase(),
    label: String(entry.level || 'log').toUpperCase(),
    message: entry.msg || '',
    time: entry.ts || null,
    seq: Number(entry.seq || 0),
  }));
  const providerNotices = technicalLogs.filter((entry) => entry.type === 'technical');
  const logs = technicalLogs.filter((entry) => entry.type !== 'technical');
  const dataHealth = providerNotices.length ? [{
    id: 'data-health-summary',
    type: 'data',
    level: 'notice',
    label: 'DATA HEALTH',
    message: `${providerNotices.length} market-data lookup${providerNotices.length === 1 ? '' : 's'} were rate-limited or unavailable. Token and chain facts remain usable; some prices may be missing.`,
    time: providerNotices[0]?.time || null,
    seq: Number.MAX_SAFE_INTEGER,
  }] : [];
  const progress = state.liveOps.lpEvents.map((event, index) => ({
    id: `progress-${index}-${event.stage || 'event'}`,
    type: 'progress',
    level: 'progress',
    label: 'PROGRESS',
    message: progressEventLabel(event),
    time: event.ts || null,
    seq: 0,
  }));
  const airdrops = state.liveOps.airdropSnapshots.map((entry, index) => ({
    id: `airdrop-${index}-${entry.key || entry.status || 'event'}`,
    type: 'airdrop',
    level: airdropProgressLevel(entry),
    label: 'AIRDROP',
    message: airdropProgressLogLabel(entry),
    time: entry.ts || entry.updatedAt || entry.startedAt || null,
    seq: 0,
  }));
  return [...logs, ...dataHealth, ...providerNotices, ...progress, ...airdrops]
    .sort((a, b) => {
      const timeA = Date.parse(a.time || '') || 0;
      const timeB = Date.parse(b.time || '') || 0;
      if (timeA !== timeB) return timeA - timeB;
      return a.seq - b.seq;
    })
    .slice(-80)
    .reverse();
}

function activityLogMatchesFilter(entry) {
  const filter = state.activityLog.filter || 'all';
  if (filter === 'all') return entry.type !== 'technical';
  if (filter === 'progress') return entry.type === 'progress';
  if (filter === 'airdrop') return entry.type === 'airdrop';
  if (filter === 'data') return entry.type === 'data';
  if (filter === 'technical') return entry.type === 'technical';
  if (filter === 'error') return entry.level === 'error';
  if (filter === 'log') return entry.type === 'log' && !['warn', 'warning', 'error'].includes(entry.level);
  return true;
}

function renderActivityLogDrawer() {
  const drawer = $('#activityLogDrawer');
  if (!drawer) return;
  const entries = activityLogEntries();
  const userEntries = entries.filter((entry) => entry.type !== 'technical');
  const logCount = entries.filter((entry) => entry.type === 'log' && !['warn', 'warning', 'error'].includes(entry.level)).length;
  const filters = [
    { id: 'all', label: 'Activity', count: userEntries.length },
    { id: 'progress', label: 'Progress', count: entries.filter((entry) => entry.type === 'progress').length },
    { id: 'airdrop', label: 'Airdrop', count: entries.filter((entry) => entry.type === 'airdrop').length },
    { id: 'log', label: 'Log', count: logCount },
    { id: 'data', label: 'Data health', count: entries.filter((entry) => entry.type === 'data').length },
    { id: 'error', label: 'Error', count: entries.filter((entry) => entry.level === 'error').length },
    { id: 'technical', label: 'Technical', count: entries.filter((entry) => entry.type === 'technical').length },
  ];
  const filteredEntries = entries.filter(activityLogMatchesFilter);

  drawer.classList.toggle('is-open', state.activityLog.open);
  drawer.setAttribute('aria-hidden', state.activityLog.open ? 'false' : 'true');
  drawer.inert = !state.activityLog.open;
  drawer.innerHTML = `
    <button class="activity-drawer-backdrop" type="button" data-action="close-activity-log" aria-label="Close activity log"></button>
    <section class="activity-drawer-panel" role="dialog" aria-modal="true" aria-label="Activity log">
      <header class="activity-drawer-head">
        <span>
          <span class="eyebrow">Activity log</span>
          <h3>${userEntries.length} activity event${userEntries.length === 1 ? '' : 's'}</h3>
        </span>
        <button class="icon-button" type="button" data-action="close-activity-log" aria-label="Close activity log">
          <i class="fa-solid fa-xmark"></i>
        </button>
      </header>
      <div class="activity-filter-tabs">
        ${filters.map((filter) => `
          <button type="button" class="${state.activityLog.filter === filter.id ? 'is-selected' : ''}" data-action="filter-activity-log" data-log-filter="${escapeHtml(filter.id)}">
            <span>${escapeHtml(filter.label)}</span>
            <strong>${filter.count}</strong>
          </button>
        `).join('')}
      </div>
      <div class="activity-log-list">
        ${filteredEntries.length ? filteredEntries.map((entry) => `
          <article class="${escapeHtml(entry.level)}">
            <span class="activity-log-meta">
              <strong>${escapeHtml(entry.label)}</strong>
              <small>${entry.time ? escapeHtml(formatDate(entry.time)) : 'live'}</small>
            </span>
            <p>${escapeHtml(entry.message)}</p>
          </article>
        `).join('') : `
          <article class="empty">
            <span class="activity-log-meta"><strong>EMPTY</strong><small>${escapeHtml(state.activityLog.filter)}</small></span>
            <p>No matching activity yet.</p>
          </article>
        `}
      </div>
    </section>
  `;
}

function renderLiveOpsPanel() {
  const panel = $('#liveOpsPanel');
  const walletPublicKey = selectedLaunchWalletPublicKey();
  const lp = state.liveOps.lp;
  const airdrop = state.liveOps.airdrop;
  const providerPattern = /tokenInfoService|GeckoTerminal|DexScreener|Jupiter|no USD price|HTTP 429/i;
  const providerNoticeCount = state.liveOps.logs.filter((entry) => providerPattern.test(String(entry.msg || ''))).length;
  const logs = state.liveOps.logs.filter((entry) => !providerPattern.test(String(entry.msg || ''))).slice(-5).reverse();
  const lpEvents = state.liveOps.lpEvents.slice(-4).reverse();
  const airdropEvents = state.liveOps.airdropSnapshots.slice(-3).reverse();
  const lpStatus = lp?.status || (state.apiStatus === 'connected' ? 'idle' : 'static');
  const airdropStatus = airdrop?.status || 'idle';
  const airdropTotal = Number(airdrop?.total || 0);
  const airdropDone = Number(airdrop?.completed || 0) + Number(airdrop?.failedCount || 0);

  panel.innerHTML = `
    <div class="live-ops-head">
      <span>
        <span class="eyebrow">Live operations</span>
        <h3>${walletPublicKey ? escapeHtml(fullAddress(walletPublicKey)) : 'No launch wallet'}</h3>
      </span>
      <span class="live-ops-actions">
        <span class="risk-badge ${state.liveOps.polling ? '' : 'warn'}">${state.liveOps.polling ? 'Polling' : state.apiStatus === 'connected' ? 'Ready' : 'Static'}</span>
        <button class="pill-button" type="button" data-action="open-activity-log">Activity</button>
      </span>
    </div>
    <div class="live-ops-grid">
      <span>
        <small>LP progress</small>
        <strong>${escapeHtml(lpStatus)}</strong>
        <em>${Number(lp?.totalEvents || state.liveOps.lpCursor || 0)} event${Number(lp?.totalEvents || state.liveOps.lpCursor || 0) === 1 ? '' : 's'}</em>
      </span>
      <span>
        <small>Airdrop</small>
        <strong>${escapeHtml(airdropStatus)}</strong>
        <em>${airdropTotal ? `${airdropDone}/${airdropTotal}` : 'no active run'}</em>
      </span>
      <span>
        <small>Data health</small>
        <strong>${providerNoticeCount ? 'Partial' : 'Ready'}</strong>
        <em>${providerNoticeCount ? `${providerNoticeCount} lookup notice${providerNoticeCount === 1 ? '' : 's'}` : state.liveOps.lastUpdatedAt ? `updated ${formatDate(state.liveOps.lastUpdatedAt)}` : 'waiting'}</em>
      </span>
    </div>
    <div class="live-ops-feed">
      ${lpEvents.length ? lpEvents.map((event) => `
        <article>
          <i class="fa-solid fa-circle-check"></i>
          <span>${escapeHtml(progressEventLabel(event))}</span>
        </article>
      `).join('') : '<article><i class="fa-solid fa-wave-square"></i><span>No LP progress events yet</span></article>'}
      ${airdropEvents.map((entry) => `
        <article class="${escapeHtml(airdropProgressLevel(entry))}">
          <i class="fa-solid fa-paper-plane"></i>
          <span>${escapeHtml(airdropProgressLogLabel(entry))}</span>
        </article>
      `).join('')}
      ${providerNoticeCount ? `<article class="notice"><i class="fa-solid fa-signal"></i><span>Some market prices are temporarily unavailable; launch-chain facts are unaffected.</span></article>` : ''}
      ${logs.length ? logs.map((entry) => `
        <article class="${escapeHtml(entry.level || '')}">
          <i class="fa-solid fa-terminal"></i>
          <span>${escapeHtml(entry.msg || '')}</span>
        </article>
      `).join('') : '<article><i class="fa-solid fa-terminal"></i><span>No backend log entries yet</span></article>'}
    </div>
  `;
  renderActivityLogDrawer();
}

function renderExecutionLedger() {
  const entries = Array.isArray(state.executionLedger) ? state.executionLedger : [];
  const rows = entries.length ? entries.slice(0, 4).map((entry) => `
    <article class="execution-ledger-row ${escapeHtml(entry.status || '')}">
      <span class="execution-ledger-icon">
        <i class="fa-solid ${executionLedgerIcon(entry.status)}"></i>
      </span>
      <span class="execution-ledger-copy">
        <strong>${escapeHtml(entry.label || 'Classic operation')}</strong>
        <small>${escapeHtml(entry.detail || entry.error || 'Guarded local-wallet execution.')}</small>
      </span>
      <span class="execution-ledger-meta">
        <strong>${escapeHtml([entry.phase || 'run', executionLedgerAttemptLabel(entry)].filter(Boolean).join(' / '))}</strong>
        <small>${escapeHtml(formatLedgerCost(entry))} / ${escapeHtml(formatLedgerDuration(entry))}</small>
      </span>
    </article>
  `).join('') : `
    <article class="execution-ledger-row idle">
      <span class="execution-ledger-icon">
        <i class="fa-solid fa-shield-halved"></i>
      </span>
      <span class="execution-ledger-copy">
        <strong>No launch steps sent yet</strong>
        <small>Each step of a live launch shows here with how it ended and the SOL it used.</small>
      </span>
      <span class="execution-ledger-meta">
        <strong>live only</strong>
        <small>waiting</small>
      </span>
    </article>
  `;
  return `
    <section class="execution-ledger" aria-label="Execution ledger">
      <div class="execution-ledger-head">
        <span>
          <span class="eyebrow">Launch steps sent</span>
          <strong>${entries.length ? entries[0]?.status === 'running' ? 'A step is running' : 'Latest steps' : 'Nothing sent yet'}</strong>
        </span>
        <span>${entries.length} event${entries.length === 1 ? '' : 's'}</span>
      </div>
      <div class="execution-ledger-list">
        ${rows}
      </div>
    </section>
  `;
}

function renderSignaturePanel() {
  const context = runProgressContext();
  const { rows, activeId } = context;
  const activeTx = rows.find((tx) => tx.id === activeId) || rows[0];
  const panel = $('#signaturePanel');

  panel.classList.toggle('is-staged', state.transactions.length > 0 || context.isLive);
  panel.classList.toggle('is-live', context.isLive);
  panel.innerHTML = `
    <div class="signature-head">
      <span>
        <span class="eyebrow">${escapeHtml(context.headingLabel)}</span>
        <h2>${escapeHtml(activeTx?.label || 'Review run plan first')}</h2>
      </span>
      <span class="signature-source">${escapeHtml(context.source)}</span>
    </div>
    <div class="signature-focus">
      <span>
        <small>${escapeHtml(context.focusLabel)}</small>
        <p>${escapeHtml(activeTx?.effects?.[0] || 'Trebuchet will list the local-wallet run before you arm it.')}${pinUnlockButton(activeTx?.effects?.[0])}</p>
      </span>
    </div>
    ${renderExecutionLedger()}
  `;
}

function buildFieldRunbookContext(proof = currentLaunchProof(), config = currentLaunchConfig()) {
  config = proofConfigForFingerprint(proof, config);
  const audit = buildV2ReportParityAudit(proof, config);
  const retirementGate = buildClassicRetirementGate(proof, audit, config);
  const fieldVerification = buildV2FieldVerification({
    proof,
    config,
    audit,
    retirementGate,
  });
  const requirementsById = new Map((Array.isArray(fieldVerification.requirements) ? fieldVerification.requirements : [])
    .filter((item) => item?.id)
    .map((item) => [item.id, item]));
  const criteriaById = new Map((Array.isArray(fieldVerification.replacementCriteria) ? fieldVerification.replacementCriteria : [])
    .filter((item) => item?.id)
    .map((item) => [item.id, item]));
  return {
    audit,
    retirementGate,
    fieldVerification,
    requirementsById,
    criteriaById,
  };
}

function fieldRunbookStageChecks(stage = {}, context = buildFieldRunbookContext()) {
  const requirementChecks = (Array.isArray(stage.requirements) ? stage.requirements : [])
    .map((id) => context.requirementsById.get(id) || {
      id,
      label: id,
      pass: false,
      action: 'review-field-proof',
      detail: 'Field proof row is not available yet.',
    });
  const criterionChecks = (Array.isArray(stage.criteria) ? stage.criteria : [])
    .map((id) => context.criteriaById.get(id) || {
      id,
      label: id,
      pass: false,
      action: 'review-replacement-criterion',
      detail: 'Replacement-criteria row is not available yet.',
    });
  return [...requirementChecks, ...criterionChecks];
}

function buildFieldRunbookStages(context = buildFieldRunbookContext()) {
  const rows = launchStages.map((stage, index) => {
    const checks = fieldRunbookStageChecks(stage, context);
    const blockers = checks.filter((item) => item.pass !== true);
    const pass = checks.length > 0 && blockers.length === 0;
    const evidenceCount = checks.filter((item) => item.pass === true).length;
    const firstBlocker = blockers[0] || null;
    return {
      ...stage,
      index,
      pass,
      evidenceCount,
      checkCount: checks.length,
      blockers,
      firstBlocker,
      action: firstBlocker?.action || 'none',
      detail: firstBlocker?.detail || stage.detail,
    };
  });
  const firstBlockedIndex = rows.findIndex((stage) => !stage.pass);
  rows.forEach((stage) => {
    if (stage.pass) {
      stage.state = 'done';
      stage.stateClass = 'is-done';
      stage.badge = 'Proof';
      stage.detail = stage.detail || 'Field proof is attached.';
      return;
    }
    if (stage.index === firstBlockedIndex) {
      stage.state = 'active';
      stage.stateClass = stage.evidenceCount > 0 ? 'is-active is-warn' : 'is-active';
      stage.badge = stage.evidenceCount > 0 ? 'Review' : 'Active';
      return;
    }
    stage.state = 'queued';
    stage.stateClass = 'is-queued';
    stage.badge = 'Queued';
  });
  return rows;
}

function renderFieldRunbookSummary(context, rows) {
  const fieldVerification = context.fieldVerification || {};
  if (fieldVerification.ready) return 'Field parity ready';
  const criteriaBlockers = Number(fieldVerification.criteriaBlockerCount || 0);
  const blockerCount = Number(fieldVerification.blockerCount || 0) + criteriaBlockers;
  const nextAction = fieldVerification.nextAction || rows.find((stage) => !stage.pass)?.action || 'review-field-proof';
  return `${blockerCount} blocker${blockerCount === 1 ? '' : 's'} · ${nextAction}`;
}

function fieldRunbookActionControl(action = '', stage = {}) {
  const detail = stage.detail || stage.firstBlocker?.detail || 'Review the current field-verification blocker.';
  const fallback = (label, message = detail) => ({
    dataAction: 'inspect-runbook-blocker',
    label,
    message,
    disabled: false,
  });
  const walletPublicKey = selectedLaunchWalletPublicKey();
  const selectedWallet = selectedManagedWallet();
  const walletLocked = state.secretPin.locked === true || selectedWallet?.secretPinLocked === true;

  if (!action || action === 'none') return null;
  if (action === 'run-demo-launch') {
    return { dataAction: 'run-demo-launch', label: 'Run test launch', disabled: state.demoLaunchRunning === true };
  }
  if (action === 'generate-or-unlock-wallet') {
    if (walletPublicKey && walletLocked) return { dataAction: 'unlock-secret-pin', label: 'Unlock PIN' };
    return { dataAction: walletPublicKey ? 'import-wallet' : 'generate-wallet', label: walletPublicKey ? 'Import wallet' : 'Generate wallet' };
  }
  if (action === 'grind-or-select-vanity-ca') {
    return { dataAction: 'start-vanity', label: state.vanityRunning ? 'Cancel grind' : 'Grind CA', disabled: false };
  }
  if (['stage-launch-plan', 'fix-pool-topology'].includes(action)) {
    return { dataAction: 'review-plan', label: 'Stage plan' };
  }
  if (action === 'run-viewport-smoke') {
    return fallback('Smoke test', 'Run `npm run test:v2:viewport`, then reconnect the desktop app so Trebuchet can verify the proof hash.');
  }
  if (['run-funding-and-quote-checks', 'back-held-reserve'].includes(action)) {
    const fundingEstimateStatus = classicFundingEstimateStatus(currentLaunchConfig());
    if (!fundingEstimateStatus.matchesConfig) {
      return { dataAction: 'estimate-funding', label: fundingEstimateStatus.stale ? 'Re-estimate' : 'Estimate' };
    }
    const quoteStatus = quoteAcquireStatus(currentLaunchConfig());
    if (quoteAcquireRoutes().length && !quoteStatus.ready) {
      return { dataAction: state.quoteAcquire.running ? 'poll-quote-acquire' : 'start-quote-acquire', label: state.quoteAcquire.running ? 'Refresh quote' : 'Acquire quote' };
    }
    if (quoteManualPrefundItems().length) {
      return { dataAction: 'refresh-manual-prefund', label: 'Check prefund', disabled: state.manualPrefund.polling === true };
    }
    return { dataAction: 'check-readiness', label: 'Check' };
  }
  if (action === 'run-non-demo-v2-launch') {
    const canRunFull = state.apiStatus === 'connected'
      && !state.demoActive
      && state.executionReadiness?.status === 'ready'
      && state.executionReadiness?.nextEndpoint
      && !state.fullRunRunning
      && !state.realExecutionRunning;
    return canRunFull
      ? { dataAction: 'run-full-launch', label: 'Run live' }
      : { dataAction: 'check-readiness', label: state.executionChecking ? 'Checking' : 'Check', disabled: state.executionChecking === true };
  }
  if (['attach-terminal-report', 'publish-report-and-sweep'].includes(action)) {
    const proof = currentLaunchProof();
    const config = proofConfigForFingerprint(proof, currentLaunchConfig());
    const reportPublishEvidence = proofHasReportPublishEvidence(proof, config);
    const airdropStatus = airdropCompletionStatus(proof, config.poolTopology);
    const reportProofReady = reportPublishEvidence && airdropStatus.complete;
    if (proof?.canPublishReport && reportProofReady) return { dataAction: 'publish-v2-report', label: state.reportPublishing ? 'Publishing' : 'Publish', disabled: state.reportPublishing === true };
    return {
      dataAction: 'download-v2-dossier',
      label: 'Dossier',
      disabled: !airdropStatus.complete || !proofCanCreateLocalDossier(proof, config),
    };
  }
  if (action === 'compare-classic-artifact') {
    const comparisonInput = String(
      state.classicReportComparison?.input
      || document.querySelector('.classic-artifact-text')?.value
      || '',
    ).trim();
    if (!comparisonInput) return { dataAction: 'load-classic-artifact', label: 'Load artifact' };
    return { dataAction: 'compare-classic-artifact', label: 'Compare' };
  }
  if (action === 'load-or-resume-journal') {
    return { dataAction: 'inspect-recovery', label: 'Open coin' };
  }
  if (action === 'resolve-proof-audit') {
    return fallback('Audit', 'Open Diagnostics and resolve the missing proof-audit rows before retiring Classic.');
  }
  if (action === 'complete-replacement-criteria') {
    return fallback('Criteria', 'Complete every replacement-criteria chip before retiring Classic.');
  }
  return fallback('Review');
}

function renderStages() {
  const context = buildFieldRunbookContext();
  const rows = buildFieldRunbookStages(context);
  $('#runbookSummary').textContent = renderFieldRunbookSummary(context, rows);
  $('#stageList').innerHTML = rows.map((stage, index) => {
    const done = stage.pass;
    const active = !done && stage.state === 'active';
    const queued = !done && !active;
    const badgeClass = done ? '' : active && stage.evidenceCount > 0 ? 'warn' : active ? 'danger' : 'warn';
    const actionLine = done
      ? `${stage.evidenceCount}/${stage.checkCount} proof checks attached.`
      : active
        ? `Next: ${stage.action || 'review-field-proof'}`
        : `Waiting on ${stage.firstBlocker?.label || 'prior field proof'}.`;
    const control = active ? fieldRunbookActionControl(stage.action, stage) : null;
    const controlAttrs = control
      ? [
        `data-action="${escapeHtml(control.dataAction)}"`,
        control.message ? `data-message="${escapeHtml(control.message)}"` : '',
        control.disabled ? 'disabled' : '',
      ].filter(Boolean).join(' ')
      : '';
    return `
      <article class="stage-row ${stage.stateClass || ''}">
        <span class="stage-num">${done ? '<i class="fa-solid fa-check"></i>' : index + 1}</span>
        <span class="stage-copy">
          <h3>${escapeHtml(stage.title)}</h3>
          <p>${escapeHtml(stage.detail)}</p>
          <small class="stage-action">${escapeHtml(actionLine)}</small>
        </span>
        <span class="stage-status-stack">
          <span class="tx-state ${badgeClass}">${done ? 'Done' : active ? stage.badge : queued ? 'Queued' : stage.badge}</span>
          ${control ? `<button class="pill-button stage-control" type="button" ${controlAttrs}>${escapeHtml(control.label)}</button>` : ''}
        </span>
      </article>
    `;
  }).join('');
}

function renderQueue() {
  const context = runProgressContext();
  const { rows, total, signed, pending, percent, activeId, isLive } = context;
  const activeTx = rows.find((tx) => tx.id === activeId) || rows[0] || null;
  const pendingRows = state.transactions.length
    ? rows.filter((tx) => tx.state === 'pending')
    : isLive
      ? activeTx ? [activeTx] : []
      : rows.slice(0, 4);
  const planSource = state.launchPlan?.source === 'local-api' ? 'local API' : 'static';
  const queueTitle = state.transactions.length
    ? `${signed} / ${total} complete`
    : isLive
      ? activeTx?.state === 'blocked' ? 'Resolve blocker' : activeTx?.label || context.headingLabel
      : 'Review run plan';
  $('#queueTitle').textContent = queueTitle;
  $('#queueList').innerHTML = state.transactions.length
    ? `
      <div class="queue-progress">
        <span style="width:${percent}%"></span>
      </div>
      ${pendingRows.length ? pendingRows.slice(0, 1).map((tx) => `
        <article class="queue-row compact">
          <span class="queue-copy">
            <h3>Run envelope armed</h3>
            <p>Trebuchet will sign ${pending} queued operation${pending === 1 ? '' : 's'} from ${escapeHtml(account().name)}.</p>
          </span>
          <button class="secondary-button compact" type="button" data-action="review" data-tx="${escapeHtml(tx.id)}">
            <i class="fa-solid fa-shield-halved"></i>
            <span>Envelope</span>
          </button>
        </article>
      `).join('') : '<div class="empty-state">Run complete.</div>'}
      <div class="kv-row"><span>Plan source</span><strong>${escapeHtml(planSource)}</strong></div>
      <div class="next-hint">One armed run replaces per-transaction wallet prompts.</div>
    `
    : isLive ? `
      <div class="queue-progress">
        <span style="width:${percent}%"></span>
      </div>
      <div class="queue-row compact ${escapeHtml(activeTx?.state || '')}">
        <span class="queue-copy">
          <h3>${escapeHtml(activeTx?.state === 'blocked' ? 'Live checkpoint blocked' : context.focusLabel)}</h3>
          <p>${escapeHtml(activeTx?.effects?.[0] || 'Trebuchet is watching launch record and readiness evidence.')}${pinUnlockButton(activeTx?.effects?.[0])}</p>
        </span>
      </div>
      <div class="kv-row"><span>Source</span><strong>${escapeHtml(context.source)}</strong></div>
      <div class="kv-row"><span>Progress</span><strong>${signed}/${total}</strong></div>
      <div class="kv-row"><span>Next</span><strong>${escapeHtml(activeTx?.label || 'Review proof')}</strong></div>
      <div class="next-hint">Live evidence replaces repeated wallet prompts once Trebuchet controls the launch key.</div>
    `
    : `
      <div class="queue-progress">
        <span style="width:0%"></span>
      </div>
      <div class="queue-row compact">
        <span class="queue-copy">
          <h3>Fund first, run later</h3>
          <p>Trebuchet stages one decoded run envelope for its local launch wallet.</p>
        </span>
      </div>
      <div class="kv-row"><span>Mode</span><strong>${escapeHtml(state.launchMode)}</strong></div>
      <div class="kv-row"><span>Blockers</span><strong>${bootGuardrails().filter((item) => item.state === 'danger').length}</strong></div>
      <div class="kv-row"><span>Runtime</span><strong>${escapeHtml(state.apiStatus === 'connected' ? 'Local app' : 'Preview')}</strong></div>
    `;

  const stageButton = $('#stageButton');
  stageButton.disabled = state.staging;
  stageButton.querySelector('span').textContent = state.staging
    ? 'Reviewing'
    : state.transactions.length ? 'Review again' : 'Review run plan';
  if (pending === 0 && (state.transactions.length > 0 || isLive)) {
    $('#queueTitle').textContent = 'Complete';
  }
}
