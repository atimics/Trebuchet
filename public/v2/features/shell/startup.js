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


// Few-choice dropdowns become visible choices: a slider for ordered values
// (address length, support depth, fee tier) and a row of buttons for the
// rest. Mark a <select> with data-choice="slider" or "buttons"; an option's
// data-short is its label. The <select> stays the source of truth, so
// change handlers and saved plans work unchanged.
function chooseOption(select, index) {
  if (select.disabled || index < 0 || index >= select.options.length) return;
  if (select.selectedIndex !== index) {
    select.selectedIndex = index;
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }
  syncChoiceControl(select);
}

function syncChoiceControl(select) {
  const control = select.nextElementSibling;
  if (!control?.classList?.contains('choice-control')) return;
  const range = control.querySelector('input[type="range"]');
  if (range) {
    range.value = String(Math.max(0, select.selectedIndex));
    range.disabled = select.disabled;
    range.setAttribute('aria-valuetext', select.options[select.selectedIndex]?.textContent?.trim() || '');
  }
  control.querySelectorAll('button[data-choice-index]').forEach((button) => {
    const on = Number(button.dataset.choiceIndex) === select.selectedIndex;
    button.classList.toggle('is-selected', on);
    button.setAttribute('aria-checked', on ? 'true' : 'false');
    button.disabled = select.disabled;
  });
}

function enhanceChoiceControls(root = document) {
  root.querySelectorAll('select[data-choice]').forEach((select) => {
    if (select.dataset.choiceReady) {
      syncChoiceControl(select);
      return;
    }
    select.dataset.choiceReady = '1';
    const kind = select.dataset.choice === 'slider' ? 'slider' : 'buttons';
    const name = select.getAttribute('aria-label')
      || select.closest('label')?.querySelector('span')?.textContent?.trim()
      || 'Choice';
    const labels = [...select.options].map((option, index) => (
      `<button type="button" role="radio" data-choice-index="${index}">${escapeHtml(option.dataset.short || option.textContent.trim())}</button>`
    )).join('');
    const control = document.createElement('div');
    control.className = `choice-control is-${kind}`;
    control.innerHTML = kind === 'slider'
      ? `<input type="range" min="0" max="${select.options.length - 1}" step="1" aria-label="${escapeHtml(name)}"><div class="choice-ticks" role="radiogroup" aria-label="${escapeHtml(name)}">${labels}</div>`
      : `<div class="choice-buttons" role="radiogroup" aria-label="${escapeHtml(name)}">${labels}</div>`;
    control.addEventListener('input', (event) => {
      if (event.target.matches('input[type="range"]')) chooseOption(select, Number(event.target.value));
      event.stopPropagation();
    });
    control.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-choice-index]');
      if (button) chooseOption(select, Number(button.dataset.choiceIndex));
    });
    select.hidden = true;
    select.after(control);
    syncChoiceControl(select);
  });
}

// Selects come and go with re-renders; enhance new ones as they appear and
// keep every control in step with its select's current value.
new MutationObserver(() => enhanceChoiceControls())
  .observe(document.body, { childList: true, subtree: true });
enhanceChoiceControls();
renderAll = ((render) => function renderAllWithChoices(...args) {
  const result = render.apply(this, args);
  enhanceChoiceControls();
  return result;
})(renderAll);

// Every address on screen can be copied in full with a click. A pass over
// new text wraps each full address, and each short form this app produced
// (shortAddress remembers them), in a copy control whose value is the whole
// address. Links keep opening their page. Clicking an address inside a
// larger button copies instead of pressing the button.
const BASE58 = '1-9A-HJ-NP-Za-km-z';
const ADDRESS_TEXT_RE = new RegExp(
  `(?<![${BASE58}.])(?:[${BASE58}]{32,44}|[${BASE58}]{4}\\.\\.\\.[${BASE58}]{4})(?![${BASE58}])`,
  'g',
);
// Skipped: form fields, links (they open their page), toasts, and narrow
// rows whose click opens a panel that shows the full, copyable address.
const ADDRESS_SKIP = '.address-copy, script, style, textarea, input, select, option, a, [contenteditable="true"], .toast, .coin-fact, summary, #walletButton, .nav-item';

function copyableAddress(text) {
  if (text.includes('...')) return shortAddressFull.get(text) || null;
  return text;
}

function wrapAddressText(node) {
  const text = node.nodeValue || '';
  ADDRESS_TEXT_RE.lastIndex = 0;
  let match;
  let last = 0;
  const fragment = document.createDocumentFragment();
  let wrapped = false;
  while ((match = ADDRESS_TEXT_RE.exec(text))) {
    const full = copyableAddress(match[0]);
    if (!full) continue;
    fragment.append(text.slice(last, match.index));
    const span = document.createElement('span');
    span.className = 'address-copy';
    span.dataset.copyAddress = full;
    span.setAttribute('role', 'button');
    span.setAttribute('tabindex', '0');
    span.title = `${full}\nClick to copy`;
    span.textContent = match[0];
    fragment.append(span);
    last = match.index + match[0].length;
    wrapped = true;
  }
  if (!wrapped) return;
  fragment.append(text.slice(last));
  node.replaceWith(fragment);
}

function makeAddressesCopyable(root = document.body) {
  if (!root) return;
  if (root.nodeType === Node.TEXT_NODE) {
    if (root.parentElement && !root.parentElement.closest(ADDRESS_SKIP)) wrapAddressText(root);
    return;
  }
  if (root.nodeType !== Node.ELEMENT_NODE || root.closest?.(ADDRESS_SKIP)) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if ((node.nodeValue || '').length < 11) return NodeFilter.FILTER_REJECT;
      if (node.parentElement?.closest(ADDRESS_SKIP)) return NodeFilter.FILTER_REJECT;
      ADDRESS_TEXT_RE.lastIndex = 0;
      return ADDRESS_TEXT_RE.test(node.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  nodes.forEach(wrapAddressText);
}

function copyAddressFrom(target) {
  const control = target?.closest?.('[data-copy-address]');
  if (!control) return false;
  copyText(control.dataset.copyAddress, `Address ${control.dataset.copyAddress}`);
  return true;
}

document.addEventListener('click', (event) => {
  if (!event.target.closest?.('[data-copy-address]')) return;
  event.preventDefault();
  event.stopPropagation();
  copyAddressFrom(event.target);
}, true);
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  if (!event.target.matches?.('[data-copy-address]')) return;
  event.preventDefault();
  event.stopPropagation();
  copyAddressFrom(event.target);
}, true);
new MutationObserver((records) => {
  records.forEach((record) => {
    if (record.type === 'characterData') makeAddressesCopyable(record.target);
    record.addedNodes.forEach((node) => makeAddressesCopyable(node));
  });
}).observe(document.body, { childList: true, subtree: true, characterData: true });
makeAddressesCopyable();
