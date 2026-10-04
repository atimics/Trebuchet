function addVanityCandidate(candidate, { select = true } = {}) {
  if (!candidate?.publicKey) return;
  const existingIndex = state.vanityCandidates.findIndex((item) => item.publicKey === candidate.publicKey);
  if (existingIndex >= 0) state.vanityCandidates[existingIndex] = { ...state.vanityCandidates[existingIndex], ...candidate };
  else state.vanityCandidates.push(candidate);
  if (select) state.selectedVanityPublicKey = candidate.publicKey;
}

async function removeVanityCandidateByPublicKey(publicKey, { confirm = true } = {}) {
  const candidate = state.vanityCandidates.find((item) => item.publicKey === publicKey);
  if (!candidate) {
    notify('Select a saved Vanity CA first');
    return false;
  }
  if (confirm) {
    const ok = await confirmOperatorAction({
      title: 'Remove saved Vanity CA',
      detail: `Remove ${fullAddress(publicKey)} from local options?`,
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return false;
  }
  if (state.apiStatus === 'connected' && state.apiClient?.removeVanityCandidate && candidate.persisted !== false) {
    await state.apiClient.removeVanityCandidate(publicKey);
  }
  state.vanityCandidates = state.vanityCandidates.filter((item) => item.publicKey !== publicKey);
  if (state.selectedVanityPublicKey === publicKey) {
    state.selectedVanityPublicKey = freeVanityCandidates().at(-1)?.publicKey || null;
  }
  invalidateClassicOutputs();
  renderAll();
  return true;
}

async function pruneHiddenVanityCandidates() {
  const visible = new Set(state.vanityCandidates.slice(-VANITY_VISIBLE_CANDIDATE_LIMIT).map((candidate) => candidate.publicKey));
  if (state.selectedVanityPublicKey) visible.add(state.selectedVanityPublicKey);
  const hidden = state.vanityCandidates.filter((candidate) => !visible.has(candidate.publicKey));
  if (!hidden.length) {
    notify('No hidden Vanity CAs to prune');
    return;
  }
  {
    const ok = await confirmOperatorAction({
      title: 'Prune hidden Vanity CAs',
      detail: `Remove ${hidden.length} hidden saved option${hidden.length === 1 ? '' : 's'}? The selected and most recent visible options stay available.`,
      confirmLabel: 'Prune',
      danger: true,
    });
    if (!ok) return;
  }
  for (const candidate of hidden) {
    if (state.apiStatus === 'connected' && state.apiClient?.removeVanityCandidate && candidate.persisted !== false) {
      await state.apiClient.removeVanityCandidate(candidate.publicKey);
    }
  }
  state.vanityCandidates = state.vanityCandidates.filter((candidate) => visible.has(candidate.publicKey));
  invalidateClassicOutputs();
  renderAll();
  notify(`Pruned ${hidden.length} hidden Vanity CA option${hidden.length === 1 ? '' : 's'}`);
}

async function startVanityGrind() {
  if (state.vanityRunning) {
    if (state.vanitySource) state.vanitySource.close();
    state.vanityRunning = false;
    state.vanityProgress = null;
    state.vanityProgressStats = null;
    if (state.apiStatus === 'connected' && state.apiClient?.cancelVanityGrind) {
      await state.apiClient.cancelVanityGrind().catch(() => null);
    }
    renderAll();
    notify('Vanity grind cancelled');
    return;
  }

  const vanity = currentVanityConfig();
  if (!vanity.prefix && !vanity.suffix) {
    setLaunchWorkspace('configure');
    state.vanityInputError = 'Enter a Vanity CA start or end before grinding.';
    renderVanityCandidates();
    const input = $('#vanityStart');
    input?.setAttribute('aria-invalid', 'true');
    window.requestAnimationFrame?.(() => input?.focus());
    notify(state.vanityInputError);
    return;
  }
  state.vanityInputError = null;
  $('#vanityStart')?.removeAttribute('aria-invalid');
  $('#vanityEnd')?.removeAttribute('aria-invalid');
  const estimate = vanityPatternEstimate(vanity.prefix, vanity.suffix);
  if (estimate.invalid.length) {
    notify(`Vanity target contains invalid Base58 character${estimate.invalid.length === 1 ? '' : 's'}: ${estimate.invalid.join(', ')}`);
    renderVanityCandidates();
    return;
  }

  if (state.apiStatus === 'connected' && state.secretPin.locked) {
    notify('Unlock the Recovery PIN to save this Vanity CA');
    const unlocked = await unlockSecretPin({ reason: 'vanity' });
    if (!unlocked) return;
  }

  if (state.apiStatus !== 'connected' || typeof EventSource !== 'function') {
    const target = vanity.prefix && vanity.suffix
      ? `${vanity.prefix}...${vanity.suffix}`
      : vanity.prefix || vanity.suffix;
    addVanityCandidate({
      publicKey: `${target || 'CA'}Static${Math.floor(Math.random() * 900000 + 100000)}`,
      target,
      prefix: vanity.prefix || null,
      suffix: vanity.suffix || null,
      mode: vanity.mode,
      rarity: 'static preview',
      persisted: false,
    });
    renderAll();
    return;
  }

  state.vanityRunning = true;
  state.vanityProgress = 'Starting';
  state.vanityProgressStats = {
    expectedAttempts: estimate.expectedAttempts,
    startedAt: Date.now(),
    attempts: 0,
    rate: null,
    samples: [],
    caseInsensitive: vanity.caseInsensitive === true,
    length: vanity.length || null,
  };
  renderAll();

  try {
    const token = await state.apiClient.getSessionToken();
    const params = new URLSearchParams({ token, client: 'v2' });
    if (vanity.prefix) params.set('prefix', vanity.prefix);
    if (vanity.caseInsensitive) params.set('caseInsensitive', '1');
    if (vanity.length) params.set('length', String(vanity.length));
    // Split-key: the grinder only sees a public point; ~30x faster too.
    params.set('split', '1');
    if (vanity.suffix) params.set('suffix', vanity.suffix);
    const source = new EventSource(`/api/generate-vanity-wallet-stream?${params.toString()}`);
    state.vanitySource = source;
    source.addEventListener('message', (event) => {
      let data;
      try { data = JSON.parse(event.data); } catch { return; }
      if (data.type === 'start') {
        state.vanityProgress = `Target ${data.target}`;
        state.vanityProgressStats = {
          expectedAttempts: Number(data.expected || estimate.expectedAttempts),
          startedAt: Date.now(),
          attempts: 0,
          rate: null,
          samples: [],
          caseInsensitive: data.caseInsensitive === true,
          length: data.length || null,
        };
        // An older server ignores the flag and grinds exact case. Say so
        // instead of silently running the slower grind.
        if (vanity.caseInsensitive && data.caseInsensitive !== true) {
          notify('This grind is exact case: the app server predates Any case. Quit and reopen Trebuchet, then grind again.');
        }
      } else if (data.type === 'progress') {
        const attempts = Number(data.attempts || 0).toLocaleString();
        const pct = clampPercent(Number(data.epoch || 0) * 100);
        state.vanityProgress = `${attempts} tries / ${pct}% expected`;
        // The grinder reports in per-thread bursts (every 16,384 tries), so
        // burst-to-burst rates swing wildly. Rate over a rolling window.
        const now = Date.now();
        const prior = state.vanityProgressStats || {};
        // Sample only when the count moves, and measure first burst to
        // latest burst: measuring to "now" dips between bursts.
        const attemptsNow = Number(data.attempts || prior.attempts || 0);
        const priorSamples = prior.samples || [];
        const moved = attemptsNow > Number(priorSamples[priorSamples.length - 1]?.attempts ?? -1);
        const samples = (moved ? [...priorSamples, { at: now, attempts: attemptsNow }] : priorSamples)
          .filter((sample) => now - sample.at <= VANITY_RATE_WINDOW_MS);
        const oldest = samples[0];
        const newest = samples[samples.length - 1];
        const windowSeconds = oldest && newest ? (newest.at - oldest.at) / 1000 : 0;
        const rate = windowSeconds >= 2
          ? (newest.attempts - oldest.attempts) / windowSeconds
          : Number(prior.rate || 0) || null;
        state.vanityProgressStats = {
          expectedAttempts: Number(prior.expectedAttempts || estimate.expectedAttempts),
          startedAt: Number(prior.startedAt || now),
          updatedAt: now,
          attempts: attemptsNow,
          rate,
          samples,
          caseInsensitive: prior.caseInsensitive === true,
          length: prior.length || null,
        };
      } else if (data.type === 'done') {
        source.close();
        state.vanityRunning = false;
        state.vanitySource = null;
        state.vanityProgress = null;
        state.vanityProgressStats = null;
        addVanityCandidate({
          publicKey: data.wallet.publicKey,
          target: data.wallet.target || null,
          prefix: data.wallet.prefix || vanity.prefix || null,
          suffix: data.wallet.suffix || vanity.suffix || null,
          mode: data.wallet.mode || vanity.mode,
          caseInsensitive: data.wallet.caseInsensitive === true,
          addressLength: data.wallet.addressLength || null,
          keyType: data.wallet.keyType || 'seed',
          rarity: data.wallet.rarity || null,
          attempts: data.wallet.attempts || null,
          persisted: data.wallet.persisted === true,
        });
        renderAll();
      } else if (data.type === 'cancelled') {
        source.close();
        state.vanityRunning = false;
        state.vanitySource = null;
        state.vanityProgress = null;
        state.vanityProgressStats = null;
        renderAll();
        notify('Vanity grind cancelled');
      } else if (data.type === 'error') {
        source.close();
        state.vanityRunning = false;
        state.vanitySource = null;
        state.vanityProgress = null;
        state.vanityProgressStats = null;
        renderAll();
        notify(data.error || 'Vanity grind failed');
        return;
      }
      renderVanityCandidates();
      renderClassicBridge();
    });
    source.addEventListener('error', () => {
      source.close();
      state.vanityRunning = false;
      state.vanitySource = null;
      state.vanityProgress = null;
      state.vanityProgressStats = null;
      renderAll();
      notify('Vanity stream disconnected');
    });
  } catch (error) {
    state.vanityRunning = false;
    state.vanitySource = null;
    state.vanityProgress = null;
    state.vanityProgressStats = null;
    renderAll();
    notify(error.message || 'Vanity grind failed');
  }
}

// One estimate at a time: repeat clicks join the running request instead of
// queuing more RPC-heavy estimates behind it.
let fundingEstimateInFlight = null;

function estimateClassicFunding() {
  if (fundingEstimateInFlight) return fundingEstimateInFlight;
  state.fundingEstimating = true;
  renderAll();
  fundingEstimateInFlight = runClassicFundingEstimate().finally(() => {
    fundingEstimateInFlight = null;
    state.fundingEstimating = false;
    renderAll();
  });
  return fundingEstimateInFlight;
}

async function runClassicFundingEstimate() {
  await autoVerifyQuoteTokens();
  const config = currentLaunchConfig();
  const fundingRequest = classicFundingEstimateRequest(config);
  if (state.apiStatus === 'connected' && state.apiClient?.estimateClassicFunding) {
    try {
      state.classicFundingEstimate = stampClassicFundingEstimate(
        await state.apiClient.estimateClassicFunding(fundingRequest),
        config,
      );
      resetQuoteAcquireState();
      resetManualPrefundState();
      renderAll();
      refreshManualPrefundBalance({ quiet: true }).catch(() => null);
      notify(`Funding estimate: ${Number(state.classicFundingEstimate.totalSol || 0).toFixed(3)} SOL`);
      return;
    } catch (error) {
      notify(error.message || 'Funding estimate failed');
      return;
    }
  }
  notify('Funding estimates require the Trebuchet desktop app');
}

// Pair tokens are checked as part of funding, automatically: before every
// estimate and readiness check, each pair with a mint and no current result
// is verified quietly. No clicking through per-token verify buttons.
let quoteVerifyInFlight = null;

function pairTokensNeedingCheck() {
  return state.customPools.filter((pool) => {
    if (!String(pool.quoteMint || '').trim() || !customQuoteLookupValue(pool)) return false;
    const record = customQuoteInfoRecord(pool);
    return !record || (!record.loading && !record.info);
  });
}

function autoVerifyQuoteTokens() {
  if (quoteVerifyInFlight) return quoteVerifyInFlight;
  if (state.apiStatus !== 'connected' || !state.apiClient?.getQuoteTokenInfo) return Promise.resolve();
  const pending = pairTokensNeedingCheck();
  if (!pending.length) return Promise.resolve();
  quoteVerifyInFlight = (async () => {
    for (const pool of pending) {
      await resolveCustomQuoteToken(pool.id, { quiet: true }).catch(() => null);
    }
  })().finally(() => {
    quoteVerifyInFlight = null;
    renderAll();
  });
  return quoteVerifyInFlight;
}

// Summary for the Fund page: every pair token and how it will be bought.
function renderPairTokenChecks() {
  const pools = state.customPools.filter((pool) => String(pool.quoteMint || '').trim());
  if (!pools.length) return '';
  const rows = pools.map((pool) => {
    const badge = customQuoteInfoBadge(pool);
    const info = customQuoteResolvedInfo(pool);
    const symbol = info?.symbol || pool.quoteSymbol || shortAddress(pool.quoteMint);
    return { symbol, badge, route: info?.swapRoute || null };
  });
  const problems = rows.filter((row) => row.badge.className === 'danger');
  const checking = rows.some((row) => ['Checking', 'Unverified'].includes(row.badge.label));
  const viaJupiter = rows.filter((row) => row.route === 'jupiter').length;
  const summary = problems.length
    ? `${problems.length} pair token${problems.length === 1 ? '' : 's'} cannot be used`
    : checking
      ? 'Checking pair tokens…'
      : `${rows.length === 1 ? 'The pair token is' : `All ${rows.length} pair tokens are`} real and tradeable${viaJupiter ? ` (${viaJupiter} bought via Jupiter)` : ''}`;
  return `
    <div class="pair-token-checks ${problems.length ? 'has-problems' : ''}">
      <small><i class="fa-solid ${problems.length ? 'fa-triangle-exclamation' : checking ? 'fa-spinner fa-spin' : 'fa-circle-check'}" aria-hidden="true"></i>${escapeHtml(summary)}</small>
      ${problems.length ? `<ul>${problems.map((row) => `<li><strong>${escapeHtml(row.symbol)}</strong> ${escapeHtml(row.badge.label)}: ${escapeHtml(row.badge.detail)}</li>`).join('')}</ul>` : ''}
    </div>`;
}

async function resolveCustomQuoteToken(poolId, { quiet = false } = {}) {
  const say = quiet ? () => {} : notify;
  const pool = state.customPools.find((item) => item.id === poolId);
  if (!pool) {
    say('Custom pool is unavailable');
    return null;
  }
  const query = customQuoteLookupValue(pool);
  const symbol = String(pool.quoteSymbol || '').trim().toUpperCase();
  if (!query || (!pool.quoteMint && !KNOWN_SAFE_QUOTE_SYMBOLS.has(symbol))) {
    say('Enter a quote mint before verifying this custom pool');
    return null;
  }
  if (state.apiStatus !== 'connected' || !state.apiClient?.getQuoteTokenInfo) {
    say('Quote-token verification requires the Trebuchet desktop app');
    return null;
  }

  state.quoteTokenInfo[poolId] = {
    query,
    loading: true,
    info: null,
    error: null,
    checkedAt: null,
  };
  renderPoolEditorPanel();
  renderSupplyEditor();

  try {
    const info = await state.apiClient.getQuoteTokenInfo(query);
    if (!state.customPools.includes(pool) || customQuoteLookupValue(pool) !== query) return null;
    if (info?.demo && pool.quoteSymbol && pool.quoteSymbol !== 'QUOTE') info.symbol = pool.quoteSymbol;
    if (info?.address) pool.quoteMint = info.address;
    if (info?.symbol) pool.quoteSymbol = String(info.symbol).toUpperCase();
    if (optionalDecimals(info?.decimals) !== undefined) pool.quoteDecimals = optionalDecimals(info.decimals);
    state.quoteTokenInfo[poolId] = {
      query: customQuoteLookupValue(pool),
      loading: false,
      info,
      error: null,
      checkedAt: new Date().toISOString(),
    };
    invalidateClassicOutputs();
    refreshClassicPreview({ includePoolEditor: true });
    const badge = customQuoteInfoBadge(pool);
    say(badge.className === 'danger' ? 'Quote token blocked by safety check' : 'Quote token verified');
    return info;
  } catch (error) {
    if (!state.customPools.includes(pool) || customQuoteLookupValue(pool) !== query) return null;
    state.quoteTokenInfo[poolId] = {
      query,
      loading: false,
      info: null,
      error: error.message || 'Quote-token verification failed',
      checkedAt: new Date().toISOString(),
    };
    refreshClassicPreview({ includePoolEditor: true });
    say(state.quoteTokenInfo[poolId].error);
    return null;
  }
}

// Return wallet. Launch assets only go to a proven wallet: the funder of the
// launch wallet (blank = funder), or a wallet that signed a Trebuchet
// challenge in the browser. Addresses are never typed in.
