function recoveryGuideModel({
  wallets = [],
  selectedPublicKey = null,
  selectedPending = false,
  recoverableCount = 0,
  secretLocked = false,
  lastSweep = null,
  busy = false,
} = {}) {
  const selectedWallet = wallets.find((wallet) => wallet.publicKey === selectedPublicKey) || null;
  const firstRecoverable = wallets.find((wallet) => !wallet.decryptionFailed) || null;
  if (state.apiStatus !== 'connected') {
    return {
      state: 'warn',
      badge: 'Local app',
      title: 'Open Trebuchet locally',
      detail: 'Recovery inventory, secret reveal, and abandoned-wallet sweep need the authenticated local app.',
      items: ['Open the OS X app, then return to History.', 'Do not discard local recovery files manually.'],
      actions: [],
    };
  }
  if (lastSweep?.error) {
    return {
      state: 'danger',
      badge: 'Retry',
      title: 'Sweep failed',
      detail: 'The recovery wallet was not cleared. Retry after checking PIN, destination, and RPC health.',
      items: recoverySweepNextSteps(lastSweep),
      actions: lastSweep.publicKey && !busy
        ? [{ label: 'Retry sweep', action: 'sweep-recovery-wallet', wallet: lastSweep.publicKey, danger: true }]
        : [],
    };
  }
  if (lastSweep?.partial || lastSweep?.stillPending) {
    return {
      state: 'warn',
      badge: 'Partial',
      title: 'Recovery still active',
      detail: 'Trebuchet kept the local recovery entry so you can retry instead of losing track of assets.',
      items: recoverySweepNextSteps(lastSweep),
      actions: lastSweep.publicKey && !busy
        ? [
          { label: 'Retry sweep', action: 'sweep-recovery-wallet', wallet: lastSweep.publicKey, danger: true },
          { label: 'Select wallet', action: 'select-recovery-wallet', wallet: lastSweep.publicKey },
        ]
        : [],
    };
  }
  if (secretLocked && recoverableCount > 0) {
    return {
      state: 'warn',
      badge: 'PIN',
      title: 'Unlock before recovery',
      detail: `${recoverableCount} recoverable launch wallet${recoverableCount === 1 ? '' : 's'} need the Recovery PIN before reveal or sweep.`,
      items: ['Unlock the Recovery PIN.', 'Select the wallet that matches the failed launch journal.', 'Sweep assets only after verifying the destination wallet.'],
      actions: [{ label: 'Unlock PIN', action: 'unlock-secret-pin' }],
    };
  }
  if (selectedWallet && selectedPending) {
    return {
      state: '',
      badge: 'Selected',
      title: 'Recover selected wallet',
      detail: 'Inspect, reveal for manual recovery, sweep stranded assets, or reuse this launch wallet for the next run.',
      items: ['Copy the address and compare it with the failed launch journal.', 'Use for launch makes it the launch wallet.', 'Reveal only if manual recovery is needed.', 'Sweep moves assets and clears the entry only after empty-wallet verification.'],
      actions: [
        { label: 'Use for launch', action: 'use-recovery-wallet-for-launch', wallet: selectedWallet.publicKey },
        { label: 'Reveal secret', action: selectedWallet.secretPinLocked ? 'unlock-secret-pin' : 'reveal-recovery-wallet', wallet: selectedWallet.publicKey },
        { label: 'Sweep wallet', action: selectedWallet.secretPinLocked ? 'unlock-secret-pin' : 'sweep-recovery-wallet', wallet: selectedWallet.publicKey, danger: true },
      ],
    };
  }
  if (firstRecoverable) {
    return {
      state: 'warn',
      badge: 'Select',
      title: 'Choose a recovery wallet',
      detail: `${wallets.length} pending launch wallet${wallets.length === 1 ? '' : 's'} are available. Select one to align it with a journal or manual cleanup path.`,
      items: ['Start with the wallet shown in the failed journal.', 'Use QR/copy for inspection before sweeping.', 'Discard only after assets are empty or backed up.'],
      actions: [{ label: 'Select first wallet', action: 'select-recovery-wallet', wallet: firstRecoverable.publicKey }],
    };
  }
  if (lastSweep && !lastSweep.error) {
    return {
      state: '',
      badge: 'Clean',
      title: 'Recovery cleanup recorded',
      detail: 'The last sweep cleared its local recovery entry.',
      items: recoverySweepNextSteps(lastSweep),
      actions: [],
    };
  }
  if (state.recovery.failedJournalCount > 0 || state.recovery.activeJournalCount > 0) {
    return {
      state: 'warn',
      badge: 'Journal',
      title: 'Review launch journals',
      detail: 'No pending wallet is selected, but recovery journals still need review.',
      items: ['Use the timeline resume plan below.', 'Unsafe partial pool states stay manual to avoid duplicate on-chain work.'],
      actions: [],
    };
  }
  return {
    state: '',
    badge: 'Clear',
    title: 'No recovery action needed',
    detail: 'No abandoned launch wallets are waiting for recovery or cleanup.',
    items: ['Keep reports and proof bundles with the launch notes.'],
    actions: [],
  };
}

function renderRecoveryGuide(model) {
  const actions = model.actions.map((action) => `
    <button class="pill-button ${action.danger ? 'danger' : ''}" type="button" data-action="${escapeHtml(action.action)}" ${action.wallet ? `data-wallet="${escapeHtml(action.wallet)}"` : ''}>
      ${escapeHtml(action.label)}
    </button>
  `).join('');
  return `
    <div class="recovery-guide ${escapeHtml(model.state)}">
      <div class="recovery-guide-head">
        <span>
          <span class="eyebrow">Recovery guide</span>
          <strong>${escapeHtml(model.title)}</strong>
          <em>${escapeHtml(model.detail)}</em>
        </span>
        <span class="risk-badge ${escapeHtml(model.state)}">${escapeHtml(model.badge)}</span>
      </div>
      <ul>${model.items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
      ${actions ? `<div class="operator-toolbar compact">${actions}</div>` : ''}
    </div>
  `;
}

function recoveryWizardActionButton(action) {
  const attrs = [
    `data-action="${escapeHtml(action.action)}"`,
    action.wallet ? `data-wallet="${escapeHtml(action.wallet)}"` : '',
    action.journalId ? `data-journal-id="${escapeHtml(action.journalId)}"` : '',
    action.step ? `data-step="${escapeHtml(action.step)}"` : '',
  ].filter(Boolean).join(' ');
  return `
    <button class="pill-button ${action.danger ? 'danger' : ''}" type="button" ${attrs} ${action.disabled ? 'disabled' : ''}>
      ${action.icon ? `<i class="fa-solid ${escapeHtml(action.icon)}"></i>` : ''}
      <span>${escapeHtml(action.label)}</span>
    </button>
  `;
}

function recoveryWizardModel({
  wallets = [],
  selectedPublicKey = null,
  selectedPending = false,
  recoverableCount = 0,
  secretLocked = false,
  lastSweep = null,
  busy = false,
} = {}) {
  const journals = state.apiStatus === 'connected' ? state.recovery.journals : [];
  const activeJournals = journals.filter((journal) => !isTerminalJournal(journal));
  const journalModels = activeJournals.map((journal) => ({
    journal,
    plan: journalResumePlan(journal),
    matchingWallet: wallets.find((wallet) => wallet.publicKey === journal.walletPublicKey) || null,
  }));
  const tokenFinishModels = journalModels.filter((item) => journalNeedsTokenFinish(item.journal));
  const manualModels = journalModels.filter((item) => item.plan.manualRecoveryRequired);
  const finishModels = journalModels.filter((item) => canContinueJournalToFinish(item.journal));
  const resumableModels = journalModels.filter((item) => canResumeJournal(item.journal));
  const selectedWallet = wallets.find((wallet) => wallet.publicKey === selectedPublicKey) || null;
  const selectedJournalModel = journalModels.find((item) => item.journal.walletPublicKey === selectedPublicKey)
    || tokenFinishModels[0]
    || finishModels[0]
    || manualModels[0]
    || resumableModels[0]
    || journalModels[0]
    || null;
  const firstRecoverable = wallets.find((wallet) => !wallet.decryptionFailed) || null;
  const hasDecryptionFailures = wallets.some((wallet) => wallet.decryptionFailed);

  const inventoryState = state.apiStatus !== 'connected'
    ? 'warn'
    : manualModels.length
      ? 'danger'
      : (activeJournals.length || wallets.length || lastSweep?.partial || lastSweep?.error)
        ? 'warn'
        : 'pass';
  const unlockState = state.apiStatus !== 'connected'
    ? 'warn'
    : recoverableCount === 0 && !hasDecryptionFailures
      ? 'pass'
      : hasDecryptionFailures
        ? 'danger'
        : !state.secretPin.configured
          ? 'danger'
          : secretLocked
            ? 'warn'
            : 'pass';
  const pathState = state.apiStatus !== 'connected'
    ? 'warn'
    : manualModels.length
      ? 'danger'
      : finishModels.length || resumableModels.length || selectedPending || wallets.length
        ? 'warn'
        : 'pass';
  const verifyState = lastSweep?.error
    ? 'danger'
    : lastSweep?.partial || lastSweep?.stillPending
      ? 'warn'
      : activeJournals.length || wallets.length
        ? 'warn'
        : 'pass';

  const inventoryActions = [];
  if (selectedJournalModel?.matchingWallet) {
    inventoryActions.push({
      label: 'Select matching wallet',
      action: 'select-recovery-wallet',
      wallet: selectedJournalModel.matchingWallet.publicKey,
      icon: 'fa-wallet',
    });
  }
  if (selectedJournalModel?.journal?.id && journalNeedsTokenFinish(selectedJournalModel.journal)) {
    inventoryActions.push({
      label: 'Open token recovery',
      action: 'open-token-recovery',
      journalId: selectedJournalModel.journal.id,
      icon: 'fa-rotate-right',
    });
  } else if (selectedJournalModel?.journal?.id && canContinueJournalToFinish(selectedJournalModel.journal)) {
    inventoryActions.push({
      label: 'Continue to Finish',
      action: 'continue-journal-finish',
      journalId: selectedJournalModel.journal.id,
      icon: 'fa-flag-checkered',
    });
  } else if (selectedJournalModel?.journal?.id && canResumeJournal(selectedJournalModel.journal)) {
    inventoryActions.push({
      label: 'Resume journal',
      action: 'resume-journal',
      journalId: selectedJournalModel.journal.id,
      icon: 'fa-rotate-right',
    });
  }

  const unlockActions = [];
  if (state.apiStatus !== 'connected') {
    unlockActions.push({ label: 'Retry local API', action: 'retry-local-api', icon: 'fa-rotate-right' });
  } else if (!state.secretPin.configured) {
    unlockActions.push({ label: 'Set Recovery PIN', action: 'setup-secret-pin', icon: 'fa-key' });
  } else if (secretLocked && recoverableCount > 0) {
    unlockActions.push({ label: 'Unlock PIN', action: 'unlock-secret-pin', icon: 'fa-lock-open' });
  } else if (selectedWallet && selectedPending) {
    unlockActions.push({
      label: 'Reveal selected wallet',
      action: selectedWallet.secretPinLocked ? 'unlock-secret-pin' : 'reveal-recovery-wallet',
      wallet: selectedWallet.publicKey,
      icon: 'fa-eye',
    });
  }

  const pathActions = [];
  if (tokenFinishModels[0]?.journal?.id) {
    pathActions.push({
      label: 'Continue token recovery',
      action: 'open-token-recovery',
      journalId: tokenFinishModels[0].journal.id,
      icon: 'fa-rotate-right',
    });
  } else if (finishModels[0]?.journal?.id) {
    pathActions.push({
      label: 'Continue to Finish',
      action: 'continue-journal-finish',
      journalId: finishModels[0].journal.id,
      icon: 'fa-flag-checkered',
    });
  } else if (manualModels[0]?.matchingWallet) {
    pathActions.push({
      label: 'Reveal for manual recovery',
      action: manualModels[0].matchingWallet.secretPinLocked || secretLocked ? 'unlock-secret-pin' : 'reveal-recovery-wallet',
      wallet: manualModels[0].matchingWallet.publicKey,
      danger: true,
      icon: 'fa-key',
    });
  } else if (resumableModels[0]?.journal?.id) {
    pathActions.push({
      label: 'Resume missing work',
      action: 'resume-journal',
      journalId: resumableModels[0].journal.id,
      icon: 'fa-rotate-right',
    });
  } else if (selectedWallet && selectedPending) {
    pathActions.push(
      { label: 'Use for launch', action: 'use-recovery-wallet-for-launch', wallet: selectedWallet.publicKey, icon: 'fa-check' },
      {
        label: 'Sweep wallet',
        action: selectedWallet.secretPinLocked || secretLocked ? 'unlock-secret-pin' : 'sweep-recovery-wallet',
        wallet: selectedWallet.publicKey,
        danger: true,
        icon: 'fa-broom',
      },
    );
  } else if (firstRecoverable) {
    pathActions.push({
      label: 'Select wallet',
      action: 'select-recovery-wallet',
      wallet: firstRecoverable.publicKey,
      icon: 'fa-wallet',
    });
  }

  const verifyActions = [];
  if ((lastSweep?.error || lastSweep?.partial || lastSweep?.stillPending) && lastSweep.publicKey && !busy) {
    verifyActions.push({
      label: 'Retry sweep',
      action: 'sweep-recovery-wallet',
      wallet: lastSweep.publicKey,
      danger: true,
      icon: 'fa-rotate-right',
    });
  }
  if (selectedJournalModel?.journal?.id && canDismissJournal(selectedJournalModel.journal)) {
    verifyActions.push({
      label: 'Dismiss journal',
      action: 'dismiss-journal',
      journalId: selectedJournalModel.journal.id,
      danger: true,
      icon: 'fa-box-archive',
    });
  }

  const screens = [
    {
      id: 'inventory',
      label: 'Find',
      title: inventoryState === 'pass' ? 'Nothing to recover' : 'Unfinished launches and old wallets',
      detail: state.apiStatus !== 'connected'
        ? 'History needs the desktop app to load journals and pending wallets.'
        : `${activeJournals.length} unfinished launch${activeJournals.length === 1 ? '' : 'es'} · ${wallets.length} old launch wallet${wallets.length === 1 ? '' : 's'}.`,
      state: inventoryState,
      stats: [
        ['Journals', activeJournals.length],
        ['Pending wallets', wallets.length],
        ['Manual blockers', manualModels.length],
      ],
      items: state.apiStatus !== 'connected'
        ? ['Open through the Trebuchet desktop app.', 'Keep recovery files in place until inventory loads.']
        : [
          selectedJournalModel ? `${selectedJournalModel.plan.title}: ${selectedJournalModel.plan.detail}` : 'No failed launch journal selected.',
          manualModels.length ? 'Manual recovery blockers are shown before automatic resume actions.' : 'Automatic resume is allowed only when prior checkpoints are safe.',
        ],
      actions: inventoryActions,
    },
    {
      id: 'unlock',
      label: 'Unlock',
      title: unlockState === 'pass' ? 'Wallets unlocked' : 'Unlock old launch wallets',
      detail: recoverableCount
        ? `${recoverableCount} old launch wallet${recoverableCount === 1 ? '' : 's'} can be swept or revealed with the Recovery PIN.`
        : hasDecryptionFailures
          ? 'Some local wallet metadata exists but cannot be decrypted on this machine.'
          : 'No pending wallet secrets are waiting.',
      state: unlockState,
      stats: [
        ['PIN', state.secretPin.configured ? secretLocked ? 'Locked' : 'Ready' : 'Unset'],
        ['Recoverable', recoverableCount],
        ['Secret errors', wallets.filter((wallet) => wallet.decryptionFailed).length],
      ],
      items: [
        state.secretPin.configured ? 'Recovery PIN gates reveal, sweep, and manual recovery actions.' : 'Set a Recovery PIN before storing new launch secrets.',
        hasDecryptionFailures ? 'Use an external backup for wallets this machine cannot decrypt.' : 'Reveal secrets only for manual recovery; prefer resume or sweep when available.',
      ],
      actions: unlockActions,
    },
    {
      id: 'path',
      label: 'Act',
      title: tokenFinishModels.length ? 'Finish the existing token' : manualModels.length ? 'Manual recovery required' : finishModels.length ? 'Continue to final sweep' : resumableModels.length ? 'Resume only missing work' : selectedPending ? 'Recover selected wallet' : 'Choose recovery path',
      detail: tokenFinishModels.length
        ? tokenFinishModels[0].plan.detail
        : manualModels.length
        ? manualModels[0].plan.detail
        : finishModels.length
          ? 'Liquidity is already recorded. Open Finish directly for report, airdrop, return wallet, and final sweep.'
        : resumableModels.length
          ? resumableModels[0].plan.detail
          : selectedPending
            ? 'Use, reveal, or sweep the selected pending launch wallet.'
            : 'Select a pending wallet or journal before acting.',
      state: pathState,
      stats: [
        ['Token finish', tokenFinishModels.length],
        ['Ready to finish', finishModels.length],
        ['Needs liquidity', resumableModels.length],
        ['Manual', manualModels.length],
      ],
      items: tokenFinishModels[0]?.plan.items || manualModels[0]?.plan.items || finishModels[0]?.plan.items || resumableModels[0]?.plan.items || [
        'Resume skips recorded on-chain work when journal checkpoints prove it is safe.',
        'Sweep stranded assets only after verifying the destination wallet.',
      ],
      actions: pathActions,
    },
    {
      id: 'verify',
      label: 'Verify',
      title: verifyState === 'pass' ? 'Recovery cleanup verified' : 'Verify cleanup state',
      detail: lastSweep
        ? lastSweep.error
          ? 'The last sweep failed and the wallet remains tracked.'
          : lastSweep.partial || lastSweep.stillPending
            ? 'The last sweep left assets or warnings; keep the recovery entry.'
            : 'The last sweep cleared its local recovery entry.'
        : activeJournals.length || wallets.length
          ? 'Recovery inventory still needs review before dismissal.'
          : 'No abandoned wallet or active launch journal remains.',
      state: verifyState,
      stats: [
        ['Last sweep', lastSweep ? lastSweep.error ? 'Failed' : lastSweep.partial || lastSweep.stillPending ? 'Partial' : 'Clean' : 'None'],
        ['Open journals', activeJournals.length],
        ['Wallet entries', wallets.length],
      ],
      items: lastSweep ? recoverySweepNextSteps(lastSweep) : [
        'Confirm destination balances externally after any sweep.',
        'Dismiss journals only after reports, proof, and assets are accounted for.',
      ],
      actions: verifyActions,
    },
  ];

  const active = screens.find((screen) => screen.state === 'danger' && screen.actions.length)
    || screens.find((screen) => screen.state === 'warn' && screen.actions.length)
    || screens.find((screen) => screen.state === 'danger')
    || screens.find((screen) => screen.state === 'warn')
    || screens[0];

  return {
    screens,
    active,
    headline: state.apiStatus !== 'connected'
      ? 'Open the Trebuchet desktop app to see recovery'
      : manualModels.length
      ? 'A launch needs manual recovery'
      : tokenFinishModels.length
        ? 'A token was left unfinished'
      : finishModels.length
        ? 'A launch is ready to finish'
      : resumableModels.length
        ? 'A launch can resume'
        : activeJournals.length || wallets.length
          ? 'Old launch wallets to check'
          : 'Nothing to recover',
  };
}

function renderRecoveryWizard(model) {
  if (!model?.screens?.length) return '';
  const active = model.active;
  const actions = active.actions.map(recoveryWizardActionButton).join('');
  const openCount = model.screens.filter((screen) => screen.state !== 'pass').length;
  if (active.state === 'pass' && openCount === 0 && !actions) {
    return `
      <section class="recovery-wizard-panel pass" aria-label="Recovery next action">
        <div class="recovery-wizard-head">
          <strong>Nothing to recover.</strong>
        </div>
      </section>
    `;
  }
  return `
    <section class="recovery-wizard-panel ${escapeHtml(active.state)}" aria-label="Recovery next action">
      <div class="recovery-wizard-head">
        <span>
          <span class="eyebrow">Recovery</span>
          <strong>${escapeHtml(model.headline)}</strong>
        </span>
        <span class="risk-badge ${escapeHtml(active.state === 'pass' ? '' : active.state)}">${escapeHtml(active.state === 'danger' ? 'Manual' : active.state === 'warn' ? 'Review' : 'Clear')}</span>
      </div>
      <div class="recovery-wizard-screen">
        <div class="recovery-next-action">
          <span class="eyebrow">Next action</span>
          <h3>${escapeHtml(active.title)}</h3>
          <p>${escapeHtml(active.detail)}</p>
        </div>
        ${actions ? `<div class="recovery-wizard-actions">${actions}</div>` : ''}
        <details class="recovery-wizard-details">
          <summary><span>Recovery details</span><strong>${openCount ? `${openCount} open` : 'All clear'}</strong></summary>
          <div class="recovery-wizard-stats">
            ${active.stats.map(([label, value]) => `<span><small>${escapeHtml(label)}</small><strong>${escapeHtml(value)}</strong></span>`).join('')}
          </div>
          <ul>${active.items.slice(0, 4).map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
          <div class="recovery-status-list" role="list" aria-label="Recovery status">
            ${model.screens.map((screen) => `
              <span role="listitem"><strong>${escapeHtml(screen.label)}</strong><em>${escapeHtml(screen.state === 'pass' ? 'Clear' : screen.state === 'danger' ? 'Manual' : 'Review')}</em></span>
            `).join('')}
          </div>
        </details>
      </div>
    </section>
  `;
}

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
  const wallets = state.apiStatus === 'connected' ? state.recovery.pendingWallets : [];
  const selectedPublicKey = selectedLaunchWalletPublicKey();
  const secretLocked = state.secretPin.locked;
  const busy = Boolean(state.fullRunRunning || state.realExecutionRunning);
  const recoverableCount = wallets.filter((wallet) => !wallet.decryptionFailed).length;
  const selectedPending = wallets.some((wallet) => wallet.publicKey === selectedPublicKey);
  const lastSweep = state.lastRecoverySweep;
  const guide = recoveryGuideModel({
    wallets,
    selectedPublicKey,
    selectedPending,
    recoverableCount,
    secretLocked,
    lastSweep,
    busy,
  });

  $('#recoveryWalletWorkspace').innerHTML = `
    <div class="recovery-wallet-head">
      <span>
        <span class="eyebrow">Pending launch wallets</span>
        <h3>${wallets.length ? `${wallets.length} local recovery entr${wallets.length === 1 ? 'y' : 'ies'}` : 'No pending launch wallets'}</h3>
        <p>${state.apiStatus === 'connected'
          ? 'Select a wallet to inspect funding QR, reveal the secret, sweep assets, or discard the local recovery entry after manual cleanup.'
          : 'Open through the Trebuchet desktop app to inspect recoverable launch wallets.'}</p>
      </span>
      <span class="recovery-wallet-stats">
        <span><small>Recoverable</small><strong>${recoverableCount}</strong></span>
        <span><small>Selected</small><strong>${selectedPending ? 'Yes' : 'No'}</strong></span>
        <span><small>PIN</small><strong>${state.secretPin.configured ? secretLocked ? 'Locked' : 'Ready' : 'Unset'}</strong></span>
      </span>
    </div>
    ${renderRecoveryGuide(guide)}
    ${wallets.length ? `
      <div class="recovery-wallet-list">
        ${wallets.map((wallet) => {
          const walletState = recoveryWalletState(wallet);
          const isSelected = wallet.publicKey === selectedPublicKey;
          const revealAction = secretLocked || wallet.secretPinLocked ? 'unlock-secret-pin' : 'reveal-recovery-wallet';
          const revealLabel = secretLocked || wallet.secretPinLocked ? 'Unlock PIN' : 'Reveal';
          const discardBusy = state.discardingWalletPublicKey === wallet.publicKey;
          const sweepBusy = state.sweepingWalletPublicKey === wallet.publicKey;
          const sweepAction = secretLocked || wallet.secretPinLocked ? 'unlock-secret-pin' : 'sweep-recovery-wallet';
          const sweepLabel = secretLocked || wallet.secretPinLocked ? 'Unlock PIN' : sweepBusy ? 'Sweeping' : 'Sweep';
          return `
            <article class="recovery-wallet-row ${isSelected ? 'is-selected' : ''}">
              <span class="ident" aria-hidden="true">${escapeHtml(shortAddress(wallet.publicKey).slice(0, 2))}</span>
              <span class="recovery-wallet-copy">
                <span class="eyebrow">${escapeHtml(formatDate(wallet.createdAt))}</span>
                <h3>${escapeHtml(shortAddress(wallet.publicKey))}</h3>
                <p>${escapeHtml(walletState.detail)}</p>
                <code>${escapeHtml(wallet.publicKey)}</code>
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
                <button class="pill-button danger" type="button" data-action="${escapeHtml(sweepAction)}" data-wallet="${escapeHtml(wallet.publicKey)}" ${wallet.decryptionFailed || busy || sweepBusy ? 'disabled' : ''}>
                  <i class="fa-solid fa-broom"></i><span>${escapeHtml(sweepLabel)}</span>
                </button>
                <button class="pill-button danger" type="button" data-action="discard-recovery-wallet" data-wallet="${escapeHtml(wallet.publicKey)}" ${busy || discardBusy ? 'disabled' : ''}>
                  <i class="fa-solid fa-trash"></i><span>${discardBusy ? 'Discarding' : 'Discard'}</span>
                </button>
              </span>
            </article>
          `;
        }).join('')}
      </div>
    ` : '<div class="empty-state">No abandoned launch wallets are waiting for recovery or cleanup.</div>'}
    ${renderSecretPinResetAudit(state.lastSecretPinReset)}
    ${renderRecoverySweepResult(lastSweep)}
  `;
}

function renderHistoryExecutionAudit() {
  const entries = Array.isArray(state.executionLedger) ? state.executionLedger : [];
  if (!entries.length) {
    return `
      <section class="history-audit-panel">
        <div class="history-audit-head">
          <span>
            <span class="eyebrow">Guarded execution audit</span>
            <strong>Classic proof trail</strong>
            <em>Run a guarded operation to record retries, duration, and observed wallet SOL deltas.</em>
          </span>
          <span class="history-audit-actions">
            <span class="risk-badge">Clear</span>
          </span>
        </div>
        <div class="history-audit-stats">
          <span><small>Complete</small><strong>0</strong></span>
          <span><small>Running</small><strong>0</strong></span>
          <span><small>Retries</small><strong>0</strong></span>
          <span><small>Observed SOL</small><strong>Waiting</strong></span>
        </div>
        <div class="history-audit-list">
          <article class="idle">
            <i class="fa-solid fa-shield-halved"></i>
            <span>
              <strong>No guarded Trebuchet operations recorded in this session.</strong>
              <small>Local wallet execution evidence will appear here after the first run.</small>
            </span>
          </article>
        </div>
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
          <span class="eyebrow">Guarded execution audit</span>
          <strong>${escapeHtml(latest?.label || 'Classic operations')}</strong>
          <em>${escapeHtml(latest?.detail || 'Recent Trebuchet local-wallet operations.')}</em>
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

function currentRecoveryWizardModel() {
  const selectedPublicKey = selectedLaunchWalletPublicKey();
  const wallets = recoveryWalletsNeedingAttention();
  return recoveryWizardModel({
    wallets,
    selectedPublicKey,
    selectedPending: wallets.some((wallet) => wallet.publicKey === selectedPublicKey),
    recoverableCount: wallets.filter((wallet) => !wallet.decryptionFailed).length,
    secretLocked: state.secretPin.locked,
    lastSweep: state.lastRecoverySweep,
    busy: Boolean(state.fullRunRunning || state.realExecutionRunning),
  });
}

function renderHistory() {
  const journalHistory = state.recovery.journals.map((journal) => ({
    id: journal.id,
    kind: 'journal',
    status: journal.status || 'journal',
    title: `${journal.status || 'journal'} / ${journal.token?.symbol || shortAddress(journal.walletPublicKey)}`,
    detail: `${humanizeStage(journal.stage)} for ${shortAddress(journal.walletPublicKey)}`,
    time: formatDate(journal.updatedAt || journal.createdAt),
    journal,
    resumePlan: journalResumePlan(journal),
  }));
  const wizard = currentRecoveryWizardModel();
  $('#recoveryWizard').innerHTML = renderRecoveryWizard(wizard);
  renderRecoveryWalletWorkspace();
  $('#historyExecutionAudit').innerHTML = renderHistoryExecutionAudit();
  const items = state.apiStatus === 'connected'
    ? [
      {
        kind: 'summary',
        title: state.recovery.journalCount ? 'Local launch journals loaded' : 'Local API connected',
        detail: state.recovery.journalCount
          ? `${state.recovery.activeJournalCount} active, ${state.recovery.failedJournalCount} failed, ${state.recovery.pendingWalletCount} pending wallets.`
          : 'No launch journals found in the local recovery store.',
        time: 'Now',
      },
      ...journalHistory,
    ]
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
          ${canResumeJournal(item.journal) ? `<button class="pill-button" type="button" data-action="resume-journal" data-journal-id="${escapeHtml(item.id)}" ${state.recoveryActionId === item.id ? 'disabled' : ''}>${state.recoveryActionId === item.id ? 'Resuming' : 'Resume'}</button>` : ''}
          ${item.resumePlan?.manualRecoveryRequired ? '<span class="risk-badge danger">Manual recovery</span>' : ''}
          ${state.demoActive && !isTerminalJournal(item.journal) ? '<button class="pill-button" type="button" data-action="toggle-demo-mode">Switch to live</button>' : ''}
          ${canDismissJournal(item.journal) ? `<button class="pill-button" type="button" data-action="dismiss-journal" data-journal-id="${escapeHtml(item.id)}" ${state.recoveryActionId === item.id ? 'disabled' : ''}>Dismiss</button>` : ''}
        </span>
        <details class="journal-resume-plan ${stateClass(item.resumePlan?.state)}">
          <summary>
            <span class="risk-badge ${stateClass(item.resumePlan?.state)}">${escapeHtml(item.resumePlan?.badge || 'Plan')}</span>
            <strong>${escapeHtml(item.resumePlan?.title || 'Resume plan')}</strong>
          </summary>
          <div>
            <p>${escapeHtml(item.resumePlan?.detail || '')}</p>
            <ul>
              ${(item.resumePlan?.items || []).slice(0, 4).map((row) => `<li>${escapeHtml(row)}</li>`).join('')}
            </ul>
          </div>
        </details>
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
