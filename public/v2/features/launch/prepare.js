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

// Grinds are jobs: the one running, the ones queued behind it, and the ones that ended with
// their stats until dismissed. One runs at a time; each takes every core.
let grindJobSeq = 0;

function grindJobTarget(job) {
  return job.prefix && job.suffix ? `${job.prefix}...${job.suffix}` : job.prefix || job.suffix || `${job.length}-character`;
}

function runningGrindJob() {
  return (state.grindJobs || []).find((job) => job.status === 'running') || null;
}

// The Grind button: queue the typed pattern, and start it when nothing is running.
async function startVanityGrind() {
  const vanity = currentVanityConfig();
  if (!vanity.prefix && !vanity.suffix) {
    setLaunchWorkspace('configure');
    state.vanityInputError = 'Enter a Vanity CA start or end before grinding.';
    renderVanityCandidates();
    const input = $('#vanityStart');
    input?.setAttribute('aria-invalid', 'true');
    window.requestAnimationFrame?.(() => input?.focus());
    return;
  }
  state.vanityInputError = null;
  $('#vanityStart')?.removeAttribute('aria-invalid');
  $('#vanityEnd')?.removeAttribute('aria-invalid');
  const estimate = vanityPatternEstimate(vanity.prefix, vanity.suffix, null);
  if (estimate.invalid.length || estimate.difficulty === 'impossible') {
    renderVanityCandidates();
    return;
  }

  if (state.apiStatus === 'connected' && state.secretPin.locked) {
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

  grindJobSeq += 1;
  const job = {
    id: `grind-${Date.now()}-${grindJobSeq}`,
    prefix: vanity.prefix || '',
    suffix: vanity.suffix || '',
    caseInsensitive: vanity.caseInsensitive === true,
    length: vanity.length || null,
    expected: estimate.expectedAttempts,
    status: 'queued',
    attempts: 0,
    rate: null,
  };
  job.target = grindJobTarget(job);
  state.grindJobs = [...(state.grindJobs || []), job];
  if (!runningGrindJob()) runNextGrindJob();
  renderAll();
}

function runNextGrindJob() {
  const next = (state.grindJobs || []).find((job) => job.status === 'queued');
  if (next) runVanityGrind(next).catch((error) => finishGrindJob(next, 'failed', { error: error.message || 'Grind failed' }));
}

function finishGrindJob(job, status, extra = {}) {
  if (job.status !== 'running' && job.status !== 'queued') return;
  if (state.vanitySource) { state.vanitySource.close(); state.vanitySource = null; }
  Object.assign(job, { status, endedAt: Date.now(), ...extra });
  state.vanityRunning = false;
  state.vanityProgress = null;
  state.vanityProgressStats = null;
  runNextGrindJob();
  renderAll();
}

// Stop the running job (its stats stay), or take a queued one out of the queue.
async function stopGrindJob(id) {
  const job = (state.grindJobs || []).find((item) => item.id === id);
  if (!job) return;
  if (job.status === 'queued') {
    state.grindJobs = state.grindJobs.filter((item) => item !== job);
    renderAll();
    return;
  }
  if (job.status !== 'running') return;
  finishGrindJob(job, 'stopped');
  if (state.apiStatus === 'connected' && state.apiClient?.cancelVanityGrind) {
    await state.apiClient.cancelVanityGrind().catch(() => null);
  }
}

function dismissGrindJob(id) {
  state.grindJobs = (state.grindJobs || []).filter((job) => job.id !== id || ['queued', 'running'].includes(job.status));
  renderAll();
}

// Measure this computer's speed: 3 seconds of the real grinder, nothing saved.
async function calibrateVanity() {
  if (state.vanityCalibrating || runningGrindJob() || !state.apiClient?.calibrateVanity) return;
  state.vanityCalibrating = true;
  state.vanityCalibrationError = null;
  renderVanityCandidates();
  try {
    const { calibration } = await state.apiClient.calibrateVanity();
    rememberVanityRate(calibration.rate);
  } catch (error) {
    state.vanityCalibrationError = error.message || 'Calibration failed';
  } finally {
    state.vanityCalibrating = false;
    renderVanityCandidates();
  }
}

async function runVanityGrind(job) {
  job.status = 'running';
  job.startedAt = Date.now();
  state.vanityRunning = true;
  state.vanityProgress = 'Starting';
  state.vanityProgressStats = {
    expectedAttempts: job.expected,
    startedAt: Date.now(),
    attempts: 0,
    rate: null,
    samples: [],
    caseInsensitive: job.caseInsensitive,
    length: job.length,
  };
  renderAll();

  const token = await state.apiClient.getSessionToken();
  if (job.status !== 'running') return;
  const params = new URLSearchParams({ token, client: 'v2' });
  if (job.prefix) params.set('prefix', job.prefix);
  if (job.caseInsensitive) params.set('caseInsensitive', '1');
  if (job.length) params.set('length', String(job.length));
  // Split-key: the grinder only sees a public point; ~30x faster too.
  params.set('split', '1');
  if (job.suffix) params.set('suffix', job.suffix);
  const source = new EventSource(`/api/generate-vanity-wallet-stream?${params.toString()}`);
  state.vanitySource = source;
  source.addEventListener('message', (event) => {
    if (job.status !== 'running') return;
    let data;
    try { data = JSON.parse(event.data); } catch { return; }
    if (data.type === 'start') {
      job.expected = Number(data.expected || job.expected);
      state.vanityProgressStats = { ...state.vanityProgressStats, expectedAttempts: job.expected };
      // An older server ignores the flag and grinds exact case.
      if (job.caseInsensitive && data.caseInsensitive !== true) job.caseInsensitive = false;
    } else if (data.type === 'progress') {
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
      if (windowSeconds >= 2) rememberVanityRate(rate);
      state.vanityProgressStats = { ...prior, updatedAt: now, attempts: attemptsNow, rate, samples };
      job.attempts = attemptsNow;
      job.rate = rate;
    } else if (data.type === 'done') {
      addVanityCandidate({
        publicKey: data.wallet.publicKey,
        target: data.wallet.target || null,
        prefix: data.wallet.prefix || job.prefix || null,
        suffix: data.wallet.suffix || job.suffix || null,
        mode: data.wallet.mode || (job.prefix && job.suffix ? 'both' : job.prefix ? 'prefix' : 'suffix'),
        caseInsensitive: data.wallet.caseInsensitive === true,
        addressLength: data.wallet.addressLength || null,
        keyType: data.wallet.keyType || 'seed',
        rarity: data.wallet.rarity || null,
        attempts: data.wallet.attempts || null,
        persisted: data.wallet.persisted === true,
      });
      finishGrindJob(job, 'found', { attempts: Number(data.wallet.attempts) || job.attempts, publicKey: data.wallet.publicKey });
      return;
    } else if (data.type === 'cancelled') {
      finishGrindJob(job, 'stopped');
      return;
    } else if (data.type === 'error') {
      finishGrindJob(job, 'failed', { error: data.error || 'Grind failed' });
      return;
    }
    renderVanityCandidates();
    renderClassicBridge();
  });
  source.addEventListener('error', () => {
    finishGrindJob(job, 'failed', { error: 'The grind stream closed' });
  });
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

// A pair token is checked automatically once; a check that failed is tried again after a minute,
// not on every readiness check (each one scans the chain for the token's pools).
const PAIR_TOKEN_RECHECK_MS = 60 * 1000;
function pairTokensNeedingCheck(now = Date.now()) {
  return state.customPools.filter((pool) => {
    if (!String(pool.quoteMint || '').trim() || !customQuoteLookupValue(pool)) return false;
    const record = customQuoteInfoRecord(pool);
    if (!record) return true;
    if (record.loading || record.info) return false;
    const failedAt = Date.parse(record.checkedAt || '');
    return !Number.isFinite(failedAt) || now - failedAt >= PAIR_TOKEN_RECHECK_MS;
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
