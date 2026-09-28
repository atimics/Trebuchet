function safeRpcUrl(value) {
  const text = String(value || '').trim();
  if (!text) return 'No RPC';
  try {
    const parsed = new URL(text);
    const maskedSearch = parsed.search ? '?...' : '';
    return `${parsed.protocol}//${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}${maskedSearch}`;
  } catch {
    return shortAddress(text);
  }
}

function isPublicRpcUrl(value) {
  try {
    const host = new URL(value).hostname.replace(/^www\./, '');
    return new Set([
      'api.mainnet-beta.solana.com',
      'solana-api.projectserum.com',
      'rpc.ankr.com',
      'solana.public-rpc.com',
    ]).has(host);
  } catch {
    return false;
  }
}

function formatDate(value) {
  if (!value) return 'Unknown';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatDiscoveryPrice(value) {
  const price = Number(value);
  if (!Number.isFinite(price)) return 'No indexed price';
  return `$${new Intl.NumberFormat(undefined, {
    maximumFractionDigits: price < 0.000001 ? 12 : price < 0.01 ? 8 : price < 1 ? 6 : 4,
  }).format(price)}`;
}

function formatDiscoveryUsd(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '—';
  return `$${new Intl.NumberFormat(undefined, {
    notation: Math.abs(amount) >= 1000 ? 'compact' : 'standard',
    maximumFractionDigits: Math.abs(amount) >= 1000 ? 2 : 0,
  }).format(amount)}`;
}

function formatDiscoveryPercent(value, fallback = '—') {
  const percent = Number(value);
  if (!Number.isFinite(percent)) return fallback;
  const sign = percent > 0 ? '+' : '';
  return `${sign}${percent.toFixed(Math.abs(percent) >= 100 ? 0 : 2)}%`;
}

function discoveryTrendClass(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number === 0) return 'is-flat';
  return number > 0 ? 'is-up' : 'is-down';
}

function discoveryTokenImageSource(url) {
  const value = String(url || '').trim();
  if (!value) return '';
  if (/^(data:|blob:|\/)/i.test(value)) return value;
  return `/api/proxy-image?url=${encodeURIComponent(value)}`;
}

function discoveryDisplayToken(token = {}) {
  const saved = (state.discovery.records || []).find((record) => record.mint === token.mint) || {};
  return {
    ...saved,
    ...token,
    name: token.name || saved.name,
    symbol: token.symbol || saved.symbol,
    imageUrl: token.imageUrl || saved.imageUrl,
  };
}

// Same colors as the coin cards: hue from the address.
function discoveryFallbackPalette(token = {}) {
  const hue = coinAddressHue(token.mint || token.symbol || token.name || 'trebuchet');
  const primary = launchIdentityHslToRgb([hue / 360, 0.72, 0.6]);
  const accent = launchIdentityHslToRgb([((hue + 137) % 360) / 360, 0.66, 0.6]);
  return {
    primary,
    accent,
    primaryHex: launchIdentityRgbHex(primary),
    accentHex: launchIdentityRgbHex(accent),
  };
}

function discoveryTokenPalette(token = {}) {
  return state.discovery.paletteByMint?.[token.mint] || discoveryFallbackPalette(token);
}

function discoveryPaletteAttributes(token = {}) {
  const palette = discoveryTokenPalette(token);
  const imageUrl = String(token.imageUrl || '').trim();
  return `data-token-palette="${escapeHtml(token.mint || token.symbol || token.name || '')}"${imageUrl ? ` data-token-image="${escapeHtml(imageUrl)}"` : ''} style="--token-primary:${escapeHtml(palette.primaryHex)};--token-accent:${escapeHtml(palette.accentHex)}"`;
}

function applyDiscoveryPalette(mint, palette) {
  $$('[data-token-palette]').forEach((node) => {
    if (node.dataset.tokenPalette !== mint) return;
    node.style.setProperty('--token-primary', palette.primaryHex);
    node.style.setProperty('--token-accent', palette.accentHex);
  });
}

function hydrateDiscoveryTokenPalettes() {
  $$('[data-token-palette]').forEach((node) => {
    const mint = node.dataset.tokenPalette;
    const imageUrl = node.dataset.tokenImage;
    const cached = state.discovery.paletteByMint?.[mint] || COIN_PALETTES.get(discoveryTokenImageSource(imageUrl));
    if (cached) applyDiscoveryPalette(mint, cached);
    if (!mint || !imageUrl || cached || state.discovery.palettePending.has(mint)) return;
    state.discovery.palettePending.add(mint);
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => {
      const palette = extractLaunchIdentityArt(image).palette;
      state.discovery.paletteByMint[mint] = palette;
      COIN_PALETTES.set(discoveryTokenImageSource(imageUrl), palette);
      state.discovery.palettePending.delete(mint);
      applyDiscoveryPalette(mint, palette);
    };
    image.onerror = () => state.discovery.palettePending.delete(mint);
    image.src = discoveryTokenImageSource(imageUrl);
  });
  $$('.token-mark img').forEach((image) => {
    image.addEventListener('error', () => image.remove(), { once: true });
  });
}

function discoveryTokenMark(rawToken, className = '') {
  const token = discoveryDisplayToken(rawToken);
  const fallback = escapeHtml(String(token?.symbol || token?.name || '--').slice(0, 2).toUpperCase());
  const image = token?.imageUrl
    ? `<img src="${escapeHtml(discoveryTokenImageSource(token.imageUrl))}" alt="" loading="lazy">`
    : '';
  return `<span class="token-mark ${className}" ${discoveryPaletteAttributes(token)}><span class="token-initials">${fallback}</span>${image}</span>`;
}

function discoveryPriceChart(market) {
  const points = Array.isArray(market?.history?.points)
    ? market.history.points
      .map((point) => ({
        time: point?.time,
        close: Number(point?.close),
      }))
      .filter((point) => point.time && Number.isFinite(point.close) && point.close > 0)
    : [];
  if (points.length < 2) return '';

  const width = 320;
  const height = 108;
  const inset = 5;
  const prices = points.map((point) => point.close);
  const low = Math.min(...prices);
  const high = Math.max(...prices);
  const span = high - low || Math.max(high * 0.01, 1e-12);
  const coordinates = points.map((point, index) => {
    const x = inset + (index / (points.length - 1)) * (width - inset * 2);
    const y = inset + ((high - point.close) / span) * (height - inset * 2);
    return [x, y];
  });
  const line = coordinates
    .map(([x, y], index) => `${index ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`)
    .join(' ');
  const area = `${line} L${coordinates.at(-1)[0].toFixed(2)},${height} L${coordinates[0][0].toFixed(2)},${height} Z`;
  const trend = market.history?.changePercent ?? market.priceChange?.h24;
  const label = `${market.history?.timeframe || '7 day'} price history, ${formatDiscoveryPercent(trend, 'unchanged')}`;

  return `
    <svg class="market-sparkline ${discoveryTrendClass(trend)}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="${escapeHtml(label)}">
      <path class="market-sparkline-area" d="${area}"></path>
      <path class="market-sparkline-line" d="${line}"></path>
    </svg>
  `;
}

function formatAge(value) {
  const timestamp = Date.parse(value || '');
  if (!Number.isFinite(timestamp)) return 'Unknown age';
  const elapsed = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(elapsed / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function humanizeStage(value) {
  return String(value || 'unknown').replaceAll('_', ' ');
}

function progressEventLabel(event) {
  const pool = Number.isFinite(Number(event?.allocationIndex))
    ? `Pool ${Number(event.allocationIndex) + 1}`
    : 'Pool';
  const stage = String(event?.stage || '');
  if (stage === 'pool_create_done') return `${pool} created`;
  if (stage === 'main_open_done') return `${pool} slice ${Number(event.sliceIndex || 0) + 1} opened`;
  if (stage === 'ladder_open_done') return `${pool} ladder ${Number(event.bandIndex || 0) + 1} opened`;
  if (stage === 'support_open_done') return `${pool} support opened`;
  if (stage === 'bootstrap_open_done') return `${pool} bootstrap opened`;
  if (stage === 'main_lock_done') return `${pool} slice ${Number(event.sliceIndex || 0) + 1} locked`;
  if (stage === 'ladder_lock_done') return `${pool} ladder ${Number(event.bandIndex || 0) + 1} locked`;
  if (stage === 'support_lock_done') return `${pool} support locked`;
  if (stage === 'bootstrap_lock_done') return `${pool} bootstrap locked`;
  if (stage === 'fee_key_transfer_done') return `${pool} Fee Key transferred`;
  return `${pool} ${humanizeStage(stage)}`;
}

function airdropProgressLevel(airdrop) {
  const status = String(airdrop?.status || '').toLowerCase();
  if (['failed', 'error'].includes(status)) return 'error';
  if (['warn', 'warning', 'partial'].includes(status) || Number(airdrop?.failedCount || 0) > 0) return 'warn';
  return 'progress';
}

function airdropProgressLogLabel(airdrop) {
  const status = String(airdrop?.status || 'running').toLowerCase();
  const total = Math.max(0, Number(airdrop?.total || 0));
  const completed = Math.max(0, Number(airdrop?.completed || 0));
  const failed = Math.max(0, Number(airdrop?.failedCount || 0));
  const seen = completed + failed;
  const parts = [`Airdrop ${humanizeStage(status)}`];
  if (total > 0) parts.push(`${seen}/${total} recipients`);
  if (completed > 0) parts.push(`${completed} delivered`);
  if (failed > 0) parts.push(`${failed} failed`);
  if (airdrop?.lastWallet) parts.push(`last ${shortAddress(airdrop.lastWallet)}`);
  if (Number(airdrop?.lastTokens || 0) > 0) parts.push(`${compactAmount(airdrop.lastTokens)} tokens`);
  return parts.join(' / ');
}

function airdropProgressSnapshotKey(airdrop) {
  return [
    String(airdrop?.status || 'running').toLowerCase(),
    Number(airdrop?.total || 0),
    Number(airdrop?.completed || 0),
    Number(airdrop?.failedCount || 0),
    String(airdrop?.lastWallet || ''),
    Number(airdrop?.lastTokens || 0),
  ].join('|');
}

function rememberAirdropProgress(airdrop) {
  if (!airdrop) return;
  const snapshot = {
    ...airdrop,
    key: airdropProgressSnapshotKey(airdrop),
    ts: new Date().toISOString(),
  };
  const existing = state.liveOps.airdropSnapshots[state.liveOps.airdropSnapshots.length - 1];
  if (existing?.key === snapshot.key) {
    state.liveOps.airdropSnapshots[state.liveOps.airdropSnapshots.length - 1] = {
      ...existing,
      ...snapshot,
      ts: existing.ts || snapshot.ts,
    };
    return;
  }
  state.liveOps.airdropSnapshots = [...state.liveOps.airdropSnapshots, snapshot].slice(-20);
}

function stateClass(value) {
  const normalized = String(value || '').toLowerCase();
  if (['failed', 'error', 'blocked', 'danger'].includes(normalized)) return 'danger';
  if (['pending', 'warn', 'recovery', 'active', 'slow', 'static'].includes(normalized)) return 'warn';
  return '';
}

function costFromOperation(item) {
  const value = Number(item?.costSol ?? item?.cost ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function transactionCost(...ids) {
  return ids.reduce((sum, id) => (
    sum + costFromOperation(baseTransactions.find((item) => item.id === id))
  ), 0);
}

function executionLedgerPhase({ kind, endpoint } = {}) {
  if (kind === 'airdrop' || kind === 'airdrop-retry') return 'airdrop';
  if (kind === 'report') return 'report';
  return {
    '/api/create-token': 'mint',
    '/api/finish-token-creation': 'mint',
    '/api/create-lp': 'liquidity',
    '/api/resume-launch': 'liquidity',
    '/api/transfer-assets': 'sweep',
  }[endpoint] || 'run';
}

function executionLedgerDescriptor(input = {}) {
  const { kind = 'endpoint', endpoint, retry, recipientCount } = input;
  if (kind === 'cancel-refund') {
    return {
      label: 'Cancel and refund',
      phase: 'refund',
      estimatedCostSol: null,
      detail: 'Sweeping the selected launch wallet to the return wallet.',
    };
  }
  if (kind === 'report') {
    return {
      label: 'Publish launch report',
      phase: 'report',
      estimatedCostSol: transactionCost('tx-report'),
      detail: 'Writing the launch record and proof bundle.',
    };
  }
  if (kind === 'airdrop' || kind === 'airdrop-retry') {
    const airdrop = currentClassicModel().airdrop || {};
    const count = Number(recipientCount || airdrop.recipientCount || 0);
    return {
      label: retry || kind === 'airdrop-retry' ? 'Retry airdrop' : 'Run airdrop',
      phase: 'airdrop',
      estimatedCostSol: Number(airdrop.executionCostSol || 0) || null,
      detail: `${count} recipient${count === 1 ? '' : 's'} queued for token transfer.`,
    };
  }
  if (endpoint === '/api/create-token' || endpoint === '/api/finish-token-creation') {
    return {
      label: fullRunEndpointLabel(endpoint),
      phase: executionLedgerPhase({ endpoint }),
      estimatedCostSol: transactionCost('tx-mint', 'tx-authority'),
      detail: endpoint === '/api/finish-token-creation'
        ? 'Recover the existing mint, complete metadata and supply, then revoke authorities.'
        : 'Mint, metadata, token account, and authority transitions.',
    };
  }
  if (endpoint === '/api/create-lp' || endpoint === '/api/resume-launch') {
    return {
      label: fullRunEndpointLabel(endpoint),
      phase: executionLedgerPhase({ endpoint }),
      estimatedCostSol: transactionCost('tx-pool', 'tx-lock'),
      detail: 'Pools, positions, locks, and Fee Key transfer checkpoints.',
    };
  }
  if (endpoint === '/api/transfer-assets') {
    return {
      label: fullRunEndpointLabel(endpoint),
      phase: executionLedgerPhase({ endpoint }),
      estimatedCostSol: null,
      detail: 'Final sweep to the return wallet.',
    };
  }
  return {
    label: input.label || 'Launch operation',
    phase: executionLedgerPhase(input),
    estimatedCostSol: null,
    detail: input.detail || 'Guarded local launch execution.',
  };
}

function startExecutionLedgerEntry(input = {}) {
  const descriptor = executionLedgerDescriptor(input);
  const label = input.label || descriptor.label;
  const retryKey = input.endpoint || label;
  const attempt = state.executionLedger.filter((entry) => (
    (retryKey && (entry.endpoint === retryKey || entry.label === label))
    && Date.now() - Number(entry.startedAt || 0) < EXECUTION_LEDGER_MAX_AGE_MS
  )).length + 1;
  const entry = {
    id: `ledger-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    endpoint: input.endpoint || null,
    status: 'running',
    startedAt: Date.now(),
    startedIso: new Date().toISOString(),
    ...descriptor,
    label,
    detail: input.detail || descriptor.detail,
    attempt,
  };
  state.executionLedger = [entry, ...state.executionLedger].slice(0, EXECUTION_LEDGER_MAX_ENTRIES);
  persistExecutionLedger();
  return entry.id;
}

function finishExecutionLedgerEntry(id, updates = {}) {
  if (!id) return;
  const entry = state.executionLedger.find((item) => item.id === id);
  if (!entry) return;
  const endedAt = Date.now();
  entry.status = updates.status || 'complete';
  entry.endedAt = endedAt;
  entry.endedIso = new Date(endedAt).toISOString();
  entry.durationMs = Math.max(0, endedAt - Number(entry.startedAt || endedAt));
  if (updates.detail) entry.detail = updates.detail;
  if (updates.error) entry.error = updates.error;
  if (Number.isFinite(Number(updates.balanceDeltaSol))) entry.balanceDeltaSol = Number(updates.balanceDeltaSol);
  if (Number.isFinite(Number(updates.observedOutflowSol))) entry.observedOutflowSol = Number(updates.observedOutflowSol);
  if (Number.isFinite(Number(updates.balanceBeforeSol))) entry.balanceBeforeSol = Number(updates.balanceBeforeSol);
  if (Number.isFinite(Number(updates.balanceAfterSol))) entry.balanceAfterSol = Number(updates.balanceAfterSol);
  if (updates.balanceObservationError) entry.balanceObservationError = updates.balanceObservationError;
  persistExecutionLedger();
}

function ledgerObservationFromExecution(executed) {
  const observed = executed?.observedWalletDelta || executed?.executionObservation?.observedWalletDelta || null;
  if (!observed || typeof observed !== 'object') return {};
  const fields = {};
  if (Number.isFinite(Number(observed.deltaSol))) fields.balanceDeltaSol = Number(observed.deltaSol);
  if (Number.isFinite(Number(observed.outflowSol))) fields.observedOutflowSol = Number(observed.outflowSol);
  if (Number.isFinite(Number(observed.beforeSol))) fields.balanceBeforeSol = Number(observed.beforeSol);
  if (Number.isFinite(Number(observed.afterSol))) fields.balanceAfterSol = Number(observed.afterSol);
  if (observed.error) fields.balanceObservationError = observed.error;
  return fields;
}

function observedExecutionSpendSummary(entries = state.executionLedger) {
  const rows = Array.isArray(entries) ? entries : [];
  return rows.reduce((summary, entry) => {
    if (!entry || entry.status === 'running') return summary;
    if (Number.isFinite(Number(entry.observedOutflowSol))) {
      const outflow = Math.max(0, Number(entry.observedOutflowSol));
      summary.outflowSol += outflow;
      summary.measuredCount += 1;
      return summary;
    }
    const delta = Number(entry.balanceDeltaSol);
    if (Number.isFinite(delta)) {
      if (delta < 0) summary.outflowSol += Math.abs(delta);
      if (delta > 0) summary.inflowSol += delta;
      summary.measuredCount += 1;
      return summary;
    }
    if (entry.balanceObservationError) summary.errorCount += 1;
    return summary;
  }, {
    outflowSol: 0,
    inflowSol: 0,
    measuredCount: 0,
    errorCount: 0,
  });
}

function formatSignedSol(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const sign = numeric > 0 ? '+' : numeric < 0 ? '-' : '';
  return `${sign}${fmtSol(Math.abs(numeric))}`;
}

function formatLedgerCost(entry) {
  if (Number.isFinite(Number(entry?.balanceDeltaSol))) {
    return `observed ${formatSignedSol(entry.balanceDeltaSol)}`;
  }
  if (entry?.balanceObservationError) return 'observed unavailable';
  const value = Number(entry?.estimatedCostSol);
  return Number.isFinite(value) && value > 0 ? `~${fmtSol(value)}` : 'variable';
}

function formatLedgerDuration(entry) {
  const now = Date.now();
  const duration = entry?.status === 'running'
    ? now - Number(entry.startedAt || now)
    : Number(entry?.durationMs || 0);
  if (!Number.isFinite(duration) || duration <= 0) return entry?.status === 'running' ? 'running' : '-';
  if (duration < 1000) return `${Math.max(1, Math.round(duration))} ms`;
  if (duration < 60000) return `${(duration / 1000).toFixed(duration < 10000 ? 1 : 0)}s`;
  return `${Math.round(duration / 60000)}m`;
}

function executionLedgerIcon(status) {
  if (status === 'complete') return 'fa-check';
  if (status === 'error') return 'fa-triangle-exclamation';
  if (status === 'warn') return 'fa-circle-exclamation';
  return 'fa-spinner';
}

function executionLedgerAttemptLabel(entry) {
  const attempt = Number(entry?.attempt || 1);
  return attempt > 1 ? `attempt ${attempt}` : '';
}
