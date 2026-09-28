function bindEvents() {
  document.addEventListener('click', handleClick);
  document.addEventListener('input', handleDynamicInput);
  document.addEventListener('input', scheduleLaunchAutoSave);
  // A pasted pair mint resolves its symbol as soon as the field is left.
  document.addEventListener('change', (event) => {
    if (event.target.closest?.('#advancedLaunchControls')) renderMoreOptionsSummary(); if (['tokenName', 'tokenSymbol'].includes(event.target?.id)) { renderCoinContext(); renderWorkingCoinCards(); }
    const mint = event.target.closest?.('.supply-mint');
    if (mint?.value.trim()) {
      resolveCustomQuoteToken(mint.dataset.poolId).catch((error) => notify(error.message || 'Token lookup failed'));
    }
  });
  document.addEventListener('keydown', (event) => {
    const operatorPromptGate = $('#operatorPromptGate');
    if (operatorPromptGate && !operatorPromptGate.hidden) {
      if (trapDialogFocus(event, operatorPromptGate)) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        closeOperatorPrompt(null);
      } else if (
        event.key === 'Enter'
        && (!operatorPromptConfig?.multiline || event.metaKey || event.ctrlKey)
      ) {
        event.preventDefault();
        submitOperatorPrompt();
      }
      return;
    }

    const sweepConfirmGate = $('#sweepConfirmGate');
    if (sweepConfirmGate && !sweepConfirmGate.hidden) {
      if (trapDialogFocus(event, sweepConfirmGate)) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        closeSweepConfirmation(null);
      } else if (event.key === 'Enter' && event.target.closest?.('.sweep-confirm-shell')) {
        event.preventDefault();
        submitSweepConfirmation();
      }
      return;
    }

    if (state.recoveryPinGate.open) {
      if (trapDialogFocus(event, $('#recoveryPinGate'))) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        cancelRecoveryPinGate();
      }
      return;
    }

    if (state.activityLog.open) {
      if (trapDialogFocus(event, $('#activityLogDrawer'))) return;
      if (event.key === 'Escape') {
        state.activityLog.open = false;
        renderActivityLogDrawer();
        const returnFocus = activityLogReturnFocus;
        activityLogReturnFocus = null;
        restoreDialogFocus(returnFocus);
      }
      return;
    }

    const activeTab = event.target.closest?.('[role="tab"]');
    const tablist = activeTab?.closest?.('[role="tablist"]');
    if (activeTab && tablist && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      const tabs = [...tablist.querySelectorAll('[role="tab"]')]
        .filter((tab) => !tab.disabled && tab.closest('[role="tablist"]') === tablist);
      const currentIndex = tabs.indexOf(activeTab);
      if (currentIndex < 0) return;
      event.preventDefault();
      const nextIndex = event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? tabs.length - 1
          : (currentIndex + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      tabs[nextIndex].click();
      tabs[nextIndex].focus();
      return;
    }

    const tagName = String(event.target.tagName || '').toLowerCase();
    const editing = ['input', 'textarea', 'select'].includes(tagName) || event.target.isContentEditable;
    if (!editing && event.altKey && !event.metaKey && !event.ctrlKey && /^Digit[1-5]$/.test(event.code)) {
      const index = Number(event.code.slice(-1)) - 1;
      const workspace = launchWorkspaces[index];
      if (workspace) {
        event.preventDefault();
        setLaunchWorkspace(workspace.id, { focus: true });
      }
    }
  });

  $('#networkButton').addEventListener('click', () => {
    setView('settings');
    window.requestAnimationFrame(() => $('.rpc-settings-panel')?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
    notify('RPC changes are made in authoritative settings');
  });

  $('#themeButton').addEventListener('click', () => {
    document.body.classList.toggle('light-mode');
    drawLaunchCanvas();
  });

  $('#walletButton').addEventListener('click', () => {
    const selectedPublicKey = selectedLaunchWalletPublicKey();
    if (!selectedPublicKey) {
      setView('wallet');
      notify('Generate or import a launch wallet');
      return;
    }
    const selected = selectedManagedWallet();
    if (!walletIsUnlocked() || state.secretPin.locked || selected?.secretPinLocked === true) {
      unlockSecretPin({ reason: 'wallet' }).then((unlocked) => {
        if (!unlocked) return;
        renderAll();
        notify('Launch wallet unlocked');
      }).catch((error) => notify(error.message || 'Wallet unlock failed'));
      return;
    }
    setView('wallet');
    notify('Launch wallet opened');
  });

  $('#stageButton').addEventListener('click', stageTransactions);
  $('#simulateButton').addEventListener('click', simulateLaunch);
  $('#discoveryInspectForm').addEventListener('submit', (event) => {
    event.preventDefault();
    inspectDiscoveryMint();
  });
  $('#discoveryWalletForm').addEventListener('submit', (event) => {
    event.preventDefault();
    addTrackedDiscoveryWallet();
  });
  $('#personalDiscoverySort')?.addEventListener('change', (event) => {
    state.discovery.sort = ['connections', 'name'].includes(event.target.value)
      ? event.target.value
      : 'relevance';
    renderPersonalDiscovery();
  });
  $('#addCoinMint')?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    addCoinByMint().catch((error) => notify(error.message || 'Could not add that coin'));
  });
  $('#tokenLogoFile').addEventListener('change', (event) => {
    selectTokenLogo(event.target.files?.[0] || null);
  });
  $('#liquidityBudgetSol')?.addEventListener('input', (event) => {
    applyLaunchBudgetRecommendation(event.target.value, { announce: false });
  });

  $('#quickTokenName')?.addEventListener('input', renderQuickLaunchCost);
  $('#quickTokenSymbol')?.addEventListener('input', renderQuickLaunchCost);
  $('#quickQuote')?.addEventListener('change', renderQuickLaunchCost);
  $('#quickFee')?.addEventListener('change', renderQuickLaunchCost);
  $('#quickTreasury')?.addEventListener('input', renderQuickLaunchCost);
  renderQuickLaunchCost();

  $('#newVaultButton').addEventListener('click', () => {
    generateManagedWallet().catch((error) => notify(error.message || 'Wallet generation failed'));
  });

  $$('.mode-button').forEach((button) => {
    button.addEventListener('click', async () => {
      try {
        if (button.dataset.mode === 'dry-run') {
          await simulateLaunch();
        } else {
          if (state.demoActive) await setDemoMode(false, { announce: false });
          state.launchMode = 'guarded';
          renderAll();
          notify('Guarded live mode selected');
        }
        $$('.mode-button').forEach((item) => item.classList.toggle('is-selected', item === button));
      } catch (error) {
        notify(error.message || 'Execution mode change failed');
      }
    });
  });

  [
    'tokenName',
    'tokenSymbol',
    'tokenSupply',
    'tokenDescription',
    'mintFormat',
    'targetMarketCapUsd',
    'vanityStart',
    'vanityEnd',
    'vanityCaseInsensitive',
    'vanityLength',
    'mainPoolPercent',
    'quotePoolPercent',
    'preallocationSupplyPercent',
    'quotePoolVenue',
    'sliceShares',
    'ladderBands',
    'supportSol',
    'airdropWallets',
    'airdropSupplyPercent',
    'airdropAutoFit',
    'feeKeyRecipient',
    'sweepDestination',
  ].forEach((id) => {
    $(`#${id}`).addEventListener('input', () => {
      invalidateClassicOutputs();
      refreshClassicPreview({ includePoolEditor: true });
    });
  });

  window.addEventListener('resize', drawLaunchCanvas);
}

window.getConnectedSolflareWallet = () => (
  state.solflare.publicKey
    ? { publicKey: state.solflare.publicKey, connectedAt: state.solflare.connectedAt }
    : null
);
window.applySolflareDestinationWallet = applySolflareAsSweepDestination;
window.addEventListener?.('solana#initialized', () => {
  wireSolflareProviderEvents();
  initializeSolflareWallet();
  renderAll();
});

restoreExecutionLedger();
restoreLaunchProof();
restoreClassicReportComparison();
restoreDiscoveryRegistry();
bindEvents();
initializeSolflareWallet();
setView('coins');
renderAll();
startLiveOpsPolling();
bootLocalApi().catch((error) => {
  console.warn('v2 local API bootstrap failed:', error);
  applyBootState({
    api: {
      available: false,
      status: 'static',
      detail: 'Static preview; local API bootstrap failed.',
    },
  });
  renderAll();
});

// The screen stays where the user put it. Only their own scrolling (wheel,
// touch, keys, or the scrollbar) moves the remembered position. When a
// re-render shortens the page for a moment (a list rebuilt, a section
// showing "Reading…"), the browser pulls the scroll up; once the content is
// back, this puts it where it was. Opening a different row resets it on
// purpose through setViewScrollTop.
const viewScrollIntent = new WeakMap();
let lastUserScrollAt = 0;

function markUserScroll(event) {
  if (event.type === 'pointerdown' && !event.target?.classList?.contains('view')) return;
  if (event.type === 'keydown' && !['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', ' '].includes(event.key)) return;
  lastUserScrollAt = Date.now();
}

function setViewScrollTop(view, top) {
  if (!view) return;
  view.scrollTop = top;
  viewScrollIntent.set(view, view.scrollTop);
}

function restoreViewScroll() {
  const view = document.querySelector('.view.is-active');
  const want = view ? viewScrollIntent.get(view) : null;
  if (want == null || Date.now() - lastUserScrollAt < 400) return;
  const reachable = Math.min(want, view.scrollHeight - view.clientHeight);
  if (view.scrollTop < reachable) view.scrollTop = reachable;
}

['wheel', 'touchmove', 'keydown', 'pointerdown'].forEach((type) => {
  window.addEventListener(type, markUserScroll, { capture: true, passive: true });
});
document.addEventListener('scroll', (event) => {
  const view = event.target;
  if (!view?.classList?.contains('view')) return;
  // A user scroll, or any move further down (e.g. scrollIntoView), is where
  // the screen should be. A move up without the user is the browser clamping.
  if (Date.now() - lastUserScrollAt < 400 || view.scrollTop > (viewScrollIntent.get(view) ?? 0)) {
    viewScrollIntent.set(view, view.scrollTop);
  }
}, true);
new MutationObserver(() => window.requestAnimationFrame(restoreViewScroll))
  .observe(document.querySelector('.workspace') || document.body, { childList: true, subtree: true, characterData: true });
