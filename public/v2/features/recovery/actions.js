async function resumeJournal(journalId) {
  if (!journalId) return;
  const journal = state.recovery.journals.find((item) => item.id === journalId);
  if (canContinueJournalToFinish(journal)) {
    openJournalFinish(journalId);
    return;
  }
  if (!canResumeJournal(journal)) {
    notify(state.demoActive ? 'Disable test mode to resume real journals' : 'Journal is not resumable');
    return;
  }
  const plan = journalResumePlan(journal);
  if (plan.manualRecoveryRequired) {
    notify('Automatic resume is blocked for this journal; use manual recovery.');
    return;
  }
  {
    const planRows = plan.items.slice(0, 4).map((item) => `- ${item}`).join('\n');
    const ok = await confirmOperatorAction({
      title: plan.title,
      detail: `${plan.detail}\n${planRows}\nThis can send real transactions from the recovered launch wallet.`,
      confirmLabel: 'Resume journal',
      danger: true,
      confirmationText: 'RESUME',
    });
    if (!ok) return;
  }
  if (state.apiStatus !== 'connected' || !state.apiClient?.resumeLaunchJournal) {
    notify('Resume requires the Trebuchet desktop app');
    return;
  }
  state.recoveryActionId = journalId;
  renderHistory();
  try {
    state.lastRecoveryResult = await state.apiClient.resumeLaunchJournal(journalId);
    await refreshLocalApiState();
    pollLiveOps().catch(() => null);
    notify(state.lastRecoveryResult.recovered ? 'Journal recovered for transfer' : 'Journal resume completed');
  } catch (error) {
    notify(error.message || 'Journal resume failed');
  } finally {
    state.recoveryActionId = null;
    renderAll();
  }
}

function openJournalFinish(journalId) {
  const journal = state.recovery.journals.find((item) => item.id === journalId);
  if (!canContinueJournalToFinish(journal)) {
    notify('This launch still has incomplete liquidity work');
    return false;
  }
  if (journal.walletPublicKey
      && state.managedWallets.some((wallet) => wallet.publicKey === journal.walletPublicKey)) {
    state.selectedWalletPublicKey = journal.walletPublicKey;
    state.accountId = journal.walletPublicKey;
  }
  restoreLaunchConfigFromJournal(journal);
  state.launchWorkspace = 'finish';
  state.recoveryWizardStep = 'verify';
  setView('launch');
  setLaunchWorkspace('finish');
  renderAll();
  checkExecutionReadiness().catch(() => null);
  notify('Liquidity is complete · Finish opened for return wallet, proof, and sweep');
  return true;
}

function openTokenRecovery(journalId) {
  const journal = state.recovery.journals.find((item) => item.id === journalId);
  if (!journalNeedsTokenFinish(journal)) {
    notify('This journal does not have an interrupted token to finish');
    return;
  }
  if (journal.walletPublicKey
      && state.managedWallets.some((wallet) => wallet.publicKey === journal.walletPublicKey)) {
    state.selectedWalletPublicKey = journal.walletPublicKey;
    state.accountId = journal.walletPublicKey;
  }
  restoreLaunchConfigFromJournal(journal);
  state.launchWorkspace = 'mint';
  setView('launch');
  setLaunchWorkspace('mint');
  renderAll();
  checkExecutionReadiness().catch(() => null);
  notify('Existing mint selected · check and finish only the missing token steps');
}

async function dismissJournal(journalId) {
  if (!journalId) return;
  const journal = state.recovery.journals.find((item) => item.id === journalId);
  if (!canDismissJournal(journal)) return;
  {
    const ok = await confirmOperatorAction({
      title: 'Dismiss launch journal',
      detail: 'Remove this journal from the active recovery list? This does not sweep assets.',
      confirmLabel: 'Dismiss journal',
      danger: true,
    });
    if (!ok) return;
  }
  if (state.apiStatus !== 'connected' || !state.apiClient?.dismissLaunchJournal) {
    notify('Dismiss requires the Trebuchet desktop app');
    return;
  }
  state.recoveryActionId = journalId;
  renderHistory();
  try {
    await state.apiClient.dismissLaunchJournal(journalId);
    await refreshLocalApiState();
    pollLiveOps().catch(() => null);
    notify('Journal dismissed');
  } catch (error) {
    notify(error.message || 'Journal dismiss failed');
  } finally {
    state.recoveryActionId = null;
    renderAll();
  }
}
