function phaseState(phase, config) {
  if (phase.id === 'wallet') return state.managedWallets.length ? 'pass' : 'warn';
  if (phase.id === 'vanity') return state.selectedVanityPublicKey ? 'pass' : state.vanityCandidates.length ? 'warn' : 'warn';
  if (phase.id === 'token') return config.token.name && config.token.symbol && config.token.supply ? 'pass' : 'danger';
  if (phase.id === 'pools') return topologyAllocationIssues(config.poolTopology).length ? 'danger' : 'pass';
  if (phase.id === 'funding') {
    const funding = fundingMeterSnapshot(config);
    const quoteAcquireReady = quoteAcquireStatus(config).ready;
    const manualItems = quoteManualPrefundItems();
    const manualSummary = manualPrefundSummary(manualItems);
    const fundingEstimateStatus = classicFundingEstimateStatus(config);
    const fundingEstimateReady = fundingEstimateStatus.matchesConfig;
    const fundingBalanceReady = state.apiStatus === 'connected' && funding.hasWalletBalance === true && funding.walletBalanceFresh === true;
    const fundingSolReady = Number(funding.missingSol || 0) <= 0.001;
    const manualPrefundReady = !manualItems.length || manualSummary.className === '';
    return fundingEstimateReady && fundingBalanceReady && fundingSolReady && quoteAcquireReady && manualPrefundReady
      ? 'pass'
      : 'warn';
  }
  if (phase.id === 'execution') {
    if (state.executionReadiness?.status === 'ready') return 'pass';
    if (state.executionReadiness?.status === 'blocked') return 'danger';
    return 'warn';
  }
  if (phase.id === 'recovery') return state.recovery.activeJournalCount || state.recovery.failedJournalCount ? 'warn' : 'pass';
  if (phase.id === 'sweep') return config.poolTopology.sweepDestination ? 'pass' : 'warn';
  return 'warn';
}

function readinessBadge(readiness) {
  if (!readiness) return { label: 'Unchecked', className: 'warn' };
  if (readiness.status === 'ready') return { label: 'Ready', className: '' };
  return { label: 'Blocked', className: 'danger' };
}

function quoteAcquireRoutes() {
  if (!classicFundingEstimateStatus(currentLaunchConfig()).matchesConfig) return [];
  return Array.isArray(state.classicFundingEstimate?.autoSwapPlan)
    ? state.classicFundingEstimate.autoSwapPlan
    : [];
}

function quoteAcquireFingerprint(config = currentLaunchConfig(), walletPublicKey = selectedLaunchWalletPublicKey()) {
  const fundingEstimateStatus = classicFundingEstimateStatus(config);
  const routes = fundingEstimateStatus.matchesConfig && Array.isArray(state.classicFundingEstimate?.autoSwapPlan)
    ? state.classicFundingEstimate.autoSwapPlan
    : [];
  return JSON.stringify(stableFundingFingerprintValue({
    walletPublicKey: String(walletPublicKey || '').trim() || null,
    fundingFingerprint: fundingEstimateStatus.expectedFingerprint,
    routes,
  }));
}

function quoteAcquireResultMatchesRoute(result, route) {
  if (!result || result.success !== true) return false;
  const routeMint = String(route?.quoteMint || '').trim().toLowerCase();
  const resultMint = String(result?.quoteMint || '').trim().toLowerCase();
  if (routeMint) return Boolean(resultMint && resultMint === routeMint);
  const routeIndex = Number(route?.allocationIndex);
  const resultIndex = Number(result?.allocationIndex);
  return Boolean(Number.isFinite(routeIndex) && Number.isFinite(resultIndex) && routeIndex === resultIndex);
}

function quoteAcquireBlockedPools() {
  return (state.customPools || [])
    .filter((pool) => Number(pool.supplyPercent || 0) > 0)
    .map((pool) => ({ pool, badge: customQuoteInfoBadge(pool) }))
    .filter((item) => item.badge.className === 'danger');
}

function quoteAcquireSafetyCheck() {
  const blocked = quoteAcquireBlockedPools();
  if (!blocked.length) return true;
  const symbols = blocked.map(({ pool }) => pool.quoteSymbol || shortAddress(pool.quoteMint));
  notify(`Resolve ${symbols.join(', ')} on Token & pools before buying pair tokens.`);
  return false;
}

function quoteAcquireSuccessEvidence(routes, job) {
  if (!routes.length) return true;
  const results = Array.isArray(job?.results) ? job.results : [];
  return routes.every((route) => results.some((result) => quoteAcquireResultMatchesRoute(result, route)));
}

function quoteAcquireStatus(config = currentLaunchConfig()) {
  const routes = quoteAcquireRoutes();
  const progress = quoteAcquireProgress();
  const job = state.quoteAcquire.job || null;
  const hasJob = Boolean(job || state.quoteAcquire.jobId);
  const expectedFingerprint = quoteAcquireFingerprint(config);
  const actualFingerprint = String(
    job?.v2QuoteAcquireFingerprint
    || state.quoteAcquire.fingerprint
    || '',
  ).trim();
  const stale = Boolean(routes.length && hasJob && (!actualFingerprint || actualFingerprint !== expectedFingerprint));
  const successEvidence = quoteAcquireSuccessEvidence(routes, job);
  const ready = quoteAcquireBlockedPools().length === 0 && (!routes.length || Boolean(
    job?.status === 'done'
    && !stale
    && successEvidence
    && Number(progress.completed || 0) >= Number(progress.total || routes.length)
    && Number(progress.failed || 0) === 0
  ));
  return {
    routes,
    progress,
    expectedFingerprint,
    actualFingerprint,
    stale,
    successEvidence,
    ready,
  };
}

function quoteAcquireManualCount() {
  if (!classicFundingEstimateStatus(currentLaunchConfig()).matchesConfig) return 0;
  return Object.keys(state.classicFundingEstimate?.byQuote || {}).length;
}

function formatManualPrefundAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return null;
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: amount >= 1 ? 6 : 9,
    minimumFractionDigits: 0,
  }).format(amount);
}

function plainManualPrefundAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return null;
  return amount.toFixed(amount >= 1 ? 6 : 9).replace(/\.?0+$/, '');
}

function parseRawTokenAmount(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) return null;
  try {
    return BigInt(text);
  } catch {
    return null;
  }
}

function formatRawTokenAmount(value, decimals = 0) {
  const raw = parseRawTokenAmount(value);
  if (raw == null) return null;
  const places = Math.max(0, Math.min(19, Math.floor(Number(decimals) || 0)));
  if (!places) return raw.toString();
  const scale = 10n ** BigInt(places);
  const whole = raw / scale;
  const fraction = raw % scale;
  const fractionText = fraction.toString().padStart(places, '0').replace(/0+$/, '');
  return fractionText ? `${whole}.${fractionText}` : whole.toString();
}

function manualPrefundBalanceSnapshotStatus(walletPublicKey = selectedLaunchWalletPublicKey()) {
  const balance = state.manualPrefund.balance && typeof state.manualPrefund.balance === 'object'
    ? state.manualPrefund.balance
    : null;
  const snapshotWalletPublicKey = state.manualPrefund.walletPublicKey || null;
  const checkedAt = state.manualPrefund.lastUpdatedAt || null;
  const checkedAtMs = Date.parse(checkedAt || '');
  const ageMs = Number.isFinite(checkedAtMs) ? Date.now() - checkedAtMs : Infinity;
  const fresh = Boolean(balance && Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= WALLET_BALANCE_FRESH_MS);
  return {
    walletPublicKey,
    snapshotWalletPublicKey,
    balance,
    checkedAt,
    ageMs,
    hasBalance: Boolean(balance),
    matchesWallet: Boolean(walletPublicKey && snapshotWalletPublicKey === walletPublicKey),
    fresh,
    stale: Boolean(balance && !fresh),
  };
}

function manualPrefundTokenBalance(mint) {
  const tokens = state.manualPrefund.balance?.tokens;
  return tokens && typeof tokens === 'object' ? tokens[mint] || null : null;
}

function formatManualPrefundBalance(token) {
  if (!token) return '0';
  const uiAmount = Number(token.amountUi);
  if (Number.isFinite(uiAmount)) return formatManualPrefundAmount(uiAmount) || '0';
  return formatRawTokenAmount(token.amountRaw, token.decimals) || String(token.amountRaw || '0');
}

function manualPrefundStatus(item) {
  const walletPublicKey = selectedLaunchWalletPublicKey();
  const snapshot = manualPrefundBalanceSnapshotStatus(walletPublicKey);
  if (!walletPublicKey) {
    return { label: 'No wallet', className: 'warn', detail: 'Generate or select a launch wallet first.' };
  }
  if (state.apiStatus !== 'connected') {
    return { label: 'Static', className: 'warn', detail: 'Open through the Trebuchet desktop app to check balances.' };
  }
  if (state.manualPrefund.error) {
    return { label: 'Check failed', className: 'danger', detail: state.manualPrefund.error };
  }
  if (snapshot.snapshotWalletPublicKey && !snapshot.matchesWallet) {
    return {
      label: 'Check balance',
      className: 'warn',
      detail: 'Balance snapshot belongs to another launch wallet; recheck the selected launch wallet.',
    };
  }
  if (!snapshot.hasBalance) {
    return {
      label: state.manualPrefund.polling ? 'Checking' : 'Not checked',
      className: 'warn',
      detail: state.manualPrefund.polling ? 'Reading the selected wallet balance.' : 'Click Check balance or wait for the live poll.',
    };
  }
  if (!snapshot.fresh) {
    return {
      label: state.manualPrefund.polling ? 'Checking' : 'Recheck',
      className: 'warn',
      detail: 'Balance snapshot is stale; wait for the live poll or click Check balance.',
    };
  }

  const token = manualPrefundTokenBalance(item.mint);
  const requiredRaw = parseRawTokenAmount(item.rawAmount);
  const currentRaw = parseRawTokenAmount(token?.amountRaw ?? '0') ?? 0n;
  const need = formatManualPrefundAmount(item.amount)
    || (requiredRaw == null ? item.rawAmount : formatRawTokenAmount(requiredRaw.toString(), token?.decimals))
    || 'unknown';
  const have = formatManualPrefundBalance(token);

  if (requiredRaw == null) {
    return token
      ? { label: 'Seen', className: 'warn', detail: `Wallet has ${have}; compare against raw requirement ${item.rawAmount || 'unknown'}.` }
      : { label: 'Missing', className: 'danger', detail: `No ${item.symbol} token balance found in the selected wallet.` };
  }
  if (currentRaw >= requiredRaw) {
    return { label: 'Funded', className: '', detail: `Wallet has ${have}; needs ${need}.` };
  }
  const shortRaw = requiredRaw - currentRaw;
  const short = formatRawTokenAmount(shortRaw.toString(), token?.decimals) || `${shortRaw.toString()} raw`;
  return { label: 'Short', className: 'danger', detail: `Wallet has ${have}; needs ${need}. Short ${short}.` };
}

function manualPrefundSummary(items) {
  if (state.manualPrefund.error) return { label: 'Check failed', className: 'danger' };
  if (!items.length) return { label: 'None', className: '' };
  const snapshot = manualPrefundBalanceSnapshotStatus();
  if (!snapshot.hasBalance) {
    return { label: state.manualPrefund.polling ? 'Checking' : 'Check balance', className: 'warn' };
  }
  const statuses = items.map((item) => manualPrefundStatus(item));
  const shortCount = statuses.filter((item) => item.className === 'danger').length;
  if (shortCount) return { label: `${shortCount} short`, className: 'danger' };
  const warningCount = statuses.filter((item) => item.className === 'warn').length;
  if (warningCount) return { label: `${warningCount} verify`, className: 'warn' };
  return { label: `${items.length}/${items.length} funded`, className: '' };
}

function quoteManualPrefundItems() {
  if (!classicFundingEstimateStatus(currentLaunchConfig()).matchesConfig) return [];
  const estimate = state.classicFundingEstimate || {};
  const byQuote = estimate.byQuote && typeof estimate.byQuote === 'object'
    ? estimate.byQuote
    : {};
  const breakdown = Array.isArray(estimate.quoteBreakdown)
    ? estimate.quoteBreakdown
    : [];
  const rowsByMint = new Map();
  breakdown.forEach((row) => {
    const mint = String(row?.mint || '').trim();
    if (!mint) return;
    if (!rowsByMint.has(mint)) rowsByMint.set(mint, []);
    rowsByMint.get(mint).push(row);
  });

  const mints = new Set([
    ...Object.keys(byQuote),
    ...rowsByMint.keys(),
  ].filter(Boolean));

  return [...mints].map((mint) => {
    const rows = rowsByMint.get(mint) || [];
    const amount = rows.reduce((sum, row) => {
      const value = Number(row?.amount);
      return Number.isFinite(value) ? sum + value : sum;
    }, 0);
    const symbol = rows.find((row) => row?.symbol)?.symbol || shortAddress(mint);
    return {
      mint,
      rawAmount: byQuote[mint] == null ? null : String(byQuote[mint]),
      symbol,
      amount: amount > 0 ? amount : null,
      rows,
    };
  });
}

function quoteAcquireProgress() {
  const job = state.quoteAcquire.job;
  const total = Number(job?.total || quoteAcquireRoutes().length || 0);
  const completed = Number(job?.completed || 0);
  const failed = Array.isArray(job?.results)
    ? job.results.filter((row) => row && row.success === false).length
    : 0;
  const percent = total > 0 ? clampPercent((completed / total) * 100) : 0;
  return { total, completed, failed, percent };
}

function quoteAcquireBadge() {
  const { total, completed, failed } = quoteAcquireProgress();
  const status = quoteAcquireStatus();
  const fundingEstimateStatus = classicFundingEstimateStatus(currentLaunchConfig());
  const saved = state.quoteAcquire.job;
  if (saved?.walletPublicKey === selectedLaunchWalletPublicKey()) {
    if (saved.status === 'recovery_required') return { label: 'Recover funds', className: 'warn' };
    if (saved.status === 'paused') return { label: 'Resume', className: 'warn' };
    if (saved.status === 'review_required') return { label: 'Review quote', className: 'warn' };
  }
  if (fundingEstimateStatus.stale) return { label: 'Re-estimate', className: 'warn' };
  if (!fundingEstimateStatus.hasEstimate) return { label: 'Estimate', className: 'warn' };
  const blocked = quoteAcquireBlockedPools();
  if (blocked.length) return { label: `${blocked.length} blocked`, className: 'danger' };
  if (state.quoteAcquire.error) return { label: 'Error', className: 'danger' };
  if (status.stale) return { label: 'Stale', className: 'warn' };
  if (state.quoteAcquire.running || state.quoteAcquire.job?.status === 'running') return { label: `${completed}/${total}`, className: 'warn' };
  if (state.quoteAcquire.job?.status === 'done') {
    if (failed) return { label: `${failed} failed`, className: 'danger' };
    return status.ready ? { label: 'Done', className: '' } : { label: 'Verify', className: 'warn' };
  }
  if (quoteAcquireRoutes().length > 0) return { label: 'Ready', className: '' };
  if (quoteAcquireManualCount() > 0) return { label: 'Manual', className: 'warn' };
  return { label: 'None', className: '' };
}

function quoteAcquireRouteLabel(route) {
  const symbol = route?.quoteSymbol || route?.quoteMint || 'Quote';
  const pool = Number.isFinite(Number(route?.allocationIndex))
    ? `Pool ${Number(route.allocationIndex) + 1}`
    : 'Pool';
  const spend = Number(route?.estSolSpend || 0);
  return `${symbol} / ${pool}${spend > 0 ? ` / ~${spend.toFixed(3)} SOL` : ''}`;
}

function quoteKey(value) {
  return String(value || '').trim().toLowerCase();
}

function sameQuoteIdentity(a, b) {
  return quoteKey(a) && quoteKey(a) === quoteKey(b);
}

function findQuoteRouteForPool(pool, poolIndex, routes = quoteAcquireRoutes()) {
  return routes.find((route) => Number(route?.allocationIndex) === poolIndex)
    || routes.find((route) => sameQuoteIdentity(route?.quoteMint, pool.quoteMint))
    || routes.find((route) => sameQuoteIdentity(route?.quoteSymbol, pool.quoteSymbol));
}

function findManualPrefundForPool(pool, items = quoteManualPrefundItems()) {
  return items.find((item) => sameQuoteIdentity(item.mint, pool.quoteMint))
    || items.find((item) => sameQuoteIdentity(item.symbol, pool.quoteSymbol));
}

function quotePoolGuidanceItems() {
  const topology = currentClassicModel();
  const routes = quoteAcquireRoutes();
  const manualItems = quoteManualPrefundItems();
  const hasEstimate = classicFundingEstimateStatus(currentLaunchConfig()).matchesConfig;

  return topology.pools
    .map((pool, poolIndex) => ({ pool, poolIndex }))
    .filter(({ pool }) => String(pool.quoteSymbol || pool.quoteToken || '').toUpperCase() !== 'SOL')
    .map(({ pool, poolIndex }) => {
      const quoteSymbol = String(pool.quoteSymbol || pool.quoteToken || `Q${poolIndex + 1}`).trim().toUpperCase();
      const quoteMint = String(pool.quoteMint || '').trim();
      const route = findQuoteRouteForPool(pool, poolIndex, routes);
      const manual = findManualPrefundForPool(pool, manualItems);
      const displayAmount = manual ? formatManualPrefundAmount(manual.amount) : null;
      const venue = Object.values(CLASSIC_QUOTE_VENUES).find((item) => `${item.key}-flywheel` === pool.id);
      const label = venue ? venue.label : `Pool ${poolIndex + 1} ${quoteSymbol}`;

      if (!quoteMint) {
        return {
          label,
          quoteSymbol,
          quoteMint,
          supplyPercent: pool.supplyPercent,
          status: 'missing',
          badge: 'Needs mint',
          className: 'danger',
          icon: 'fa-triangle-exclamation',
          detail: 'Add the quote mint before estimating or launching this pool.',
        };
      }
      const safetyBadge = customQuoteInfoBadge(pool);
      if (safetyBadge.className === 'danger') {
        return {
          label,
          quoteSymbol,
          quoteMint,
          supplyPercent: pool.supplyPercent,
          status: 'blocked',
          badge: safetyBadge.label,
          className: 'danger',
          icon: 'fa-triangle-exclamation',
          detail: safetyBadge.detail,
        };
      }
      if (!hasEstimate) {
        return {
          label,
          quoteSymbol,
          quoteMint,
          supplyPercent: pool.supplyPercent,
          status: 'estimate',
          badge: 'Estimate',
          className: 'warn',
          icon: 'fa-magnifying-glass-chart',
          detail: 'Run estimate to decide whether Trebuchet can acquire this token from SOL.',
        };
      }
      if (route) {
        return {
          label,
          quoteSymbol,
          quoteMint,
          supplyPercent: pool.supplyPercent,
          status: 'auto',
          badge: 'Auto acquire',
          className: '',
          icon: 'fa-route',
          detail: quoteAcquireRouteLabel(route),
        };
      }
      if (manual) {
        return {
          label,
          quoteSymbol,
          quoteMint,
          supplyPercent: pool.supplyPercent,
          status: 'manual',
          badge: 'Manual prefund',
          className: 'warn',
          icon: 'fa-wallet',
          detail: displayAmount
            ? `Send ${displayAmount} ${manual.symbol || quoteSymbol} to the selected launch wallet.`
            : `Send the required ${manual.symbol || quoteSymbol} raw amount to the selected launch wallet.`,
        };
      }
      return {
        label,
        quoteSymbol,
        quoteMint,
        supplyPercent: pool.supplyPercent,
        status: 'covered',
        badge: 'Covered',
        className: '',
        icon: 'fa-circle-check',
        detail: 'Estimator did not require extra quote-token funding for this pool.',
      };
    });
}

function renderQuotePoolGuidance() {
  const items = quotePoolGuidanceItems();
  if (!items.length) return '';
  const fundingEstimateStatus = classicFundingEstimateStatus(currentLaunchConfig());
  const autoCount = items.filter((item) => item.status === 'auto').length;
  const manualCount = items.filter((item) => item.status === 'manual').length;
  const blockedCount = items.filter((item) => ['missing', 'blocked'].includes(item.status)).length;
  const estimateCount = items.filter((item) => item.status === 'estimate').length;
  const badge = blockedCount
    ? { label: `${blockedCount} blocked`, className: 'danger' }
    : estimateCount
      ? { label: 'Estimate', className: 'warn' }
      : manualCount
        ? { label: `${manualCount} manual`, className: 'warn' }
        : autoCount
          ? { label: `${autoCount} auto`, className: '' }
          : { label: 'Covered', className: '' };
  const detail = fundingEstimateStatus.stale
    ? 'Funding estimate is stale for this launch model; rerun it before acquiring quote tokens.'
    : fundingEstimateStatus.matchesConfig
      ? 'Every non-SOL pool is classified by the current funding estimate.'
      : 'Run the estimate before launch so flywheel quote-token funding is explicit.';

  return `
    <div class="quote-guidance-panel">
      <div class="quote-guidance-head">
        <span>
          <span class="eyebrow">Flywheel quote tokens</span>
          <h3>Acquire map</h3>
          <p>${escapeHtml(detail)}</p>
        </span>
        <span class="risk-badge ${escapeHtml(badge.className)}">${escapeHtml(badge.label)}</span>
      </div>
      <div class="quote-guidance-list">
        ${items.map((item) => `
          <article class="${escapeHtml(item.className)}">
            <i class="fa-solid ${escapeHtml(item.icon)}"></i>
            <span>
              <strong>${escapeHtml(item.label)} <em>${formatPercent(item.supplyPercent)}%</em></strong>
              <small>${escapeHtml(item.detail)}</small>
            </span>
            <code title="${escapeHtml(item.quoteMint || 'Quote mint missing')}">${escapeHtml(item.quoteMint ? shortAddress(item.quoteMint) : 'No mint')}</code>
            <span class="risk-badge ${escapeHtml(item.className)}">${escapeHtml(item.badge)}</span>
          </article>
        `).join('')}
      </div>
    </div>
  `;
}

function renderManualPrefundPanel() {
  const items = quoteManualPrefundItems();
  if (!classicFundingEstimateStatus(currentLaunchConfig()).matchesConfig || !items.length) return '';
  const walletPublicKey = selectedLaunchWalletPublicKey();
  const summary = manualPrefundSummary(items);
  const canCheck = state.apiStatus === 'connected' && Boolean(walletPublicKey) && !state.manualPrefund.polling;
  const checkedLabel = state.manualPrefund.lastUpdatedAt
    ? `Checked ${formatDate(state.manualPrefund.lastUpdatedAt)}`
    : (state.apiStatus === 'connected' ? 'Awaiting balance check' : 'Static preview');
  return `
    <div class="manual-prefund-panel">
      <div class="manual-prefund-head">
        <span>
          <span class="eyebrow">Manual prefund checklist</span>
          <h3>Send quote tokens to launch wallet</h3>
          <p>${escapeHtml(checkedLabel)}</p>
        </span>
        <span class="manual-prefund-head-actions">
          <span class="risk-badge ${escapeHtml(summary.className)}">${escapeHtml(summary.label)}</span>
          <button class="pill-button" type="button" data-action="refresh-manual-prefund" ${canCheck ? '' : 'disabled'}>
            ${state.manualPrefund.polling ? 'Checking' : 'Check balance'}
          </button>
        </span>
      </div>
      <div class="manual-prefund-wallet">
        <span>
          <small>Destination wallet</small>
          <code>${walletPublicKey ? escapeHtml(walletPublicKey) : 'Generate or select a launch wallet first'}</code>
        </span>
        <button class="pill-button" type="button" data-action="copy-manual-prefund" data-copy="wallet" ${walletPublicKey ? '' : 'disabled'}>
          <i class="fa-solid fa-copy"></i><span>Copy wallet</span>
        </button>
      </div>
      <div class="manual-prefund-list">
        ${items.map((item) => {
          const displayAmount = formatManualPrefundAmount(item.amount);
          const copyAmount = plainManualPrefundAmount(item.amount) || item.rawAmount || '';
          const status = manualPrefundStatus(item);
          const lineItems = item.rows.length
            ? item.rows.map((row) => `
              <li>
                <span>${escapeHtml(row.label || 'Quote prefund')}</span>
                <strong>${escapeHtml(formatManualPrefundAmount(row.amount) || String(row.amount || ''))} ${escapeHtml(row.symbol || item.symbol)}</strong>
              </li>
            `).join('')
            : `<li><span>Aggregate raw amount</span><strong>${escapeHtml(item.rawAmount || 'unknown')}</strong></li>`;
          return `
            <article class="manual-prefund-row">
              <span class="manual-prefund-token">
                <strong>${escapeHtml(copyAmount || 'Amount')} ${escapeHtml(item.symbol)}</strong>
                <code>${escapeHtml(item.mint)}</code>
              </span>
              <span class="manual-prefund-actions">
                <span class="risk-badge ${escapeHtml(status.className)}">${escapeHtml(status.label)}</span>
                <button class="pill-button" type="button" data-action="copy-manual-prefund" data-copy="amount" data-mint="${escapeHtml(item.mint)}" ${copyAmount ? '' : 'disabled'}>Amount</button>
                <button class="pill-button" type="button" data-action="copy-manual-prefund" data-copy="mint" data-mint="${escapeHtml(item.mint)}">Mint</button>
              </span>
              <p class="manual-prefund-status">${escapeHtml(status.detail)}</p>
              <ul>${lineItems}</ul>
            </article>
          `;
        }).join('')}
      </div>
    </div>
  `;
}

function renderQuoteAcquirePanel() {
  const routes = quoteAcquireRoutes();
  const blocked = quoteAcquireBlockedPools();
  const manualCount = quoteAcquireManualCount();
  const fundingEstimateStatus = classicFundingEstimateStatus(currentLaunchConfig());
  const hasCurrentEstimate = fundingEstimateStatus.matchesConfig;
  const acquireStatus = quoteAcquireStatus();
  const badge = quoteAcquireBadge();
  const { total, completed, failed, percent } = quoteAcquireProgress();
  const job = state.quoteAcquire.job;
  const rows = Array.isArray(job?.results) && job.results.length
    ? job.results.map((result) => `
      <article class="${result.success === false ? 'danger' : ''}">
        <i class="fa-solid ${result.success === false ? 'fa-triangle-exclamation' : 'fa-circle-check'}"></i>
        <span>
          <strong>${escapeHtml(result.quoteSymbol || result.quoteMint || 'Quote')}</strong>
          <small>${escapeHtml(result.success === false ? (result.error || 'Swap failed') : (result.txId || 'Already funded'))}</small>
        </span>
      </article>
    `).join('')
    : routes.slice(0, 4).map((route) => `
      <article>
        <i class="fa-solid fa-route"></i>
        <span>
          <strong>${escapeHtml(quoteAcquireRouteLabel(route))}</strong>
          <small>${escapeHtml(shortAddress(route.quoteMint || ''))}</small>
        </span>
      </article>
    `).join('');
  const savedAction = ['review_required', 'paused', 'recovery_required'].includes(job?.status) && job.walletPublicKey === selectedLaunchWalletPublicKey();
  const detail = savedAction ? (job.status === 'recovery_required' ? 'Review cleanup for the saved quote purchase.' : job.status === 'paused' ? 'Resume the saved purchase and verify its original receipts.' : 'Review the saved quote and its complete spending ceiling.')
    : fundingEstimateStatus.stale
    ? 'Funding estimate is stale for this launch model; rerun it before acquiring quote tokens.'
    : blocked.length
      ? `Resolve ${blocked.map(({ pool }) => pool.quoteSymbol || shortAddress(pool.quoteMint)).join(', ')} on Token & pools before buying pair tokens.`
    : acquireStatus.stale
      ? 'Previous quote acquire belongs to another wallet or launch model; run it again for the selected launch wallet.'
      : hasCurrentEstimate
      ? (routes.length
        ? `${routes.length} route${routes.length === 1 ? '' : 's'} can be auto-acquired from the launch wallet.`
        : manualCount
          ? `${manualCount} quote token${manualCount === 1 ? '' : 's'} require manual prefund.`
          : 'No quote-token acquire needed for this launch plan.')
      : 'Run the funding estimate to discover quote-token acquire routes.';
  const canStart = state.apiStatus === 'connected'
    && Boolean(selectedLaunchWalletPublicKey())
    && (routes.length > 0 || savedAction)
    && blocked.length === 0
    && !state.quoteAcquire.running;
  const startLabel = state.quoteAcquire.running
    ? 'Acquiring'
    : blocked.length ? 'Resolve pair block'
    : savedAction ? (job.status === 'recovery_required' ? 'Recover funds' : job.status === 'paused' ? 'Resume purchase' : 'Review quote') : state.quoteAcquire.job?.status === 'done' ? 'Run again' : 'Acquire';
  const button = state.quoteAcquire.running
    ? `<button class="pill-button" type="button" data-action="poll-quote-acquire">Refresh</button>`
    : `<button class="pill-button" type="button" data-action="${hasCurrentEstimate || savedAction ? 'start-quote-acquire' : 'estimate-funding'}" ${canStart || !hasCurrentEstimate ? '' : 'disabled'}>${escapeHtml(savedAction ? startLabel : fundingEstimateStatus.stale ? 'Re-estimate' : hasCurrentEstimate ? startLabel : 'Estimate')}</button>`;
  const clear = state.quoteAcquire.jobId && !state.quoteAcquire.running && !['paused', 'recovery_required'].includes(job?.status)
    ? '<button class="pill-button" type="button" data-action="clear-quote-acquire">Clear</button>'
    : '';

  return `
    <div class="quote-acquire-panel">
      <div class="quote-acquire-head">
        <span>
          <span class="eyebrow">Quote-token acquire</span>
          <h3>Funding step</h3>
          <p>${escapeHtml(detail)}</p>
        </span>
        <span class="risk-badge ${escapeHtml(badge.className)}">${escapeHtml(badge.label)}</span>
      </div>
      <div class="quote-acquire-progress">
        <span style="width:${percent}%"></span>
      </div>
      <div class="quote-acquire-stats">
        <span><small>Routes</small><strong>${routes.length}</strong></span>
        <span><small>Manual</small><strong>${manualCount}</strong></span>
        <span><small>Complete</small><strong>${completed}/${total}</strong></span>
        <span><small>Failed</small><strong>${failed}</strong></span>
      </div>
      ${renderQuotePoolGuidance()}
      <div class="quote-acquire-feed">
        ${rows || '<article><i class="fa-solid fa-wallet"></i><span><strong>No route rows yet</strong><small>Estimate funding first</small></span></article>'}
      </div>
      <div class="operator-toolbar compact">${button}${clear}</div>
      ${renderManualPrefundPanel()}
      ${state.quoteAcquire.error ? `<p class="quote-acquire-error">${escapeHtml(state.quoteAcquire.error)}</p>` : ''}
    </div>
  `;
}
