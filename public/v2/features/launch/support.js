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
  if (state.supportReviewJobId || ['opening', 'preparing'].includes(state.poolSupport.status)) return;
  state.poolSupport = { status: 'idle', plan: null, result: null, error: null };
  renderPoolSupport();
}

async function previewPoolSupport() {
  if (state.supportReviewJobId || ['opening', 'preparing'].includes(state.poolSupport.status)) return;
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
  const pending = { status: 'previewing', plan: null, result: null, error: null };
  state.poolSupport = pending;
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
    if (state.poolSupport !== pending || selectedLaunchWalletPublicKey() !== inputs.walletPublicKey) return;
    state.poolSupport = { status: 'ready', plan: response.plan, result: null, error: null, inputs };
  } catch (error) {
    if (state.poolSupport !== pending || selectedLaunchWalletPublicKey() !== inputs.walletPublicKey) return;
    state.poolSupport = { status: 'error', plan: null, result: null, error: error.message || 'Preview failed' };
  }
  renderPoolSupport();
}

function applySavedSupportJob(job) {
  if (job.walletPublicKey !== selectedLaunchWalletPublicKey()) return;
  state.poolSupport = { ...state.poolSupport, job, plan: job.plan, result: job.result,
    status: job.status === 'confirmed' ? 'done' : job.status === 'running' ? 'opening' : 'ready', error: null,
    inputs: { walletPublicKey: job.walletPublicKey, target: job.tokenMint, solAmount: solFromLamports(job.depositLamports), depthPct: job.plan.depthPct || 50 } };
}

function applySavedSupportJobs(walletPublicKey, jobs, error = null) {
  if (walletPublicKey !== selectedLaunchWalletPublicKey()) return;
  state.supportJobs = { walletPublicKey, jobs, error };
  const current = jobs.find((job) => job.jobId === state.poolSupport.job?.jobId);
  if (current && !state.supportReviewJobId && ['opening', 'done'].includes(state.poolSupport.status)) applySavedSupportJob(current);
  renderPoolSupport();
}

async function refreshSavedSupportJobs() {
  const walletPublicKey = selectedLaunchWalletPublicKey();
  if (!walletPublicKey || state.demoActive || !state.apiClient?.getSupportJobs) return;
  try { const response = await state.apiClient.getSupportJobs(walletPublicKey); applySavedSupportJobs(walletPublicKey, response.jobs || []); }
  catch (error) { applySavedSupportJobs(walletPublicKey, state.supportJobs?.walletPublicKey === walletPublicKey ? state.supportJobs.jobs : [], error.message); }
}

function savedSupportHistoryHtml() {
  const history = state.supportJobs;
  if (state.demoActive || history?.walletPublicKey !== selectedLaunchWalletPublicKey()) return '';
  const jobs = (history.jobs || []).slice().reverse();
  if (!jobs.length && !history.error) return '';
  const sol = (value) => formatRawTokenAmount(String(value || 0), 9);
  return `<section class="pool-support-plan"><h3>Saved support</h3>
    ${history.error ? `<p class="pool-support-error" role="alert">${escapeHtml(history.error)}</p>` : ''}
    ${jobs.map((job) => `<div class="pool-support-plan"><strong>${escapeHtml(job.network)} · ${escapeHtml(shortAddress(job.poolId))}</strong>
      <p>${escapeHtml(job.status === 'confirmed' ? `Added ${sol(job.result.depositedRaw)} SOL. Fee paid: ${sol(job.result.feeLamports)} SOL.`
        : job.status === 'failed' ? `Transaction failed. Fee paid: ${sol(job.result.feeLamports)} SOL.`
        : `${sol(job.depositLamports)} SOL deposit. Maximum total: ${sol(job.maxSpendLamports)} SOL.`)}</p>
      ${['review_required', 'paused', 'running'].includes(job.status) ? `<button class="pill-button" type="button" data-action="resume-support-job" data-job-id="${escapeHtml(job.jobId)}">${job.status === 'paused' ? 'Resume support' : job.status === 'running' ? 'Refresh support' : 'Review support'}</button>` : ''}
    </div>`).join('')}</section>`;
}

async function reviewSavedSupportJob(job) {
  if (state.supportReviewJobId) return;
  state.supportReviewJobId = job.jobId;
  try { await performSupportReview(job); }
  finally { state.supportReviewJobId = null; }
}

async function performSupportReview(job) {
  if (job.walletPublicKey !== selectedLaunchWalletPublicKey()) throw new Error('Select the saved support wallet to continue.');
  applySavedSupportJob(job); renderPoolSupport();
  if (['confirmed', 'failed', 'running'].includes(job.status)) return;
  if (!walletIsUnlocked()) { const unlocked = await unlockSecretPin({ reason: 'unlock' }); if (!unlocked || !walletIsUnlocked()) return; }
  const sol = (value) => formatRawTokenAmount(String(value), 9);
  const ok = await confirmOperatorAction({ title: job.status === 'paused' ? 'Resume buy support' : 'Add buy support',
    detail: `Wallet: ${job.walletPublicKey}. Network: ${job.network}. Pool: ${job.poolId}. Position: ${job.nftMint}. `
      + `Deposit up to ${sol(job.depositLamports)} SOL between ${fmtPoolPrice(job.plan.topPriceSol)} and ${fmtPoolPrice(job.plan.bottomPriceSol)} per token. `
      + `Fees are at most ${sol(job.feeCeilingLamports)} SOL. Account rent is at most ${sol(job.rentCeilingLamports)} SOL. Maximum total: ${sol(job.maxSpendLamports)} SOL.`,
    confirmLabel: job.status === 'paused' ? 'Resume support' : 'Add support', danger: true, confirmationText: 'ADD SUPPORT' });
  if (!ok) { await refreshSavedSupportJobs(); return; }
  if (job.walletPublicKey !== selectedLaunchWalletPublicKey()) throw new Error('Select the saved support wallet before continuing.');
  state.poolSupport = { ...state.poolSupport, status: 'opening', error: null }; renderPoolSupport();
  try {
    const response = await state.apiClient.openSolSupport({ walletPublicKey: job.walletPublicKey, jobId: job.jobId, planDigest: job.planDigest, maxSpendLamports: job.maxSpendLamports });
    if (selectedLaunchWalletPublicKey() === job.walletPublicKey) {
      state.poolSupport = { ...state.poolSupport, status: response.result.status === 'confirmed' ? 'done' : 'ready', result: response.result,
        job: { ...job, status: response.result.status, result: response.result } };
    }
    if (selectedLaunchWalletPublicKey() === job.walletPublicKey) {
      loadCoinDetail(job.tokenMint).catch(() => null); loadCoinPositions(job.tokenMint).catch(() => null);
      refreshManualPrefundBalance({ quiet: true }).catch(() => null);
    }
    notify(response.result.status === 'confirmed' ? 'Buy support added' : 'Support receipt saved');
  } catch (error) {
    const saved = await state.apiClient.getSupportJob(job.jobId).catch(() => null);
    if (saved?.job) applySavedSupportJob(saved.job);
    if (selectedLaunchWalletPublicKey() === job.walletPublicKey) state.poolSupport = { ...state.poolSupport, status: 'ready', error: error.message || 'Resume the saved support job' };
    throw error;
  } finally { await refreshSavedSupportJobs(); renderPoolSupport(); }
}

async function resumeSupportPositionJob(jobId) {
  try { const response = await state.apiClient.getSupportJob(jobId); await reviewSavedSupportJob(response.job); }
  catch (error) { notify(error.message || 'Read the saved support job'); }
}

async function openPoolSupport() {
  const { plan, inputs, job } = state.poolSupport, walletPublicKey = selectedLaunchWalletPublicKey();
  if (!plan || !inputs || state.supportReviewJobId || ['opening', 'preparing'].includes(state.poolSupport.status)) return;
  if (!walletPublicKey) { notify('Select a launch wallet to sign with'); return; }
  if (!state.demoActive) {
    try {
      if (job && ['paused', 'running'].includes(job.status)) return await resumeSupportPositionJob(job.jobId);
      if (!walletIsUnlocked()) { const unlocked = await unlockSecretPin({ reason: 'unlock' }); if (!unlocked || !walletIsUnlocked()) return; }
      if (selectedLaunchWalletPublicKey() !== walletPublicKey) throw new Error('Review support with the selected wallet.');
      state.poolSupport = { ...state.poolSupport, status: 'preparing', error: null }; renderPoolSupport();
      const prepared = await state.apiClient.prepareSolSupport({ walletPublicKey, poolId: plan.poolId, solAmount: inputs.solAmount, depthPct: inputs.depthPct,
        requestId: window.crypto?.randomUUID?.() });
      await reviewSavedSupportJob(prepared.job); await refreshSavedSupportJobs();
    } catch (error) {
      if (selectedLaunchWalletPublicKey() === walletPublicKey) state.poolSupport = { ...state.poolSupport, status: 'ready', error: error.message || 'Prepare the support review' };
      notify(error.message || 'Prepare the support review');
    }
    finally { renderPoolSupport(); }
    return;
  }
  const deposit = solFromLamports(plan.depositLamports), symbol = plan.token?.symbol || shortAddress(plan.token?.mint);
  const ok = await confirmOperatorAction({ title: 'Add buy support', detail: `Put ${deposit.toFixed(4)} SOL into the ${symbol}/SOL pool from ${fullAddress(walletPublicKey)}, `
    + `between ${fmtPoolPrice(plan.topPriceSol)} and ${fmtPoolPrice(plan.bottomPriceSol)} per ${symbol}.`, confirmLabel: 'Add support', danger: true, confirmationText: 'ADD SUPPORT' });
  if (!ok || selectedLaunchWalletPublicKey() !== walletPublicKey) return;
  state.poolSupport = { ...state.poolSupport, status: 'opening', error: null }; renderPoolSupport();
  try {
    const response = await state.apiClient.openSolSupport({ walletPublicKey, poolId: plan.poolId, tokenMint: inputs.target, solAmount: inputs.solAmount, depthPct: inputs.depthPct,
      expected: { tickLower: plan.tickLower, tickUpper: plan.tickUpper, totalLamports: plan.totalLamports } });
    state.poolSupport = { ...state.poolSupport, status: 'done', result: response.result, error: null };
    const tokenMint = inputs.target || plan.token?.mint;
    loadCoinDetail(tokenMint).catch(() => null); loadCoinPositions(tokenMint).catch(() => null);
    refreshManualPrefundBalance({ quiet: true }).catch(() => null); notify('Practice support added');
  } catch (error) { state.poolSupport = { ...state.poolSupport, status: 'ready', error: error.message || 'Adding support failed' }; notify(state.poolSupport.error); }
  renderPoolSupport();
}

function renderPoolSupport() {
  const target = $('#poolSupportResult');
  if (!target) return;
  const { status, plan, result, error } = state.poolSupport;
  const history = savedSupportHistoryHtml();
  if (status === 'previewing' || status === 'preparing') {
    target.innerHTML = '<p class="pool-support-status"><i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> Preparing the support review…</p>' + history;
    return;
  }
  if (!plan) {
    target.innerHTML = (error ? `<p class="pool-support-error" role="alert">${escapeHtml(error)}</p>` : '') + history;
    return;
  }
  const symbol = plan.token?.symbol || shortAddress(plan.token?.mint);
  const pctBelow = (price) => Math.max(0, Math.round((1 - Number(price) / Number(plan.currentPriceSol)) * 100));
  const rent = solFromLamports(plan.newArrayRentLamports);
  const wallet = plan.walletLamports === null ? null : solFromLamports(plan.walletLamports);
  const facts = [
    ['Pool', `${symbol}/SOL · ${fullAddress(plan.poolId)}`],
    ['Observed price', fmtPoolPrice(plan.currentPriceSol)],
    ['Cheapest elsewhere', plan.ceiling ? `${fmtPoolPrice(plan.ceiling.priceSol)} in the ${plan.ceiling.quoteSymbol || 'other'} pool` : 'No other pool with this token'],
    ['Support range', `${fmtPoolPrice(plan.topPriceSol)} (−${pctBelow(plan.topPriceSol)}%) to ${fmtPoolPrice(plan.bottomPriceSol)} (−${pctBelow(plan.bottomPriceSol)}%)`],
  ];
  const costs = [
    ['Into the pool', solFromLamports(plan.depositLamports), 'yours; you can withdraw it'],
    ['New tick arrays', rent, plan.newTickArrays ? `${plan.newTickArrays} × rent, never returned` : 'none; the range reuses existing ones'],
    ['Position accounts', solFromLamports(plan.positionRentLamports), 'position and NFT account rent'],
    ...(plan.otherRentLamports ? [['Other account rent', solFromLamports(plan.otherRentLamports), 'temporary SOL, token, and shared pool accounts']] : []),
    ['Fees and buffer', solFromLamports(plan.feeBufferLamports), 'unspent SOL stays in the wallet'],
  ];
  const opening = status === 'opening';
  const done = status === 'done' && result;
  target.innerHTML = `
    <div class="pool-support-plan">
      <dl class="pool-support-facts">${facts.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl>
      <ul class="pool-support-costs">
        ${costs.map(([label, sol, note]) => `<li><span>${escapeHtml(label)}<small>${escapeHtml(note)}</small></span><strong>${sol.toFixed(4)}</strong></li>`).join('')}
        <li class="is-total"><span>Needed in the wallet${wallet === null ? '' : `<small>${escapeHtml(fullAddress(selectedLaunchWalletPublicKey()))} has ${wallet.toFixed(4)} SOL</small>`}</span><strong>${solFromLamports(plan.totalLamports).toFixed(4)} SOL</strong></li>
      </ul>
      ${plan.warnings?.length ? `<ul class="pool-support-warnings">${plan.warnings.map((warning) => `<li><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>${escapeHtml(warning)}</li>`).join('')}</ul>` : ''}
      ${error ? `<p class="pool-support-error" role="alert">${escapeHtml(error)}</p>` : ''}
      ${done
        ? `<p class="pool-support-done"><i class="fa-solid fa-check" aria-hidden="true"></i> Added. Position ${escapeHtml(fullAddress(result.nftMint))}${result.txId && !String(result.txId).startsWith('Demo') ? ` · <a href="${escapeHtml(solscanTxUrl(result.txId))}" target="_blank" rel="noopener">transaction</a>` : ''}</p>`
        : `<div class="operator-toolbar compact"><button class="primary-button compact" type="button" data-action="open-pool-support" ${opening || plan.enoughSol === false ? 'disabled' : ''}><span>${opening ? 'Adding support…' : `Add ${solFromLamports(plan.depositLamports).toFixed(4)} SOL of support`}</span><i class="fa-solid fa-arrow-right" aria-hidden="true"></i></button></div>`}
    </div>${history}`;
}

function renderReturnWalletCard() {
  const card = $('#returnWalletCard');
  if (!card) return;
  card.innerHTML = assetDestinationsHtml();
}

function editReturnWallet() {
  setView('launch');
  setLaunchWorkspace('mint');
  window.requestAnimationFrame(() => {
    setPlanSlide('return');
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
      if (!quiet) notify(`Funding wallet detected: ${fullAddress(funder)}`);
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
