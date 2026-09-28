function poolSupportInputs() {
  const target = String($('#poolSupportTarget')?.value || '').trim();
  const walletPublicKey = selectedLaunchWalletPublicKey() || null;
  return {
    walletPublicKey,
    target,
    solAmount: parseNumericInput($('#poolSupportSol')?.value, 0),
    depthPct: parseNumericInput($('#poolSupportDepth')?.value, 50),
  };
}

function solFromLamports(value) {
  return Number(value || 0) / 1e9;
}

function fmtPoolPrice(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return '—';
  return `${number < 0.0001 ? number.toExponential(3) : number.toPrecision(4)} SOL`;
}

function resetPoolSupport() {
  if (state.poolSupport.status === 'opening') return;
  state.poolSupport = { status: 'idle', plan: null, result: null, error: null };
  renderPoolSupport();
}

async function previewPoolSupport() {
  const inputs = poolSupportInputs();
  if (!inputs.target) {
    notify('Paste a token mint or SOL pool address');
    return;
  }
  if (!(inputs.solAmount > 0)) {
    notify('Enter how much SOL to add');
    return;
  }
  if (state.apiStatus !== 'connected' || !state.apiClient?.previewSolSupport) {
    notify('Adding buy support needs the Trebuchet desktop app');
    return;
  }
  state.poolSupport = { status: 'previewing', plan: null, result: null, error: null };
  renderPoolSupport();
  try {
    // A pool address and a token mint look alike; the server resolves a
    // token mint to its deepest SOL pool when the address is not a pool.
    const response = await state.apiClient.previewSolSupport({
      walletPublicKey: inputs.walletPublicKey,
      tokenMint: inputs.target,
      solAmount: inputs.solAmount,
      depthPct: inputs.depthPct,
    });
    state.poolSupport = { status: 'ready', plan: response.plan, result: null, error: null, inputs };
  } catch (error) {
    state.poolSupport = { status: 'error', plan: null, result: null, error: error.message || 'Preview failed' };
  }
  renderPoolSupport();
}

async function openPoolSupport() {
  const { plan, inputs } = state.poolSupport;
  const walletPublicKey = selectedLaunchWalletPublicKey();
  if (!plan || !inputs) return;
  if (!walletPublicKey) {
    notify('Select a launch wallet to sign with');
    return;
  }
  if (plan.enoughSol === false) {
    notify('The selected wallet does not have enough SOL for this');
    return;
  }
  const deposit = solFromLamports(plan.depositLamports);
  const rent = solFromLamports(plan.newArrayRentLamports);
  const symbol = plan.token?.symbol || shortAddress(plan.token?.mint);
  const ok = await confirmOperatorAction({
    title: 'Add buy support',
    detail: `Put ${deposit.toFixed(4)} SOL into the ${symbol}/SOL pool from ${shortAddress(walletPublicKey)}, `
      + `between ${fmtPoolPrice(plan.topPriceSol)} and ${fmtPoolPrice(plan.bottomPriceSol)} per ${symbol}.`
      + (rent > 0 ? ` ${rent.toFixed(4)} SOL is tick-array rent that is never returned.` : ''),
    confirmLabel: 'Add support',
    danger: true,
    confirmationText: 'ADD SUPPORT',
  });
  if (!ok) return;
  state.poolSupport = { ...state.poolSupport, status: 'opening', error: null };
  renderPoolSupport();
  try {
    const response = await state.apiClient.openSolSupport({
      walletPublicKey,
      poolId: plan.poolId,
      tokenMint: inputs.target,
      solAmount: inputs.solAmount,
      depthPct: inputs.depthPct,
      expected: { tickLower: plan.tickLower, tickUpper: plan.tickUpper, totalLamports: plan.totalLamports },
    });
    state.poolSupport = { ...state.poolSupport, status: 'done', result: response.result, error: null };
    if (inputs.target) {
      loadCoinDetail(inputs.target).catch(() => null);
      loadCoinPositions(inputs.target).catch(() => null);
    }
    notify(`Buy support added: ${deposit.toFixed(4)} SOL in the ${symbol}/SOL pool`);
    refreshManualPrefundBalance({ quiet: true }).catch(() => null);
  } catch (error) {
    const changed = error?.response?.plan && ['SUPPORT_PLAN_CHANGED', 'SUPPORT_INSUFFICIENT_SOL'].includes(error.code);
    state.poolSupport = changed
      ? { ...state.poolSupport, status: 'ready', plan: error.response.plan, error: error.message }
      : { ...state.poolSupport, status: 'ready', error: error.message || 'Adding support failed' };
    notify(error.message || 'Adding support failed');
  }
  renderPoolSupport();
}

function renderPoolSupport() {
  const target = $('#poolSupportResult');
  if (!target) return;
  const { status, plan, result, error } = state.poolSupport;
  if (status === 'previewing') {
    target.innerHTML = '<p class="pool-support-status"><i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> Reading the pool and the token\'s other pools…</p>';
    return;
  }
  if (!plan) {
    target.innerHTML = error ? `<p class="pool-support-error" role="alert">${escapeHtml(error)}</p>` : '';
    return;
  }
  const symbol = plan.token?.symbol || shortAddress(plan.token?.mint);
  const pctBelow = (price) => Math.max(0, Math.round((1 - Number(price) / Number(plan.currentPriceSol)) * 100));
  const rent = solFromLamports(plan.newArrayRentLamports);
  const wallet = plan.walletLamports === null ? null : solFromLamports(plan.walletLamports);
  const facts = [
    ['Pool', `${symbol}/SOL · ${shortAddress(plan.poolId)}`],
    ['Current price', fmtPoolPrice(plan.currentPriceSol)],
    ['Cheapest elsewhere', plan.ceiling ? `${fmtPoolPrice(plan.ceiling.priceSol)} in the ${plan.ceiling.quoteSymbol || 'other'} pool` : 'No other pool with this token'],
    ['Support range', `${fmtPoolPrice(plan.topPriceSol)} (−${pctBelow(plan.topPriceSol)}%) to ${fmtPoolPrice(plan.bottomPriceSol)} (−${pctBelow(plan.bottomPriceSol)}%)`],
  ];
  const costs = [
    ['Into the pool', solFromLamports(plan.depositLamports), 'yours; you can withdraw it'],
    ['New tick arrays', rent, plan.newTickArrays ? `${plan.newTickArrays} × rent, never returned` : 'none; the range reuses existing ones'],
    ['Position accounts', solFromLamports(plan.positionRentLamports), 'returned when you close the position'],
    ['Fees and buffer', solFromLamports(plan.feeBufferLamports), 'unspent SOL stays in the wallet'],
  ];
  const opening = status === 'opening';
  const done = status === 'done' && result;
  target.innerHTML = `
    <div class="pool-support-plan">
      <dl class="pool-support-facts">${facts.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl>
      <ul class="pool-support-costs">
        ${costs.map(([label, sol, note]) => `<li><span>${escapeHtml(label)}<small>${escapeHtml(note)}</small></span><strong>${sol.toFixed(4)}</strong></li>`).join('')}
        <li class="is-total"><span>Needed in the wallet${wallet === null ? '' : `<small>${escapeHtml(shortAddress(selectedLaunchWalletPublicKey()))} has ${wallet.toFixed(4)} SOL</small>`}</span><strong>${solFromLamports(plan.totalLamports).toFixed(4)} SOL</strong></li>
      </ul>
      ${plan.warnings?.length ? `<ul class="pool-support-warnings">${plan.warnings.map((warning) => `<li><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>${escapeHtml(warning)}</li>`).join('')}</ul>` : ''}
      ${error ? `<p class="pool-support-error" role="alert">${escapeHtml(error)}</p>` : ''}
      ${done
        ? `<p class="pool-support-done"><i class="fa-solid fa-check" aria-hidden="true"></i> Added. Position ${escapeHtml(shortAddress(result.nftMint))}${result.txId && !String(result.txId).startsWith('Demo') ? ` · <a href="${escapeHtml(solscanTxUrl(result.txId))}" target="_blank" rel="noopener">transaction</a>` : ''}</p>`
        : `<div class="operator-toolbar compact"><button class="primary-button compact" type="button" data-action="open-pool-support" ${opening || plan.enoughSol === false ? 'disabled' : ''}><span>${opening ? 'Adding support…' : `Add ${solFromLamports(plan.depositLamports).toFixed(4)} SOL of support`}</span><i class="fa-solid fa-arrow-right" aria-hidden="true"></i></button></div>`}
    </div>`;
}

function renderReturnWalletCard() {
  const card = $('#returnWalletCard');
  if (!card) return;
  card.innerHTML = assetDestinationsHtml();
}

function editReturnWallet() {
  setView('launch');
  setLaunchWorkspace('configure');
  window.requestAnimationFrame(() => {
    const card = $('#returnWalletCard');
    card?.closest('details')?.setAttribute('open', '');
    card?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  });
}

async function detectFundingWallet({ quiet = false } = {}) {
  const walletPublicKey = selectedLaunchWalletPublicKey();
  if (!walletPublicKey) {
    if (!quiet) notify('Generate or select a launch wallet first');
    return null;
  }
  if (state.apiStatus !== 'connected' || !state.apiClient?.findFundingWallet) {
    if (!quiet) notify('Funding wallet detection requires the Trebuchet desktop app');
    return null;
  }

  state.fundingWallet = {
    ...state.fundingWallet,
    walletPublicKey,
    checking: true,
    error: null,
  };
  renderAll();

  try {
    const result = await state.apiClient.findFundingWallet(walletPublicKey);
    const funder = result?.funder || null;
    state.fundingWallet = {
      walletPublicKey,
      funder,
      amount: funder ? result?.amount ?? null : null,
      checking: false,
      checkedAt: new Date().toISOString(),
      exhausted: !funder,
      error: null,
    };
    // The funder is the default destination; detection never writes an
    // address into the return wallet.
    if (funder) state.destinations = { ...state.destinations, funder };
    if (funder) {
      if (!quiet) notify(`Funding wallet detected: ${shortAddress(funder)}`);
    } else if (!quiet) {
      notify('Wallet history could not identify a funder. Sign with your wallet before the final sweep.');
    }
    return state.fundingWallet;
  } catch (error) {
    state.fundingWallet = {
      walletPublicKey,
      funder: null,
      amount: null,
      checking: false,
      checkedAt: new Date().toISOString(),
      exhausted: false,
      error: error.message || 'Funding wallet detection failed',
    };
    if (!quiet) notify(state.fundingWallet.error);
    return null;
  } finally {
    renderAll();
  }
}
