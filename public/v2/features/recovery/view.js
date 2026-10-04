function renderSecretPinResetAudit(reset) {
  if (!reset) return '';
  const removed = reset.removed || {};
  const wallets = Number(removed.pendingWallets || 0);
  const vanityCAs = Number(removed.vanityCAs || 0);
  return `
    <div class="recovery-reset-audit warn">
      <div class="recovery-sweep-head">
        <span>
          <span class="eyebrow">Recovery PIN reset audit</span>
          <strong>${escapeHtml(reportTimestamp(reset.at || new Date()))}</strong>
        </span>
        <span class="risk-badge warn">Discarded</span>
      </div>
      <p>PIN-encrypted local secrets were removed. This does not move on-chain assets; recover anything still funded only from an external backup.</p>
      <div class="recovery-sweep-grid">
        <span><small>Launch wallets</small><strong>${wallets}</strong></span>
        <span><small>Vanity CAs</small><strong>${vanityCAs}</strong></span>
        <span><small>PIN</small><strong>${escapeHtml(reset.status?.configured ? 'Reset' : 'Unset')}</strong></span>
      </div>
      <ul class="recovery-sweep-steps">
        <li>Do not discard journals that still point at a funded wallet unless you have the secret backed up elsewhere.</li>
        <li>Generate or import a new launch wallet before the next launch.</li>
      </ul>
    </div>
  `;
}

function renderRecoveryWalletWorkspace() {
  // Old launch wallets only: the one in use is on the Wallet page and is not
  // something to recover unless an unfinished launch left work on it.
  const wallets = recoveryWalletsNeedingAttention();
  const selectedPublicKey = selectedLaunchWalletPublicKey();
  const secretLocked = state.secretPin.locked;
  const busy = Boolean(state.fullRunRunning || state.realExecutionRunning);
  const lastSweep = state.lastRecoverySweep;

  $('#recoveryWalletWorkspace').innerHTML = `
    <div class="recovery-wallet-head">
      <span>
        <span class="eyebrow">Old launch wallets</span>
        <h3>${wallets.length ? `${wallets.length} may still hold assets` : 'None'}</h3>
        <p>${state.apiStatus !== 'connected'
          ? 'Open the Trebuchet desktop app to see old launch wallets.'
          : wallets.length
            ? 'Sweep what is left to your return wallet, or reveal the secret to recover it yourself.'
            : 'The launch wallet in use is on the Wallet page.'}</p>
      </span>
    </div>
    ${wallets.length ? `
      <div class="recovery-wallet-list">
        ${wallets.map((wallet) => {
          const walletState = recoveryWalletState(wallet);
          const isSelected = wallet.publicKey === selectedPublicKey;
          const revealAction = secretLocked || wallet.secretPinLocked ? 'unlock-secret-pin' : 'reveal-recovery-wallet';
          const revealLabel = secretLocked || wallet.secretPinLocked ? 'Unlock PIN' : 'Reveal';
          const discardBusy = state.discardingWalletPublicKey === wallet.publicKey;
          const sweepBusy = state.sweepingWalletPublicKey === wallet.publicKey;
          const coinMint = recoveryCoinMint((state.recovery.journals || []).find((journal) => journal.walletPublicKey === wallet.publicKey && !isTerminalJournal(journal)));
          const sweepAction = secretLocked || wallet.secretPinLocked ? 'unlock-secret-pin' : 'sweep-recovery-wallet';
          const sweepLabel = secretLocked || wallet.secretPinLocked ? 'Unlock PIN' : sweepBusy ? 'Sweeping' : 'Sweep';
          return `
            <article class="recovery-wallet-row ${isSelected ? 'is-selected' : ''}">
              <span class="ident" aria-hidden="true">${escapeHtml(shortAddress(wallet.publicKey).slice(0, 2))}</span>
              <span class="recovery-wallet-copy">
                <span class="eyebrow">${escapeHtml(formatDate(wallet.createdAt))}</span>
                <h3>${escapeHtml(fullAddress(wallet.publicKey))}</h3>
                <p>${escapeHtml(walletState.detail)}</p>
              </span>
              <span class="timeline-actions">
                <span class="risk-badge ${escapeHtml(walletState.className)}">${escapeHtml(walletState.label)}</span>
                <button class="pill-button" type="button" data-action="select-recovery-wallet" data-wallet="${escapeHtml(wallet.publicKey)}">${isSelected ? 'Selected' : 'Select'}</button>
                <button class="pill-button" type="button" data-action="copy-recovery-wallet" data-wallet="${escapeHtml(wallet.publicKey)}">
                  <i class="fa-solid fa-copy"></i><span>Copy</span>
                </button>
                <button class="pill-button" type="button" data-action="${escapeHtml(revealAction)}" data-wallet="${escapeHtml(wallet.publicKey)}" ${wallet.decryptionFailed ? 'disabled' : ''}>
                  <i class="fa-solid fa-key"></i><span>${escapeHtml(revealLabel)}</span>
                </button>
                ${coinMint ? `<button class="pill-button" type="button" data-action="open-coin-mint" data-mint="${escapeHtml(coinMint)}">
                  <i class="fa-solid fa-arrow-right"></i><span>Open coin</span>
                </button>` : `<button class="pill-button" type="button" data-action="use-recovery-wallet-for-launch" data-wallet="${escapeHtml(wallet.publicKey)}" ${wallet.decryptionFailed || busy ? 'disabled' : ''}>
                  <i class="fa-solid fa-check"></i><span>Use for launch</span>
                </button><button class="pill-button danger" type="button" data-action="${escapeHtml(sweepAction)}" data-wallet="${escapeHtml(wallet.publicKey)}" ${wallet.decryptionFailed || busy || sweepBusy ? 'disabled' : ''}>
                  <i class="fa-solid fa-broom"></i><span>${escapeHtml(sweepLabel)}</span>
                </button>`}
                <button class="pill-button" type="button" data-action="discard-recovery-wallet" data-wallet="${escapeHtml(wallet.publicKey)}" ${busy || discardBusy ? 'disabled' : ''}>
                  <i class="fa-solid fa-eye-slash"></i><span>${discardBusy ? 'Hiding' : 'Hide'}</span>
                </button>
              </span>
            </article>
          `;
        }).join('')}
      </div>
    ` : ''}
    ${renderSecretPinResetAudit(state.lastSecretPinReset)}
    ${renderRecoverySweepResult(lastSweep)}
  `;
}

function renderHistoryExecutionAudit() {
  const entries = Array.isArray(state.executionLedger) ? state.executionLedger : [];
  if (!entries.length) {
    return `
      <section class="history-audit-panel">
        <p class="history-empty">Nothing sent yet.</p>
      </section>
    `;
  }
  const attention = entries.filter((entry) => ['error', 'warn'].includes(entry.status)).length;
  const complete = entries.filter((entry) => entry.status === 'complete').length;
  const running = entries.filter((entry) => entry.status === 'running').length;
  const retries = entries.filter((entry) => Number(entry.attempt || 1) > 1).length;
  const observedSpend = observedExecutionSpendSummary(entries);
  const estimatedCost = entries.reduce((sum, entry) => {
    const value = Number(entry.estimatedCostSol || 0);
    return Number.isFinite(value) && value > 0 ? sum + value : sum;
  }, 0);
  const latest = entries[0];
  return `
    <section class="history-audit-panel ${attention ? 'warn' : ''}">
      <div class="history-audit-head">
        <span>
          <span class="eyebrow">Launch steps sent</span>
          <strong>${escapeHtml(latest?.label || 'Launch steps')}</strong>
          <em>${escapeHtml(latest?.detail || 'Steps sent from the launch wallet.')}</em>
        </span>
        <span class="history-audit-actions">
          <span class="risk-badge ${attention ? 'warn' : ''}">${attention ? `${attention} attention` : 'Clear'}</span>
          <button class="pill-button" type="button" data-action="clear-execution-audit">Clear</button>
        </span>
      </div>
      <div class="history-audit-stats">
        <span><small>Complete</small><strong>${complete}</strong></span>
        <span><small>Running</small><strong>${running}</strong></span>
        <span><small>Retries</small><strong>${retries}</strong></span>
        <span><small>${observedSpend.measuredCount ? 'Observed SOL' : 'Est. cost'}</small><strong>${observedSpend.measuredCount ? fmtSol(observedSpend.outflowSol) : estimatedCost ? fmtSol(estimatedCost) : 'Variable'}</strong></span>
      </div>
      <div class="history-audit-list">
        ${entries.slice(0, 5).map((entry) => `
          <article class="${escapeHtml(entry.status || '')}">
            <i class="fa-solid ${executionLedgerIcon(entry.status)}"></i>
            <span>
              <strong>${escapeHtml(entry.label || 'Classic operation')}</strong>
              <small>${escapeHtml([entry.phase || 'run', executionLedgerAttemptLabel(entry), formatLedgerCost(entry), formatLedgerDuration(entry)].filter(Boolean).join(' / '))}</small>
            </span>
          </article>
        `).join('')}
      </div>
    </section>
  `;
}

// Saved launch wallets that may still hold assets. The launch wallet in use
// is not something to recover unless an unfinished launch left work on it.
function recoveryWalletsNeedingAttention() {
  if (state.apiStatus !== 'connected') return [];
  const selectedPublicKey = selectedLaunchWalletPublicKey();
  const selectedHasOpenJournal = (state.recovery.journals || [])
    .some((journal) => !isTerminalJournal(journal) && journal.walletPublicKey === selectedPublicKey);
  return (state.recovery.pendingWallets || [])
    .filter((wallet) => wallet.publicKey !== selectedPublicKey || selectedHasOpenJournal);
}

// A launch lives on its coin page: that page shows what is left and runs it. Recovery only lists
// the launches that still need something and opens each one there. A launch whose token was never
// created has no coin yet, so it continues on the create page; a wallet with no launch record is
// handled on the Wallets tab.
function recoveryCoinMint(journal) {
  return journal?.token?.mint || journal?.poolPlan?.tokenMint || null;
}

function recoveryListModel() {
  const journals = (state.recovery.journals || []).filter((journal) => !isTerminalJournal(journal));
  const journalWallets = new Set(journals.map((journal) => journal.walletPublicKey));
  const looseWallets = recoveryWalletsNeedingAttention().filter((wallet) => !journalWallets.has(wallet.publicKey));
  return {
    launches: journals.map((journal) => ({ journal, mint: recoveryCoinMint(journal) })),
    looseWallets,
  };
}

function renderRecoveryList() {
  if (state.apiStatus !== 'connected') {
    return '<section class="recovery-wizard-panel warn" aria-label="Unfinished launches"><div class="recovery-wizard-head"><strong>Open the Trebuchet desktop app to see unfinished launches.</strong></div></section>';
  }
  const { launches, looseWallets } = recoveryListModel();
  if (!launches.length && !looseWallets.length) {
    return '<section class="recovery-wizard-panel pass" aria-label="Unfinished launches"><div class="recovery-wizard-head"><strong>Nothing to recover.</strong></div></section>';
  }
  const rows = launches.map(({ journal, mint }) => {
    const symbol = journal.token?.symbol || journal.launchConfig?.token?.symbol || shortAddress(journal.walletPublicKey);
    const button = mint
      ? `<button class="primary-button compact" type="button" data-action="open-coin-mint" data-mint="${escapeHtml(mint)}"><span>Open ${escapeHtml(symbol)}</span><i class="fa-solid fa-arrow-right"></i></button>`
      : canResumeJournal(journal)
        ? `<button class="primary-button compact" type="button" data-action="resume-journal" data-journal-id="${escapeHtml(journal.id)}" ${state.recoveryActionId === journal.id ? 'disabled' : ''}><span>Continue creating the token</span><i class="fa-solid fa-arrow-right"></i></button>`
        : '<span class="risk-badge danger">Manual recovery</span>';
    return `
      <article class="timeline-row ${stateClass(journal.status)}">
        <span>
          <span class="eyebrow">${escapeHtml(formatDate(journal.updatedAt || journal.createdAt))}</span>
          <h3>${escapeHtml(symbol)}</h3>
          <p>${escapeHtml(mint ? `Stopped at: ${humanizeStage(journal.stage)}.` : 'The token was not created yet.')}</p>
        </span>
        <span class="timeline-actions">${button}</span>
      </article>`;
  }).join('');
  const wallets = looseWallets.length ? `
      <article class="timeline-row">
        <span>
          <h3>${looseWallets.length} old launch wallet${looseWallets.length === 1 ? '' : 's'} with no launch record</h3>
          <p>${looseWallets.length === 1 ? 'It' : 'They'} may still hold assets.</p>
        </span>
        <span class="timeline-actions"><button class="pill-button" type="button" data-action="select-history-pane" data-history-pane="wallets">Open wallets</button></span>
      </article>` : '';
  return `
    <section class="recovery-wizard-panel warn" aria-label="Unfinished launches">
      <div class="recovery-wizard-head">
        <span><span class="eyebrow">Recovery</span><strong>${launches.length} unfinished launch${launches.length === 1 ? '' : 'es'}</strong></span>
      </div>
      <div class="recovery-list">${rows}${wallets}</div>
    </section>`;
}

function renderHistory() {
  const journalHistory = state.recovery.journals.map((journal) => ({
    id: journal.id,
    kind: 'journal',
    status: journal.status || 'journal',
    title: `${journal.token?.symbol || shortAddress(journal.walletPublicKey)} · ${journal.status || 'launch'}`,
    detail: `${humanizeStage(journal.stage)} for ${fullAddress(journal.walletPublicKey)}`,
    time: formatDate(journal.updatedAt || journal.createdAt),
    journal,
    resumePlan: journalResumePlan(journal),
  }));
  $('#recoveryWizard').innerHTML = renderRecoveryList();
  renderRecoveryWalletWorkspace();
  $('#historyExecutionAudit').innerHTML = renderHistoryExecutionAudit();
  // Launches only: the app's own connection state is not a launch.
  const items = state.apiStatus === 'connected'
    ? journalHistory.length
      ? journalHistory
      : [{ kind: 'summary', title: 'No launches yet', detail: 'Each launch you run is kept here, with where it stopped if it did not finish.', time: '' }]
    : history;

  $('#timeline').innerHTML = items.map((item) => `
    <article class="timeline-row ${item.status ? stateClass(item.status) : ''}">
      <span>
        <span class="eyebrow">${escapeHtml(item.time)}</span>
        <h3>${escapeHtml(item.title)}</h3>
        <p>${escapeHtml(item.detail)}</p>
      </span>
      ${item.kind === 'journal' ? `
        <span class="timeline-actions">
          <span class="risk-badge ${stateClass(item.status)}">${escapeHtml(item.status)}</span>
          ${!isTerminalJournal(item.journal) && recoveryCoinMint(item.journal)
            ? `<button class="pill-button" type="button" data-action="open-coin-mint" data-mint="${escapeHtml(recoveryCoinMint(item.journal))}">Open coin</button>`
            : canResumeJournal(item.journal) ? `<button class="pill-button" type="button" data-action="resume-journal" data-journal-id="${escapeHtml(item.id)}" ${state.recoveryActionId === item.id ? 'disabled' : ''}>${state.recoveryActionId === item.id ? 'Resuming' : 'Resume'}</button>` : ''}
          ${item.resumePlan?.manualRecoveryRequired ? '<span class="risk-badge danger">Manual recovery</span>' : ''}
          ${state.demoActive && !isTerminalJournal(item.journal) ? '<button class="pill-button" type="button" data-action="toggle-demo-mode">Switch to live</button>' : ''}
          ${canDismissJournal(item.journal) ? `<button class="pill-button" type="button" data-action="dismiss-journal" data-journal-id="${escapeHtml(item.id)}" ${state.recoveryActionId === item.id ? 'disabled' : ''}>Dismiss</button>` : ''}
        </span>
        <section class="journal-resume-plan ${stateClass(item.resumePlan?.state)}">
          <header class="journal-plan-head">
            <span class="risk-badge ${stateClass(item.resumePlan?.state)}">${escapeHtml(item.resumePlan?.badge || 'Plan')}</span>
            <strong>${escapeHtml(item.resumePlan?.title || 'Resume plan')}</strong>
          </header>
          <div>
            <p>${escapeHtml(item.resumePlan?.detail || '')}</p>
            <ul>
              ${(item.resumePlan?.items || []).slice(0, 2).map((row) => `<li>${escapeHtml(row)}</li>`).join('')}
            </ul>
          </div>
        </section>
      ` : ''}
    </article>
  `).join('');
  renderHistoryPanes();
}

function renderHistoryPanes() {
  const panes = ['recovery', 'wallets', 'audit', 'journal'];
  if (!panes.includes(state.activeHistoryPane)) state.activeHistoryPane = 'recovery';
  $$('[data-history-pane]').forEach((button) => {
    const selected = button.dataset.historyPane === state.activeHistoryPane;
    button.classList.toggle('is-selected', selected);
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
  });
  $$('[data-history-pane-panel]').forEach((panel) => {
    const selected = panel.dataset.historyPanePanel === state.activeHistoryPane;
    panel.classList.toggle('is-active', selected);
    panel.hidden = !selected;
  });
}
